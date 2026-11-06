//! Git in the workspace (ADR 0074): branches, merges, history, the shared
//! folder and the commit author. Status, commits and conflict resolution go
//! through the shared version control commands.

use std::path::{Path, PathBuf};

use alcy_app::structured_file_changes_from_content;
use alcy_domain::{GitIdentity, GitIdentitySettings, RemoteLocation, WorkspaceLink};
use alcy_git::{
    Applied, BlobHashCache, FolderKind, HistoryPage, Integration, MAX_HISTORY_PAGE, PeerState,
    SyncOutcome,
};
use alcy_storage::{GitIdentityStore, GitPeerStore, WorkspaceLinkStore};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::execution_registry::ExecutionRegistry;
use super::remote_command::{RemoteCommandError, cancellable};
use super::version_control::{
    StructuredFileChangesDto, VersionControlFiles, WorkspaceLinkDto, link_dto,
    structured_changes_dto,
};
use super::workspace_operation_coordinator::WorkspaceOperationCoordinator;

/// The commit author override, this installation's peer id and the blob
/// hashes already computed, managed together.
pub struct LocalGitProvider {
    pub identity: GitIdentityStore,
    pub peer: GitPeerStore,
    pub hashes: BlobHashCache,
}

impl LocalGitProvider {
    pub fn new(identity: GitIdentityStore, peer: GitPeerStore) -> Self {
        Self {
            identity,
            peer,
            hashes: BlobHashCache::default(),
        }
    }

    /// Author for the next commit: the Alcy override, field by field over the
    /// system's git config.
    pub fn identity(&self) -> Result<Option<GitIdentity>, RemoteCommandError> {
        let settings = self.identity.load()?;
        let system = alcy_git::system_identity();
        Ok(settings.resolve(system.name.as_deref(), system.email.as_deref()))
    }

    /// This installation's id in shared folders: readable name plus a random
    /// suffix, created once.
    fn peer_id(&self, identity: Option<&GitIdentity>) -> Result<String, RemoteCommandError> {
        Ok(self.peer.load_or_create(|| {
            let name = identity
                .map(|identity| identity.name.as_str())
                .unwrap_or("");
            format!("{}-{}", slug(name), random_suffix())
        })?)
    }
}

fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_end_matches('-').chars().take(24).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        "alcy".to_string()
    } else {
        slug
    }
}

/// Eight hex digits from the process-seeded std hasher and the clock: enough
/// to tell installations apart, no extra dependency.
fn random_suffix() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    hasher.write_u128(nanos);
    hasher.write_u32(std::process::id());
    format!("{:08x}", hasher.finish() as u32)
}

async fn blocking<T, F>(work: F) -> Result<T, RemoteCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, RemoteCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| RemoteCommandError::Files {
            message: error.to_string(),
        })?
}

fn git_link(root: &Path) -> Result<WorkspaceLink, RemoteCommandError> {
    let link = WorkspaceLinkStore::new(root.to_path_buf())
        .load()?
        .ok_or(RemoteCommandError::NotLinked)?;
    if !matches!(link.location, RemoteLocation::Git { .. }) {
        return Err(RemoteCommandError::Invalid {
            message: "the workspace does not use git".to_string(),
        });
    }
    Ok(link)
}

fn shared_folder(link: &WorkspaceLink) -> Result<PathBuf, RemoteCommandError> {
    match &link.location {
        RemoteLocation::Git {
            shared_folder: Some(folder),
        } => Ok(PathBuf::from(folder)),
        _ => Err(RemoteCommandError::Invalid {
            message: "no shared folder".to_string(),
        }),
    }
}

/// Saves the link a git operation changed and returns the files rewritten.
fn save_applied(root: &Path, applied: Applied) -> Result<Vec<String>, RemoteCommandError> {
    WorkspaceLinkStore::new(root.to_path_buf()).save(&applied.link)?;
    Ok(applied.files)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRootInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationInput {
    pub root_path: String,
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInput {
    pub root_path: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGitBranchInput {
    pub root_path: String,
    pub name: String,
    #[serde(default)]
    pub switch_to: bool,
}

/// Files a git operation rewrote on disk (the interface reloads them).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFilesDto {
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitMergeDto {
    pub label: String,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStateDto {
    pub branch: String,
    pub branches: Vec<String>,
    pub has_commits: bool,
    pub merge: Option<GitMergeDto>,
    pub shared_folder: Option<String>,
}

#[tauri::command]
pub async fn get_git_state(
    input: GitRootInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
) -> Result<GitStateDto, RemoteCommandError> {
    let root = PathBuf::from(input.root_path);
    let _guard = coordinator.read(&root).await;
    let result = blocking(move || {
        let link = git_link(&root)?;
        let state = alcy_git::git_state(&root)?;
        Ok(GitStateDto {
            branch: state.branch,
            branches: state.branches,
            has_commits: state.has_commits,
            merge: state.merge.map(|merge| GitMergeDto {
                label: merge.label,
                conflicts: merge.conflicts,
            }),
            shared_folder: match link.location {
                RemoteLocation::Git { shared_folder } => shared_folder,
                _ => None,
            },
        })
    })
    .await;
    crate::logging::logged("alcy::vc", "ler estado git", result)
}

#[tauri::command]
pub async fn create_git_branch(
    input: CreateGitBranchInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
) -> Result<GitFilesDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let result = blocking(move || {
        let name = input.name.trim().to_string();
        alcy_git::create_branch(&root, &name)?;
        if !input.switch_to {
            return Ok(GitFilesDto { files: Vec::new() });
        }
        let link = git_link(&root)?;
        let applied = alcy_git::checkout(&root, &files, &link, &name)?;
        Ok(GitFilesDto {
            files: save_applied(&root, applied)?,
        })
    })
    .await;
    crate::logging::logged("alcy::vc", "criar branch git", result)
}

#[tauri::command]
pub async fn switch_git_branch(
    input: GitBranchInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
) -> Result<GitFilesDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let result = blocking(move || {
        let link = git_link(&root)?;
        let applied = alcy_git::checkout(&root, &files, &link, &input.name)?;
        Ok(GitFilesDto {
            files: save_applied(&root, applied)?,
        })
    })
    .await;
    crate::logging::logged("alcy::vc", "trocar branch git", result)
}

#[tauri::command]
pub async fn delete_git_branch(
    input: GitBranchInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
) -> Result<(), RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let result = blocking(move || Ok(alcy_git::delete_branch(&root, &input.name)?)).await;
    crate::logging::logged("alcy::vc", "excluir branch git", result)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitMergeResultDto {
    /// `upToDate`, `fastForward`, `merged` or `conflicts`.
    pub outcome: String,
    pub conflicts: Vec<String>,
    pub files: Vec<String>,
}

fn merge_result(integration: Integration, files: Vec<String>) -> GitMergeResultDto {
    let (outcome, conflicts) = match integration {
        Integration::UpToDate => ("upToDate", Vec::new()),
        Integration::FastForward => ("fastForward", Vec::new()),
        Integration::Merged => ("merged", Vec::new()),
        Integration::Conflicts(conflicts) => ("conflicts", conflicts),
    };
    GitMergeResultDto {
        outcome: outcome.to_string(),
        conflicts,
        files,
    }
}

#[tauri::command]
pub async fn merge_git_branch(
    input: GitBranchInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    git: State<'_, LocalGitProvider>,
) -> Result<GitMergeResultDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let identity = git.identity()?;
    let result = blocking(move || {
        let link = git_link(&root)?;
        let (integration, applied) =
            alcy_git::merge_branch(&root, &files, &link, identity.as_ref(), &input.name)?;
        let files = save_applied(&root, applied)?;
        Ok(merge_result(integration, files))
    })
    .await;
    crate::logging::logged("alcy::vc", "mesclar branch git", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishGitMergeInput {
    pub root_path: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResultDto {
    pub commit_id: String,
}

#[tauri::command]
pub async fn finish_git_merge(
    input: FinishGitMergeInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    git: State<'_, LocalGitProvider>,
) -> Result<GitCommitResultDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let identity = git.identity()?;
    let result = blocking(move || {
        let link = git_link(&root)?;
        let (commit_id, applied) =
            alcy_git::finish_merge(&root, &files, &link, identity.as_ref(), &input.message)?;
        save_applied(&root, applied)?;
        Ok(GitCommitResultDto { commit_id })
    })
    .await;
    crate::logging::logged("alcy::vc", "concluir mesclagem git", result)
}

#[tauri::command]
pub async fn abort_git_merge(
    input: GitRootInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
) -> Result<GitFilesDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let result = blocking(move || {
        let link = git_link(&root)?;
        let applied = alcy_git::abort_merge(&root, &files, &link)?;
        Ok(GitFilesDto {
            files: save_applied(&root, applied)?,
        })
    })
    .await;
    crate::logging::logged("alcy::vc", "cancelar mesclagem git", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryInput {
    pub root_path: String,
    pub operation_id: String,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDto {
    pub id: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
    pub summary: String,
    pub files: Vec<String>,
    pub merge: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryDto {
    pub commits: Vec<GitCommitDto>,
    pub next_offset: Option<usize>,
}

fn history_dto(page: HistoryPage) -> GitHistoryDto {
    GitHistoryDto {
        commits: page
            .commits
            .into_iter()
            .map(|commit| GitCommitDto {
                id: commit.id,
                author_name: commit.author_name,
                author_email: commit.author_email,
                time: commit.time,
                summary: commit.summary,
                files: commit.files,
                merge: commit.merge,
            })
            .collect(),
        next_offset: page.next_offset,
    }
}

/// One page of the current branch's history, newest first.
#[tauri::command]
pub async fn get_git_history(
    input: GitHistoryInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    registry: State<'_, ExecutionRegistry>,
) -> Result<GitHistoryDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.read(&root).await;
    let offset = input.offset;
    let result = cancellable(&registry, &input.operation_id, async move {
        blocking(move || {
            git_link(&root)?;
            Ok(history_dto(alcy_git::history(
                &root,
                offset,
                MAX_HISTORY_PAGE,
            )?))
        })
        .await
    })
    .await;
    crate::logging::logged("alcy::vc", "ler histórico git", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileInput {
    pub root_path: String,
    pub commit: String,
    pub file_name: String,
}

/// What a commit changed in one file, per item (local = the commit, remote =
/// its first parent).
#[tauri::command]
pub async fn get_git_commit_changes(
    input: GitCommitFileInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
) -> Result<StructuredFileChangesDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.read(&root).await;
    let result = blocking(move || {
        let link = git_link(&root)?;
        if !link.tracked_files().contains(&input.file_name.as_str()) {
            return Err(RemoteCommandError::Invalid {
                message: format!("{} is not versioned", input.file_name),
            });
        }
        let versions = alcy_git::file_versions(&root, &input.commit, &input.file_name)?;
        let changes = structured_file_changes_from_content(
            &input.file_name,
            versions.at_commit,
            versions.before,
        )?;
        Ok(structured_changes_dto(&changes, 0, 200))
    })
    .await;
    crate::logging::logged("alcy::vc", "ler alterações do commit", result)
}

#[tauri::command]
pub async fn restore_git_file(
    input: GitCommitFileInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
) -> Result<GitFilesDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let result = blocking(move || {
        let link = git_link(&root)?;
        if !link.tracked_files().contains(&input.file_name.as_str()) {
            return Err(RemoteCommandError::Invalid {
                message: format!("{} is not versioned", input.file_name),
            });
        }
        alcy_git::restore_file(&root, &files, &input.commit, &input.file_name)?;
        Ok(GitFilesDto {
            files: vec![input.file_name],
        })
    })
    .await;
    crate::logging::logged("alcy::vc", "restaurar arquivo do commit", result)
}

/// Accepts an empty folder (a bare repository is created) or one already
/// holding a bare repository.
pub(super) fn prepare_shared_folder(folder: &Path) -> Result<(), RemoteCommandError> {
    match alcy_git::inspect_folder(folder)? {
        FolderKind::Empty => Ok(alcy_git::init_bare(folder, "main")?),
        FolderKind::Bare { .. } => Ok(()),
        FolderKind::NonBare => Err(RemoteCommandError::GitNotBare),
        FolderKind::NotARepository => Err(RemoteCommandError::GitNotRepository),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGitSharedFolderInput {
    pub root_path: String,
    /// `None` stops sharing (the folder is left as it is).
    pub folder: Option<String>,
}

#[tauri::command]
pub async fn set_git_shared_folder(
    input: SetGitSharedFolderInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
) -> Result<WorkspaceLinkDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let result = blocking(move || {
        let mut link = git_link(&root)?;
        let folder = alcy_domain::normalize_shared_folder(input.folder.as_deref())?;
        if let Some(folder) = &folder {
            prepare_shared_folder(Path::new(folder))?;
        }
        link.location = RemoteLocation::Git {
            shared_folder: folder,
        };
        WorkspaceLinkStore::new(root).save(&link)?;
        Ok(link_dto(&link))
    })
    .await;
    crate::logging::logged("alcy::vc", "definir pasta compartilhada git", result)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitPeerDto {
    pub peer: String,
    pub name: String,
    pub time: i64,
    /// `upToDate`, `incoming` or `syncing`.
    pub state: String,
}

fn peer_state_name(state: PeerState) -> &'static str {
    match state {
        PeerState::UpToDate => "upToDate",
        PeerState::Incoming => "incoming",
        PeerState::Syncing => "syncing",
    }
}

/// Everyone else publishing the current branch in the shared folder.
#[tauri::command]
pub async fn get_git_peers(
    input: GitOperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    registry: State<'_, ExecutionRegistry>,
    git: State<'_, LocalGitProvider>,
) -> Result<Vec<GitPeerDto>, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.read(&root).await;
    let identity = git.identity()?;
    let me = git.peer_id(identity.as_ref())?;
    let result = cancellable(&registry, &input.operation_id, async move {
        blocking(move || {
            let shared = shared_folder(&git_link(&root)?)?;
            Ok(alcy_git::peer_statuses(&root, &shared, &me)?
                .into_iter()
                .map(|peer| GitPeerDto {
                    peer: peer.peer,
                    name: peer.name,
                    time: peer.time,
                    state: peer_state_name(peer.state).to_string(),
                })
                .collect())
        })
        .await
    })
    .await;
    crate::logging::logged("alcy::vc", "ler pessoas da pasta compartilhada", result)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncDto {
    pub published: bool,
    pub integrated: Vec<String>,
    pub syncing: Vec<String>,
    pub merge: Option<GitMergeDto>,
    pub files: Vec<String>,
}

fn sync_dto(outcome: SyncOutcome) -> GitSyncDto {
    GitSyncDto {
        published: outcome.published,
        integrated: outcome.integrated,
        syncing: outcome.syncing,
        merge: outcome
            .merging
            .map(|(label, conflicts)| GitMergeDto { label, conflicts }),
        files: outcome.files,
    }
}

/// Publishes this person's branch and integrates everyone else's.
#[tauri::command]
pub async fn sync_git_shared_folder(
    input: GitOperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    git: State<'_, LocalGitProvider>,
) -> Result<GitSyncDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let identity = git.identity()?;
    let me = git.peer_id(identity.as_ref())?;
    let result = cancellable(&registry, &input.operation_id, async move {
        blocking(move || {
            let link = git_link(&root)?;
            let shared = shared_folder(&link)?;
            let outcome = alcy_git::sync(&root, &files, &link, identity.as_ref(), &shared, &me)?;
            WorkspaceLinkStore::new(root).save(&outcome.link)?;
            Ok(sync_dto(outcome))
        })
        .await
    })
    .await;
    crate::logging::logged("alcy::vc", "sincronizar pasta compartilhada", result)
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityFieldsDto {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityDto {
    /// `user.name`/`user.email` from the system's git config.
    pub system: GitIdentityFieldsDto,
    /// Values set in Alcy (blank = use the system's).
    pub overrides: GitIdentityFieldsDto,
    /// Author of the next commit; `None` while name or e-mail is unknown.
    pub effective: Option<GitIdentityFieldsDto>,
}

fn identity_dto(settings: GitIdentitySettings) -> GitIdentityDto {
    let system = alcy_git::system_identity();
    let effective = settings
        .resolve(system.name.as_deref(), system.email.as_deref())
        .map(|identity| GitIdentityFieldsDto {
            name: Some(identity.name),
            email: Some(identity.email),
        });
    GitIdentityDto {
        system: GitIdentityFieldsDto {
            name: system.name,
            email: system.email,
        },
        overrides: GitIdentityFieldsDto {
            name: settings.name,
            email: settings.email,
        },
        effective,
    }
}

#[tauri::command]
pub async fn get_git_identity(
    git: State<'_, LocalGitProvider>,
) -> Result<GitIdentityDto, RemoteCommandError> {
    let result = git
        .identity
        .load()
        .map(identity_dto)
        .map_err(RemoteCommandError::from);
    crate::logging::logged("alcy::settings", "ler usuário git", result)
}

#[tauri::command]
pub async fn save_git_identity(
    input: GitIdentityFieldsDto,
    git: State<'_, LocalGitProvider>,
) -> Result<GitIdentityDto, RemoteCommandError> {
    let result: Result<GitIdentityDto, RemoteCommandError> = (|| {
        let settings = GitIdentitySettings::new(input.name.as_deref(), input.email.as_deref())?;
        git.identity.save(&settings)?;
        Ok(identity_dto(settings))
    })();
    crate::logging::logged("alcy::settings", "salvar usuário git", result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_ids_are_readable_ref_components() {
        assert_eq!(slug("Ana Lima"), "ana-lima");
        assert_eq!(slug("  João!! "), "jo-o");
        assert_eq!(slug(""), "alcy");
        assert_eq!(slug("---"), "alcy");
        assert!(slug(&"x".repeat(80)).len() <= 24);
        let suffix = random_suffix();
        assert_eq!(suffix.len(), 8);
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn shared_folders_must_be_empty_or_bare() {
        let empty = tempfile::tempdir().unwrap();
        prepare_shared_folder(empty.path()).unwrap();
        assert!(empty.path().join("HEAD").is_file());
        prepare_shared_folder(empty.path()).unwrap();

        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("a.txt"), "x").unwrap();
        assert_eq!(
            prepare_shared_folder(other.path()),
            Err(RemoteCommandError::GitNotRepository)
        );
        let worktree = tempfile::tempdir().unwrap();
        std::fs::create_dir(worktree.path().join(".git")).unwrap();
        assert_eq!(
            prepare_shared_folder(worktree.path()),
            Err(RemoteCommandError::GitNotBare)
        );
    }

    #[test]
    fn results_serialize_camel_case() {
        assert_eq!(
            serde_json::to_value(merge_result(
                Integration::Conflicts(vec!["alcy-collections.json".into()]),
                vec![]
            ))
            .unwrap(),
            serde_json::json!({
                "outcome": "conflicts",
                "conflicts": ["alcy-collections.json"],
                "files": []
            })
        );
        let dto =
            identity_dto(GitIdentitySettings::new(Some("Ana"), Some("ana@example.com")).unwrap());
        assert_eq!(
            dto.effective,
            Some(GitIdentityFieldsDto {
                name: Some("Ana".into()),
                email: Some("ana@example.com".into()),
            })
        );
    }
}
