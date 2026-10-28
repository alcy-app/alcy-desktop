use std::collections::BTreeMap;

use thiserror::Error;

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

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WorkspaceLinkError {
    #[error("o caminho dentro do repositório é inválido")]
    InvalidDirectory,
    #[error("a pasta do OneDrive é inválida")]
    InvalidFolder,
}

/// Where the shared copy of the workspace lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteLocation {
    Gitlab {
        account_id: String,
        project_id: u64,
        project_path: String,
        branch: String,
        /// Folder inside the repository (empty = root), without edge slashes.
        directory: String,
    },
    /// A OneDrive or SharePoint folder, addressed by ids so renames and
    /// folders shared by other people keep working (ADR 0063).
    Onedrive {
        account_id: String,
        drive_id: String,
        folder_id: String,
        /// Folder path shown to the user; never used for addressing.
        display_path: String,
    },
}

/// Link between a workspace and its remote copy.
///
/// `base` holds the SHA-256 of each file at the last sync; a file missing
/// from the map did not exist at that point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceLink {
    pub location: RemoteLocation,
    pub include_environments: bool,
    pub base: BTreeMap<String, String>,
}

impl WorkspaceLink {
    pub fn gitlab(
        account_id: impl Into<String>,
        project_id: u64,
        project_path: impl Into<String>,
        branch: impl Into<String>,
        directory: &str,
        include_environments: bool,
    ) -> Result<Self, WorkspaceLinkError> {
        Ok(Self::with_location(
            RemoteLocation::Gitlab {
                account_id: account_id.into(),
                project_id,
                project_path: project_path.into(),
                branch: branch.into(),
                directory: normalize_directory(directory)?,
            },
            include_environments,
        ))
    }

    pub fn onedrive(
        account_id: impl Into<String>,
        drive_id: &str,
        folder_id: &str,
        display_path: impl Into<String>,
        include_environments: bool,
    ) -> Result<Self, WorkspaceLinkError> {
        let drive_id = drive_id.trim();
        let folder_id = folder_id.trim();
        let is_id = |id: &str| !id.is_empty() && !id.contains(['/', '\\', '?', '#', ':']);
        if !is_id(drive_id) || !is_id(folder_id) {
            return Err(WorkspaceLinkError::InvalidFolder);
        }
        Ok(Self::with_location(
            RemoteLocation::Onedrive {
                account_id: account_id.into(),
                drive_id: drive_id.to_string(),
                folder_id: folder_id.to_string(),
                display_path: display_path.into(),
            },
            include_environments,
        ))
    }

    fn with_location(location: RemoteLocation, include_environments: bool) -> Self {
        Self {
            location,
            include_environments,
            base: BTreeMap::new(),
        }
    }

    pub fn account_id(&self) -> &str {
        match &self.location {
            RemoteLocation::Gitlab { account_id, .. }
            | RemoteLocation::Onedrive { account_id, .. } => account_id,
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

    /// Path of the file in the remote: inside the repository directory on
    /// GitLab, relative to the linked folder on OneDrive.
    pub fn remote_path(&self, file_name: &str) -> String {
        match &self.location {
            RemoteLocation::Gitlab { directory, .. } if !directory.is_empty() => {
                format!("{directory}/{file_name}")
            }
            _ => file_name.to_string(),
        }
    }
}

fn normalize_directory(input: &str) -> Result<String, WorkspaceLinkError> {
    let trimmed = input.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let invalid = trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'));
    if invalid {
        return Err(WorkspaceLinkError::InvalidDirectory);
    }
    Ok(trimmed.to_string())
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
    fn gitlab_link_builds_remote_paths_and_tracked_files() {
        let link = WorkspaceLink::gitlab("a", 7, "eq/proj", "main", "/alcy/", false).unwrap();
        assert!(matches!(
            &link.location,
            RemoteLocation::Gitlab { directory, .. } if directory == "alcy"
        ));
        assert_eq!(link.account_id(), "a");
        assert_eq!(
            link.remote_path("alcy-collections.json"),
            "alcy/alcy-collections.json"
        );
        assert_eq!(link.tracked_files().len(), 5);
        assert!(link.tracked_files().contains(&VALUE_MONITORS_FILE));

        let root = WorkspaceLink::gitlab("a", 7, "eq/proj", "main", "", true).unwrap();
        assert_eq!(root.remote_path("alcy-flows.json"), "alcy-flows.json");
        assert!(root.tracked_files().contains(&ENVIRONMENTS_FILE));

        assert_eq!(
            WorkspaceLink::gitlab("a", 7, "p", "main", "a/../b", false),
            Err(WorkspaceLinkError::InvalidDirectory)
        );
    }

    #[test]
    fn onedrive_link_addresses_files_relative_to_the_folder() {
        let link =
            WorkspaceLink::onedrive("m", " b!drive ", "01ABC", "/Equipe/Alcy", true).unwrap();
        assert_eq!(link.account_id(), "m");
        assert!(matches!(
            &link.location,
            RemoteLocation::Onedrive { drive_id, .. } if drive_id == "b!drive"
        ));
        assert_eq!(
            link.remote_path("alcy-collections.json"),
            "alcy-collections.json"
        );
        assert!(link.tracked_files().contains(&ENVIRONMENTS_FILE));

        for (drive, folder) in [("", "f"), ("d", " "), ("d/x", "f"), ("d", "../f")] {
            assert_eq!(
                WorkspaceLink::onedrive("m", drive, folder, "", false),
                Err(WorkspaceLinkError::InvalidFolder),
                "{drive} {folder}"
            );
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
