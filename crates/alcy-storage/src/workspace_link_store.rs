use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use alcy_domain::WorkspaceLink;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const LINK_VERSION: u32 = 2;
/// Version 1 and any other provider tag come from version control backends
/// that no longer exist: such a workspace simply counts as not linked.
const LEGACY_VERSION: u32 = 1;
const GIT_PROVIDER: &str = "git";
pub(crate) const LINK_FILE_NAME: &str = "alcy-git-link.json";

#[derive(Deserialize)]
struct LinkProbe {
    version: u32,
    #[serde(default)]
    provider: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedLink {
    version: u32,
    provider: String,
    #[serde(default)]
    include_environments: bool,
    #[serde(default)]
    base: BTreeMap<String, String>,
}

/// Reads and writes the link between the workspace and its git repository
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
        let probe: LinkProbe = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        match probe.version {
            LEGACY_VERSION => return Ok(None),
            LINK_VERSION if probe.provider.as_deref() != Some(GIT_PROVIDER) => return Ok(None),
            LINK_VERSION => {}
            other => return Err(StorageError::UnsupportedVersion(other)),
        }
        let persisted: PersistedLink = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        let mut link = WorkspaceLink::new(persisted.include_environments);
        link.base = persisted.base;
        Ok(Some(link))
    }

    pub fn save(&self, link: &WorkspaceLink) -> Result<(), StorageError> {
        let json = serde_json::to_string_pretty(&PersistedLink {
            version: LINK_VERSION,
            provider: GIT_PROVIDER.to_string(),
            include_environments: link.include_environments,
            base: link.base.clone(),
        })
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
        let mut link = WorkspaceLink::new(true);
        link.base.insert("alcy-flows.json".into(), "abc".into());

        store.save(&link).unwrap();
        assert_eq!(store.load().unwrap(), Some(link));

        store.remove().unwrap();
        store.remove().unwrap();
        assert_eq!(store.load().unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn roundtrips_git_links_as_v2() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());

        let mut link = WorkspaceLink::new(true);
        link.base.insert("alcy-flows.json".into(), "abc".into());
        store.save(&link).unwrap();
        assert_eq!(store.load().unwrap(), Some(link.clone()));
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(LINK_FILE_NAME)).unwrap()).unwrap();
        assert_eq!(raw["version"], 2);
        assert_eq!(raw["provider"], "git");
        assert!(raw.get("sharedFolder").is_none());

        // The shared folder of 0.10.0-preview01 links is dropped on load.
        fs::write(
            root.join(LINK_FILE_NAME),
            r#"{"version":2,"provider":"git","sharedFolder":"/team","includeEnvironments":true,"base":{"alcy-flows.json":"abc"}}"#,
        )
        .unwrap();
        assert_eq!(store.load().unwrap(), Some(link));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn links_of_removed_backends_count_as_not_linked() {
        let root = temp_root();
        let store = WorkspaceLinkStore::new(root.clone());
        for raw in [
            r#"{"version":1,"accountId":"u","projectId":7,"projectPath":"p","branch":"main"}"#,
            r#"{"version":2,"provider":"another","accountId":"u"}"#,
            r#"{"version":2}"#,
        ] {
            fs::write(root.join(LINK_FILE_NAME), raw).unwrap();
            assert_eq!(store.load().unwrap(), None, "{raw}");
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
            r#"{"version":2,"provider":"git","base":"not a map"}"#,
        )
        .unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_dir_all(root);
    }
}
