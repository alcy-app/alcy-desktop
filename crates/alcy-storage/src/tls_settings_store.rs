use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

/// Preferência de TLS das chamadas do usuário (ADR 0058).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TlsSettings {
    /// Verifica cadeia, prazo e hostname do certificado. Ligado por padrão.
    pub verify_certificates: bool,
}

impl Default for TlsSettings {
    fn default() -> Self {
        Self {
            verify_certificates: true,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    verify_certificates: bool,
}

/// Lê e grava a preferência de verificação de certificado (arquivo único e
/// versionado em `app_data_dir`).
pub struct TlsSettingsStore {
    path: PathBuf,
}

impl TlsSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Sem arquivo, devolve o padrão (verificação ligada).
    pub fn load(&self) -> Result<TlsSettings, StorageError> {
        if !self.path.exists() {
            return Ok(TlsSettings::default());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }

        Ok(TlsSettings {
            verify_certificates: file.verify_certificates,
        })
    }

    pub fn save(&self, settings: &TlsSettings) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            verify_certificates: settings.verify_certificates,
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
        std::env::temp_dir().join(format!("alcy-tls-settings-test-{nanos}-{count}.json"))
    }

    #[test]
    fn missing_file_keeps_certificate_verification_on() {
        let store = TlsSettingsStore::new(temp_path());

        assert!(store.load().unwrap().verify_certificates);
    }

    #[test]
    fn roundtrips_the_preference() {
        let path = temp_path();
        let store = TlsSettingsStore::new(path.clone());
        for verify_certificates in [false, true] {
            let settings = TlsSettings {
                verify_certificates,
            };
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_version_and_corrupted_file() {
        let path = temp_path();
        let store = TlsSettingsStore::new(path.clone());

        fs::write(&path, r#"{"version":99,"verifyCertificates":false}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(99))
        ));

        fs::write(&path, "não é json").unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }
}
