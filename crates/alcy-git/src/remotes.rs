//! The `origin` remote, as in any git repository: its URL lives in
//! `.git/config`, fetch and push go through the system's git, and pulling
//! merges `origin/<branch>` into the current branch with Alcy's per-item
//! merge. Where the remote lives (a server, a network share, a folder synced
//! by a cloud drive) is the person's choice; Alcy treats every URL alike.

use std::ffi::OsString;
use std::path::Path;

use alcy_app::WorkspaceFiles;
use alcy_domain::{ENVIRONMENTS_FILE, GitIdentity, MANIFEST_FILE, WorkspaceLink};
use gix::ObjectId;
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit};
use gix::refs::{FullName, Target};

use crate::cli::{git, validate_remote_url, validate_trusted_folder};
use crate::ownership::CLONED_COPY_KEY;
use crate::repo::{blob_at, commit_tree, head, short_name};
use crate::workspace::{Applied, Incoming, Integration, ensure_no_merge, integrate, is_fresh};
use crate::{GitError, open_workspace, ref_target, rejected};

/// The one remote Alcy manages.
pub const REMOTE: &str = "origin";

/// Makes git write working files byte for byte as committed. Alcy compares
/// the files with the commit byte for byte, so a conversion such as
/// `core.autocrlf=true` (Git for Windows' default) would make every file of a
/// fresh clone look changed on both sides.
const LINE_ENDINGS: [(&str, &str); 2] = [("core.autocrlf", "false"), ("core.eol", "lf")];

fn args<const N: usize>(values: [&str; N]) -> Vec<OsString> {
    values.into_iter().map(OsString::from).collect()
}

/// URL of `origin`, read from the repository's configuration.
pub fn remote_url(root: &Path) -> Result<Option<String>, GitError> {
    let repo = open_workspace(root)?;
    Ok(remote_url_of(&repo))
}

fn remote_url_of(repo: &gix::Repository) -> Option<String> {
    repo.config_snapshot()
        .string(format!("remote.{REMOTE}.url").as_str())
        .map(|url| url.to_string())
        .filter(|url| !url.trim().is_empty())
}

/// Adds, changes or (with `None`) removes `origin`.
pub async fn set_remote(root: &Path, url: Option<&str>) -> Result<Option<String>, GitError> {
    let current = remote_url(root)?;
    let url = url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(validate_remote_url)
        .transpose()?;
    match (&current, &url) {
        (None, None) => {}
        (Some(_), None) => {
            git(Some(root), &args(["remote", "remove", REMOTE])).await?;
        }
        (None, Some(url)) => {
            git(Some(root), &args(["remote", "add", REMOTE, url])).await?;
        }
        (Some(current), Some(url)) if current == url => {}
        (Some(_), Some(url)) => {
            git(Some(root), &args(["remote", "set-url", REMOTE, url])).await?;
        }
    }
    Ok(url)
}

fn require_remote(root: &Path) -> Result<(), GitError> {
    match remote_url(root)? {
        Some(_) => Ok(()),
        None => Err(GitError::NoRemote),
    }
}

/// Downloads what `origin` has. While the current branch has no commits,
/// also asks `origin` for its default branch, so a first pull can follow it.
pub async fn fetch(root: &Path) -> Result<(), GitError> {
    require_remote(root)?;
    git(Some(root), &args(["fetch", "--prune", REMOTE])).await?;
    // `gix::Repository` is not `Send`: it must not live across an await.
    let unborn = head(&open_workspace(root)?)?.1.is_none();
    if unborn {
        // An empty remote has no default branch: nothing to follow.
        let _ = git(Some(root), &args(["remote", "set-head", REMOTE, "--auto"])).await;
    }
    Ok(())
}

/// Sends the current branch to the branch of the same name on `origin` and
/// makes it the upstream. Rejected when `origin` has commits this branch
/// lacks: pull first.
pub async fn push(root: &Path) -> Result<(), GitError> {
    require_remote(root)?;
    let branch = {
        let repo = open_workspace(root)?;
        let (name, local) = head(&repo)?;
        if local.is_none() {
            return Err(rejected("commit before pushing").into());
        }
        short_name(&name)
    };
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    git(
        Some(root),
        &args(["push", "--porcelain", "--set-upstream", REMOTE, &refspec]),
    )
    .await?;
    Ok(())
}

pub(crate) fn remote_branch_ref(branch: &str) -> Result<FullName, GitError> {
    FullName::try_from(format!("refs/remotes/{REMOTE}/{branch}"))
        .map_err(|error| rejected(error).into())
}

/// Branch `origin/HEAD` names, as `fetch` recorded it.
fn remote_default_branch(repo: &gix::Repository) -> Result<Option<String>, GitError> {
    let name = FullName::try_from(format!("refs/remotes/{REMOTE}/HEAD")).map_err(rejected)?;
    let Some(reference) = repo.try_find_reference(name.as_ref()).map_err(rejected)? else {
        return Ok(None);
    };
    let prefix = format!("refs/remotes/{REMOTE}/");
    Ok(match reference.target() {
        gix::refs::TargetRef::Symbolic(target) => target
            .as_bstr()
            .to_string()
            .strip_prefix(&prefix)
            .map(str::to_string),
        gix::refs::TargetRef::Object(_) => None,
    })
}

/// Commits ahead of and behind `origin/<branch>`, as of the last fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tracking {
    pub ahead: usize,
    pub behind: usize,
}

/// `None` while `origin` has no branch of this name (never pushed, or not
/// fetched yet).
pub(crate) fn tracking(
    repo: &gix::Repository,
    branch: &str,
    local: Option<ObjectId>,
) -> Result<Option<Tracking>, GitError> {
    let Some(remote) = ref_target(repo, &remote_branch_ref(branch)?)? else {
        return Ok(None);
    };
    let Some(local) = local else {
        return Ok(Some(Tracking {
            ahead: 0,
            behind: count_only_in(repo, remote, None)?,
        }));
    };
    Ok(Some(Tracking {
        ahead: count_only_in(repo, local, Some(remote))?,
        behind: count_only_in(repo, remote, Some(local))?,
    }))
}

/// Commits reachable from `tip` and not from `hidden`.
fn count_only_in(
    repo: &gix::Repository,
    tip: ObjectId,
    hidden: Option<ObjectId>,
) -> Result<usize, GitError> {
    if hidden == Some(tip) {
        return Ok(0);
    }
    let walk = repo.rev_walk([tip]).with_hidden(hidden);
    let mut count = 0;
    for info in walk.all().map_err(rejected)? {
        info.map_err(rejected)?;
        count += 1;
    }
    Ok(count)
}

/// Merges `origin/<branch>` (after a `fetch`) into the current branch:
/// nothing, a fast-forward, a merge commit, or a pending merge. A branch
/// without commits in a workspace created moments ago takes the remote's
/// work as is, following `origin`'s default branch when its own name does
/// not exist there.
pub fn merge_upstream<F: WorkspaceFiles>(
    root: &Path,
    files: &F,
    link: &WorkspaceLink,
    identity: Option<&GitIdentity>,
) -> Result<(Integration, Applied), GitError> {
    let repo = open_workspace(root)?;
    ensure_no_merge(&repo)?;
    let (name, local) = head(&repo)?;
    let mut branch = short_name(&name);
    let mut upstream = ref_target(&repo, &remote_branch_ref(&branch)?)?;
    if upstream.is_none()
        && local.is_none()
        && let Some(default) = remote_default_branch(&repo)?
    {
        upstream = ref_target(&repo, &remote_branch_ref(&default)?)?;
        if upstream.is_some() {
            follow_branch(&repo, &default)?;
            branch = default;
        }
    }
    let Some(upstream) = upstream else {
        return Ok((
            Integration::UpToDate,
            Applied {
                files: Vec::new(),
                link: link.clone(),
            },
        ));
    };
    let adopt_fresh = local.is_none() && is_fresh(files, &link.tracked_files())?;
    let label = format!("{REMOTE}/{branch}");
    integrate(
        &repo,
        files,
        link,
        identity,
        Incoming {
            commit: upstream,
            label: &label,
            message: &format!("Merge remote-tracking branch '{label}'"),
            adopt_fresh,
        },
    )
}

/// Points an unborn `HEAD` at another branch name.
fn follow_branch(repo: &gix::Repository, branch: &str) -> Result<(), GitError> {
    let target = crate::branch_ref(branch)?;
    repo.edit_reference(RefEdit {
        change: Change::Update {
            log: LogChange::default(),
            expected: PreviousValue::Any,
            new: Target::Symbolic(target),
        },
        name: FullName::try_from("HEAD").map_err(rejected)?,
        deref: false,
    })
    .map_err(rejected)?;
    Ok(())
}

/// Clones `url` into `destination`, a folder that must not exist yet. The
/// repository must hold an Alcy workspace; otherwise the clone is removed.
pub async fn clone(url: &str, destination: &Path) -> Result<(), GitError> {
    clone_with(url, destination, &[]).await
}

/// Whether a folder's repository can serve as the `origin` of a new copy: its
/// current commit holds the workspace, and it has no `origin` of its own
/// (a repository that has one should be cloned from there).
pub fn can_clone_as_remote(root: &Path) -> bool {
    clonable_folder(root).unwrap_or(false)
}

fn clonable_folder(root: &Path) -> Result<bool, GitError> {
    let repo = open_workspace(root)?;
    if repo.is_bare() || remote_url_of(&repo).is_some() {
        return Ok(false);
    }
    let Some(commit) = head(&repo)?.1 else {
        return Ok(false);
    };
    let tree = commit_tree(&repo, commit)?;
    Ok(blob_at(&repo, Some(tree), MANIFEST_FILE)?.is_some())
}

/// Clones the workspace repository in the folder `source`, which becomes
/// `origin`: how a team without a git server shares a workspace. Objects are
/// copied, not hard-linked, so the copy shares nothing with the team's folder.
pub async fn clone_folder(source: &Path, destination: &Path) -> Result<(), GitError> {
    clone_with(&source.to_string_lossy(), destination, &["--no-hardlinks"]).await?;
    // A read-only share still serves pulls; a push will explain the refusal.
    let _ = accept_pushes(source).await;
    Ok(())
}

/// Lets a folder with working files take pushes to its current branch: git
/// updates the files, and refuses while they have uncommitted changes. An
/// existing `receive.denyCurrentBranch` is someone's decision and stays; the
/// line endings are always set, since git writes those files with the
/// pusher's configuration.
async fn accept_pushes(source: &Path) -> Result<(), GitError> {
    const KEY: &str = "receive.denyCurrentBranch";
    let configured = open_workspace(source)?
        .config_snapshot()
        .string(KEY)
        .is_some();
    let mut settings = LINE_ENDINGS.to_vec();
    if !configured {
        settings.push((KEY, "updateInstead"));
    }
    let config = source.join(".git").join("config");
    for (key, value) in settings {
        // `--file` edits the configuration without entering the repository,
        // so git's ownership check for the working tree does not apply.
        let mut command = args(["config", "--file"]);
        command.push(config.clone().into_os_string());
        command.extend(args([key, value]));
        git(None, &command).await?;
    }
    Ok(())
}

/// Adds one folder to the `safe.directory` list of the person's own git
/// configuration, after they agreed to trust it.
pub async fn trust_folder(path: &str) -> Result<(), GitError> {
    let path = validate_trusted_folder(path)?;
    git(
        None,
        &args(["config", "--global", "--add", "safe.directory", path]),
    )
    .await?;
    Ok(())
}

async fn clone_with(url: &str, destination: &Path, options: &[&str]) -> Result<(), GitError> {
    let url = validate_remote_url(url)?;
    if destination.exists() {
        return Err(GitError::DestinationExists);
    }
    let marker = format!("{CLONED_COPY_KEY}=true");
    let mut command = args(["clone", "--config", &marker]);
    // Applies to the checkout too, and stays in the copy's configuration.
    for (key, value) in LINE_ENDINGS {
        command.push(OsString::from("--config"));
        command.push(OsString::from(format!("{key}={value}")));
    }
    command.extend(options.iter().map(OsString::from));
    command.push(OsString::from("--"));
    command.push(OsString::from(&url));
    command.push(destination.as_os_str().to_owned());
    git(None, &command).await?;
    if destination.join(MANIFEST_FILE).is_file() {
        return Ok(());
    }
    discard_clone(destination)?;
    Err(GitError::NotAWorkspace)
}

/// Removes the folder a clone created.
pub fn discard_clone(destination: &Path) -> Result<(), GitError> {
    if !destination.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(destination).map_err(|error| GitError::Files(error.to_string()))
}

/// Whether the current commit versions the environments (the clone keeps
/// them versioned only if whoever pushed chose to).
pub fn versions_environments(root: &Path) -> Result<bool, GitError> {
    let repo = open_workspace(root)?;
    let (_, local) = head(&repo)?;
    let tree = local.map(|id| commit_tree(&repo, id)).transpose()?;
    Ok(blob_at(&repo, tree, ENVIRONMENTS_FILE)?.is_some())
}
