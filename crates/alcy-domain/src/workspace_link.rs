use std::collections::BTreeMap;

/// Workspace files under version control by default.
pub const VERSIONED_FILES: [&str; 5] = [
    "alcy-workspace.json",
    "alcy-collections.json",
    "alcy-flows.json",
    API_DOCS_FILE,
    VALUE_MONITORS_FILE,
];

/// Imported API documentation (ADR 0035), versioned with the collections
/// that reference it.
pub const API_DOCS_FILE: &str = "alcy-api-docs.json";

/// Value monitors: validation rules for response fields, shared across the
/// workspace's requests.
pub const VALUE_MONITORS_FILE: &str = "alcy-value-monitors.json";

/// Versioned only by opt-in (it holds secrets in plain text).
pub const ENVIRONMENTS_FILE: &str = "alcy-environments.json";

/// Workspace manifest: a remote update never deletes it.
pub const MANIFEST_FILE: &str = "alcy-workspace.json";

/// Link between a workspace and its git repository, kept in the workspace
/// folder (ADR 0074). The branch comes from `HEAD` and the remote from the
/// repository's configuration.
///
/// `base` holds the SHA-256 of each file at the last sync; a file missing
/// from the map did not exist at that point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceLink {
    pub include_environments: bool,
    pub base: BTreeMap<String, String>,
}

impl WorkspaceLink {
    pub fn new(include_environments: bool) -> Self {
        Self {
            include_environments,
            base: BTreeMap::new(),
        }
    }

    /// Names (relative to the workspace root) of the versioned files.
    pub fn tracked_files(&self) -> Vec<&'static str> {
        let mut files = VERSIONED_FILES.to_vec();
        if self.include_environments {
            files.push(ENVIRONMENTS_FILE);
        }
        files
    }
}

/// Subset of `git check-ref-format` rules for a single branch name: enough to
/// keep the name a plain path under `refs/heads/`.
pub fn is_valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name.contains("/.")
        && name != "@"
        && !name
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c))
}

/// State of a versioned file, from comparing three contents: the last sync
/// (base), the local one and the remote one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    Clean,
    LocalAdded,
    LocalModified,
    LocalDeleted,
    /// Changed (or deleted) only in the remote; an update applies it.
    RemoteChanged,
    /// Changed on both sides to different contents.
    Conflict,
}

impl FileState {
    pub fn is_local_change(self) -> bool {
        matches!(
            self,
            Self::LocalAdded | Self::LocalModified | Self::LocalDeleted
        )
    }
}

/// Classifies a file from its hashes (`None` = missing).
pub fn classify(base: Option<&str>, local: Option<&str>, remote: Option<&str>) -> FileState {
    if local == remote {
        return FileState::Clean;
    }
    if local == base {
        return FileState::RemoteChanged;
    }
    if remote == base {
        return match (base, local) {
            (_, None) => FileState::LocalDeleted,
            (None, Some(_)) => FileState::LocalAdded,
            (Some(_), Some(_)) => FileState::LocalModified,
        };
    }
    FileState::Conflict
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environments_are_tracked_only_by_opt_in() {
        assert!(
            !WorkspaceLink::new(false)
                .tracked_files()
                .contains(&ENVIRONMENTS_FILE)
        );
        assert!(
            WorkspaceLink::new(true)
                .tracked_files()
                .contains(&ENVIRONMENTS_FILE)
        );
    }

    #[test]
    fn branch_names_follow_git_rules() {
        for branch in [
            "", "a b", "a..b", "-x", "x.lock", "x/", "a:b", "a@{1}", "@", ".x", "a//b",
        ] {
            assert!(!is_valid_branch_name(branch), "{branch:?}");
        }
        for branch in ["main", "team/alcy", "release-1.2"] {
            assert!(is_valid_branch_name(branch), "{branch}");
        }
    }

    #[test]
    fn classifies_every_combination() {
        // Equal (including missing) => clean.
        assert_eq!(classify(Some("a"), Some("a"), Some("a")), FileState::Clean);
        assert_eq!(classify(None, None, None), FileState::Clean);
        // Changed on both sides to the same content => clean.
        assert_eq!(classify(Some("a"), Some("b"), Some("b")), FileState::Clean);
        // Local only.
        assert_eq!(
            classify(Some("a"), Some("b"), Some("a")),
            FileState::LocalModified
        );
        assert_eq!(classify(None, Some("b"), None), FileState::LocalAdded);
        assert_eq!(
            classify(Some("a"), None, Some("a")),
            FileState::LocalDeleted
        );
        // Remote only.
        assert_eq!(
            classify(Some("a"), Some("a"), Some("b")),
            FileState::RemoteChanged
        );
        assert_eq!(classify(None, None, Some("b")), FileState::RemoteChanged);
        assert_eq!(
            classify(Some("a"), Some("a"), None),
            FileState::RemoteChanged
        );
        // Diverged.
        assert_eq!(
            classify(Some("a"), Some("b"), Some("c")),
            FileState::Conflict
        );
        assert_eq!(classify(None, Some("b"), Some("c")), FileState::Conflict);
        assert_eq!(classify(Some("a"), None, Some("c")), FileState::Conflict);
        assert_eq!(classify(Some("a"), Some("b"), None), FileState::Conflict);
    }
}
