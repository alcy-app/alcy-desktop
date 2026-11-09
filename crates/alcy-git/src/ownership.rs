//! Who may delete a workspace's files. A folder shared through a cloud drive
//! or a network share is the same folder for everyone, so deleting it deletes
//! it for the whole team: only whoever started the repository may do that.
//!
//! This guards against accidents inside Alcy; it is not access control. The
//! git identity is self-declared and the folder's permissions are the file
//! system's.

use std::path::Path;

use alcy_domain::GitIdentity;
use gix::ObjectId;

use crate::{GitError, open_workspace, rejected};

/// Set by `clone` in the new copy's own configuration, which is neither
/// versioned nor pushed. A clone is a separate folder: deleting it affects
/// only the person who made it.
pub(crate) const CLONED_COPY_KEY: &str = "alcy.clonedCopy";

/// Author of the repository's first commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryOwner {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileDeletion {
    Allowed,
    OwnerOnly(RepositoryOwner),
}

/// Whether `identity` may delete the workspace folder at `root`. An
/// unreadable repository is an error, so callers keep the files: a folder in
/// the middle of a sync is exactly when a wrong answer would cost the most.
pub fn file_deletion(
    root: &Path,
    identity: Option<&GitIdentity>,
) -> Result<FileDeletion, GitError> {
    if !root.join(".git").is_dir() {
        return Ok(FileDeletion::Allowed);
    }
    let repo = open_workspace(root)?;
    if repo.config_snapshot().boolean(CLONED_COPY_KEY) == Some(true) {
        return Ok(FileDeletion::Allowed);
    }
    let Some(owner) = repository_owner(&repo)? else {
        return Ok(FileDeletion::Allowed);
    };
    let is_owner = identity.is_some_and(|identity| same_email(&identity.email, &owner.email));
    Ok(if is_owner {
        FileDeletion::Allowed
    } else {
        FileDeletion::OwnerOnly(owner)
    })
}

/// The oldest root reachable from `HEAD`, so every copy with the same commits
/// agrees even after unrelated histories were merged. `None` without commits.
fn repository_owner(repo: &gix::Repository) -> Result<Option<RepositoryOwner>, GitError> {
    let Some(tip) = repo.head().map_err(rejected)?.id() else {
        return Ok(None);
    };
    let mut oldest: Option<(i64, ObjectId, RepositoryOwner)> = None;
    for info in repo.rev_walk([tip.detach()]).all().map_err(rejected)? {
        let info = info.map_err(rejected)?;
        if !info.parent_ids.is_empty() {
            continue;
        }
        let commit = repo.find_commit(info.id).map_err(rejected)?;
        let author = commit.author().map_err(rejected)?;
        let time = author.time().map(|time| time.seconds).unwrap_or_default();
        if oldest
            .as_ref()
            .is_none_or(|(seconds, id, _)| (time, info.id) < (*seconds, *id))
        {
            let owner = RepositoryOwner {
                name: author.name.to_string(),
                email: author.email.to_string(),
            };
            oldest = Some((time, info.id, owner));
        }
    }
    Ok(oldest.map(|(_, _, owner)| owner))
}

/// A commit without an e-mail identifies nobody.
fn same_email(left: &str, right: &str) -> bool {
    let left = left.trim();
    !left.is_empty() && left.eq_ignore_ascii_case(right.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_emails_ignoring_case_and_never_matches_a_blank_one() {
        assert!(same_email("Ana@Example.com ", "ana@example.com"));
        assert!(!same_email("bia@example.com", "ana@example.com"));
        assert!(!same_email(" ", " "));
    }
}
