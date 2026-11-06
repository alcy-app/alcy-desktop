use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use alcy_app::RemoteError;
use gix::ObjectId;

use crate::repo::{commit_tree, file_at, head};
use crate::{GitError, open_workspace, rejected};

/// Largest page served at once (invariant 8: never the whole log).
pub const MAX_HISTORY_PAGE: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitSummary {
    pub id: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, in seconds since the Unix epoch.
    pub time: i64,
    /// First line of the message.
    pub summary: String,
    /// Root files added, changed or removed against the first parent.
    pub files: Vec<String>,
    /// More than one parent: a merge.
    pub merge: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPage {
    pub commits: Vec<CommitSummary>,
    /// Offset of the next page, while there are more commits.
    pub next_offset: Option<usize>,
}

/// Commits reachable from `HEAD`, newest first by commit time.
pub fn history(root: &Path, offset: usize, limit: usize) -> Result<HistoryPage, GitError> {
    let repo = open_workspace(root)?;
    let (_, head) = head(&repo)?;
    let Some(head) = head else {
        return Ok(HistoryPage {
            commits: Vec::new(),
            next_offset: None,
        });
    };
    let limit = limit.clamp(1, MAX_HISTORY_PAGE);
    let walk = repo
        .rev_walk([head])
        .sorting(gix::revision::walk::Sorting::ByCommitTime(
            Default::default(),
        ))
        .all()
        .map_err(rejected)?;
    let mut commits = Vec::new();
    let mut more = false;
    for (index, info) in walk.enumerate() {
        if index < offset {
            continue;
        }
        if commits.len() == limit {
            more = true;
            break;
        }
        let id = info.map_err(rejected)?.id;
        commits.push(summary(&repo, id)?);
    }
    Ok(HistoryPage {
        next_offset: more.then_some(offset + commits.len()),
        commits,
    })
}

fn summary(repo: &gix::Repository, id: ObjectId) -> Result<CommitSummary, RemoteError> {
    let commit = repo.find_commit(id).map_err(rejected)?;
    let author = commit.author().map_err(rejected)?;
    let time = author.time().map(|time| time.seconds).unwrap_or_default();
    let summary = commit.message().map_err(rejected)?.summary().to_string();
    let parents: Vec<ObjectId> = commit.parent_ids().map(|parent| parent.detach()).collect();
    let tree = commit.tree_id().map_err(rejected)?.detach();
    let parent_tree = parents
        .first()
        .map(|parent| commit_tree(repo, *parent))
        .transpose()?;
    Ok(CommitSummary {
        id: id.to_string(),
        author_name: author.name.to_string(),
        author_email: author.email.to_string(),
        time,
        summary,
        files: changed_root_entries(repo, parent_tree, tree)?,
        merge: parents.len() > 1,
    })
}

fn root_entries(
    repo: &gix::Repository,
    tree: Option<ObjectId>,
) -> Result<BTreeMap<String, ObjectId>, RemoteError> {
    let Some(tree) = tree else {
        return Ok(BTreeMap::new());
    };
    let tree = repo.find_tree(tree).map_err(rejected)?;
    let mut entries = BTreeMap::new();
    for entry in tree.iter() {
        let entry = entry.map_err(rejected)?;
        entries.insert(entry.filename().to_string(), entry.object_id());
    }
    Ok(entries)
}

/// Workspace files live at the repository root, so comparing root entries is
/// enough (a changed folder shows as its name).
fn changed_root_entries(
    repo: &gix::Repository,
    before: Option<ObjectId>,
    after: ObjectId,
) -> Result<Vec<String>, RemoteError> {
    let before = root_entries(repo, before)?;
    let after = root_entries(repo, Some(after))?;
    let names: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    Ok(names
        .into_iter()
        .filter(|name| before.get(*name) != after.get(*name))
        .cloned()
        .collect())
}

/// A file's content at a commit and at its first parent (`None` = absent).
pub struct FileVersions {
    pub at_commit: Option<Vec<u8>>,
    pub before: Option<Vec<u8>>,
}

/// `file` as `commit` left it, and as its first parent had it.
pub fn file_versions(root: &Path, commit: &str, file: &str) -> Result<FileVersions, GitError> {
    let repo = open_workspace(root)?;
    let id = ObjectId::from_hex(commit.as_bytes()).map_err(rejected)?;
    let found = repo.find_commit(id).map_err(rejected)?;
    let parent = found.parent_ids().next().map(|parent| parent.detach());
    let tree = commit_tree(&repo, id)?;
    let parent_tree = parent
        .map(|parent| commit_tree(&repo, parent))
        .transpose()?;
    Ok(FileVersions {
        at_commit: file_at(&repo, Some(tree), file)?,
        before: file_at(&repo, parent_tree, file)?,
    })
}
