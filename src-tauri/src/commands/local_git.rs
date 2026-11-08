//! Git in the workspace (ADR 0074): branches, merges, history, the `origin`
//! remote (fetch, pull, push, clone) and the commit author. Status, commits
//! and conflict resolution go through the shared version control commands.

use std::path::{Path, PathBuf};

use alcy_app::{structured_file_changes_from_content, version_status};
use alcy_domain::{GitIdentity, GitIdentitySettings, WorkspaceLink};
use alcy_git::{
    Applied, BlobHashCache, HistoryPage, Integration, MAX_HISTORY_PAGE, Tracking, WorkspaceRemote,
};
use alcy_storage::{GitIdentityStore, RecentWorkspacesStore, WorkspaceLinkStore, WorkspaceStore};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use super::execution_registry::ExecutionRegistry;
use super::remote_command::{RemoteCommandError, cancellable};
use super::version_control::{
    DEFAULT_GIT_BRANCH, StructuredFileChangesDto, VersionControlFiles, structured_changes_dto,
};
use super::workspace_operation_coordinator::WorkspaceOperationCoordinator;
use super::workspaces::{
    WORKSPACES_FOLDER_NAME, WorkspaceDto, next_available_path, record_recent_in_order,
    workspace_to_dto,
};

/// The commit author override and the blob hashes already computed,
/// managed together.
pub struct LocalGitProvider {
    pub identity: GitIdentityStore,
    pub hashes: BlobHashCache,
}

impl LocalGitProvider {
    pub fn new(identity: GitIdentityStore) -> Self {
        Self {
            identity,
            hashes: BlobHashCache::default(),
        }
    }

    /// The repository in `root`, signing commits with the current author.
    pub fn remote(&self, root: &Path) -> Result<WorkspaceRemote, RemoteCommandError> {
        Ok(WorkspaceRemote::new(
            root.to_path_buf(),
            self.identity()?,
            self.hashes.clone(),
        ))
    }

    /// Commits need an author, set in Alcy or in the system's git config.
    pub fn require_identity(&self) -> Result<(), RemoteCommandError> {
        self.identity()?
            .map(|_| ())
            .ok_or(RemoteCommandError::GitIdentityMissing)
    }

    /// Author for the next commit: the Alcy override, field by field over the
    /// system's git config.
    pub fn identity(&self) -> Result<Option<GitIdentity>, RemoteCommandError> {
        let settings = self.identity.load()?;
        let system = alcy_git::system_identity();
        Ok(settings.resolve(system.name.as_deref(), system.email.as_deref()))
    }
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
    Ok(link)
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
pub struct GitTrackingDto {
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStateDto {
    pub branch: String,
    pub branches: Vec<String>,
    pub has_commits: bool,
    pub merge: Option<GitMergeDto>,
    /// URL of `origin`.
    pub remote: Option<String>,
    /// Against `origin/<branch>` as of the last fetch; `None` while that
    /// branch does not exist there.
    pub tracking: Option<GitTrackingDto>,
}

#[tauri::command]
pub async fn get_git_state(
    input: GitRootInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
) -> Result<GitStateDto, RemoteCommandError> {
    let root = PathBuf::from(input.root_path);
    let _guard = coordinator.read(&root).await;
    let result = blocking(move || {
        git_link(&root)?;
        let state = alcy_git::git_state(&root)?;
        Ok(GitStateDto {
            branch: state.branch,
            branches: state.branches,
            has_commits: state.has_commits,
            merge: state.merge.map(|merge| GitMergeDto {
                label: merge.label,
                conflicts: merge.conflicts,
            }),
            remote: state.remote,
            tracking: state
                .tracking
                .map(|Tracking { ahead, behind }| GitTrackingDto { ahead, behind }),
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
    /// First parent first; more than one is a merge.
    pub parents: Vec<String>,
    /// Local and `origin/…` branches pointing at this commit.
    pub refs: Vec<String>,
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
                parents: commit.parents,
                refs: commit.refs,
            })
            .collect(),
        next_offset: page.next_offset,
    }
}

/// One page of the current branch's history and its upstream, newest first.
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGitRemoteInput {
    pub root_path: String,
    /// `None` (or blank) removes `origin`.
    pub url: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteDto {
    pub url: Option<String>,
}

/// Adds, changes or removes `origin`, in the repository's own configuration.
#[tauri::command]
pub async fn set_git_remote(
    input: SetGitRemoteInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
) -> Result<GitRemoteDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let result = async {
        git_link(&root)?;
        let url = alcy_git::set_remote(&root, input.url.as_deref()).await?;
        Ok(GitRemoteDto { url })
    }
    .await;
    crate::logging::logged("alcy::vc", "definir remote git", result)
}

/// Downloads what `origin` has, without touching the workspace files.
#[tauri::command]
pub async fn fetch_git_remote(
    input: GitOperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    registry: State<'_, ExecutionRegistry>,
) -> Result<(), RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let result = cancellable(&registry, &input.operation_id, async {
        git_link(&root)?;
        Ok(alcy_git::fetch(&root).await?)
    })
    .await;
    crate::logging::logged("alcy::vc", "buscar remote git", result)
}

/// Fetches and merges `origin/<branch>` into the current branch.
#[tauri::command]
pub async fn pull_git_remote(
    input: GitOperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    git: State<'_, LocalGitProvider>,
) -> Result<GitMergeResultDto, RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let files = files_view.open(root.clone())?;
    let identity = git.identity()?;
    let result = cancellable(&registry, &input.operation_id, async {
        git_link(&root)?;
        alcy_git::fetch(&root).await?;
        let root = root.clone();
        blocking(move || {
            let link = git_link(&root)?;
            let (integration, applied) =
                alcy_git::merge_upstream(&root, &files, &link, identity.as_ref())?;
            let files = save_applied(&root, applied)?;
            Ok(merge_result(integration, files))
        })
        .await
    })
    .await;
    crate::logging::logged("alcy::vc", "pull do remote git", result)
}

/// Sends the current branch to `origin`.
#[tauri::command]
pub async fn push_git_remote(
    input: GitOperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    registry: State<'_, ExecutionRegistry>,
) -> Result<(), RemoteCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _guard = coordinator.write(&root).await;
    let result = cancellable(&registry, &input.operation_id, async {
        git_link(&root)?;
        Ok(alcy_git::push(&root).await?)
    })
    .await;
    crate::logging::logged("alcy::vc", "push para o remote git", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneGitWorkspaceInput {
    pub operation_id: String,
    pub url: String,
}

/// Local folder name used when the repository's has nothing usable.
const FALLBACK_FOLDER_NAME: &str = "Workspace";

/// A repository name made safe as a local folder name on every platform.
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

/// Folder name for a clone: the repository's name, without `.git`.
fn repository_name(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\', ':']).next().unwrap_or(trimmed);
    local_folder_name(last.strip_suffix(".git").unwrap_or(last))
}

/// Clones a repository holding an Alcy workspace into a new folder of the
/// workspaces folder, named after the repository, links it to git and opens
/// it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn clone_git_workspace(
    input: CloneGitWorkspaceInput,
    app: tauri::AppHandle,
    registry: State<'_, ExecutionRegistry>,
    files_view: State<'_, VersionControlFiles>,
    recent_store: State<'_, RecentWorkspacesStore>,
    git: State<'_, LocalGitProvider>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<WorkspaceDto, RemoteCommandError> {
    let result: Result<WorkspaceDto, RemoteCommandError> = async {
        let url = alcy_git::validate_remote_url(&input.url)?;
        let workspaces = app
            .path()
            .document_dir()
            .map_err(|error| RemoteCommandError::Storage {
                message: error.to_string(),
            })?
            .join(WORKSPACES_FOLDER_NAME);
        std::fs::create_dir_all(&workspaces).map_err(|error| RemoteCommandError::Files {
            message: error.to_string(),
        })?;
        let root = next_available_path(&workspaces, &repository_name(&url))?.0;
        let created = cancellable(&registry, &input.operation_id, async {
            alcy_git::clone(&url, &root).await?;
            let link_root = root.clone();
            let link = blocking(move || {
                let link = WorkspaceLink::new(alcy_git::versions_environments(&link_root)?);
                alcy_git::init_workspace(&link_root, DEFAULT_GIT_BRANCH, &link.tracked_files())?;
                Ok(link)
            })
            .await?;
            // Files equal to the cloned commit start as synced.
            let files = files_view.open(root.clone())?;
            let remote = WorkspaceRemote::new(root.clone(), None, git.hashes.clone());
            let status = version_status(&files, &remote, &link).await?;
            WorkspaceLinkStore::new(root.clone()).save(&status.link)?;
            let workspace = WorkspaceStore::new(root.clone()).load()?;
            record_recent_in_order(&recent_store, root.clone(), workspace.name().to_string())
                .await?;
            Ok(workspace_to_dto(
                &workspace,
                root.to_string_lossy().to_string(),
            ))
        })
        .await;
        // A cancelled or failed clone leaves nothing behind, unless the
        // folder appeared meanwhile and clone refused to touch it.
        if created.is_err() && !matches!(created, Err(RemoteCommandError::GitDestinationExists)) {
            let _ = alcy_git::discard_clone(&root);
        }
        created
    }
    .await;
    if result.is_ok() {
        usage.record(alcy_app::UsageEvent::WorkspaceOpened {
            kind: alcy_app::WorkspaceOpenKind::Opened,
        });
    }
    crate::logging::logged("alcy::vc", "clonar workspace git", result)
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
    fn clones_are_named_after_the_repository() {
        assert_eq!(repository_name("https://example.com/team/api.git"), "api");
        assert_eq!(repository_name("git@example.com:team/api.git/"), "api");
        assert_eq!(repository_name("git@example.com:api"), "api");
        assert_eq!(repository_name(r"C:\repos\Team API.git"), "Team API");
        assert_eq!(repository_name("/srv/git/"), "git");
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
