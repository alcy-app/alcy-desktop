//! This person's decision about the scripts of each workspace folder
//! (spec 0162). Kept in the app data folder, never in the workspace: the
//! workspace is versioned or synced, and whoever can write there must not be
//! able to grant trust.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use alcy_domain::WorkspaceScriptTrust;
use serde::{Deserialize, Serialize};

use crate::environment_store::write_atomic;
use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Decision {
    Trusted,
    Untrusted,
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    /// Workspaces opened before this file existed were trusted once.
    #[serde(default)]
    migrated: bool,
    /// Canonical workspace path → decision. A missing path is undecided.
    #[serde(default)]
    workspaces: BTreeMap<String, Decision>,
}

impl Default for PersistedFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            migrated: false,
            workspaces: BTreeMap::new(),
        }
    }
}

/// Reads and writes `script-trust.json`. Clones share one lock, so two
/// commands never interleave their read-modify-write.
#[derive(Clone)]
pub struct ScriptTrustStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl ScriptTrustStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// The decision about `root`. An unreadable file trusts nothing.
    pub fn workspace(&self, root: &Path) -> WorkspaceScriptTrust {
        let Ok(_guard) = self.lock.lock() else {
            return WorkspaceScriptTrust::Undecided;
        };
        self.read().map_or(WorkspaceScriptTrust::Undecided, |file| {
            decision_of(&file, root)
        })
    }

    /// Records whether this person trusts the scripts of `root`.
    pub fn set_workspace(&self, root: &Path, trusted: bool) -> Result<(), StorageError> {
        self.set_decision(
            root,
            if trusted {
                WorkspaceScriptTrust::Trusted
            } else {
                WorkspaceScriptTrust::Untrusted
            },
        )
    }

    /// Records `trust` for `root`; `Undecided` forgets the decision. Used to
    /// carry a decision along when the app moves the workspace folder.
    pub fn set_decision(
        &self,
        root: &Path,
        trust: WorkspaceScriptTrust,
    ) -> Result<(), StorageError> {
        let key = key(root);
        self.update(|file| match trust {
            WorkspaceScriptTrust::Trusted => {
                file.workspaces.insert(key, Decision::Trusted);
            }
            WorkspaceScriptTrust::Untrusted => {
                file.workspaces.insert(key, Decision::Untrusted);
            }
            WorkspaceScriptTrust::Undecided => {
                file.workspaces.remove(&key);
            }
        })
    }

    /// Trusts `root` unless this person already decided otherwise: a
    /// workspace created empty in the app holds only what they write.
    pub fn trust_if_undecided(&self, root: &Path) -> Result<(), StorageError> {
        self.update(|file| {
            file.workspaces
                .entry(key(root))
                .or_insert(Decision::Trusted);
        })
    }

    /// Trusts, once, the workspaces this person already had open before
    /// this file existed: their scripts were already running.
    pub fn migrate(&self, roots: &[PathBuf]) -> Result<(), StorageError> {
        let Ok(_guard) = self.lock.lock() else {
            return Err(StorageError::Write(
                "script trust lock poisoned".to_string(),
            ));
        };
        let mut file = self.read_or_back_up()?;
        if file.migrated {
            return Ok(());
        }
        for root in roots {
            file.workspaces
                .entry(key(root))
                .or_insert(Decision::Trusted);
        }
        file.migrated = true;
        self.write(&file)
    }

    fn update(&self, change: impl FnOnce(&mut PersistedFile)) -> Result<(), StorageError> {
        let Ok(_guard) = self.lock.lock() else {
            return Err(StorageError::Write(
                "script trust lock poisoned".to_string(),
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
    /// before being replaced, and its decisions are not carried over: the
    /// workspaces in it become undecided again.
    fn read_or_back_up(&self) -> Result<PersistedFile, StorageError> {
        match self.read() {
            Ok(file) => Ok(file),
            Err(StorageError::Read(message)) => Err(StorageError::Read(message)),
            Err(_) => {
                fs::copy(&self.path, self.path.with_extension("json.bak"))
                    .map_err(|error| StorageError::Write(error.to_string()))?;
                Ok(PersistedFile {
                    // The workspaces it listed were already migrated.
                    migrated: true,
                    ..PersistedFile::default()
                })
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

fn decision_of(file: &PersistedFile, root: &Path) -> WorkspaceScriptTrust {
    match file.workspaces.get(&key(root)) {
        Some(Decision::Trusted) => WorkspaceScriptTrust::Trusted,
        Some(Decision::Untrusted) => WorkspaceScriptTrust::Untrusted,
        None => WorkspaceScriptTrust::Undecided,
    }
}

/// The same folder reached through another spelling (a trailing separator,
/// a symlink) maps to one entry. A folder that no longer exists keeps its
/// path as given.
fn key(root: &Path) -> String {
    fs::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
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
        let dir = std::env::temp_dir().join(format!("alcy-script-trust-test-{nanos}-{count}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn workspace(dir: &Path, name: &str) -> PathBuf {
        let root = dir.join(name);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_workspace_without_a_decision_is_undecided() {
        let dir = temp_dir();
        let store = ScriptTrustStore::new(dir.join("script-trust.json"));
        assert_eq!(
            store.workspace(&workspace(&dir, "api")),
            WorkspaceScriptTrust::Undecided
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decisions_round_trip_and_can_be_revoked() {
        let dir = temp_dir();
        let store = ScriptTrustStore::new(dir.join("script-trust.json"));
        let root = workspace(&dir, "api");

        store.set_workspace(&root, true).unwrap();
        assert_eq!(store.workspace(&root), WorkspaceScriptTrust::Trusted);
        store.set_workspace(&root, false).unwrap();
        assert_eq!(store.workspace(&root), WorkspaceScriptTrust::Untrusted);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_decision_can_be_forgotten() {
        let dir = temp_dir();
        let store = ScriptTrustStore::new(dir.join("script-trust.json"));
        let root = workspace(&dir, "api");

        store.set_workspace(&root, true).unwrap();
        store
            .set_decision(&root, WorkspaceScriptTrust::Undecided)
            .unwrap();
        assert_eq!(store.workspace(&root), WorkspaceScriptTrust::Undecided);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn another_spelling_of_the_same_folder_shares_the_decision() {
        let dir = temp_dir();
        let store = ScriptTrustStore::new(dir.join("script-trust.json"));
        let root = workspace(&dir, "api");

        store.set_workspace(&root.join("."), true).unwrap();
        assert_eq!(store.workspace(&root), WorkspaceScriptTrust::Trusted);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn trusting_a_new_workspace_keeps_an_earlier_refusal() {
        let dir = temp_dir();
        let store = ScriptTrustStore::new(dir.join("script-trust.json"));
        let fresh = workspace(&dir, "fresh");
        let refused = workspace(&dir, "refused");
        store.set_workspace(&refused, false).unwrap();

        store.trust_if_undecided(&fresh).unwrap();
        store.trust_if_undecided(&refused).unwrap();

        assert_eq!(store.workspace(&fresh), WorkspaceScriptTrust::Trusted);
        assert_eq!(store.workspace(&refused), WorkspaceScriptTrust::Untrusted);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migration_trusts_existing_workspaces_only_once() {
        let dir = temp_dir();
        let store = ScriptTrustStore::new(dir.join("script-trust.json"));
        let known = workspace(&dir, "known");
        let later = workspace(&dir, "later");

        store.migrate(std::slice::from_ref(&known)).unwrap();
        store.migrate(std::slice::from_ref(&later)).unwrap();

        assert_eq!(store.workspace(&known), WorkspaceScriptTrust::Trusted);
        assert_eq!(store.workspace(&later), WorkspaceScriptTrust::Undecided);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_file_trusts_nothing_and_is_backed_up_before_a_write() {
        let dir = temp_dir();
        let path = dir.join("script-trust.json");
        let root = workspace(&dir, "api");
        fs::write(&path, "{ not json").unwrap();
        let store = ScriptTrustStore::new(path.clone());

        assert_eq!(store.workspace(&root), WorkspaceScriptTrust::Undecided);
        store.migrate(std::slice::from_ref(&root)).unwrap();
        assert_eq!(store.workspace(&root), WorkspaceScriptTrust::Undecided);

        store.set_workspace(&root, true).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("script-trust.json.bak")).unwrap(),
            "{ not json"
        );
        assert_eq!(store.workspace(&root), WorkspaceScriptTrust::Trusted);
        fs::remove_dir_all(&dir).ok();
    }
}
