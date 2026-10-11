use std::fs;
use std::path::PathBuf;

use alcy_domain::UpdateSettings;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

/// Campos desconhecidos são ignorados: builds anteriores gravavam também a
/// origem das releases (`source`), que hoje vem fixa no build.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    check_on_startup: bool,
}

/// Lê e grava as preferências de atualização do app (arquivo único e
/// versionado).
pub struct UpdateSettingsStore {
    path: PathBuf,
}

impl UpdateSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Sem arquivo, devolve o padrão (verificar ao abrir).
    pub fn load(&self) -> Result<UpdateSettings, StorageError> {
        if !self.path.exists() {
            return Ok(UpdateSettings::default());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }

        Ok(UpdateSettings {
            check_on_startup: file.check_on_startup,
        })
    }

    pub fn save(&self, settings: &UpdateSettings) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            check_on_startup: settings.check_on_startup,
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
        std::env::temp_dir().join(format!("alcy-update-settings-test-{nanos}-{count}.json"))
    }

    #[test]
    fn missing_file_loads_the_default() {
        let store = UpdateSettingsStore::new(temp_path());
        assert_eq!(store.load().unwrap(), UpdateSettings::default());
    }

    #[test]
    fn roundtrips_the_startup_preference() {
        let path = temp_path();
        let store = UpdateSettingsStore::new(path.clone());
        for check_on_startup in [false, true] {
            let settings = UpdateSettings { check_on_startup };
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ignores_the_source_saved_by_earlier_builds() {
        let path = temp_path();
        let store = UpdateSettingsStore::new(path.clone());
        fs::write(
            &path,
            r#"{"version":1,"source":{"projectUrl":"https://gitlab.corp/g/alcy","accountId":"u@gitlab.corp","projectId":4,"projectName":"g/alcy","projectWebUrl":"https://gitlab.corp/g/alcy"},"checkOnStartup":false}"#,
        )
        .unwrap();

        assert_eq!(
            store.load().unwrap(),
            UpdateSettings {
                check_on_startup: false
            }
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_version_and_corrupted_file() {
        let path = temp_path();
        let store = UpdateSettingsStore::new(path.clone());

        fs::write(&path, r#"{"version":99,"checkOnStartup":true}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(99))
        ));

        fs::write(&path, "não é json").unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }
}
