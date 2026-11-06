use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use alcy_domain::{RemoteLocation, WorkspaceLink};
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

/// GitLab links stay on v1 so builds without other providers keep reading
/// them; v2 carries a `provider` tag and is written for OneDrive (ADR 0063)
/// and git folders (ADR 0074; builds without that provider reject the tag).
const GITLAB_VERSION: u32 = 1;
const PROVIDER_VERSION: u32 = 2;
pub(crate) const LINK_FILE_NAME: &str = "alcy-git-link.json";

#[derive(Deserialize)]
struct VersionProbe {
    version: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGitlabLink {
    version: u32,
    account_id: String,
    project_id: u64,
    project_path: String,
    branch: String,
    #[serde(default)]
    directory: String,
    #[serde(default)]
    include_environments: bool,
    #[serde(default)]
    base: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProviderLink {
    version: u32,
    #[serde(flatten)]
    location: PersistedLocation,
    #[serde(default)]
    include_environments: bool,
    #[serde(default)]
    base: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "camelCase")]
enum PersistedLocation {
    #[serde(rename_all = "camelCase")]
    Onedrive {
        account_id: String,
        drive_id: String,
        folder_id: String,
        #[serde(default)]
        display_path: String,
    },
    #[serde(rename_all = "camelCase")]
    Git {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shared_folder: Option<String>,
    },
}

/// Reads and writes the link between the workspace and its remote copy
/// (`alcy-git-link.json`, at the workspace root).
pub struct WorkspaceLinkStore {
    path: PathBuf,
}

impl WorkspaceLinkStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join(LINK_FILE_NAME),
        }
    }

    /// Without the file, the workspace is not linked.
    pub fn load(&self) -> Result<Option<WorkspaceLink>, StorageError> {
        if !self.path.exists() {
            return Ok(None);
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let probe: VersionProbe = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        let corrupted = |error: serde_json::Error| StorageError::Corrupted(error.to_string());

        let (link, base) = match probe.version {
            GITLAB_VERSION => {
                let persisted: PersistedGitlabLink =
                    serde_json::from_str(&raw).map_err(corrupted)?;
                let link = WorkspaceLink::gitlab(
                    persisted.account_id,
                    persisted.project_id,
                    persisted.project_path,
                    persisted.branch,
                    &persisted.directory,
                    persisted.include_environments,
                );
                (link, persisted.base)
            }
            PROVIDER_VERSION => {
                let persisted: PersistedProviderLink =
                    serde_json::from_str(&raw).map_err(corrupted)?;
                let link = match persisted.location {
                    PersistedLocation::Onedrive {
                        account_id,
                        drive_id,
                        folder_id,
                        display_path,
                    } => WorkspaceLink::onedrive(
                        account_id,
                        &drive_id,
                        &folder_id,
                        display_path,
                        persisted.include_environments,
                    ),
                    PersistedLocation::Git { shared_folder } => {
                        WorkspaceLink::git(shared_folder.as_deref(), persisted.include_environments)
                    }
                };
                (link, persisted.base)
            }
            other => return Err(StorageError::UnsupportedVersion(other)),
        };
        let mut link = link.map_err(|error| StorageError::Corrupted(error.to_string()))?;
        link.base = base;
        Ok(Some(link))
    }

    pub fn save(&self, link: &WorkspaceLink) -> Result<(), StorageError> {
        let include_environments = link.include_environments;
        let base = link.base.clone();
        let json = match &link.location {
            RemoteLocation::Gitlab {
                account_id,
                project_id,
                project_path,
                branch,
                directory,
            } => serde_json::to_string_pretty(&PersistedGitlabLink {
                version: GITLAB_VERSION,
                account_id: account_id.clone(),
                project_id: *project_id,
                project_path: project_path.clone(),
                branch: branch.clone(),
                directory: directory.clone(),
                include_environments,
                base,
            }),
            RemoteLocation::Onedrive {
                account_id,
                drive_id,
                folder_id,
                display_path,
            } => serde_json::to_string_pretty(&PersistedProviderLink {
                version: PROVIDER_VERSION,
                location: PersistedLocation::Onedrive {
                    account_id: account_id.clone(),
                    drive_id: drive_id.clone(),
                    folder_id: folder_id.clone(),
                    display_path: display_path.clone(),
                },
                include_environments,
                base,
            }),
            RemoteLocation::Git { shared_folder } => {
                serde_json::to_string_pretty(&PersistedProviderLink {
                    version: PROVIDER_VERSION,
                    location: PersistedLocation::Git {
                        shared_folder: shared_folder.clone(),
                    },
                    include_environments,
                    base,
                })
            }
        }
        .map_err(|error| StorageError::Write(error.to_string()))?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }

        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.path)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        Ok(())
    }

    /// Removes the link (not an error when it does not exist).
    pub fn remove(&self) -> Result<(), StorageError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StorageError::Write(error.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("alcy-link-test-{nanos}-{count}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn unlinked_workspace_loads_none() {
        let root = temp_root();
        assert_eq!(WorkspaceLinkStore::new(root.clone()).load().unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn roundtrips_and_removes_the_link() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());
        let mut link = WorkspaceLink::gitlab("u@h", 7, "eq/proj", "main", "alcy", true).unwrap();
        link.base.insert("alcy-flows.json".into(), "abc".into());

        store.save(&link).unwrap();
        assert_eq!(store.load().unwrap(), Some(link));

        store.remove().unwrap();
        store.remove().unwrap();
        assert_eq!(store.load().unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn gitlab_links_keep_the_v1_format() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());
        let mut link = WorkspaceLink::gitlab("u@h", 7, "eq/proj", "main", "alcy", false).unwrap();
        link.base.insert("alcy-flows.json".into(), "abc".into());

        store.save(&link).unwrap();

        let raw = fs::read_to_string(root.join(LINK_FILE_NAME)).unwrap();
        assert_eq!(
            raw,
            r#"{
  "version": 1,
  "accountId": "u@h",
  "projectId": 7,
  "projectPath": "eq/proj",
  "branch": "main",
  "directory": "alcy",
  "includeEnvironments": false,
  "base": {
    "alcy-flows.json": "abc"
  }
}"#
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn roundtrips_git_links_as_v2() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());

        let mut local = WorkspaceLink::git(None, false).unwrap();
        local.base.insert("alcy-flows.json".into(), "abc".into());
        store.save(&local).unwrap();
        assert_eq!(store.load().unwrap(), Some(local));
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(LINK_FILE_NAME)).unwrap()).unwrap();
        assert_eq!(raw["version"], 2);
        assert_eq!(raw["provider"], "git");
        assert!(raw.get("sharedFolder").is_none());

        let folder = root.join("shared");
        let shared = WorkspaceLink::git(Some(&folder.to_string_lossy()), true).unwrap();
        store.save(&shared).unwrap();
        assert_eq!(store.load().unwrap(), Some(shared));
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(LINK_FILE_NAME)).unwrap()).unwrap();
        assert_eq!(raw["sharedFolder"], folder.to_string_lossy().as_ref());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn roundtrips_a_onedrive_link_as_v2() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());
        let mut link =
            WorkspaceLink::onedrive("m@x", "b!drive", "01FOLDER", "/Equipe/Alcy", true).unwrap();
        link.base
            .insert("alcy-collections.json".into(), "def".into());

        store.save(&link).unwrap();

        let raw = fs::read_to_string(root.join(LINK_FILE_NAME)).unwrap();
        assert!(raw.contains("\"version\": 2"));
        assert!(raw.contains("\"provider\": \"onedrive\""));
        assert_eq!(store.load().unwrap(), Some(link));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_invalid_v2_links() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());
        let path = root.join(LINK_FILE_NAME);

        for raw in [
            r#"{"version":2,"provider":"onedrive","accountId":"a","driveId":"","folderId":"f"}"#,
            r#"{"version":2,"provider":"onedrive","accountId":"a","driveId":"d"}"#,
            r#"{"version":2,"provider":"dropbox","accountId":"a"}"#,
        ] {
            fs::write(&path, raw).unwrap();
            assert!(
                matches!(store.load(), Err(StorageError::Corrupted(_))),
                "{raw}"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsupported_version_and_corrupted_file() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());
        let path = root.join(LINK_FILE_NAME);

        fs::write(
            &path,
            r#"{"version":99,"accountId":"a","projectId":1,"projectPath":"p","branch":"main"}"#,
        )
        .unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(99))
        ));

        fs::write(&path, "not json").unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));

        fs::write(
            &path,
            r#"{"version":1,"accountId":"a","projectId":1,"projectPath":"p","branch":"main","directory":"../outside"}"#,
        )
        .unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_dir_all(root);
    }
}
