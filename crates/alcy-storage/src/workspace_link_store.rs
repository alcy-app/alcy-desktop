use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use alcy_domain::WorkspaceLink;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;
pub(crate) const LINK_FILE_NAME: &str = "alcy-git-link.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedLink {
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

/// Lê e grava o vínculo do workspace com um repositório remoto
/// (`alcy-git-link.json`, na raiz do workspace).
pub struct WorkspaceLinkStore {
    path: PathBuf,
}

impl WorkspaceLinkStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join(LINK_FILE_NAME),
        }
    }

    /// Sem arquivo, o workspace não está vinculado.
    pub fn load(&self) -> Result<Option<WorkspaceLink>, StorageError> {
        if !self.path.exists() {
            return Ok(None);
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let persisted: PersistedLink = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if persisted.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(persisted.version));
        }

        let mut link = WorkspaceLink::new(
            persisted.account_id,
            persisted.project_id,
            persisted.project_path,
            persisted.branch,
            &persisted.directory,
            persisted.include_environments,
        )
        .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        link.base = persisted.base;
        Ok(Some(link))
    }

    pub fn save(&self, link: &WorkspaceLink) -> Result<(), StorageError> {
        let persisted = PersistedLink {
            version: CURRENT_VERSION,
            account_id: link.account_id.clone(),
            project_id: link.project_id,
            project_path: link.project_path.clone(),
            branch: link.branch.clone(),
            directory: link.directory.clone(),
            include_environments: link.include_environments,
            base: link.base.clone(),
        };
        let json = serde_json::to_string_pretty(&persisted)
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

    /// Desfaz o vínculo (não é erro se ele não existe).
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
        let mut link = WorkspaceLink::new("u@h", 7, "eq/proj", "main", "alcy", true).unwrap();
        link.base.insert("alcy-flows.json".into(), "abc".into());

        store.save(&link).unwrap();
        assert_eq!(store.load().unwrap(), Some(link));

        store.remove().unwrap();
        store.remove().unwrap();
        assert_eq!(store.load().unwrap(), None);
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

        fs::write(&path, "não é json").unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));

        fs::write(
            &path,
            r#"{"version":1,"accountId":"a","projectId":1,"projectPath":"p","branch":"main","directory":"../fora"}"#,
        )
        .unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_dir_all(root);
    }
}
