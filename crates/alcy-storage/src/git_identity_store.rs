use std::fs;
use std::path::PathBuf;

use alcy_domain::GitIdentitySettings;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
}

/// Git author set in Alcy, replacing the system's `user.name`/`user.email`
/// (single versioned file in `app_data_dir`; the git config files are never
/// written).
pub struct GitIdentityStore {
    path: PathBuf,
}

impl GitIdentityStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Without the file, nothing is overridden.
    pub fn load(&self) -> Result<GitIdentitySettings, StorageError> {
        if !self.path.exists() {
            return Ok(GitIdentitySettings::default());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        GitIdentitySettings::new(file.name.as_deref(), file.email.as_deref())
            .map_err(|error| StorageError::Corrupted(error.to_string()))
    }

    pub fn save(&self, settings: &GitIdentitySettings) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            name: settings.name.clone(),
            email: settings.email.clone(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }
        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.path).map_err(|error| StorageError::Write(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-git-identity-test-{nanos}-{count}.json"))
    }

    #[test]
    fn missing_file_overrides_nothing() {
        let store = GitIdentityStore::new(temp_path());
        assert_eq!(store.load().unwrap(), GitIdentitySettings::default());
    }

    #[test]
    fn roundtrips_full_and_partial_overrides() {
        let path = temp_path();
        let store = GitIdentityStore::new(path.clone());
        for settings in [
            GitIdentitySettings::new(Some("Ana"), Some("ana@example.com")).unwrap(),
            GitIdentitySettings::new(None, Some("ana@example.com")).unwrap(),
            GitIdentitySettings::default(),
        ] {
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_version_and_invalid_values() {
        let path = temp_path();
        let store = GitIdentityStore::new(path.clone());

        fs::write(&path, r#"{"version":2,"name":"Ana"}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(2))
        ));

        fs::write(&path, r#"{"version":1,"name":"<Ana>"}"#).unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }
}
