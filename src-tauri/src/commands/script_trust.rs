//! Whether collection scripts may run (spec 0162): this person's decision
//! about each workspace, the mark of collections imported without trust, and
//! the check every send makes before running scripts.

use std::path::{Path, PathBuf};

use alcy_domain::{ScriptsSkipReason, WorkspaceScriptTrust, scripts_skip_reason};
use alcy_storage::{CollectionsStore, LocalSecrets, ScriptTrustStore, StorageError};
use serde::{Deserialize, Serialize};

use crate::commands::collections::COLLECTION_SAVES;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScriptTrustInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkspaceScriptTrustInput {
    pub root_path: String,
    pub trusted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCollectionScriptTrustInput {
    pub root_path: String,
    pub collection_id: String,
    pub trusted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceScriptTrustDto {
    Trusted,
    Untrusted,
    Undecided,
}

impl From<WorkspaceScriptTrust> for WorkspaceScriptTrustDto {
    fn from(trust: WorkspaceScriptTrust) -> Self {
        match trust {
            WorkspaceScriptTrust::Trusted => Self::Trusted,
            WorkspaceScriptTrust::Untrusted => Self::Untrusted,
            WorkspaceScriptTrust::Undecided => Self::Undecided,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScriptTrustCommandError {
    NotFound { message: String },
    Storage { message: String },
}

impl From<StorageError> for ScriptTrustCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

/// Scripts of a send that did not run because they are not trusted. The
/// request went out without them.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptsSkippedOutput {
    /// `workspace` or `collection`.
    pub reason: String,
    pub pre_request: bool,
    pub post_response: bool,
}

impl ScriptsSkippedOutput {
    pub(crate) fn new(reason: ScriptsSkipReason, pre_request: bool, post_response: bool) -> Self {
        Self {
            reason: reason.as_str().to_string(),
            pre_request,
            post_response,
        }
    }
}

#[tauri::command]
pub async fn get_workspace_script_trust(
    input: WorkspaceScriptTrustInput,
    trust: tauri::State<'_, ScriptTrustStore>,
) -> Result<WorkspaceScriptTrustDto, ScriptTrustCommandError> {
    let trust = ScriptTrustStore::clone(&trust);
    run_blocking(move || Ok(trust.workspace(Path::new(&input.root_path)).into())).await
}

#[tauri::command]
pub async fn set_workspace_script_trust(
    input: SetWorkspaceScriptTrustInput,
    trust: tauri::State<'_, ScriptTrustStore>,
) -> Result<(), ScriptTrustCommandError> {
    let trust = ScriptTrustStore::clone(&trust);
    let result = run_blocking(move || {
        trust
            .set_workspace(Path::new(&input.root_path), input.trusted)
            .map_err(Into::into)
    })
    .await;
    crate::logging::logged("alcy::scripts", "workspace script trust", result)
}

/// Marks or clears one collection. The mark lives in the collection file,
/// so it reaches everyone who receives the workspace (spec 0162).
#[tauri::command]
pub async fn set_collection_script_trust(
    input: SetCollectionScriptTrustInput,
    secrets: tauri::State<'_, LocalSecrets>,
) -> Result<(), ScriptTrustCommandError> {
    let secrets = LocalSecrets::clone(&secrets);
    let result = run_blocking(move || {
        let store = CollectionsStore::new(PathBuf::from(&input.root_path), secrets);
        let found = COLLECTION_SAVES
            .run_unordered(|| store.set_script_trust(&input.collection_id, input.trusted))?;
        if found {
            Ok(())
        } else {
            Err(ScriptTrustCommandError::NotFound {
                message: format!("collection '{}' not found", input.collection_id),
            })
        }
    })
    .await;
    crate::logging::logged("alcy::scripts", "collection script trust", result)
}

/// Why the scripts of the saved request `request_id` must not run in this
/// send, or `None` when they may (or there are none). Unsaved tabs run
/// their scripts: the person wrote them.
pub(crate) async fn scripts_skip_reason_for(
    trust: &ScriptTrustStore,
    secrets: &LocalSecrets,
    root_path: &str,
    request_id: Option<&str>,
) -> Option<ScriptsSkipReason> {
    let request_id = request_id?.to_string();
    let root = PathBuf::from(root_path);
    let trust = trust.clone();
    let secrets = secrets.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = trust.workspace(&root);
        if workspace != WorkspaceScriptTrust::Trusted {
            return Some(ScriptsSkipReason::Workspace);
        }
        match CollectionsStore::new(root, secrets).load() {
            Ok(collections) => scripts_skip_reason(workspace, &collections, Some(&request_id)),
            // Without the file there is no way to know the mark: do not run.
            Err(_) => Some(ScriptsSkipReason::Collection),
        }
    })
    .await
    .unwrap_or(Some(ScriptsSkipReason::Collection))
}

/// Clears the scripts of an interactive send when they are not trusted, so
/// the request goes out without them, and says which ones were dropped.
pub(crate) async fn withhold_untrusted_send_scripts(
    trust: &ScriptTrustStore,
    secrets: &LocalSecrets,
    root_path: &str,
    request_id: Option<&str>,
    pre_request_script: &mut String,
    post_response_script: &mut String,
) -> Option<ScriptsSkippedOutput> {
    let pre_request = !pre_request_script.trim().is_empty();
    let post_response = !post_response_script.trim().is_empty();
    if !pre_request && !post_response {
        return None;
    }
    let reason = scripts_skip_reason_for(trust, secrets, root_path, request_id).await?;
    pre_request_script.clear();
    post_response_script.clear();
    log::info!(target: "alcy::scripts", "scripts skipped (not trusted: {})", reason.as_str());
    Some(ScriptsSkippedOutput::new(
        reason,
        pre_request,
        post_response,
    ))
}

async fn run_blocking<T, F>(work: F) -> Result<T, ScriptTrustCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ScriptTrustCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(ScriptTrustCommandError::Storage {
                message: error.to_string(),
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_secrets::test_secrets;
    use alcy_domain::{
        Authentication, Collection, Endpoint, ProtocolId, Request, RequestDocument, SavedRequest,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("alcy-script-trust-cmd-{nanos}-{count}"));
        fs::create_dir_all(dir.join("workspace")).unwrap();
        dir
    }

    /// A workspace with one collection holding `request-1`, and a trust file.
    fn setup(untrusted_collection: bool) -> (PathBuf, ScriptTrustStore) {
        let dir = temp_dir();
        let root = dir.join("workspace");
        let request = Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_scripts("al.x = 1", "");
        let collection = Collection::new(
            "collection-1",
            "API",
            vec![],
            vec![SavedRequest::new("request-1", "Ping", request).unwrap()],
        )
        .unwrap()
        .with_untrusted_scripts(untrusted_collection);
        CollectionsStore::new(root.clone(), test_secrets())
            .save(&[collection])
            .unwrap();
        (root, ScriptTrustStore::new(dir.join("script-trust.json")))
    }

    async fn withhold(
        trust: &ScriptTrustStore,
        root: &Path,
        request_id: Option<&str>,
        pre: &str,
        post: &str,
    ) -> (Option<ScriptsSkippedOutput>, String, String) {
        let mut pre = pre.to_string();
        let mut post = post.to_string();
        let skipped = withhold_untrusted_send_scripts(
            trust,
            &test_secrets(),
            &root.to_string_lossy(),
            request_id,
            &mut pre,
            &mut post,
        )
        .await;
        (skipped, pre, post)
    }

    #[tokio::test]
    async fn an_undecided_workspace_sends_without_scripts() {
        let (root, trust) = setup(false);

        let (skipped, pre, post) =
            withhold(&trust, &root, Some("request-1"), "al.x = 1", "  ").await;

        assert_eq!(
            skipped,
            Some(ScriptsSkippedOutput::new(
                ScriptsSkipReason::Workspace,
                true,
                false
            ))
        );
        assert!(pre.is_empty() && post.is_empty());
    }

    #[tokio::test]
    async fn a_marked_collection_sends_without_scripts_in_a_trusted_workspace() {
        let (root, trust) = setup(true);
        trust.set_workspace(&root, true).unwrap();

        let (skipped, pre, _) = withhold(&trust, &root, Some("request-1"), "a", "b").await;

        assert_eq!(
            skipped.map(|skipped| skipped.reason),
            Some("collection".to_string())
        );
        assert!(pre.is_empty());
    }

    #[tokio::test]
    async fn trusted_scripts_and_unsaved_tabs_keep_their_scripts() {
        let (root, trust) = setup(false);
        trust.set_workspace(&root, true).unwrap();

        let (skipped, pre, post) = withhold(&trust, &root, Some("request-1"), "a", "b").await;
        assert_eq!((skipped, pre.as_str(), post.as_str()), (None, "a", "b"));

        let untrusted = ScriptTrustStore::new(root.join("other-trust.json"));
        let (skipped, pre, _) = withhold(&untrusted, &root, None, "a", "").await;
        assert_eq!((skipped, pre.as_str()), (None, "a"));
    }

    #[tokio::test]
    async fn a_send_without_scripts_reports_nothing() {
        let (root, trust) = setup(true);

        let (skipped, _, _) = withhold(&trust, &root, Some("request-1"), " ", "").await;

        assert_eq!(skipped, None);
    }
}
