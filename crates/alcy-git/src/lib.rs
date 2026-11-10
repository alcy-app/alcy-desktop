//! Git in the workspace folder, as in any git repository (ADR 0074).
//!
//! The repository lives at `<workspace>/.git`. Alcy builds commits from its
//! own view of the workspace files and serves the committed state as the
//! `RemoteRepository` of the provider-neutral sync use cases. Local work
//! (commits, branches, merges, history) runs in-process with `gix`; talking
//! to the `origin` remote (clone, fetch, push) runs the system's git.

mod cli;
mod history;
mod identity;
mod merge_state;
mod ownership;
mod remote;
mod remotes;
mod repo;
mod workspace;

pub use cli::validate_remote_url;
pub use history::{
    CommitSummary, FileVersions, HistoryPage, MAX_HISTORY_PAGE, file_versions, history,
};
pub use identity::{SystemIdentity, system_identity};
pub use ownership::{FileDeletion, RepositoryOwner, file_deletion};
pub use remote::{BlobHashCache, WorkspaceRemote};
pub use remotes::{
    REMOTE, Tracking, can_clone_as_remote, clone, clone_folder, discard_clone, fetch,
    merge_upstream, push, remote_url, set_remote, trust_folder, versions_environments,
};
pub use repo::{GitState, MergeInfo, git_state, init_workspace, write_gitignore};
pub use workspace::{
    Applied, Integration, abort_merge, checkout, create_branch, delete_branch, finish_merge,
    merge_branch, restore_file,
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
    #[error("invalid remote: {0}")]
    InvalidRemote(String),
    #[error("no remote configured")]
    NoRemote,
    /// The `git` program is not installed (or not on `PATH`).
    #[error("git is not installed")]
    GitMissing,
    /// The remote refused the credentials, or none were available.
    #[error("authentication failed: {0}")]
    Auth(String),
    /// The remote has commits the branch lacks.
    #[error("push rejected: pull first")]
    PushRejected,
    /// Any other failure reported by git.
    #[error("git failed: {0}")]
    Command(String),
    #[error("the destination folder already exists")]
    DestinationExists,
    /// The cloned repository holds no Alcy workspace.
    #[error("the repository has no Alcy workspace")]
    NotAWorkspace,
    /// Git refuses a folder owned by someone else until it is trusted; holds
    /// the value `safe.directory` needs.
    #[error("git does not trust the folder {0}")]
    UntrustedFolder(String),
    /// The folder `origin` points to would have its working files overwritten
    /// by the push, or does not accept pushes to its current branch.
    #[error("the remote folder refused the push")]
    RemoteFolderBusy,
}

fn rejected(error: impl std::fmt::Display) -> RemoteError {
    RemoteError::Rejected(error.to_string())
}

/// Opens without the user's or system's git configuration: behavior must not
/// depend on settings meant for the git CLI. Commits carry their author
/// explicitly; the fallback identity only signs reflog entries, which git
/// writes in non-bare repositories.
fn open_options() -> gix::open::Options {
    gix::open::Options::isolated().config_overrides(["user.name=Alcy", "user.email=alcy@localhost"])
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
