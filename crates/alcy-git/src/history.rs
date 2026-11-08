use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use alcy_app::RemoteError;
use gix::ObjectId;

use crate::remotes::remote_branch_ref;
use crate::repo::{commit_tree, file_at, head, short_name};
use crate::{GitError, open_workspace, ref_target, rejected};

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
    /// Full ids, first parent first; more than one is a merge.
    pub parents: Vec<String>,
    /// Local branches and `origin/…` branches pointing at this commit.
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPage {
    pub commits: Vec<CommitSummary>,
    /// Offset of the next page, while there are more commits.
    pub next_offset: Option<usize>,
}

/// Branch names by the commit they point at.
fn refs_by_commit(repo: &gix::Repository) -> Result<HashMap<ObjectId, Vec<String>>, RemoteError> {
    let platform = repo.references().map_err(rejected)?;
    let mut refs: HashMap<ObjectId, Vec<String>> = HashMap::new();
    let local = platform.local_branches().map_err(rejected)?;
    let remote = platform.remote_branches().map_err(rejected)?;
    for reference in local.chain(remote) {
        let mut reference = reference.map_err(rejected)?;
        let name = reference.name().shorten().to_string();
        // `origin/HEAD` only says which branch is the default one.
        if name.ends_with("/HEAD") {
            continue;
        }
        let id = reference.peel_to_id().map_err(rejected)?.detach();
        refs.entry(id).or_default().push(name);
    }
    for names in refs.values_mut() {
        names.sort();
    }
    Ok(refs)
}

/// Commits reachable from `HEAD` and from `origin/<branch>` (so what a fetch
/// brought shows up before it is pulled), newest first by commit time.
pub fn history(root: &Path, offset: usize, limit: usize) -> Result<HistoryPage, GitError> {
    let repo = open_workspace(root)?;
    let (name, head) = head(&repo)?;
    let upstream = ref_target(&repo, &remote_branch_ref(&short_name(&name))?)?;
    let tips: Vec<ObjectId> = head.into_iter().chain(upstream).collect();
    if tips.is_empty() {
        return Ok(HistoryPage {
            commits: Vec::new(),
            next_offset: None,
        });
    }
    let refs = refs_by_commit(&repo)?;
    let limit = limit.clamp(1, MAX_HISTORY_PAGE);
    let walk = repo
        .rev_walk(tips)
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
        commits.push(summary(&repo, id, &refs)?);
    }
    Ok(HistoryPage {
        next_offset: more.then_some(offset + commits.len()),
        commits,
    })
}

fn summary(
    repo: &gix::Repository,
    id: ObjectId,
    refs: &HashMap<ObjectId, Vec<String>>,
) -> Result<CommitSummary, RemoteError> {
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
        parents: parents.iter().map(ObjectId::to_string).collect(),
        refs: refs.get(&id).cloned().unwrap_or_default(),
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
