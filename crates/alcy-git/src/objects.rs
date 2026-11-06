//! Copying commits between two repositories on disk (the workspace and the
//! shared folder). Objects are content-addressed and written once, so a sync
//! client can deliver them in any order without conflicts.

use std::collections::HashSet;

use alcy_app::RemoteError;
use gix::ObjectId;
use gix::objs::Write as _;

use crate::rejected;

/// Commits reachable from `tip` that `to` lacks, oldest first (parents
/// before children). `None` while `from` does not hold every object they
/// need yet, e.g. a sync client still delivering them.
pub(crate) fn missing_commits(
    from: &gix::Repository,
    to: &gix::Repository,
    tip: ObjectId,
) -> Result<Option<Vec<ObjectId>>, RemoteError> {
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    // (commit, parents already pushed)
    let mut stack = vec![(tip, false)];
    while let Some((id, expanded)) = stack.pop() {
        if expanded {
            order.push(id);
            continue;
        }
        if to.has_object(id) || !seen.insert(id) {
            continue;
        }
        let Some(object) = from.try_find_object(id).map_err(rejected)? else {
            return Ok(None);
        };
        let commit = object.try_into_commit().map_err(rejected)?;
        let tree = commit.tree_id().map_err(rejected)?.detach();
        if !tree_available(from, to, tree)? {
            return Ok(None);
        }
        stack.push((id, true));
        for parent in commit.parent_ids() {
            stack.push((parent.detach(), false));
        }
    }
    Ok(Some(order))
}

/// Whether every object of `tree` missing in `to` exists in `from`.
fn tree_available(
    from: &gix::Repository,
    to: &gix::Repository,
    tree: ObjectId,
) -> Result<bool, RemoteError> {
    if to.has_object(tree) {
        return Ok(true);
    }
    let Some(object) = from.try_find_object(tree).map_err(rejected)? else {
        return Ok(false);
    };
    let tree = object.try_into_tree().map_err(rejected)?;
    for entry in tree.iter() {
        let entry = entry.map_err(rejected)?;
        let id = entry.object_id();
        let mode = entry.mode();
        let available = if mode.is_tree() {
            tree_available(from, to, id)?
        } else if mode.is_commit() {
            true
        } else {
            to.has_object(id) || from.has_object(id)
        };
        if !available {
            return Ok(false);
        }
    }
    Ok(true)
}

fn copy_object(
    from: &gix::Repository,
    to: &gix::Repository,
    id: ObjectId,
) -> Result<(), RemoteError> {
    if to.has_object(id) {
        return Ok(());
    }
    let object = from.find_object(id).map_err(rejected)?;
    to.objects
        .write_buf(object.kind, &object.data)
        .map_err(rejected)?;
    Ok(())
}

fn copy_tree(
    from: &gix::Repository,
    to: &gix::Repository,
    tree: ObjectId,
) -> Result<(), RemoteError> {
    if to.has_object(tree) {
        return Ok(());
    }
    let entries: Vec<(ObjectId, gix::objs::tree::EntryMode)> = {
        let tree = from.find_tree(tree).map_err(rejected)?;
        tree.iter()
            .map(|entry| entry.map(|entry| (entry.object_id(), entry.mode())))
            .collect::<Result<_, _>>()
            .map_err(rejected)?
    };
    for (id, mode) in entries {
        if mode.is_tree() {
            copy_tree(from, to, id)?;
        } else if !mode.is_commit() {
            copy_object(from, to, id)?;
        }
    }
    // Written after its entries: a tree in `to` always has its content.
    copy_object(from, to, tree)
}

/// Copies `commits` (oldest first, from `missing_commits`) with their trees.
pub(crate) fn copy_commits(
    from: &gix::Repository,
    to: &gix::Repository,
    commits: &[ObjectId],
) -> Result<(), RemoteError> {
    for &commit in commits {
        let tree = from
            .find_commit(commit)
            .and_then(|commit| commit.tree_id())
            .map_err(rejected)?
            .detach();
        copy_tree(from, to, tree)?;
        copy_object(from, to, commit)?;
    }
    Ok(())
}
