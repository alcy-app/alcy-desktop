//! Git operations that change the workspace files: switching branches,
//! merging, restoring, syncing with the shared folder. Files are read and
//! written through `WorkspaceFiles` (the same view the sync use cases use),
//! and the link's base follows every file rewritten here.

use std::collections::BTreeMap;
use std::path::Path;

use alcy_app::{CommitAction, FileMerge, WorkspaceFiles, content_hash, merge_file};
use alcy_domain::{
    FileState, GitIdentity, MANIFEST_FILE, WorkspaceLink, classify, is_valid_branch_name,
};
use gix::ObjectId;
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use gix::refs::{FullName, Target};

use crate::merge_state::MergeState;
use crate::objects::{copy_commits, missing_commits};
use crate::remote::apply_actions;
use crate::repo::{
    blob_at, branch_exists, commit_tree, file_at, head, is_ancestor, move_branch, short_name,
    write_commit, write_index,
};
use crate::shared::{PeerState, peer_heads, peer_state, publish};
use crate::{GitError, branch_ref, open_bare, open_workspace, ref_target, rejected};

/// Files rewritten on disk and the link with their new base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub files: Vec<String>,
    pub link: WorkspaceLink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Integration {
    UpToDate,
    FastForward,
    /// A merge commit was written.
    Merged,
    /// A merge is pending; these files need a decision.
    Conflicts(Vec<String>),
}

fn read_local<F: WorkspaceFiles>(files: &F, name: &str) -> Result<Option<Vec<u8>>, GitError> {
    files.read(name).map_err(GitError::Files)
}

/// Writes (or deletes) a file and makes it the link's base.
fn write_local<F: WorkspaceFiles>(
    files: &F,
    link: &mut WorkspaceLink,
    name: &str,
    content: Option<&[u8]>,
) -> Result<(), GitError> {
    match content {
        Some(bytes) => {
            files.write(name, bytes).map_err(GitError::Files)?;
            link.base.insert(name.to_string(), content_hash(bytes));
        }
        None => {
            files.delete(name).map_err(GitError::Files)?;
            link.base.remove(name);
        }
    }
    Ok(())
}

/// Files among `names` whose working copy differs from `tree`.
fn dirty<F: WorkspaceFiles>(
    repo: &gix::Repository,
    files: &F,
    tree: Option<ObjectId>,
    names: &[&str],
) -> Result<Vec<String>, GitError> {
    let mut changed = Vec::new();
    for name in names {
        if read_local(files, name)? != file_at(repo, tree, name)? {
            changed.push((*name).to_string());
        }
    }
    Ok(changed)
}

fn require_clean<F: WorkspaceFiles>(
    repo: &gix::Repository,
    files: &F,
    tree: Option<ObjectId>,
    names: &[&str],
) -> Result<(), GitError> {
    let changed = dirty(repo, files, tree, names)?;
    if changed.is_empty() {
        Ok(())
    } else {
        Err(GitError::UncommittedChanges(changed))
    }
}

/// Tracked files whose committed content differs between two trees.
fn changed_between(
    repo: &gix::Repository,
    a: Option<ObjectId>,
    b: Option<ObjectId>,
    tracked: &[&'static str],
) -> Result<Vec<&'static str>, GitError> {
    let mut changed = Vec::new();
    for &name in tracked {
        if blob_at(repo, a, name)? != blob_at(repo, b, name)? {
            changed.push(name);
        }
    }
    Ok(changed)
}

/// Any non-empty list anywhere in the JSON: collections, requests, flows…
fn has_entries(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(items) => !items.is_empty(),
        serde_json::Value::Object(fields) => fields.values().any(has_entries),
        _ => false,
    }
}

/// A workspace created moments ago: besides its manifest, every versioned
/// file is missing or holds no entries. Joining a shared folder replaces it
/// with the published work instead of asking to commit an empty workspace.
fn is_fresh<F: WorkspaceFiles>(files: &F, tracked: &[&str]) -> Result<bool, GitError> {
    for name in tracked {
        if *name == MANIFEST_FILE {
            continue;
        }
        let Some(bytes) = read_local(files, name)? else {
            continue;
        };
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) if !has_entries(&value) => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn ensure_no_merge(repo: &gix::Repository) -> Result<(), GitError> {
    if MergeState::load(repo.git_dir())?.is_some() {
        return Err(GitError::MergeInProgress);
    }
    Ok(())
}

fn valid_branch(branch: &str) -> Result<(), GitError> {
    if is_valid_branch_name(branch) {
        Ok(())
    } else {
        Err(GitError::InvalidBranch(branch.to_string()))
    }
}

/// Points `HEAD` at `branch` and rewrites the files that differ. Refuses to
/// overwrite uncommitted changes.
pub fn checkout<F: WorkspaceFiles>(
    root: &Path,
    files: &F,
    link: &WorkspaceLink,
    branch: &str,
) -> Result<Applied, GitError> {
    valid_branch(branch)?;
    let repo = open_workspace(root)?;
    ensure_no_merge(&repo)?;
    let target_name = branch_ref(branch)?;
    let target = ref_target(&repo, &target_name)?
        .ok_or_else(|| GitError::InvalidBranch(branch.to_string()))?;
    let (name, head) = head(&repo)?;
    let mut link = link.clone();
    if name == target_name {
        return Ok(Applied {
            files: Vec::new(),
            link,
        });
    }
    let current_tree = head.map(|head| commit_tree(&repo, head)).transpose()?;
    let target_tree = Some(commit_tree(&repo, target)?);
    let tracked = link.tracked_files();
    let changed = changed_between(&repo, current_tree, target_tree, &tracked)?;
    require_clean(&repo, files, current_tree, &changed)?;

    let head_name = FullName::try_from("HEAD").map_err(rejected)?;
    repo.edit_reference(RefEdit {
        change: Change::Update {
            log: LogChange::default(),
            expected: PreviousValue::Any,
            new: Target::Symbolic(target_name),
        },
        name: head_name,
        deref: false,
    })
    .map_err(rejected)?;

    for name in &changed {
        let content = file_at(&repo, target_tree, name)?;
        write_local(files, &mut link, name, content.as_deref())?;
    }
    if let Some(tree) = target_tree {
        write_index(&repo, tree)?;
    }
    Ok(Applied {
        files: changed.iter().map(|name| (*name).to_string()).collect(),
        link,
    })
}

/// New branch at the current commit (without switching to it).
pub fn create_branch(root: &Path, branch: &str) -> Result<(), GitError> {
    valid_branch(branch)?;
    let repo = open_workspace(root)?;
    if branch_exists(&repo, branch)? {
        return Err(rejected(format!("branch {branch} already exists")).into());
    }
    let (_, head) = head(&repo)?;
    let head = head.ok_or_else(|| rejected("commit before creating a branch"))?;
    move_branch(&repo, &branch_ref(branch)?, None, head, "branch")?;
    Ok(())
}

/// Deletes a branch other than the current one.
pub fn delete_branch(root: &Path, branch: &str) -> Result<(), GitError> {
    valid_branch(branch)?;
    let repo = open_workspace(root)?;
    let name = branch_ref(branch)?;
    let (current, _) = head(&repo)?;
    if current == name {
        return Err(rejected("the current branch cannot be deleted").into());
    }
    if !branch_exists(&repo, branch)? {
        return Err(GitError::InvalidBranch(branch.to_string()));
    }
    repo.edit_reference(RefEdit {
        change: Change::Delete {
            expected: PreviousValue::MustExist,
            log: RefLog::AndReference,
        },
        name,
        deref: false,
    })
    .map_err(rejected)?;
    Ok(())
}

fn action_for(path: &str, exists: bool, content: Option<&[u8]>) -> Option<CommitAction> {
    match (exists, content) {
        (_, Some(content)) => Some(CommitAction::Update {
            path: path.to_string(),
            content: content.to_vec(),
            last_commit_id: None,
        }),
        (true, None) => Some(CommitAction::Delete {
            path: path.to_string(),
            last_commit_id: None,
        }),
        (false, None) => None,
    }
}

/// Work to bring into the current branch.
struct Incoming<'a> {
    commit: ObjectId,
    /// Who or what it comes from (a person or a branch).
    label: &'a str,
    message: &'a str,
    /// The local branch has no commits and the workspace is fresh: take the
    /// incoming work instead of protecting the local files.
    adopt_fresh: bool,
}

/// Brings `theirs` into the current branch: nothing, a fast-forward, a merge
/// commit, or a pending merge when items conflict.
fn integrate<F: WorkspaceFiles>(
    repo: &gix::Repository,
    files: &F,
    link: &WorkspaceLink,
    identity: Option<&GitIdentity>,
    incoming: Incoming<'_>,
) -> Result<(Integration, Applied), GitError> {
    let Incoming {
        commit: theirs,
        label,
        message,
        adopt_fresh,
    } = incoming;
    let mut link = link.clone();
    let tracked = link.tracked_files();
    let (name, ours) = head(repo)?;
    let unchanged = |link| {
        Ok((
            Integration::UpToDate,
            Applied {
                files: Vec::new(),
                link,
            },
        ))
    };
    if let Some(ours) = ours
        && (ours == theirs || is_ancestor(repo, theirs, ours)?)
    {
        return unchanged(link);
    }
    let theirs_tree = Some(commit_tree(repo, theirs)?);
    let ours_tree = ours.map(|ours| commit_tree(repo, ours)).transpose()?;

    let fast_forward = match ours {
        None => true,
        Some(ours) => is_ancestor(repo, ours, theirs)?,
    };
    if fast_forward {
        let changed = changed_between(repo, ours_tree, theirs_tree, &tracked)?;
        // A fresh workspace with no commits takes the published work as is.
        if !(adopt_fresh && ours.is_none()) {
            require_clean(repo, files, ours_tree, &changed)?;
        }
        move_branch(repo, &name, ours, theirs, "fast-forward")?;
        for name in &changed {
            let content = file_at(repo, theirs_tree, name)?;
            write_local(files, &mut link, name, content.as_deref())?;
        }
        if let Some(tree) = theirs_tree {
            write_index(repo, tree)?;
        }
        return Ok((
            Integration::FastForward,
            Applied {
                files: changed.iter().map(|name| (*name).to_string()).collect(),
                link,
            },
        ));
    }

    let ours = ours.ok_or_else(|| rejected("nothing to merge into"))?;
    let base = repo.merge_base(ours, theirs).map_err(rejected)?;
    let base_tree = base
        .map(|base| commit_tree(repo, base.detach()))
        .transpose()?;
    let mut merged: BTreeMap<&'static str, Option<Vec<u8>>> = BTreeMap::new();
    let mut conflicts: Vec<&'static str> = Vec::new();
    let mut base_versions: BTreeMap<&'static str, Option<Vec<u8>>> = BTreeMap::new();
    let mut theirs_versions: BTreeMap<&'static str, Option<Vec<u8>>> = BTreeMap::new();
    for &name in &tracked {
        let ours_content = file_at(repo, ours_tree, name)?;
        let theirs_content = file_at(repo, theirs_tree, name)?;
        if ours_content == theirs_content {
            continue;
        }
        let base_content = file_at(repo, base_tree, name)?;
        match merge_file(
            name,
            base_content.as_deref(),
            ours_content.as_deref(),
            theirs_content.as_deref(),
        ) {
            FileMerge::Merged(content) => {
                if content != ours_content {
                    merged.insert(name, content);
                }
            }
            FileMerge::Conflict => {
                conflicts.push(name);
                base_versions.insert(name, base_content);
                theirs_versions.insert(name, theirs_content);
            }
        }
    }
    let touched: Vec<&'static str> = merged
        .keys()
        .copied()
        .chain(conflicts.iter().copied())
        .collect();
    require_clean(repo, files, ours_tree, &touched)?;

    let mut actions = Vec::new();
    for (name, content) in &merged {
        let exists = blob_at(repo, ours_tree, name)?.is_some();
        actions.extend(action_for(name, exists, content.as_deref()));
    }
    for name in &conflicts {
        let exists = blob_at(repo, ours_tree, name)?.is_some();
        let theirs_content = theirs_versions.get(name).cloned().flatten();
        actions.extend(action_for(name, exists, theirs_content.as_deref()));
    }
    let merge_tree = apply_actions(repo, ours_tree, &actions)?;

    if conflicts.is_empty() {
        let identity = identity.ok_or(GitError::IdentityMissing)?;
        let commit = write_commit(repo, identity, message, merge_tree, vec![ours, theirs])?;
        move_branch(repo, &name, Some(ours), commit, message)?;
        for (name, content) in &merged {
            write_local(files, &mut link, name, content.as_deref())?;
        }
        write_index(repo, merge_tree)?;
        return Ok((
            Integration::Merged,
            Applied {
                files: merged.keys().map(|name| (*name).to_string()).collect(),
                link,
            },
        ));
    }

    MergeState {
        theirs,
        label: label.to_string(),
        merge_tree,
        files: touched.iter().map(|name| (*name).to_string()).collect(),
        conflicts: conflicts.iter().map(|name| (*name).to_string()).collect(),
    }
    .save(repo.git_dir())?;
    for (name, content) in &merged {
        write_local(files, &mut link, name, content.as_deref())?;
    }
    // Conflicted files keep our version on disk; with the merge base as their
    // base and their version as "remote", the sync use cases classify them as
    // conflicts and the existing resolver applies.
    for name in &conflicts {
        match base_versions.get(name).cloned().flatten() {
            Some(bytes) => {
                link.base.insert((*name).to_string(), content_hash(&bytes));
            }
            None => {
                link.base.remove(*name);
            }
        }
    }
    Ok((
        Integration::Conflicts(conflicts.iter().map(|name| (*name).to_string()).collect()),
        Applied {
            files: merged.keys().map(|name| (*name).to_string()).collect(),
            link,
        },
    ))
}

/// Merges another local branch into the current one.
pub fn merge_branch<F: WorkspaceFiles>(
    root: &Path,
    files: &F,
    link: &WorkspaceLink,
    identity: Option<&GitIdentity>,
    branch: &str,
) -> Result<(Integration, Applied), GitError> {
    valid_branch(branch)?;
    let repo = open_workspace(root)?;
    ensure_no_merge(&repo)?;
    let theirs = ref_target(&repo, &branch_ref(branch)?)?
        .ok_or_else(|| GitError::InvalidBranch(branch.to_string()))?;
    integrate(
        &repo,
        files,
        link,
        identity,
        Incoming {
            commit: theirs,
            label: branch,
            message: &format!("Merge branch '{branch}'"),
            adopt_fresh: false,
        },
    )
}

/// Commits the pending merge: the merge tree plus the files as resolved on
/// disk, with both sides as parents.
pub fn finish_merge<F: WorkspaceFiles>(
    root: &Path,
    files: &F,
    link: &WorkspaceLink,
    identity: Option<&GitIdentity>,
    message: &str,
) -> Result<(String, Applied), GitError> {
    let repo = open_workspace(root)?;
    let state = MergeState::load(repo.git_dir())?.ok_or(GitError::NoMergeInProgress)?;
    let mut unresolved = Vec::new();
    for name in &state.conflicts {
        let local = read_local(files, name)?;
        let theirs = file_at(&repo, Some(state.merge_tree), name)?;
        let state = classify(
            link.base.get(name).map(String::as_str),
            local.as_deref().map(content_hash).as_deref(),
            theirs.as_deref().map(content_hash).as_deref(),
        );
        if state == FileState::Conflict {
            unresolved.push(name.clone());
        }
    }
    if !unresolved.is_empty() {
        return Err(GitError::Conflicts(unresolved));
    }
    let identity = identity.ok_or(GitError::IdentityMissing)?;
    let (name, ours) = head(&repo)?;
    let ours = ours.ok_or_else(|| rejected("nothing to merge into"))?;

    let mut actions = Vec::new();
    let mut link = link.clone();
    for file in &state.files {
        let local = read_local(files, file)?;
        if local != file_at(&repo, Some(state.merge_tree), file)? {
            let exists = blob_at(&repo, Some(state.merge_tree), file)?.is_some();
            actions.extend(action_for(file, exists, local.as_deref()));
        }
        match &local {
            Some(bytes) => {
                link.base.insert(file.clone(), content_hash(bytes));
            }
            None => {
                link.base.remove(file);
            }
        }
    }
    let tree = apply_actions(&repo, Some(state.merge_tree), &actions)?;
    let message = match message.trim() {
        "" => format!("Merge changes from {}", state.label),
        message => message.to_string(),
    };
    let commit = write_commit(&repo, identity, &message, tree, vec![ours, state.theirs])?;
    move_branch(&repo, &name, Some(ours), commit, &message)?;
    write_index(&repo, tree)?;
    MergeState::clear(repo.git_dir())?;
    Ok((
        commit.to_string(),
        Applied {
            files: Vec::new(),
            link,
        },
    ))
}

/// Drops the pending merge and puts the touched files back as committed.
pub fn abort_merge<F: WorkspaceFiles>(
    root: &Path,
    files: &F,
    link: &WorkspaceLink,
) -> Result<Applied, GitError> {
    let repo = open_workspace(root)?;
    let state = MergeState::load(repo.git_dir())?.ok_or(GitError::NoMergeInProgress)?;
    let (_, ours) = head(&repo)?;
    let ours_tree = ours.map(|ours| commit_tree(&repo, ours)).transpose()?;
    let mut link = link.clone();
    for name in &state.files {
        let content = file_at(&repo, ours_tree, name)?;
        write_local(files, &mut link, name, content.as_deref())?;
    }
    MergeState::clear(repo.git_dir())?;
    Ok(Applied {
        files: state.files,
        link,
    })
}

/// Puts `file` back as `commit` left it, as an uncommitted change.
pub fn restore_file<F: WorkspaceFiles>(
    root: &Path,
    files: &F,
    commit: &str,
    file: &str,
) -> Result<(), GitError> {
    let repo = open_workspace(root)?;
    ensure_no_merge(&repo)?;
    let id = ObjectId::from_hex(commit.as_bytes()).map_err(rejected)?;
    let tree = commit_tree(&repo, id)?;
    match file_at(&repo, Some(tree), file)? {
        Some(bytes) => files.write(file, &bytes).map_err(GitError::Files),
        None => files.delete(file).map_err(GitError::Files),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncOutcome {
    /// This installation's branch moved in the shared folder.
    pub published: bool,
    /// People whose work was integrated (fast-forward or merge).
    pub integrated: Vec<String>,
    /// People whose latest work is still being delivered by the sync client.
    pub syncing: Vec<String>,
    /// Whose work is waiting in a pending merge, with its conflicted files.
    pub merging: Option<(String, Vec<String>)>,
    pub files: Vec<String>,
    pub link: WorkspaceLink,
}

/// Publishes the current branch, integrates everyone else's complete work on
/// the same branch, and publishes the result. Stops at the first merge that
/// needs decisions.
pub fn sync<F: WorkspaceFiles>(
    root: &Path,
    files: &F,
    link: &WorkspaceLink,
    identity: Option<&GitIdentity>,
    shared: &Path,
    me: &str,
) -> Result<SyncOutcome, GitError> {
    let repo = open_workspace(root)?;
    ensure_no_merge(&repo)?;
    let mut published = publish(root, shared, me)?;
    let remote = open_bare(shared)?;
    let (name, local_head) = head(&repo)?;
    let adopt_fresh = local_head.is_none() && is_fresh(files, &link.tracked_files())?;
    let mut outcome = SyncOutcome {
        published,
        integrated: Vec::new(),
        syncing: Vec::new(),
        merging: None,
        files: Vec::new(),
        link: link.clone(),
    };
    for peer in peer_heads(&remote, me, &short_name(&name))? {
        let (_, local_head) = head(&repo)?;
        let label = match remote.find_commit(peer.head) {
            Ok(commit) => commit
                .author()
                .map(|author| author.name.to_string())
                .unwrap_or_else(|_| peer.peer.clone()),
            Err(_) => peer.peer.clone(),
        };
        match peer_state(&repo, &remote, local_head, peer.head)? {
            PeerState::UpToDate => continue,
            PeerState::Syncing => {
                outcome.syncing.push(label);
                continue;
            }
            PeerState::Incoming => {}
        }
        if let Some(commits) = missing_commits(&remote, &repo, peer.head)? {
            copy_commits(&remote, &repo, &commits)?;
        }
        let (integration, applied) = integrate(
            &repo,
            files,
            &outcome.link,
            identity,
            Incoming {
                commit: peer.head,
                label: &label,
                message: &format!("Merge changes from {label}"),
                adopt_fresh,
            },
        )?;
        outcome.link = applied.link;
        outcome.files.extend(applied.files);
        match integration {
            Integration::UpToDate => {}
            Integration::FastForward | Integration::Merged => outcome.integrated.push(label),
            Integration::Conflicts(conflicts) => {
                outcome.merging = Some((label, conflicts));
                break;
            }
        }
    }
    if !outcome.integrated.is_empty() && outcome.merging.is_none() {
        published |= publish(root, shared, me)?;
        outcome.published = published;
    }
    outcome.files.sort();
    outcome.files.dedup();
    Ok(outcome)
}
