//! The repository in the workspace folder: creation, `HEAD`, trees, index.

use std::path::Path;

use alcy_app::RemoteError;
use alcy_domain::{GitIdentity, is_valid_branch_name};
use gix::ObjectId;
use gix::refs::transaction::{PreviousValue, RefEdit};
use gix::refs::{FullName, Target};

use crate::merge_state::MergeState;
use crate::remotes::{Tracking, remote_url, tracking};
use crate::{GitError, branch_ref, open_workspace, ref_target, rejected};

/// First line of the `.gitignore` Alcy manages; a file without it is the
/// user's own and is left alone.
const GITIGNORE_MARKER: &str = "# Managed by Alcy";

/// Allow-list: everything at the root is ignored except the versioned files,
/// so per-user files (history, tab session, runs) never enter the repository.
pub fn gitignore_content(tracked: &[&str]) -> String {
    let mut content =
        format!("{GITIGNORE_MARKER}: only the shared workspace files are versioned.\n/*\n");
    for name in tracked {
        content.push_str(&format!("!/{name}\n"));
    }
    content
}

/// Writes the managed `.gitignore` unless the user has one of their own.
pub fn write_gitignore(root: &Path, tracked: &[&str]) -> Result<(), RemoteError> {
    let path = root.join(".gitignore");
    if let Ok(existing) = std::fs::read_to_string(&path)
        && !existing.starts_with(GITIGNORE_MARKER)
    {
        return Ok(());
    }
    std::fs::write(path, gitignore_content(tracked)).map_err(rejected)
}

/// Creates the repository in the workspace folder with `HEAD` on `branch`,
/// or adopts the one already there.
pub fn init_workspace(root: &Path, branch: &str, tracked: &[&str]) -> Result<(), GitError> {
    if !is_valid_branch_name(branch) {
        return Err(GitError::InvalidBranch(branch.to_string()));
    }
    if !root.is_dir() {
        return Err(GitError::Files(format!(
            "{} is not a folder",
            root.display()
        )));
    }
    if root.join(".git").exists() {
        let repo = open_workspace(root)?;
        if repo.is_bare() || repo.workdir().is_none() {
            return Err(
                rejected("the workspace folder holds a repository without a working tree").into(),
            );
        }
    } else {
        gix::init(root).map_err(rejected)?;
        std::fs::write(
            root.join(".git").join("HEAD"),
            format!("ref: refs/heads/{branch}\n"),
        )
        .map_err(rejected)?;
    }
    write_gitignore(root, tracked)?;
    Ok(())
}

/// The branch `HEAD` names (it may have no commits yet).
pub(crate) fn current_branch(repo: &gix::Repository) -> Result<FullName, RemoteError> {
    match repo.head_name().map_err(rejected)? {
        Some(name) if name.as_bstr().starts_with(b"refs/heads/") => Ok(name),
        _ => Err(rejected("HEAD is not on a branch")),
    }
}

pub(crate) fn short_name(name: &FullName) -> String {
    name.shorten().to_string()
}

/// Current branch and its latest commit.
pub(crate) fn head(repo: &gix::Repository) -> Result<(FullName, Option<ObjectId>), RemoteError> {
    let name = current_branch(repo)?;
    let id = ref_target(repo, &name)?;
    Ok((name, id))
}

pub(crate) fn commit_tree(
    repo: &gix::Repository,
    commit: ObjectId,
) -> Result<ObjectId, RemoteError> {
    Ok(repo
        .find_commit(commit)
        .and_then(|commit| commit.tree_id())
        .map_err(rejected)?
        .detach())
}

pub(crate) fn empty_tree(repo: &gix::Repository) -> ObjectId {
    ObjectId::empty_tree(repo.object_hash())
}

/// Blob at `file` (a root path) in `tree`.
pub(crate) fn blob_at(
    repo: &gix::Repository,
    tree: Option<ObjectId>,
    file: &str,
) -> Result<Option<ObjectId>, RemoteError> {
    let Some(tree) = tree else { return Ok(None) };
    let tree = repo.find_tree(tree).map_err(rejected)?;
    let entry = tree.lookup_entry_by_path(file).map_err(rejected)?;
    Ok(entry
        .filter(|entry| entry.mode().is_blob())
        .map(|entry| entry.object_id()))
}

pub(crate) fn read_blob(repo: &gix::Repository, id: ObjectId) -> Result<Vec<u8>, RemoteError> {
    let mut blob = repo.find_blob(id).map_err(rejected)?;
    Ok(blob.take_data())
}

pub(crate) fn file_at(
    repo: &gix::Repository,
    tree: Option<ObjectId>,
    file: &str,
) -> Result<Option<Vec<u8>>, RemoteError> {
    blob_at(repo, tree, file)?
        .map(|id| read_blob(repo, id))
        .transpose()
}

/// Keeps git's index equal to `HEAD`'s tree, so the git CLI sees a clean
/// working tree for files Alcy committed.
pub(crate) fn write_index(repo: &gix::Repository, tree: ObjectId) -> Result<(), RemoteError> {
    let mut index = repo.index_from_tree(&tree).map_err(rejected)?;
    index.write(Default::default()).map_err(rejected)
}

/// Moves a branch from `old` to `new` by compare-and-swap.
pub(crate) fn move_branch(
    repo: &gix::Repository,
    name: &FullName,
    old: Option<ObjectId>,
    new: ObjectId,
    message: &str,
) -> Result<(), RemoteError> {
    let expected = match old {
        Some(old) => PreviousValue::MustExistAndMatch(Target::Object(old)),
        None => PreviousValue::MustNotExist,
    };
    let summary = message.lines().next().unwrap_or_default();
    repo.edit_reference(RefEdit::update(name.clone(), new, expected, summary))
        .map_err(rejected)?;
    Ok(())
}

pub(crate) fn signature(identity: &GitIdentity) -> gix::actor::Signature {
    gix::actor::Signature {
        name: identity.name.as_str().into(),
        email: identity.email.as_str().into(),
        time: gix::date::Time::now_local_or_utc(),
    }
}

pub(crate) fn write_commit(
    repo: &gix::Repository,
    identity: &GitIdentity,
    message: &str,
    tree: ObjectId,
    parents: Vec<ObjectId>,
) -> Result<ObjectId, RemoteError> {
    let signature = signature(identity);
    let commit = gix::objs::Commit {
        tree,
        parents: parents.into_iter().collect(),
        author: signature.clone(),
        committer: signature,
        encoding: None,
        message: message.into(),
        extra_headers: Vec::new(),
    };
    Ok(repo.write_object(&commit).map_err(rejected)?.detach())
}

/// Whether `ancestor` is reachable from `of` (or equal to it).
pub(crate) fn is_ancestor(
    repo: &gix::Repository,
    ancestor: ObjectId,
    of: ObjectId,
) -> Result<bool, RemoteError> {
    if ancestor == of {
        return Ok(true);
    }
    let base = repo.merge_base(ancestor, of).map_err(rejected)?;
    Ok(base.is_some_and(|base| base.detach() == ancestor))
}

pub(crate) fn local_branches(repo: &gix::Repository) -> Result<Vec<String>, RemoteError> {
    let platform = repo.references().map_err(rejected)?;
    let mut branches = Vec::new();
    for reference in platform.local_branches().map_err(rejected)? {
        let reference = reference.map_err(rejected)?;
        branches.push(reference.name().shorten().to_string());
    }
    branches.sort();
    Ok(branches)
}

pub(crate) fn branch_exists(repo: &gix::Repository, branch: &str) -> Result<bool, RemoteError> {
    Ok(ref_target(repo, &branch_ref(branch)?)?.is_some())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeInfo {
    pub label: String,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitState {
    pub branch: String,
    pub branches: Vec<String>,
    /// The current branch has at least one commit.
    pub has_commits: bool,
    pub merge: Option<MergeInfo>,
    /// URL of `origin`.
    pub remote: Option<String>,
    /// Against `origin/<branch>` as of the last fetch.
    pub tracking: Option<Tracking>,
}

pub fn git_state(root: &Path) -> Result<GitState, GitError> {
    let repo = open_workspace(root)?;
    let (name, head) = head(&repo)?;
    let merge = MergeState::load(repo.git_dir())?.map(|state| MergeInfo {
        label: state.label,
        conflicts: state.conflicts,
    });
    let branch = short_name(&name);
    let remote = remote_url(root)?;
    let tracking = match remote {
        Some(_) => tracking(&repo, &branch, head)?,
        None => None,
    };
    Ok(GitState {
        tracking,
        remote,
        branches: local_branches(&repo)?,
        has_commits: head.is_some(),
        branch,
        merge,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACKED: [&str; 2] = ["alcy-workspace.json", "alcy-collections.json"];

    #[test]
    fn initializes_or_adopts_the_workspace_repository() {
        let dir = tempfile::tempdir().unwrap();
        init_workspace(dir.path(), "trunk", &TRACKED).unwrap();
        let state = git_state(dir.path()).unwrap();
        assert_eq!(state.branch, "trunk");
        assert!(!state.has_commits);
        assert_eq!(state.merge, None);
        let ignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(ignore.starts_with(GITIGNORE_MARKER));
        assert!(ignore.contains("/*\n!/alcy-workspace.json\n!/alcy-collections.json\n"));

        // Adopting keeps the branch and rewrites only Alcy's own .gitignore.
        init_workspace(dir.path(), "main", &["alcy-workspace.json"]).unwrap();
        assert_eq!(git_state(dir.path()).unwrap().branch, "trunk");
        assert!(
            !std::fs::read_to_string(dir.path().join(".gitignore"))
                .unwrap()
                .contains("collections")
        );

        std::fs::write(dir.path().join(".gitignore"), "node_modules\n").unwrap();
        init_workspace(dir.path(), "main", &TRACKED).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "node_modules\n"
        );

        assert_eq!(
            init_workspace(dir.path(), "a b", &TRACKED),
            Err(GitError::InvalidBranch("a b".to_string()))
        );
    }
}
