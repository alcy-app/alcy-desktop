use std::fs;
use std::path::PathBuf;

use alcy_domain::SecuritySettings;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    sync_sensitive_values: bool,
}

/// Lê e grava as preferências de segurança do app (arquivo único e
/// versionado em `app_data_dir`).
pub struct SecuritySettingsStore {
    path: PathBuf,
}

impl SecuritySettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Sem arquivo, devolve o padrão (valores sensíveis não sincronizam).
    pub fn load(&self) -> Result<SecuritySettings, StorageError> {
        if !self.path.exists() {
            return Ok(SecuritySettings::default());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }

        Ok(SecuritySettings {
            sync_sensitive_values: file.sync_sensitive_values,
        })
    }

    pub fn save(&self, settings: &SecuritySettings) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            sync_sensitive_values: settings.sync_sensitive_values,
        };
        let json = serde_json::to_string_pretty(&file)
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
        std::env::temp_dir().join(format!("alcy-security-settings-test-{nanos}-{count}.json"))
    }

    #[test]
    fn missing_file_keeps_sensitive_values_out_of_sync() {
        let store = SecuritySettingsStore::new(temp_path());

        assert!(!store.load().unwrap().sync_sensitive_values);
    }

    #[test]
    fn roundtrips_the_preference() {
        let path = temp_path();
        let store = SecuritySettingsStore::new(path.clone());
        for sync_sensitive_values in [true, false] {
            let settings = SecuritySettings {
                sync_sensitive_values,
            };
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_version_and_corrupted_file() {
        let path = temp_path();
        let store = SecuritySettingsStore::new(path.clone());

        fs::write(&path, r#"{"version":99,"syncSensitiveValues":true}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(99))
        ));

        fs::write(&path, "não é json").unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }
}
