//! Body files of REST requests (spec 0163): which ones a send may read, the
//! native picker that grants a file outside the workspace, copying a picked
//! file into the workspace, and the state shown next to each file field.
//!
//! Every send resolves body file paths through `authorize_body_files`, the
//! only place that turns a saved path into one the REST executor opens.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use alcy_app::{InstrumentedResponse, RequestExecutor};
use alcy_domain::{
    BodyFileAccess, BodyFileAccessStatus, BodyPayload, ExecutionError, Request, Response,
    resolve_file_path,
};
use alcy_storage::{BodyFileGrantStore, SecuritySettingsStore};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// Access for tests that send no body files.
#[cfg(test)]
pub(crate) static NO_BODY_FILES: BodyFileAccess = BodyFileAccess::empty();

/// Folder, inside the workspace, that receives copied body files.
const COPIED_FILES_DIRECTORY: &str = "files";

/// What a send may read in the workspace at `root`. An unreadable setting
/// keeps files outside the workspace blocked.
pub(crate) async fn load_body_file_access(
    root: &Path,
    settings: &SecuritySettingsStore,
    grants: &BodyFileGrantStore,
) -> BodyFileAccess {
    let canonical_root = tokio::fs::canonicalize(root).await.ok();
    let allow_outside = settings
        .load()
        .map(|settings| settings.allow_body_files_outside_workspace)
        .unwrap_or(false);
    let granted = canonical_root
        .as_deref()
        .map(|root| grants.grants(root))
        .unwrap_or_default();
    BodyFileAccess::new(canonical_root, allow_outside, granted)
}

/// Resolves the body file paths of `payload` against `root` and refuses the
/// send when one of them may not be read. Runs right before the executor
/// opens the files, after variables were resolved.
pub(crate) async fn authorize_body_files(
    payload: &BodyPayload,
    root: &Path,
    access: &BodyFileAccess,
) -> Result<BodyPayload, ExecutionError> {
    let mut resolved: HashMap<&str, String> = HashMap::new();
    for path in payload.sent_file_paths() {
        if resolved.contains_key(path) {
            continue;
        }
        let joined = resolve_file_path(root, path);
        let canonical = tokio::fs::canonicalize(&joined).await.map_err(|error| {
            ExecutionError::BodyFileUnreadable {
                path: joined.clone(),
                detail: error.to_string(),
            }
        })?;
        if !access.status_of(&canonical).is_allowed() {
            log::warn!(
                target: "alcy::request",
                "body file outside the workspace blocked (not picked in this workspace)"
            );
            return Err(ExecutionError::BodyFileNotAllowed {
                path: path.to_string(),
            });
        }
        resolved.insert(path, joined);
    }
    // Disabled fields are never read; they only get their path joined.
    Ok(payload.map_file_paths(|path| {
        resolved
            .get(path)
            .cloned()
            .unwrap_or_else(|| resolve_file_path(root, path))
    }))
}

/// Executor wrapper that authorizes body files before delegating, for
/// callers that hold a protocol executor directly (load runs).
pub(crate) struct BodyFileGuard<'a, E> {
    pub(crate) inner: &'a E,
    pub(crate) workspace_root: &'a Path,
    pub(crate) access: &'a BodyFileAccess,
}

impl<E: RequestExecutor + Sync> BodyFileGuard<'_, E> {
    async fn authorized(&self, request: &Request) -> Result<Request, ExecutionError> {
        let mut request = request.clone();
        request.body_payload =
            authorize_body_files(&request.body_payload, self.workspace_root, self.access).await?;
        Ok(request)
    }
}

impl<E: RequestExecutor + Sync> RequestExecutor for BodyFileGuard<'_, E> {
    async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
        let request = self.authorized(request).await?;
        self.inner.execute(&request).await
    }

    // Written out instead of `async fn`: that form inherits the trait's
    // `Self: Sync` bound, which rustc cannot prove for every lifetime of the
    // guard; without the bound the future is still `Send`.
    #[allow(clippy::manual_async_fn)]
    fn execute_instrumented(
        &self,
        request: &Request,
    ) -> impl Future<Output = Result<InstrumentedResponse, ExecutionError>> + Send {
        async move {
            let request = self.authorized(request).await?;
            self.inner.execute_instrumented(&request).await
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BodyFileCommandError {
    Storage {
        message: String,
    },
    Io {
        message: String,
    },
    /// Copying is only for a file picked for this workspace.
    NotGranted,
}

impl From<alcy_storage::StorageError> for BodyFileCommandError {
    fn from(error: alcy_storage::StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

fn io_error(error: std::io::Error) -> BodyFileCommandError {
    BodyFileCommandError::Io {
        message: error.to_string(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckBodyFilesInput {
    pub root_path: String,
    pub paths: Vec<String>,
}

/// State of a body file in the Body tab.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BodyFileStatus {
    Ok,
    Missing,
    /// Outside the workspace and neither picked here nor allowed.
    Blocked,
    /// Outside the workspace, picked here or allowed by the setting.
    OutsideAllowed,
}

/// Tells, for each body file path (relative to the workspace or absolute),
/// whether it exists and whether a send may read it, so the Body tab warns
/// before sending.
#[tauri::command]
pub async fn check_body_files(
    input: CheckBodyFilesInput,
    settings: State<'_, SecuritySettingsStore>,
    grants: State<'_, BodyFileGrantStore>,
) -> Result<Vec<BodyFileStatus>, ()> {
    let root = Path::new(&input.root_path);
    let access = load_body_file_access(root, &settings, &grants).await;
    Ok(check_body_files_inner(root, &input.paths, &access).await)
}

async fn check_body_files_inner(
    root: &Path,
    paths: &[String],
    access: &BodyFileAccess,
) -> Vec<BodyFileStatus> {
    let mut statuses = Vec::with_capacity(paths.len());
    for path in paths {
        statuses.push(body_file_status(root, path, access).await);
    }
    statuses
}

async fn body_file_status(root: &Path, path: &str, access: &BodyFileAccess) -> BodyFileStatus {
    if path.is_empty() {
        return BodyFileStatus::Missing;
    }
    let resolved = resolve_file_path(root, path);
    let is_file = tokio::fs::metadata(&resolved)
        .await
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);
    let Some(canonical) = is_file
        .then_some(())
        .and(tokio::fs::canonicalize(&resolved).await.ok())
    else {
        return BodyFileStatus::Missing;
    };
    match access.status_of(&canonical) {
        BodyFileAccessStatus::InsideWorkspace => BodyFileStatus::Ok,
        BodyFileAccessStatus::Granted | BodyFileAccessStatus::AllowedBySetting => {
            BodyFileStatus::OutsideAllowed
        }
        BodyFileAccessStatus::Blocked => BodyFileStatus::Blocked,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickBodyFileInput {
    pub root_path: String,
    /// Path currently in the field; the dialog opens in its folder.
    #[serde(default)]
    pub current_path: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickedBodyFile {
    /// Relative with `/` inside the workspace; absolute outside it.
    pub path: String,
    pub outside_workspace: bool,
    pub size_bytes: u64,
}

/// Opens the native file dialog for a body file. A file outside the
/// workspace is granted for this workspace: the dialog is the only way a
/// path outside it becomes readable, so nothing a collection carries can
/// grant it.
#[tauri::command]
pub async fn pick_body_file(
    input: PickBodyFileInput,
    window: tauri::WebviewWindow,
    grants: State<'_, BodyFileGrantStore>,
) -> Result<Option<PickedBodyFile>, BodyFileCommandError> {
    let root = PathBuf::from(&input.root_path);
    let mut dialog = window.dialog().file().set_parent(&window);
    if let Some(directory) = starting_directory(&root, input.current_path.as_deref()).await {
        dialog = dialog.set_directory(directory);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |picked| {
        let _ = sender.send(picked);
    });
    let Some(picked) = receiver.await.ok().flatten() else {
        return Ok(None);
    };
    let Ok(picked) = picked.into_path() else {
        return Ok(None);
    };
    record_picked_file(&root, &picked, &grants).await.map(Some)
}

/// Folder of the current file when it exists, else the workspace.
async fn starting_directory(root: &Path, current_path: Option<&str>) -> Option<PathBuf> {
    let current = current_path
        .filter(|path| !path.is_empty())
        .map(|path| PathBuf::from(resolve_file_path(root, path)))
        .and_then(|path| path.parent().map(Path::to_path_buf));
    for candidate in current.into_iter().chain([root.to_path_buf()]) {
        if tokio::fs::metadata(&candidate)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            return Some(candidate);
        }
    }
    None
}

async fn record_picked_file(
    root: &Path,
    picked: &Path,
    grants: &BodyFileGrantStore,
) -> Result<PickedBodyFile, BodyFileCommandError> {
    let canonical_file = tokio::fs::canonicalize(picked).await.map_err(io_error)?;
    let size_bytes = tokio::fs::metadata(&canonical_file)
        .await
        .map_err(io_error)?
        .len();
    let canonical_root = tokio::fs::canonicalize(root).await.ok();
    if let Some(relative) = canonical_root
        .as_deref()
        .and_then(|root| relative_inside(root, &canonical_file))
    {
        return Ok(PickedBodyFile {
            path: relative,
            outside_workspace: false,
            size_bytes,
        });
    }
    if let Some(canonical_root) = canonical_root.as_deref() {
        grants.grant(canonical_root, &canonical_file)?;
    }
    Ok(PickedBodyFile {
        path: picked.to_string_lossy().into_owned(),
        outside_workspace: true,
        size_bytes,
    })
}

/// `file` relative to `root` with `/` separators, when it lies inside it.
fn relative_inside(root: &Path, file: &Path) -> Option<String> {
    if !alcy_domain::path_is_within(root, file) {
        return None;
    }
    let parts: Vec<String> = file
        .components()
        .skip(root.components().count())
        .map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<_>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyBodyFileInput {
    pub root_path: String,
    pub file_path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopiedBodyFile {
    /// Workspace-relative path of the copy, with `/` separators.
    pub path: String,
}

/// Copies a file picked for this workspace into its `files/` folder. Only
/// granted files are copied, so this never becomes a way to read a file a
/// collection points at.
#[tauri::command]
pub async fn copy_body_file_into_workspace(
    input: CopyBodyFileInput,
    grants: State<'_, BodyFileGrantStore>,
) -> Result<CopiedBodyFile, BodyFileCommandError> {
    copy_body_file_inner(
        Path::new(&input.root_path),
        Path::new(&input.file_path),
        &grants,
    )
    .await
}

async fn copy_body_file_inner(
    root: &Path,
    file: &Path,
    grants: &BodyFileGrantStore,
) -> Result<CopiedBodyFile, BodyFileCommandError> {
    let canonical_root = tokio::fs::canonicalize(root).await.map_err(io_error)?;
    let canonical_file = tokio::fs::canonicalize(file).await.map_err(io_error)?;
    let access = BodyFileAccess::new(
        Some(canonical_root.clone()),
        false,
        grants.grants(&canonical_root),
    );
    if access.status_of(&canonical_file) != BodyFileAccessStatus::Granted {
        return Err(BodyFileCommandError::NotGranted);
    }
    let file_name = canonical_file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or(BodyFileCommandError::NotGranted)?;
    let directory = canonical_root.join(COPIED_FILES_DIRECTORY);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(io_error)?;
    let (name, mut target) = create_unique(&directory, &file_name).await?;
    let mut source = tokio::fs::File::open(&canonical_file)
        .await
        .map_err(io_error)?;
    let copied = tokio::io::copy(&mut source, &mut target).await;
    if let Err(error) = copied {
        drop(target);
        let _ = tokio::fs::remove_file(directory.join(&name)).await;
        return Err(io_error(error));
    }
    Ok(CopiedBodyFile {
        path: format!("{COPIED_FILES_DIRECTORY}/{name}"),
    })
}

/// Creates `name`, or `stem (2).ext`, `stem (3).ext`… when it is taken,
/// without ever replacing an existing file.
async fn create_unique(
    directory: &Path,
    file_name: &str,
) -> Result<(String, tokio::fs::File), BodyFileCommandError> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_string());
    let extension = path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    for attempt in 1..=1000 {
        let name = if attempt == 1 {
            file_name.to_string()
        } else {
            format!("{stem} ({attempt}){extension}")
        };
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(&name))
            .await
        {
            Ok(file) => return Ok((name, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(error)),
        }
    }
    Err(BodyFileCommandError::Io {
        message: format!("no free name for {file_name}"),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyFileGrantsInput {
    pub root_path: String,
}

/// How many files outside the workspace were picked for it.
#[tauri::command]
pub async fn count_body_file_grants(
    input: BodyFileGrantsInput,
    grants: State<'_, BodyFileGrantStore>,
) -> Result<usize, BodyFileCommandError> {
    Ok(tokio::fs::canonicalize(&input.root_path)
        .await
        .map(|root| grants.grants(&root).len())
        .unwrap_or(0))
}

/// Forgets the files outside the workspace picked for it.
#[tauri::command]
pub async fn clear_body_file_grants(
    input: BodyFileGrantsInput,
    grants: State<'_, BodyFileGrantStore>,
) -> Result<(), BodyFileCommandError> {
    let Ok(root) = tokio::fs::canonicalize(&input.root_path).await else {
        return Ok(());
    };
    grants.clear(&root)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{FormDataField, FormDataFieldValue};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A workspace folder and an "outside" folder next to it.
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        outside: PathBuf,
        grants: BodyFileGrantStore,
    }

    impl Fixture {
        fn new() -> Self {
            let count = COUNTER.fetch_add(1, Ordering::SeqCst);
            let base = std::env::temp_dir().join(format!(
                "alcy-body-files-test-{}-{count}",
                std::process::id()
            ));
            let root = base.join("workspace");
            let outside = base.join("outside");
            std::fs::create_dir_all(root.join("files")).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(root.join("files/photo.png"), b"photo").unwrap();
            std::fs::write(outside.join("private.txt"), b"secret").unwrap();
            let grants = BodyFileGrantStore::new(base.join("body-file-grants.json"));
            Self {
                base,
                root,
                outside,
                grants,
            }
        }

        fn access(&self, allow_outside: bool) -> BodyFileAccess {
            let root = std::fs::canonicalize(&self.root).unwrap();
            let granted = self.grants.grants(&root);
            BodyFileAccess::new(Some(root), allow_outside, granted)
        }

        fn secret(&self) -> String {
            self.outside
                .join("private.txt")
                .to_string_lossy()
                .into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.base).ok();
        }
    }

    fn binary(path: &str) -> BodyPayload {
        BodyPayload::Binary {
            file_path: path.to_string(),
        }
    }

    fn form_file(path: &str, enabled: bool) -> BodyPayload {
        BodyPayload::FormData(vec![FormDataField {
            name: "file".to_string(),
            enabled,
            value: FormDataFieldValue::File {
                file_path: path.to_string(),
            },
        }])
    }

    #[tokio::test]
    async fn a_file_inside_the_workspace_is_resolved_against_the_root() {
        let fixture = Fixture::new();
        let authorized = authorize_body_files(
            &binary("files/photo.png"),
            &fixture.root,
            &fixture.access(false),
        )
        .await
        .unwrap();
        assert_eq!(
            authorized,
            binary(&fixture.root.join("files/photo.png").to_string_lossy())
        );
    }

    #[tokio::test]
    async fn an_absolute_path_outside_the_workspace_is_blocked() {
        let fixture = Fixture::new();
        let error = authorize_body_files(
            &form_file(&fixture.secret(), true),
            &fixture.root,
            &fixture.access(false),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            ExecutionError::BodyFileNotAllowed {
                path: fixture.secret()
            }
        );
    }

    #[tokio::test]
    async fn a_relative_path_escaping_with_dot_dot_is_blocked() {
        let fixture = Fixture::new();
        let error = authorize_body_files(
            &binary("../outside/private.txt"),
            &fixture.root,
            &fixture.access(false),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ExecutionError::BodyFileNotAllowed { .. }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_inside_the_workspace_pointing_outside_is_blocked() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(
            fixture.outside.join("private.txt"),
            fixture.root.join("files/innocent.png"),
        )
        .unwrap();
        let error = authorize_body_files(
            &binary("files/innocent.png"),
            &fixture.root,
            &fixture.access(false),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ExecutionError::BodyFileNotAllowed { .. }));
    }

    #[tokio::test]
    async fn a_granted_file_or_the_setting_allows_a_file_outside() {
        let fixture = Fixture::new();
        assert!(
            authorize_body_files(
                &binary(&fixture.secret()),
                &fixture.root,
                &fixture.access(true)
            )
            .await
            .is_ok()
        );
        let canonical_root = std::fs::canonicalize(&fixture.root).unwrap();
        let canonical_file = std::fs::canonicalize(fixture.secret()).unwrap();
        fixture
            .grants
            .grant(&canonical_root, &canonical_file)
            .unwrap();
        assert!(
            authorize_body_files(
                &binary(&fixture.secret()),
                &fixture.root,
                &fixture.access(false)
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn a_grant_from_another_workspace_does_not_apply() {
        let fixture = Fixture::new();
        let other = fixture.base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        fixture
            .grants
            .grant(
                &std::fs::canonicalize(&other).unwrap(),
                &std::fs::canonicalize(fixture.secret()).unwrap(),
            )
            .unwrap();
        assert!(
            authorize_body_files(
                &binary(&fixture.secret()),
                &fixture.root,
                &fixture.access(false)
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn a_disabled_field_is_not_checked() {
        let fixture = Fixture::new();
        assert!(
            authorize_body_files(
                &form_file(&fixture.secret(), false),
                &fixture.root,
                &fixture.access(false)
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn a_missing_file_fails_as_unreadable() {
        let fixture = Fixture::new();
        let error = authorize_body_files(
            &binary("files/missing.png"),
            &fixture.root,
            &fixture.access(false),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ExecutionError::BodyFileUnreadable { .. }));
    }

    struct RecordingExecutor(std::sync::Mutex<Vec<Request>>);

    impl RequestExecutor for RecordingExecutor {
        async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
            self.0.lock().unwrap().push(request.clone());
            Err(ExecutionError::Cancelled)
        }
    }

    fn request_with(payload: BodyPayload) -> Request {
        Request::new(
            alcy_domain::Endpoint::new("http://127.0.0.1:9").unwrap(),
            alcy_domain::RequestDocument::new(alcy_domain::ProtocolId::Rest, ""),
            "",
            vec![],
            alcy_domain::Authentication::None,
        )
        .with_body_payload(payload)
    }

    #[tokio::test]
    async fn the_guard_never_hands_a_blocked_file_to_the_executor() {
        let fixture = Fixture::new();
        let inner = RecordingExecutor(std::sync::Mutex::new(Vec::new()));
        let access = fixture.access(false);
        let guard = BodyFileGuard {
            inner: &inner,
            workspace_root: &fixture.root,
            access: &access,
        };

        let blocked = guard
            .execute_instrumented(&request_with(binary(&fixture.secret())))
            .await;
        let allowed = guard
            .execute(&request_with(binary("files/photo.png")))
            .await;

        assert!(matches!(
            blocked,
            Err(ExecutionError::BodyFileNotAllowed { .. })
        ));
        assert_eq!(allowed, Err(ExecutionError::Cancelled));
        let seen = inner.0.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].body_payload,
            binary(&fixture.root.join("files/photo.png").to_string_lossy())
        );
    }

    #[tokio::test]
    async fn reports_the_state_of_each_file() {
        let fixture = Fixture::new();
        let absolute_inside = fixture
            .root
            .join("files/photo.png")
            .to_string_lossy()
            .into_owned();
        let paths = vec![
            "files/photo.png".to_string(),
            absolute_inside,
            "files/missing.png".to_string(),
            "files".to_string(),
            String::new(),
            fixture.secret(),
            "../outside/private.txt".to_string(),
        ];

        let blocked = check_body_files_inner(&fixture.root, &paths, &fixture.access(false)).await;
        let allowed = check_body_files_inner(&fixture.root, &paths, &fixture.access(true)).await;

        use BodyFileStatus::*;
        assert_eq!(
            blocked,
            vec![Ok, Ok, Missing, Missing, Missing, Blocked, Blocked]
        );
        assert_eq!(
            allowed,
            vec![
                Ok,
                Ok,
                Missing,
                Missing,
                Missing,
                OutsideAllowed,
                OutsideAllowed
            ]
        );
    }

    #[tokio::test]
    async fn picking_a_file_inside_returns_a_relative_path_and_grants_nothing() {
        let fixture = Fixture::new();
        let picked = record_picked_file(
            &fixture.root,
            &fixture.root.join("files/photo.png"),
            &fixture.grants,
        )
        .await
        .unwrap();
        assert_eq!(
            picked,
            PickedBodyFile {
                path: "files/photo.png".to_string(),
                outside_workspace: false,
                size_bytes: 5,
            }
        );
        assert!(
            fixture
                .grants
                .grants(&std::fs::canonicalize(&fixture.root).unwrap())
                .is_empty()
        );
    }

    #[tokio::test]
    async fn picking_a_file_outside_grants_it_for_this_workspace() {
        let fixture = Fixture::new();
        let picked = record_picked_file(
            &fixture.root,
            &fixture.outside.join("private.txt"),
            &fixture.grants,
        )
        .await
        .unwrap();
        assert_eq!(picked.path, fixture.secret());
        assert!(picked.outside_workspace);
        assert!(
            authorize_body_files(
                &binary(&fixture.secret()),
                &fixture.root,
                &fixture.access(false)
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn copies_a_granted_file_without_replacing_existing_ones() {
        let fixture = Fixture::new();
        std::fs::write(fixture.outside.join("photo.png"), b"new").unwrap();
        record_picked_file(
            &fixture.root,
            &fixture.outside.join("photo.png"),
            &fixture.grants,
        )
        .await
        .unwrap();

        let first = copy_body_file_inner(
            &fixture.root,
            &fixture.outside.join("photo.png"),
            &fixture.grants,
        )
        .await
        .unwrap();
        let second = copy_body_file_inner(
            &fixture.root,
            &fixture.outside.join("photo.png"),
            &fixture.grants,
        )
        .await
        .unwrap();

        assert_eq!(first.path, "files/photo (2).png");
        assert_eq!(second.path, "files/photo (3).png");
        assert_eq!(
            std::fs::read(fixture.root.join("files/photo.png")).unwrap(),
            b"photo"
        );
        assert_eq!(
            std::fs::read(fixture.root.join("files/photo (2).png")).unwrap(),
            b"new"
        );
    }

    #[tokio::test]
    async fn refuses_to_copy_a_file_that_was_not_picked() {
        let fixture = Fixture::new();
        let error = copy_body_file_inner(
            &fixture.root,
            &fixture.outside.join("private.txt"),
            &fixture.grants,
        )
        .await
        .unwrap_err();
        assert_eq!(error, BodyFileCommandError::NotGranted);
        assert!(!fixture.root.join("files/private.txt").exists());
    }

    #[test]
    fn relative_paths_use_forward_slashes() {
        let root = std::env::temp_dir().join("workspace");
        assert_eq!(
            relative_inside(&root, &root.join("files").join("a.bin")),
            Some("files/a.bin".to_string())
        );
        assert_eq!(relative_inside(&root, &root), None);
        assert_eq!(
            relative_inside(&root, &std::env::temp_dir().join("elsewhere")),
            None
        );
    }
}
