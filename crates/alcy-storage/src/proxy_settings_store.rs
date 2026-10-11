use std::fs;
use std::path::PathBuf;

use alcy_domain::ProxySettings;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
enum PersistedProxy {
    Disabled,
    System,
    Pac { url: String },
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    proxy: PersistedProxy,
}

/// Lê e grava a configuração de proxy do app (arquivo único e versionado).
pub struct ProxySettingsStore {
    path: PathBuf,
}

impl ProxySettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Sem arquivo, devolve o padrão (`Disabled`).
    pub fn load(&self) -> Result<ProxySettings, StorageError> {
        if !self.path.exists() {
            return Ok(ProxySettings::default());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }

        Ok(match file.proxy {
            PersistedProxy::Disabled => ProxySettings::Disabled,
            PersistedProxy::System => ProxySettings::System,
            PersistedProxy::Pac { url } => ProxySettings::Pac { url },
        })
    }

    pub fn save(&self, settings: &ProxySettings) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            proxy: match settings {
                ProxySettings::Disabled => PersistedProxy::Disabled,
                ProxySettings::System => PersistedProxy::System,
                ProxySettings::Pac { url } => PersistedProxy::Pac { url: url.clone() },
            },
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
        std::env::temp_dir().join(format!("alcy-proxy-settings-test-{nanos}-{count}.json"))
    }

    #[test]
    fn missing_file_loads_the_default() {
        let store = ProxySettingsStore::new(temp_path());
        assert_eq!(store.load().unwrap(), ProxySettings::Disabled);
    }

    #[test]
    fn roundtrips_every_mode() {
        let path = temp_path();
        let store = ProxySettingsStore::new(path.clone());
        for settings in [
            ProxySettings::Disabled,
            ProxySettings::System,
            ProxySettings::Pac {
                url: "https://corp/proxy.pac".into(),
            },
        ] {
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_version_and_corrupted_file() {
        let path = temp_path();
        let store = ProxySettingsStore::new(path.clone());

        fs::write(&path, r#"{"version":99,"proxy":{"mode":"system"}}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(99))
        ));

        fs::write(&path, "não é json").unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }
}
