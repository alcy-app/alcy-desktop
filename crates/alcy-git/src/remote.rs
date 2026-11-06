//! The committed state of the workspace repository, served to the
//! provider-neutral sync use cases as their `RemoteRepository`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use alcy_app::{CommitAction, RemoteError, RemoteFileMeta, RemoteRepository, content_hash};
use alcy_domain::GitIdentity;
use gix::ObjectId;
use gix::objs::tree::EntryKind;

use crate::merge_state::MergeState;
use crate::repo::{blob_at, commit_tree, head, move_branch, read_blob, write_commit, write_index};
use crate::{blocking, open_workspace, rejected};

/// Entries kept before the cache starts over.
const MAX_CACHED_HASHES: usize = 1024;

/// SHA-256 of blobs already read, by object id. A blob never changes.
#[derive(Clone, Default)]
pub struct BlobHashCache(Arc<Mutex<HashMap<ObjectId, String>>>);

impl BlobHashCache {
    fn get(&self, id: &ObjectId) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .cloned()
    }

    fn insert(&self, id: ObjectId, hash: String) {
        let mut map = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if map.len() >= MAX_CACHED_HASHES {
            map.clear();
        }
        map.insert(id, hash);
    }
}

/// "Remote" of a git workspace: `HEAD`'s tree, or the merge tree while a
/// merge waits for conflict resolution. Committing writes a commit on the
/// current branch. `last_commit_id` carries the file's blob id, so a commit
/// only succeeds while the committed state still holds what was read.
pub struct WorkspaceRemote {
    root: PathBuf,
    identity: Option<GitIdentity>,
    hashes: BlobHashCache,
}

impl WorkspaceRemote {
    /// `identity` is only needed to commit.
    pub fn new(
        root: impl Into<PathBuf>,
        identity: Option<GitIdentity>,
        hashes: BlobHashCache,
    ) -> Self {
        Self {
            root: root.into(),
            identity,
            hashes,
        }
    }
}

/// Tree compared against the working files.
fn committed_tree(repo: &gix::Repository) -> Result<Option<ObjectId>, RemoteError> {
    if let Some(state) = MergeState::load(repo.git_dir())? {
        return Ok(Some(state.merge_tree));
    }
    let (_, head) = head(repo)?;
    head.map(|head| commit_tree(repo, head)).transpose()
}

fn file_meta_blocking(
    root: &Path,
    file: &str,
    hashes: &BlobHashCache,
) -> Result<RemoteFileMeta, RemoteError> {
    let repo = open_workspace(root)?;
    let Some(id) = blob_at(&repo, committed_tree(&repo)?, file)? else {
        return Ok(RemoteFileMeta::default());
    };
    let sha256 = match hashes.get(&id) {
        Some(hash) => hash,
        None => {
            let hash = content_hash(&read_blob(&repo, id)?);
            hashes.insert(id, hash.clone());
            hash
        }
    };
    Ok(RemoteFileMeta {
        sha256: Some(sha256),
        last_commit_id: Some(id.to_string()),
    })
}

fn read_file_blocking(root: &Path, file: &str) -> Result<Option<Vec<u8>>, RemoteError> {
    let repo = open_workspace(root)?;
    blob_at(&repo, committed_tree(&repo)?, file)?
        .map(|id| read_blob(&repo, id))
        .transpose()
}

fn action_path(action: &CommitAction) -> &str {
    match action {
        CommitAction::Create { path, .. }
        | CommitAction::Update { path, .. }
        | CommitAction::Delete { path, .. } => path,
    }
}

/// Checks each action against the file as the committed state holds it.
fn verify_actions(
    repo: &gix::Repository,
    tree: Option<ObjectId>,
    actions: &[CommitAction],
) -> Result<(), RemoteError> {
    for action in actions {
        let current = blob_at(repo, tree, action_path(action))?;
        let expected = match action {
            CommitAction::Create { .. } => {
                if current.is_some() {
                    return Err(RemoteError::Conflict);
                }
                continue;
            }
            CommitAction::Update { last_commit_id, .. }
            | CommitAction::Delete { last_commit_id, .. } => last_commit_id,
        };
        let Some(expected) = expected else { continue };
        if current.map(|id| id.to_string()).as_deref() != Some(expected.as_str()) {
            return Err(RemoteError::Conflict);
        }
    }
    Ok(())
}

/// Tree with the actions applied on top of `base` (`None` = empty).
pub(crate) fn apply_actions(
    repo: &gix::Repository,
    base: Option<ObjectId>,
    actions: &[CommitAction],
) -> Result<ObjectId, RemoteError> {
    let base = base.unwrap_or_else(|| crate::repo::empty_tree(repo));
    let mut editor = repo.edit_tree(base).map_err(rejected)?;
    for action in actions {
        match action {
            CommitAction::Create { path, content } | CommitAction::Update { path, content, .. } => {
                let blob = repo.write_blob(content).map_err(rejected)?;
                editor
                    .upsert(path.as_str(), EntryKind::Blob, blob.detach())
                    .map_err(rejected)?;
            }
            CommitAction::Delete { path, .. } => {
                editor.remove(path.as_str()).map_err(rejected)?;
            }
        }
    }
    Ok(editor.write().map_err(rejected)?.detach())
}

fn commit_blocking(
    root: &Path,
    identity: &GitIdentity,
    message: &str,
    actions: &[CommitAction],
) -> Result<String, RemoteError> {
    let repo = open_workspace(root)?;
    if MergeState::load(repo.git_dir())?.is_some() {
        return Err(rejected("finish or cancel the merge in progress first"));
    }
    let (name, head) = head(&repo)?;
    let tree = head.map(|head| commit_tree(&repo, head)).transpose()?;
    verify_actions(&repo, tree, actions)?;
    let new_tree = apply_actions(&repo, tree, actions)?;
    let commit = write_commit(
        &repo,
        identity,
        message,
        new_tree,
        head.into_iter().collect(),
    )?;
    move_branch(&repo, &name, head, commit, message)?;
    write_index(&repo, new_tree)?;
    Ok(commit.to_string())
}

impl RemoteRepository for WorkspaceRemote {
    async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
        let (root, file, hashes) = (self.root.clone(), path.to_string(), self.hashes.clone());
        blocking(move || file_meta_blocking(&root, &file, &hashes)).await
    }

    async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        let (root, file) = (self.root.clone(), path.to_string());
        blocking(move || read_file_blocking(&root, &file)).await
    }

    async fn commit(&self, message: &str, actions: &[CommitAction]) -> Result<String, RemoteError> {
        let Some(identity) = self.identity.clone() else {
            return Err(rejected("git user not configured"));
        };
        let (root, message, actions) = (self.root.clone(), message.to_string(), actions.to_vec());
        blocking(move || commit_blocking(&root, &identity, &message, &actions)).await
    }
}
