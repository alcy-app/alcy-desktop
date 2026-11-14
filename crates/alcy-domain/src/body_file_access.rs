//! Which body files a send may read (spec 0163).
//!
//! A collection decides the path of its form-data and binary files, and that
//! path reaches the app through imports, clones, pulls and synced folders. So
//! a send only reads a file inside the workspace, a file this person picked
//! in the native dialog for this workspace, or any file when they turned the
//! security setting on. Paths are compared after canonicalization (done by
//! the caller), so `..` and symlinks cannot reach outside.

use std::path::{Component, Path, PathBuf};

/// Why a body file may or may not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyFileAccessStatus {
    InsideWorkspace,
    /// Outside the workspace, picked by this person for this workspace.
    Granted,
    /// Outside the workspace, allowed by the security setting.
    AllowedBySetting,
    Blocked,
}

impl BodyFileAccessStatus {
    pub fn is_allowed(self) -> bool {
        self != Self::Blocked
    }
}

/// What a send may read in one workspace: its canonical root, the setting
/// and the files this person picked there.
#[derive(Debug, Clone, Default)]
pub struct BodyFileAccess {
    canonical_root: Option<PathBuf>,
    allow_outside: bool,
    grants: Vec<PathBuf>,
}

impl BodyFileAccess {
    /// `canonical_root` is `None` when the workspace folder could not be
    /// canonicalized: then nothing counts as inside it.
    pub fn new(canonical_root: Option<PathBuf>, allow_outside: bool, grants: Vec<PathBuf>) -> Self {
        Self {
            // A root without components would contain every path.
            canonical_root: canonical_root.filter(|root| root.components().next().is_some()),
            allow_outside,
            grants,
        }
    }

    /// No workspace, no grants, setting off: only blocks.
    pub const fn empty() -> Self {
        Self {
            canonical_root: None,
            allow_outside: false,
            grants: Vec::new(),
        }
    }

    pub fn canonical_root(&self) -> Option<&Path> {
        self.canonical_root.as_deref()
    }

    /// Status of an existing file, given by its canonical path.
    pub fn status_of(&self, canonical_file: &Path) -> BodyFileAccessStatus {
        if self
            .canonical_root
            .as_deref()
            .is_some_and(|root| path_is_within(root, canonical_file))
        {
            BodyFileAccessStatus::InsideWorkspace
        } else if self
            .grants
            .iter()
            .any(|grant| same_path(grant, canonical_file))
        {
            BodyFileAccessStatus::Granted
        } else if self.allow_outside {
            BodyFileAccessStatus::AllowedBySetting
        } else {
            BodyFileAccessStatus::Blocked
        }
    }
}

/// Whether `path` is `root` or lies under it, comparing whole components
/// (`/ws-other` is not inside `/ws`). Windows compares without case.
pub fn path_is_within(root: &Path, path: &Path) -> bool {
    let mut path_components = path.components();
    root.components().all(|root_component| {
        path_components
            .next()
            .is_some_and(|component| same_component(root_component, component))
    })
}

/// Whether two canonical paths name the same file.
pub fn same_path(left: &Path, right: &Path) -> bool {
    left.components().count() == right.components().count() && path_is_within(left, right)
}

/// Whether a saved body file path names a file outside the workspace by
/// itself: absolute (in either system's syntax) or climbing out with `..`.
/// Used to warn on import; a send decides with canonical paths.
pub fn points_outside_workspace(path: &str) -> bool {
    let bytes = path.as_bytes();
    let windows_absolute = path.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    if windows_absolute || path.starts_with('/') {
        return true;
    }
    let mut depth = 0usize;
    for component in path.split(['/', '\\']) {
        match component {
            "" | "." => {}
            ".." => match depth.checked_sub(1) {
                Some(parent) => depth = parent,
                None => return true,
            },
            _ => depth += 1,
        }
    }
    false
}

fn same_component(left: Component<'_>, right: Component<'_>) -> bool {
    if cfg!(windows) {
        left.as_os_str().to_string_lossy().to_lowercase()
            == right.as_os_str().to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join("workspace")
    }

    #[test]
    fn a_file_under_the_root_is_inside_the_workspace() {
        let access = BodyFileAccess::new(Some(root()), false, vec![]);
        assert_eq!(
            access.status_of(&root().join("files/photo.png")),
            BodyFileAccessStatus::InsideWorkspace
        );
    }

    #[test]
    fn a_sibling_folder_with_the_same_prefix_is_outside() {
        let access = BodyFileAccess::new(Some(root()), false, vec![]);
        let sibling = std::env::temp_dir().join("workspace-other/key");
        assert_eq!(access.status_of(&sibling), BodyFileAccessStatus::Blocked);
    }

    #[test]
    fn a_file_outside_is_blocked_unless_granted_or_allowed() {
        let outside = std::env::temp_dir().join("elsewhere/private.txt");
        let blocked = BodyFileAccess::new(Some(root()), false, vec![]);
        let granted = BodyFileAccess::new(Some(root()), false, vec![outside.clone()]);
        let allowed = BodyFileAccess::new(Some(root()), true, vec![]);

        assert_eq!(blocked.status_of(&outside), BodyFileAccessStatus::Blocked);
        assert_eq!(granted.status_of(&outside), BodyFileAccessStatus::Granted);
        assert_eq!(
            allowed.status_of(&outside),
            BodyFileAccessStatus::AllowedBySetting
        );
        assert!(!BodyFileAccessStatus::Blocked.is_allowed());
        assert!(BodyFileAccessStatus::Granted.is_allowed());
    }

    #[test]
    fn a_grant_covers_only_its_own_file() {
        let granted = std::env::temp_dir().join("elsewhere/report.pdf");
        let access = BodyFileAccess::new(Some(root()), false, vec![granted.clone()]);
        assert_eq!(
            access.status_of(&granted.join("nested")),
            BodyFileAccessStatus::Blocked
        );
        assert_eq!(
            access.status_of(&std::env::temp_dir().join("elsewhere")),
            BodyFileAccessStatus::Blocked
        );
    }

    #[test]
    fn without_a_root_nothing_is_inside() {
        let file = root().join("files/photo.png");
        assert_eq!(
            BodyFileAccess::new(None, false, vec![]).status_of(&file),
            BodyFileAccessStatus::Blocked
        );
        assert_eq!(
            BodyFileAccess::new(Some(PathBuf::new()), false, vec![]).status_of(&file),
            BodyFileAccessStatus::Blocked
        );
    }

    #[test]
    fn recognizes_paths_that_point_outside_by_themselves() {
        for outside in [
            "/home/ana/private/notes.txt",
            r"C:\Users\Ana\private\notes.txt",
            r"\\server\share\file",
            "../private",
            "files/../../private",
            r"files\..\..\private",
        ] {
            assert!(points_outside_workspace(outside), "{outside}");
        }
        for inside in ["files/photo.png", "./a.bin", "files/../a.bin", ""] {
            assert!(!points_outside_workspace(inside), "{inside}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_compares_paths_without_case() {
        let access = BodyFileAccess::new(Some(PathBuf::from(r"C:\Users\Ana\api")), false, vec![]);
        assert_eq!(
            access.status_of(Path::new(r"c:\users\ana\API\files\a.bin")),
            BodyFileAccessStatus::InsideWorkspace
        );
    }
}
