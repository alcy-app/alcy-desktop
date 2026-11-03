//! Opening a workspace from a team's OneDrive catalog (spec 0133): creates
//! the local copy, links it and pulls, or reuses a recent copy already
//! linked to the same folder.

use std::fs;
use std::path::{Path, PathBuf};

use alcy_app::{RemoteRepository, pull_changes};
use alcy_domain::{ENVIRONMENTS_FILE, RemoteLocation, Workspace, WorkspaceLink};
use alcy_onedrive::DriveFolder;
use alcy_platform::KeyringCredentialStore;
use alcy_storage::{
    RecentWorkspaceEntry, RecentWorkspacesStore, StorageError, WorkspaceLinkStore, WorkspaceStore,
};
use serde::Deserialize;
use tauri::{Manager, State};

use super::execution_registry::ExecutionRegistry;
use super::onedrive::{OnedriveProvider, find_onedrive_account};
use super::remote_command::{RemoteCommandError, cancellable};
use super::version_control::VersionControlFiles;
use super::workspaces::{
    WORKSPACES_FOLDER_NAME, WorkspaceCommandError, WorkspaceDto, next_available_path,
    record_recent_in_order, workspace_to_dto,
};

/// Local folder name used when the remote one has nothing usable.
const FALLBACK_FOLDER_NAME: &str = "Workspace";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTeamWorkspaceInput {
    pub operation_id: String,
    pub account_id: String,
    pub drive_id: String,
    pub folder_id: String,
    /// Id for a new manifest when the team folder has none yet.
    pub id: String,
}

impl From<WorkspaceCommandError> for RemoteCommandError {
    fn from(error: WorkspaceCommandError) -> Self {
        match error {
            WorkspaceCommandError::Invalid { message } => Self::Invalid { message },
            WorkspaceCommandError::NotAWorkspace { message }
            | WorkspaceCommandError::Storage { message } => Self::Storage { message },
        }
    }
}

/// Opens a team workspace: a recent copy linked to the same folder when
/// there is one, otherwise a new local copy in the workspaces folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_onedrive_team_workspace(
    input: OpenTeamWorkspaceInput,
    app: tauri::AppHandle,
    registry: State<'_, ExecutionRegistry>,
    onedrive: State<'_, OnedriveProvider>,
    credentials: State<'_, KeyringCredentialStore>,
    files_view: State<'_, VersionControlFiles>,
    recent_store: State<'_, RecentWorkspacesStore>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<WorkspaceDto, RemoteCommandError> {
    let result: Result<WorkspaceDto, RemoteCommandError> = async {
        let account = find_onedrive_account(&onedrive.accounts, &input.account_id)?;
        let session = onedrive.client.session(&account, &*credentials);
        let workspaces_root = app
            .path()
            .document_dir()
            .map_err(|error| RemoteCommandError::Storage {
                message: error.to_string(),
            })?
            .join(WORKSPACES_FOLDER_NAME);

        cancellable(&registry, &input.operation_id, async {
            let folder = session.folder(&input.drive_id, &input.folder_id).await?;

            if let Some((root, workspace)) = linked_recent(&recent_store.load()?, &folder) {
                record_recent_in_order(&recent_store, root.clone(), workspace.name().to_string())
                    .await?;
                return Ok(workspace_to_dto(
                    &workspace,
                    root.to_string_lossy().to_string(),
                ));
            }

            let (root, name) =
                next_available_path(&workspaces_root, &local_folder_name(&folder.name))?;
            fs::create_dir_all(&root).map_err(|error| RemoteCommandError::Files {
                message: error.to_string(),
            })?;

            let created = async {
                let remote = session.repository(&folder.drive_id, &folder.id);
                // Environments travel only when someone already shares them.
                let include_environments =
                    remote.file_meta(ENVIRONMENTS_FILE).await?.sha256.is_some();
                let link = WorkspaceLink::onedrive(
                    account.id.clone(),
                    &folder.drive_id,
                    &folder.id,
                    folder.path.clone(),
                    include_environments,
                )?;
                let files = files_view.open(root.clone())?;
                let pulled = pull_changes(&files, &remote, &link).await?;
                WorkspaceLinkStore::new(root.clone()).save(&pulled.link)?;

                let workspace = load_or_create_manifest(&root, &input.id, &name)?;
                record_recent_in_order(&recent_store, root.clone(), workspace.name().to_string())
                    .await?;
                Ok(workspace_to_dto(
                    &workspace,
                    root.to_string_lossy().to_string(),
                ))
            }
            .await;
            if created.is_err() {
                // Leave no half-synced copy behind.
                let _ = fs::remove_dir_all(&root);
            }
            created
        })
        .await
    }
    .await;
    if result.is_ok() {
        usage.record(alcy_app::UsageEvent::WorkspaceOpened {
            kind: alcy_app::WorkspaceOpenKind::OnedriveTeam,
        });
    }
    crate::logging::logged("alcy::onedrive", "abrir workspace do time", result)
}

/// A recent workspace already linked to `folder`, still readable.
fn linked_recent(
    recents: &[RecentWorkspaceEntry],
    folder: &DriveFolder,
) -> Option<(PathBuf, Workspace)> {
    recents.iter().find_map(|entry| {
        let link = WorkspaceLinkStore::new(entry.root_path.clone())
            .load()
            .ok()
            .flatten()?;
        let same_folder = matches!(
            &link.location,
            RemoteLocation::Onedrive { drive_id, folder_id, .. }
                if *drive_id == folder.drive_id && *folder_id == folder.id
        );
        if !same_folder {
            return None;
        }
        let workspace = WorkspaceStore::new(entry.root_path.clone()).load().ok()?;
        Some((entry.root_path.clone(), workspace))
    })
}

/// The pulled manifest, or a new one named after the folder when the team
/// folder had none yet (it is pushed like any local change).
fn load_or_create_manifest(
    root: &Path,
    id: &str,
    name: &str,
) -> Result<Workspace, RemoteCommandError> {
    let store = WorkspaceStore::new(root.to_path_buf());
    match store.load() {
        Ok(workspace) => Ok(workspace),
        Err(StorageError::NotFound(_)) => {
            let workspace =
                Workspace::new(id, name).map_err(|error| RemoteCommandError::Invalid {
                    message: error.to_string(),
                })?;
            store.save(&workspace)?;
            Ok(workspace)
        }
        Err(error) => Err(error.into()),
    }
}

/// A SharePoint folder name made safe as a local folder name on every
/// platform.
fn local_folder_name(remote: &str) -> String {
    let cleaned: String = remote
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    if cleaned.is_empty() {
        FALLBACK_FOLDER_NAME.to_string()
    } else {
        cleaned.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("alcy-team-workspace-test-{nanos}-{count}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn folder(id: &str) -> DriveFolder {
        DriveFolder {
            drive_id: "b!team".into(),
            id: id.into(),
            name: "API".into(),
            path: "/Alcy/API".into(),
            child_count: None,
        }
    }

    #[test]
    fn local_names_drop_characters_other_systems_refuse() {
        assert_eq!(local_folder_name("API Pagamentos"), "API Pagamentos");
        assert_eq!(local_folder_name("a:b*c"), "a-b-c");
        assert_eq!(local_folder_name(" nome. "), "nome");
        assert_eq!(local_folder_name(" .. "), FALLBACK_FOLDER_NAME);
    }

    #[test]
    fn reuses_the_recent_copy_linked_to_the_same_folder() {
        let linked = temp_root();
        let other = temp_root();
        WorkspaceStore::new(linked.clone())
            .save(&Workspace::new("w1", "API").unwrap())
            .unwrap();
        WorkspaceLinkStore::new(linked.clone())
            .save(&WorkspaceLink::onedrive("a", "b!team", "F1", "/Alcy/API", false).unwrap())
            .unwrap();
        WorkspaceStore::new(other.clone())
            .save(&Workspace::new("w2", "Outro").unwrap())
            .unwrap();
        let recents = vec![
            RecentWorkspaceEntry {
                root_path: other.clone(),
                name: "Outro".into(),
            },
            RecentWorkspaceEntry {
                root_path: linked.clone(),
                name: "API".into(),
            },
        ];

        let (root, workspace) = linked_recent(&recents, &folder("F1")).unwrap();
        assert_eq!(root, linked);
        assert_eq!(workspace.id, "w1");
        assert!(linked_recent(&recents, &folder("F2")).is_none());

        let _ = fs::remove_dir_all(linked);
        let _ = fs::remove_dir_all(other);
    }

    #[test]
    fn creates_a_manifest_only_when_the_team_folder_has_none() {
        let root = temp_root();
        let created = load_or_create_manifest(&root, "new-id", "API").unwrap();
        assert_eq!(created.id, "new-id");
        assert_eq!(created.name(), "API");

        let again = load_or_create_manifest(&root, "other-id", "Outro").unwrap();
        assert_eq!(again.id, "new-id");
        let _ = fs::remove_dir_all(root);
    }
}
