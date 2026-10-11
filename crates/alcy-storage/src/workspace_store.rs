use std::fs;
use std::path::PathBuf;

use alcy_domain::Workspace;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;
const MANIFEST_FILE_NAME: &str = "alcy-workspace.json";

#[derive(Serialize, Deserialize)]
struct PersistedManifest {
    version: u32,
    id: String,
    name: String,
}

/// Lê e grava o manifesto de um workspace (`alcy-workspace.json`) na
/// raiz da pasta escolhida pelo usuário, com escrita atômica (arquivo
/// temporário + rename) e formato versionado.
pub struct WorkspaceStore {
    manifest_path: PathBuf,
}

impl WorkspaceStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            manifest_path: root.join(MANIFEST_FILE_NAME),
        }
    }

    pub fn load(&self) -> Result<Workspace, StorageError> {
        if !self.manifest_path.exists() {
            return Err(StorageError::NotFound(format!(
                "nenhum workspace em {}",
                self.manifest_path.display()
            )));
        }

        let raw = fs::read_to_string(&self.manifest_path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let persisted: PersistedManifest = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if persisted.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(persisted.version));
        }

        Workspace::new(persisted.id, persisted.name)
            .map_err(|error| StorageError::Corrupted(error.to_string()))
    }

    pub fn save(&self, workspace: &Workspace) -> Result<(), StorageError> {
        let persisted = PersistedManifest {
            version: CURRENT_VERSION,
            id: workspace.id.clone(),
            name: workspace.name().to_string(),
        };

        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        if let Some(parent) = self.manifest_path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }

        let tmp_path = self.manifest_path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.manifest_path)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        Ok(())
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
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-workspace-store-test-{nanos}-{count}"))
    }

    #[test]
    fn load_fails_with_not_found_when_the_manifest_does_not_exist() {
        let store = WorkspaceStore::new(temp_root());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::NotFound(_)));
    }

    #[test]
    fn save_then_load_round_trips_the_workspace() {
        let root = temp_root();
        let store = WorkspaceStore::new(root.clone());
        let workspace = Workspace::new("workspace-1", "My API").unwrap();

        store.save(&workspace).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, workspace);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_creates_the_root_directory_when_it_does_not_exist() {
        let root = temp_root();
        let store = WorkspaceStore::new(root.clone());

        assert!(!root.exists());
        store
            .save(&Workspace::new("workspace-1", "My API").unwrap())
            .unwrap();

        assert!(root.join(MANIFEST_FILE_NAME).exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_does_not_leave_a_temporary_file_behind() {
        let root = temp_root();
        let store = WorkspaceStore::new(root.clone());

        store
            .save(&Workspace::new("workspace-1", "My API").unwrap())
            .unwrap();

        assert!(!root.join(MANIFEST_FILE_NAME).with_extension("tmp").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), "not json").unwrap();
        let store = WorkspaceStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 99, "id": "workspace-1", "name": "My API"}"#,
        )
        .unwrap();
        let store = WorkspaceStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_data_that_violates_domain_invariants() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "id": "workspace-1", "name": ""}"#,
        )
        .unwrap();
        let store = WorkspaceStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }
}
