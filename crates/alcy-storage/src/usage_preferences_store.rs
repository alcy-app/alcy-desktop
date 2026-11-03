use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    usage_events_enabled: bool,
}

/// Whether the person lets the app record usage events (spec 0142), in a
/// single versioned file in `app_data_dir`. On by default: the person can
/// turn it off in Settings > Telemetry.
pub struct UsagePreferencesStore {
    path: PathBuf,
}

impl UsagePreferencesStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Without a file, usage events are enabled.
    pub fn load(&self) -> Result<bool, StorageError> {
        if !self.path.exists() {
            return Ok(true);
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        Ok(file.usage_events_enabled)
    }

    pub fn save(&self, usage_events_enabled: bool) -> Result<(), StorageError> {
        let json = serde_json::to_string_pretty(&PersistedFile {
            version: CURRENT_VERSION,
            usage_events_enabled,
        })
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

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "alcy-usage-preferences-test-{}-{}.json",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn usage_events_are_enabled_until_the_person_turns_them_off() {
        let path = temp_path();
        let store = UsagePreferencesStore::new(path.clone());
        assert!(store.load().unwrap());
        store.save(false).unwrap();
        assert!(!store.load().unwrap());
        store.save(true).unwrap();
        assert!(store.load().unwrap());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unknown_versions() {
        let path = temp_path();
        fs::write(&path, r#"{"version":9,"usageEventsEnabled":false}"#).unwrap();
        assert!(matches!(
            UsagePreferencesStore::new(path.clone()).load(),
            Err(StorageError::UnsupportedVersion(9))
        ));
        let _ = fs::remove_file(path);
    }
}
