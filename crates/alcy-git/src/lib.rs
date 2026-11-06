//! Git in the workspace folder, shared through a folder with one branch per
//! person (ADR 0074).
//!
//! The repository lives at `<workspace>/.git`. Alcy builds commits from its
//! own view of the workspace files and serves the committed state as the
//! `RemoteRepository` of the provider-neutral sync use cases. Sharing goes
//! through a bare repository in a folder (network share or a folder synced by
//! OneDrive, Dropbox…): every installation writes only its own refs, so no
//! file is ever written by two machines.

mod folder;
mod history;
mod identity;
mod merge_state;
mod objects;
mod remote;
mod repo;
mod shared;
mod workspace;

pub use folder::{FolderKind, init_bare, inspect_folder};
pub use history::{
    CommitSummary, FileVersions, HistoryPage, MAX_HISTORY_PAGE, file_versions, history,
};
pub use identity::{SystemIdentity, system_identity};
pub use remote::{BlobHashCache, WorkspaceRemote};
pub use repo::{GitState, MergeInfo, git_state, init_workspace, write_gitignore};
pub use shared::{PeerState, PeerStatus, peer_statuses, publish};
pub use workspace::{
    Applied, Integration, SyncOutcome, abort_merge, checkout, create_branch, delete_branch,
    finish_merge, merge_branch, restore_file, sync,
};

use std::path::Path;

use alcy_app::RemoteError;
use thiserror::Error;

/// Failure of a git operation on the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GitError {
    #[error(transparent)]
    Remote(#[from] RemoteError),
    #[error("failed to access workspace files: {0}")]
    Files(String),
    #[error("git user not configured")]
    IdentityMissing,
    /// Files the operation would overwrite have uncommitted changes.
    #[error("uncommitted changes in {0:?}")]
    UncommittedChanges(Vec<String>),
    #[error("a merge is in progress")]
    MergeInProgress,
    #[error("no merge in progress")]
    NoMergeInProgress,
    /// Conflicts of the pending merge that are still unresolved.
    #[error("unresolved conflicts in {0:?}")]
    Conflicts(Vec<String>),
    #[error("invalid branch: {0}")]
    InvalidBranch(String),
    #[error("the folder holds a git repository with a working tree")]
    NotBare,
    #[error("the folder has other files and is not a git repository")]
    NotARepository,
}

fn rejected(error: impl std::fmt::Display) -> RemoteError {
    RemoteError::Rejected(error.to_string())
}

fn unavailable(path: &Path) -> RemoteError {
    RemoteError::Network(format!("folder unavailable: {}", path.display()))
}

/// Opens without the user's or system's git configuration: behavior must not
/// depend on settings meant for the git CLI. Commits carry their author
/// explicitly; the fallback identity only signs reflog entries, which git
/// writes in non-bare repositories.
fn open_options() -> gix::open::Options {
    gix::open::Options::isolated().config_overrides(["user.name=Alcy", "user.email=alcy@localhost"])
}

/// The bare repository in a shared folder.
fn open_bare(path: &Path) -> Result<gix::Repository, RemoteError> {
    if !path.is_dir() {
        return Err(unavailable(path));
    }
    let repo = gix::open_opts(path, open_options()).map_err(rejected)?;
    if !repo.is_bare() {
        return Err(rejected(
            "the shared folder holds a repository with a working tree",
        ));
    }
    Ok(repo)
}

/// The repository whose working tree is the workspace folder.
fn open_workspace(root: &Path) -> Result<gix::Repository, RemoteError> {
    if !root.join(".git").is_dir() {
        return Err(RemoteError::NotFound(format!(
            "no git repository in {}",
            root.display()
        )));
    }
    gix::open_opts(root, open_options()).map_err(rejected)
}

fn branch_ref(branch: &str) -> Result<gix::refs::FullName, RemoteError> {
    gix::refs::FullName::try_from(format!("refs/heads/{branch}")).map_err(rejected)
}

/// Commit a reference points to; `None` while it does not exist.
fn ref_target(
    repo: &gix::Repository,
    name: &gix::refs::FullName,
) -> Result<Option<gix::ObjectId>, RemoteError> {
    let Some(mut reference) = repo.try_find_reference(name.as_ref()).map_err(rejected)? else {
        return Ok(None);
    };
    let id = reference.peel_to_id().map_err(rejected)?;
    Ok(Some(id.detach()))
}

/// Runs git work off the async runtime (invariant 7).
async fn blocking<T, F>(work: F) -> Result<T, RemoteError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, RemoteError> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| RemoteError::Rejected(error.to_string()))?
}
