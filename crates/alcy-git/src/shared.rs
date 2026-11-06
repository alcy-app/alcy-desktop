//! The shared folder: a bare repository where each installation publishes
//! its own branches under `refs/heads/alcy/<peer>/<branch>` and nobody else's.

use std::path::Path;

use alcy_app::RemoteError;
use gix::ObjectId;
use gix::refs::FullName;
use gix::refs::transaction::{PreviousValue, RefEdit};

use crate::objects::{copy_commits, missing_commits};
use crate::repo::{head, is_ancestor, short_name};
use crate::{GitError, open_bare, open_workspace, ref_target, rejected};

const PEER_PREFIX: &str = "refs/heads/alcy/";

pub(crate) fn peer_ref(peer: &str, branch: &str) -> Result<FullName, RemoteError> {
    FullName::try_from(format!("{PEER_PREFIX}{peer}/{branch}")).map_err(rejected)
}

/// Copies the current branch's new commits to the shared folder and moves
/// this installation's ref there. `false` when it was already published.
pub fn publish(root: &Path, shared: &Path, peer: &str) -> Result<bool, GitError> {
    let local = open_workspace(root)?;
    let (name, head) = head(&local)?;
    let Some(head) = head else { return Ok(false) };
    let remote = open_bare(shared)?;
    let commits = missing_commits(&local, &remote, head)?
        .ok_or_else(|| rejected("the workspace repository is missing objects"))?;
    copy_commits(&local, &remote, &commits)?;

    let target = peer_ref(peer, &short_name(&name))?;
    if ref_target(&remote, &target)? == Some(head) {
        return Ok(false);
    }
    // Only this installation writes this ref, so no compare-and-swap with
    // other machines is needed (a sync client never sees two writers).
    remote
        .edit_reference(RefEdit::update(target, head, PreviousValue::Any, "publish"))
        .map_err(rejected)?;
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerState {
    /// Everything they published is already in this workspace.
    UpToDate,
    /// New commits, ready to integrate.
    Incoming,
    /// Their ref arrived before all of its objects (sync still running).
    Syncing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerStatus {
    pub peer: String,
    /// Author of their latest commit.
    pub name: String,
    pub head: String,
    /// Commit time of their latest commit, seconds since the Unix epoch.
    pub time: i64,
    pub state: PeerState,
}

pub(crate) struct PeerHead {
    pub peer: String,
    pub head: ObjectId,
}

/// Other installations' refs for `branch`.
pub(crate) fn peer_heads(
    remote: &gix::Repository,
    me: &str,
    branch: &str,
) -> Result<Vec<PeerHead>, RemoteError> {
    let platform = remote.references().map_err(rejected)?;
    let mut heads = Vec::new();
    for reference in platform.prefixed(PEER_PREFIX).map_err(rejected)? {
        // A ref file still being delivered may not parse yet: skip it.
        let Ok(reference) = reference else {
            continue;
        };
        let full = reference.name().as_bstr().to_string();
        let Some(rest) = full.strip_prefix(PEER_PREFIX) else {
            continue;
        };
        let Some((peer, peer_branch)) = rest.split_once('/') else {
            continue;
        };
        if peer == me || peer_branch != branch {
            continue;
        }
        // The target id, without peeling: peeling needs the commit object,
        // which a sync client may not have delivered yet.
        let Some(id) = reference.target().try_id().map(ToOwned::to_owned) else {
            continue;
        };
        heads.push(PeerHead {
            peer: peer.to_string(),
            head: id,
        });
    }
    heads.sort_by(|a, b| a.peer.cmp(&b.peer));
    Ok(heads)
}

pub(crate) fn peer_state(
    local: &gix::Repository,
    remote: &gix::Repository,
    local_head: Option<ObjectId>,
    peer_head: ObjectId,
) -> Result<PeerState, RemoteError> {
    if local.has_object(peer_head) {
        if let Some(local_head) = local_head
            && is_ancestor(local, peer_head, local_head)?
        {
            return Ok(PeerState::UpToDate);
        }
        return Ok(PeerState::Incoming);
    }
    Ok(match missing_commits(remote, local, peer_head)? {
        Some(_) => PeerState::Incoming,
        None => PeerState::Syncing,
    })
}

/// Everyone else publishing the current branch in the shared folder.
pub fn peer_statuses(root: &Path, shared: &Path, me: &str) -> Result<Vec<PeerStatus>, GitError> {
    let local = open_workspace(root)?;
    let (name, local_head) = head(&local)?;
    let remote = open_bare(shared)?;
    let mut statuses = Vec::new();
    for PeerHead { peer, head } in peer_heads(&remote, me, &short_name(&name))? {
        let state = peer_state(&local, &remote, local_head, head)?;
        let source = if local.has_object(head) {
            &local
        } else {
            &remote
        };
        let (author, time) = match source.find_commit(head) {
            Ok(commit) => {
                let author = commit
                    .author()
                    .map(|author| author.name.to_string())
                    .unwrap_or_default();
                let time = commit.time().map(|time| time.seconds).unwrap_or_default();
                (author, time)
            }
            Err(_) => (String::new(), 0),
        };
        statuses.push(PeerStatus {
            name: if author.is_empty() {
                peer.clone()
            } else {
                author
            },
            peer,
            head: head.to_string(),
            time,
            state,
        });
    }
    Ok(statuses)
}
