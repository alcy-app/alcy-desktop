use std::fs;
use std::path::PathBuf;

use alcy_domain::{
    DEFAULT_HISTORY_RETENTION_DAYS, DEFAULT_RESPONSE_SIZE_LIMIT_MB, GeneralSettings,
    HistoryRetention, RequestTimeout, ResponseSizeLimit,
};
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    /// `null` quando o timeout está desabilitado.
    request_timeout_seconds: Option<u32>,
    /// `null` quando o limite está desabilitado. Aditivo: um arquivo gravado
    /// antes deste campo existir não o tem e fica com o limite padrão.
    #[serde(default = "default_response_size_limit_mb")]
    response_size_limit_mb: Option<u32>,
    /// `0` desativa o histórico. Aditivo, como o limite de resposta.
    #[serde(default = "default_history_retention_days")]
    history_retention_days: u32,
    /// Aditivo. Um arquivo sem o campo foi gravado por uma versão anterior,
    /// que sempre guardava as respostas: continua guardando (`true`).
    #[serde(default = "saved_before_the_option_existed")]
    save_history_responses: bool,
}

fn saved_before_the_option_existed() -> bool {
    true
}

fn default_response_size_limit_mb() -> Option<u32> {
    Some(DEFAULT_RESPONSE_SIZE_LIMIT_MB)
}

fn default_history_retention_days() -> u32 {
    DEFAULT_HISTORY_RETENTION_DAYS
}

/// Lê e grava as preferências gerais do app (arquivo único e versionado).
pub struct GeneralSettingsStore {
    path: PathBuf,
}

impl GeneralSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Sem arquivo, devolve o padrão (timeout de 60 segundos).
    pub fn load(&self) -> Result<GeneralSettings, StorageError> {
        if !self.path.exists() {
            return Ok(GeneralSettings::default());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }

        let request_timeout = match file.request_timeout_seconds {
            None => RequestTimeout::Disabled,
            Some(seconds) => RequestTimeout::seconds(seconds)
                .map_err(|error| StorageError::Corrupted(error.to_string()))?,
        };
        let response_size_limit = match file.response_size_limit_mb {
            None => ResponseSizeLimit::Disabled,
            Some(megabytes) => ResponseSizeLimit::megabytes(megabytes)
                .map_err(|error| StorageError::Corrupted(error.to_string()))?,
        };
        let history_retention = HistoryRetention::days(file.history_retention_days)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        Ok(GeneralSettings {
            request_timeout,
            response_size_limit,
            history_retention,
            save_history_responses: file.save_history_responses,
        })
    }

    /// Grava as preferências da primeira abertura quando ainda não há
    /// arquivo, para que a decisão abaixo não mude nas aberturas seguintes:
    /// - quem já usava uma versão anterior (`previous_install`) continua
    ///   com as respostas guardadas no histórico, como antes;
    /// - uma instalação nova começa com elas desligadas (o padrão).
    ///
    /// Com o arquivo já existente, não faz nada.
    pub fn ensure_first_run_defaults(&self, previous_install: bool) -> Result<(), StorageError> {
        if self.path.exists() {
            return Ok(());
        }
        self.save(&GeneralSettings {
            save_history_responses: previous_install,
            ..GeneralSettings::default()
        })
    }

    pub fn save(&self, settings: &GeneralSettings) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            request_timeout_seconds: match settings.request_timeout {
                RequestTimeout::Disabled => None,
                RequestTimeout::Seconds(seconds) => Some(seconds),
            },
            response_size_limit_mb: match settings.response_size_limit {
                ResponseSizeLimit::Disabled => None,
                ResponseSizeLimit::Megabytes(megabytes) => Some(megabytes),
            },
            history_retention_days: settings.history_retention.as_days(),
            save_history_responses: settings.save_history_responses,
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
        std::env::temp_dir().join(format!("alcy-general-settings-test-{nanos}-{count}.json"))
    }

    #[test]
    fn missing_file_loads_the_default() {
        let store = GeneralSettingsStore::new(temp_path());
        assert_eq!(store.load().unwrap(), GeneralSettings::default());
    }

    #[test]
    fn roundtrips_the_request_timeout() {
        let path = temp_path();
        let store = GeneralSettingsStore::new(path.clone());
        for request_timeout in [RequestTimeout::Disabled, RequestTimeout::Seconds(15)] {
            let settings = GeneralSettings {
                request_timeout,
                ..GeneralSettings::default()
            };
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_disabled_timeout_is_saved_as_null() {
        let path = temp_path();
        let store = GeneralSettingsStore::new(path.clone());
        store
            .save(&GeneralSettings {
                request_timeout: RequestTimeout::Disabled,
                ..GeneralSettings::default()
            })
            .unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"requestTimeoutSeconds\": null"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn roundtrips_the_response_size_limit() {
        let path = temp_path();
        let store = GeneralSettingsStore::new(path.clone());
        for response_size_limit in [
            ResponseSizeLimit::Disabled,
            ResponseSizeLimit::Megabytes(10),
        ] {
            let settings = GeneralSettings {
                response_size_limit,
                ..GeneralSettings::default()
            };
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_file_without_the_response_limit_loads_the_default_limit() {
        let path = temp_path();
        fs::write(&path, r#"{"version":1,"requestTimeoutSeconds":30}"#).unwrap();
        let store = GeneralSettingsStore::new(path.clone());
        let settings = store.load().unwrap();
        assert_eq!(settings.request_timeout, RequestTimeout::Seconds(30));
        assert_eq!(settings.response_size_limit, ResponseSizeLimit::default());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn roundtrips_the_history_retention_including_disabled() {
        let path = temp_path();
        let store = GeneralSettingsStore::new(path.clone());
        for days in [0, 3, 7] {
            let settings = GeneralSettings {
                history_retention: HistoryRetention::days(days).unwrap(),
                ..GeneralSettings::default()
            };
            store.save(&settings).unwrap();
            assert_eq!(store.load().unwrap(), settings);
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_file_without_the_history_retention_keeps_seven_days() {
        let path = temp_path();
        fs::write(
            &path,
            r#"{"version":1,"requestTimeoutSeconds":30,"responseSizeLimitMb":10}"#,
        )
        .unwrap();
        let store = GeneralSettingsStore::new(path.clone());
        assert_eq!(
            store.load().unwrap().history_retention,
            HistoryRetention::default()
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn roundtrips_saving_history_responses() {
        let path = temp_path();
        let store = GeneralSettingsStore::new(path.clone());
        let settings = GeneralSettings {
            save_history_responses: true,
            ..GeneralSettings::default()
        };
        store.save(&settings).unwrap();
        assert_eq!(store.load().unwrap(), settings);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_file_from_a_previous_version_keeps_saving_history_responses() {
        let path = temp_path();
        fs::write(&path, r#"{"version":1,"requestTimeoutSeconds":30}"#).unwrap();
        let store = GeneralSettingsStore::new(path.clone());
        assert!(store.load().unwrap().save_history_responses);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn first_run_defaults_depend_on_a_previous_install_and_are_kept() {
        for previous_install in [true, false] {
            let path = temp_path();
            let store = GeneralSettingsStore::new(path.clone());

            store.ensure_first_run_defaults(previous_install).unwrap();
            assert_eq!(
                store.load().unwrap().save_history_responses,
                previous_install
            );

            // Nas aberturas seguintes, o arquivo já existe e nada muda.
            store.ensure_first_run_defaults(!previous_install).unwrap();
            assert_eq!(
                store.load().unwrap().save_history_responses,
                previous_install
            );
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn first_run_defaults_do_not_touch_existing_settings() {
        let path = temp_path();
        let store = GeneralSettingsStore::new(path.clone());
        let settings = GeneralSettings {
            request_timeout: RequestTimeout::Seconds(15),
            save_history_responses: false,
            ..GeneralSettings::default()
        };
        store.save(&settings).unwrap();

        store.ensure_first_run_defaults(true).unwrap();

        assert_eq!(store.load().unwrap(), settings);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_an_out_of_range_history_retention() {
        let path = temp_path();
        fs::write(
            &path,
            r#"{"version":1,"requestTimeoutSeconds":30,"historyRetentionDays":8}"#,
        )
        .unwrap();
        let store = GeneralSettingsStore::new(path.clone());
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_an_out_of_range_timeout() {
        let path = temp_path();
        fs::write(&path, r#"{"version":1,"requestTimeoutSeconds":0}"#).unwrap();
        let store = GeneralSettingsStore::new(path.clone());
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_an_unknown_version() {
        let path = temp_path();
        fs::write(&path, r#"{"version":2,"requestTimeoutSeconds":30}"#).unwrap();
        let store = GeneralSettingsStore::new(path.clone());
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(2))
        ));
        let _ = fs::remove_file(path);
    }
}
