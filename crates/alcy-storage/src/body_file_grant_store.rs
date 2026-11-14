//! Body files outside a workspace that this person picked for it in the
//! native dialog (spec 0163). Kept in the app data folder, never in the
//! workspace: the workspace is versioned, synced and imported, and nothing
//! that arrives through those channels may grant reading a file.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use alcy_domain::same_path;
use serde::{Deserialize, Serialize};

use crate::environment_store::write_atomic;
use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    /// Canonical workspace path → canonical paths of the picked files.
    #[serde(default)]
    workspaces: BTreeMap<String, Vec<String>>,
}

impl Default for PersistedFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            workspaces: BTreeMap::new(),
        }
    }
}

/// Reads and writes `body-file-grants.json`. Callers pass canonical paths.
/// Clones share one lock, so two commands never interleave their
/// read-modify-write.
#[derive(Clone)]
pub struct BodyFileGrantStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl BodyFileGrantStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// Files picked for `canonical_root`. An unreadable file grants nothing.
    pub fn grants(&self, canonical_root: &Path) -> Vec<PathBuf> {
        let Ok(_guard) = self.lock.lock() else {
            return Vec::new();
        };
        self.read()
            .ok()
            .and_then(|mut file| file.workspaces.remove(&key(canonical_root)))
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }

    /// Records that this person picked `canonical_file` for `canonical_root`.
    pub fn grant(&self, canonical_root: &Path, canonical_file: &Path) -> Result<(), StorageError> {
        self.update(|file| {
            let files = file.workspaces.entry(key(canonical_root)).or_default();
            if !files
                .iter()
                .any(|granted| same_path(Path::new(granted), canonical_file))
            {
                files.push(key(canonical_file));
            }
        })
    }

    /// Forgets every file picked for `canonical_root`.
    pub fn clear(&self, canonical_root: &Path) -> Result<(), StorageError> {
        self.update(|file| {
            file.workspaces.remove(&key(canonical_root));
        })
    }

    fn update(&self, change: impl FnOnce(&mut PersistedFile)) -> Result<(), StorageError> {
        let Ok(_guard) = self.lock.lock() else {
            return Err(StorageError::Write(
                "body file grants lock poisoned".to_string(),
            ));
        };
        let mut file = self.read_or_back_up()?;
        change(&mut file);
        self.write(&file)
    }

    fn read(&self) -> Result<PersistedFile, StorageError> {
        if !self.path.exists() {
            return Ok(PersistedFile::default());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        Ok(file)
    }

    /// Reads the file for a write. An unreadable one is copied to `.bak`
    /// before being replaced, and its grants are not carried over.
    fn read_or_back_up(&self) -> Result<PersistedFile, StorageError> {
        match self.read() {
            Ok(file) => Ok(file),
            Err(StorageError::Read(message)) => Err(StorageError::Read(message)),
            Err(_) => {
                fs::copy(&self.path, self.path.with_extension("json.bak"))
                    .map_err(|error| StorageError::Write(error.to_string()))?;
                Ok(PersistedFile::default())
            }
        }
    }

    fn write(&self, file: &PersistedFile) -> Result<(), StorageError> {
        let json = serde_json::to_string_pretty(file)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }
        write_atomic(&self.path, json.as_bytes())
    }
}

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("alcy-body-file-grants-test-{nanos}-{count}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn grants_are_kept_per_workspace() {
        let dir = temp_dir();
        let store = BodyFileGrantStore::new(dir.join("body-file-grants.json"));
        let api = dir.join("api");
        let other = dir.join("other");
        let report = dir.join("report.pdf");

        assert!(store.grants(&api).is_empty());
        store.grant(&api, &report).unwrap();
        store.grant(&api, &report).unwrap();

        assert_eq!(store.grants(&api), vec![report]);
        assert!(store.grants(&other).is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clearing_forgets_only_that_workspace() {
        let dir = temp_dir();
        let store = BodyFileGrantStore::new(dir.join("body-file-grants.json"));
        let api = dir.join("api");
        let other = dir.join("other");
        store.grant(&api, &dir.join("a.bin")).unwrap();
        store.grant(&other, &dir.join("b.bin")).unwrap();

        store.clear(&api).unwrap();

        assert!(store.grants(&api).is_empty());
        assert_eq!(store.grants(&other), vec![dir.join("b.bin")]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_file_grants_nothing_and_is_backed_up_before_a_write() {
        let dir = temp_dir();
        let path = dir.join("body-file-grants.json");
        let store = BodyFileGrantStore::new(path.clone());
        let api = dir.join("api");
        fs::write(&path, "not json").unwrap();

        assert!(store.grants(&api).is_empty());
        store.grant(&api, &dir.join("a.bin")).unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("body-file-grants.json.bak")).unwrap(),
            "not json"
        );
        assert_eq!(store.grants(&api), vec![dir.join("a.bin")]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unsupported_version_grants_nothing() {
        let dir = temp_dir();
        let path = dir.join("body-file-grants.json");
        fs::write(&path, r#"{"version":2,"workspaces":{"/api":["/a.bin"]}}"#).unwrap();

        assert!(
            BodyFileGrantStore::new(path)
                .grants(Path::new("/api"))
                .is_empty()
        );
        fs::remove_dir_all(&dir).ok();
    }
}
