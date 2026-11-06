use std::path::Path;

use alcy_app::RemoteError;
use alcy_domain::is_valid_branch_name;

use crate::{open_bare as open, rejected};

/// What a folder chosen to hold the repository contains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderKind {
    /// Nothing in it yet: a repository can be created there.
    Empty,
    /// A bare repository, ready to link.
    Bare {
        branches: Vec<String>,
        /// Branch `HEAD` names, which may not have commits yet.
        head_branch: Option<String>,
    },
    /// A repository with a working tree (or its `.git` folder). Writing to
    /// its checked-out branch would leave that working tree behind.
    NonBare,
    /// Other files that are not a git repository.
    NotARepository,
}

pub fn inspect_folder(path: &Path) -> Result<FolderKind, RemoteError> {
    let mut entries = std::fs::read_dir(path)
        .map_err(|error| RemoteError::Network(format!("{}: {error}", path.display())))?;
    if entries.next().is_none() {
        return Ok(FolderKind::Empty);
    }
    if path.join(".git").exists() {
        return Ok(FolderKind::NonBare);
    }
    if !path.join("HEAD").is_file() || !path.join("objects").is_dir() {
        return Ok(FolderKind::NotARepository);
    }
    let repo = match open(path) {
        Ok(repo) => repo,
        Err(RemoteError::Rejected(_)) if gix::open(path).is_ok() => return Ok(FolderKind::NonBare),
        Err(RemoteError::Rejected(_)) => return Ok(FolderKind::NotARepository),
        Err(error) => return Err(error),
    };
    let mut branches = Vec::new();
    let platform = repo.references().map_err(rejected)?;
    for reference in platform.local_branches().map_err(rejected)? {
        let reference = reference.map_err(rejected)?;
        branches.push(reference.name().shorten().to_string());
    }
    branches.sort();
    let head_branch = repo
        .head_name()
        .map_err(rejected)?
        .filter(|name| name.as_bstr().starts_with(b"refs/heads/"))
        .map(|name| name.shorten().to_string());
    Ok(FolderKind::Bare {
        branches,
        head_branch,
    })
}

/// Creates a bare repository in an empty folder, with `HEAD` on `branch`.
pub fn init_bare(path: &Path, branch: &str) -> Result<(), RemoteError> {
    if !is_valid_branch_name(branch) {
        return Err(RemoteError::Rejected(format!(
            "invalid branch name: {branch}"
        )));
    }
    if inspect_folder(path)? != FolderKind::Empty {
        return Err(RemoteError::Rejected("the folder is not empty".to_string()));
    }
    gix::init_bare(path).map_err(rejected)?;
    std::fs::write(path.join("HEAD"), format!("ref: refs/heads/{branch}\n")).map_err(rejected)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_folder_kinds_apart() {
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(inspect_folder(empty.path()).unwrap(), FolderKind::Empty);

        init_bare(empty.path(), "alcy").unwrap();
        assert_eq!(
            inspect_folder(empty.path()).unwrap(),
            FolderKind::Bare {
                branches: Vec::new(),
                head_branch: Some("alcy".to_string()),
            }
        );
        assert!(init_bare(empty.path(), "main").is_err());

        let worktree = tempfile::tempdir().unwrap();
        gix::init(worktree.path()).unwrap();
        assert_eq!(
            inspect_folder(worktree.path()).unwrap(),
            FolderKind::NonBare
        );
        assert_eq!(
            inspect_folder(&worktree.path().join(".git")).unwrap(),
            FolderKind::NonBare
        );

        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("notes.txt"), "x").unwrap();
        assert_eq!(
            inspect_folder(other.path()).unwrap(),
            FolderKind::NotARepository
        );

        assert!(matches!(
            inspect_folder(&other.path().join("missing")),
            Err(RemoteError::Network(_))
        ));

        let fresh = tempfile::tempdir().unwrap();
        assert!(init_bare(fresh.path(), "a b").is_err());
    }
}
