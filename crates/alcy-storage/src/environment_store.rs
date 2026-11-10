use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use alcy_domain::{Environment, EnvironmentVariable};
use serde::{Deserialize, Serialize};

use crate::local_secrets::{LocalSecrets, SecretKeys};
use crate::storage_error::StorageError;

/// Plain JSON with sensitive values left empty: the file on disk is exactly
/// what version control commits, so git sees it as clean.
const CURRENT_VERSION: u32 = 1;
/// Earlier format, with sensitive values sealed in each variable's
/// `encrypted`. Still read, and moved to the secrets file on the next save.
const SEALED_INLINE_VERSION: u32 = 2;
const MANIFEST_FILE_NAME: &str = "alcy-environments.json";
const SECRETS_VERSION: u32 = 1;
/// Sealed values, beside the environments file. Never versioned: a pull or a
/// push rewrites the environments file and leaves this one alone.
pub const SECRETS_FILE_NAME: &str = "alcy-environments-secrets.json";

/// Whole environments state, read or written at once.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EnvironmentsSnapshot {
    pub environments: Vec<Environment>,
    pub active_environment_id: Option<String>,
}

/// Result of `EnvironmentStore::load`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LoadedEnvironments {
    pub snapshot: EnvironmentsSnapshot,
    /// The file is in the earlier format or holds sensitive values in plain
    /// text, and must be rewritten.
    pub needs_migration: bool,
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    active_environment_id: Option<String>,
    environments: Vec<PersistedEnvironment>,
}

#[derive(Serialize, Deserialize)]
struct PersistedEnvironment {
    id: String,
    name: String,
    variables: Vec<PersistedVariable>,
}

#[derive(Serialize, Deserialize)]
struct PersistedVariable {
    name: String,
    value: String,
    sensitive: bool,
    /// Only in files of the earlier format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    encrypted: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct SecretsFile {
    version: u32,
    secrets: Vec<PersistedSecret>,
}

#[derive(Serialize, Deserialize)]
struct PersistedSecret {
    environment_id: String,
    variable: String,
    /// One value per person who filled the variable in, each opened only by
    /// that person's key.
    sealed: Vec<String>,
}

/// Sealed values by environment id and variable name.
type SealedValues = BTreeMap<(String, String), Vec<String>>;

fn secret_key(environment_id: &str, variable: &str) -> (String, String) {
    (environment_id.to_string(), variable.to_string())
}

/// Gets the local keys only the first time they are needed: a file with
/// nothing sensitive never touches the keyring.
struct LazyKeys<'a> {
    secrets: &'a LocalSecrets,
    keys: Option<Arc<SecretKeys>>,
}

impl<'a> LazyKeys<'a> {
    fn new(secrets: &'a LocalSecrets) -> Self {
        Self {
            secrets,
            keys: None,
        }
    }

    fn get(&mut self) -> Result<&SecretKeys, StorageError> {
        if self.keys.is_none() {
            self.keys = Some(self.secrets.keys()?);
        }
        match &self.keys {
            Some(keys) => Ok(keys),
            None => Err(StorageError::Secrets("chave local indisponível".into())),
        }
    }

    fn seal(&mut self, plaintext: &str) -> Result<String, StorageError> {
        self.get()?
            .encrypt(plaintext)
            .map_err(|error| StorageError::Secrets(error.to_string()))
    }

    /// This person's value among `sealed`; `None` while none of them is theirs.
    fn open(&mut self, sealed: &[String]) -> Result<Option<String>, StorageError> {
        if sealed.is_empty() {
            return Ok(None);
        }
        let keys = self.get()?;
        Ok(sealed.iter().find_map(|value| keys.decrypt(value).ok()))
    }

    /// `stored` with this person's value set to `value` (empty removes it).
    /// Values their key cannot open belong to someone else and stay, and an
    /// unchanged value is not sealed again, so the file only changes when
    /// something did.
    fn updated_sealed(
        &mut self,
        value: &str,
        stored: &[String],
    ) -> Result<Vec<String>, StorageError> {
        let mut kept = Vec::with_capacity(stored.len() + 1);
        let mut has_own = false;
        if !stored.is_empty() {
            let keys = self.get()?;
            for sealed in stored {
                match keys.decrypt(sealed) {
                    Err(_) => kept.push(sealed.clone()),
                    Ok(plain) if plain == value && !has_own => {
                        has_own = true;
                        kept.push(sealed.clone());
                    }
                    Ok(_) => {}
                }
            }
        }
        if !has_own && !value.is_empty() {
            kept.push(self.seal(value)?);
        }
        Ok(kept)
    }
}

/// Reads and writes a workspace's environments (`alcy-environments.json`) at
/// the root of the workspace folder, with atomic writes (temporary file and
/// rename) and a versioned format. Environments are not shared between
/// workspaces: each has its own file, like collections and history.
///
/// Sensitive values are sealed with the local key (`LocalSecrets`) and kept in
/// a separate file. A value sealed by someone else's key stays there and loads
/// empty here, so people using the same folder each keep their own.
pub struct EnvironmentStore {
    path: PathBuf,
    secrets_path: PathBuf,
    secrets: LocalSecrets,
}

impl EnvironmentStore {
    pub fn new(root: PathBuf, secrets: LocalSecrets) -> Self {
        Self {
            path: root.join(MANIFEST_FILE_NAME),
            secrets_path: root.join(SECRETS_FILE_NAME),
            secrets,
        }
    }

    pub fn load(&self) -> Result<LoadedEnvironments, StorageError> {
        let Some(raw) = read_optional(&self.path)? else {
            return Ok(LoadedEnvironments::default());
        };
        let persisted = parse_file(&raw)?;
        let needs_migration = persisted.version != CURRENT_VERSION
            || variables(&persisted)
                .any(|variable| variable.sensitive && !variable.value.is_empty());
        let mut sealed = parse_secrets(read_optional(&self.secrets_path)?.as_deref())?;
        absorb_inline(&mut sealed, &persisted);

        let mut keys = LazyKeys::new(&self.secrets);
        let mut environments = Vec::with_capacity(persisted.environments.len());
        for environment in persisted.environments {
            let mut variables = Vec::with_capacity(environment.variables.len());
            for variable in &environment.variables {
                let value = if variable.sensitive && variable.value.is_empty() {
                    let stored = sealed.get(&secret_key(&environment.id, &variable.name));
                    keys.open(stored.map_or(&[], Vec::as_slice))?
                        .unwrap_or_default()
                } else {
                    variable.value.clone()
                };
                variables.push(
                    EnvironmentVariable::new(variable.name.clone(), value, variable.sensitive)
                        .map_err(|error| StorageError::Corrupted(error.to_string()))?,
                );
            }
            environments.push(
                Environment::new(environment.id, environment.name, variables)
                    .map_err(|error| StorageError::Corrupted(error.to_string()))?,
            );
        }

        Ok(LoadedEnvironments {
            snapshot: EnvironmentsSnapshot {
                environments,
                active_environment_id: persisted.active_environment_id,
            },
            needs_migration,
        })
    }

    /// Writes only the files whose content changed. An unreadable file is an
    /// error rather than nothing: writing over it would lose the values other
    /// people keep there.
    pub fn save(&self, snapshot: &EnvironmentsSnapshot) -> Result<(), StorageError> {
        let current = read_optional(&self.path)?;
        let current_secrets = read_optional(&self.secrets_path)?;
        let mut stored = parse_secrets(current_secrets.as_deref())?;
        if let Some(raw) = &current {
            absorb_inline(&mut stored, &parse_file(raw)?);
        }

        let mut keys = LazyKeys::new(&self.secrets);
        let mut sealed = SealedValues::new();
        let mut environments = Vec::with_capacity(snapshot.environments.len());
        for environment in &snapshot.environments {
            let mut variables = Vec::with_capacity(environment.variables().len());
            for variable in environment.variables() {
                let value = if variable.sensitive {
                    let key = secret_key(&environment.id, variable.name());
                    let previous = stored.get(&key).map_or(&[][..], Vec::as_slice);
                    let updated = keys.updated_sealed(variable.value(), previous)?;
                    if !updated.is_empty() {
                        sealed.insert(key, updated);
                    }
                    String::new()
                } else {
                    variable.value().to_string()
                };
                variables.push(PersistedVariable {
                    name: variable.name().to_string(),
                    value,
                    sensitive: variable.sensitive,
                    encrypted: None,
                });
            }
            environments.push(PersistedEnvironment {
                id: environment.id.clone(),
                name: environment.name().to_string(),
                variables,
            });
        }

        let persisted = PersistedFile {
            version: CURRENT_VERSION,
            active_environment_id: snapshot.active_environment_id.clone(),
            environments,
        };

        // Secrets first: an interruption leaves them in both places, not lost.
        write_secrets(&self.secrets_path, current_secrets.as_deref(), &sealed)?;
        let json = to_json(&persisted)?;
        if current.as_deref() != Some(json.as_slice()) {
            write_atomic(&self.path, &json)?;
        }
        Ok(())
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, StorageError> {
    match fs::read(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(StorageError::Read(error.to_string())),
    }
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), StorageError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
    }
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, content).map_err(|error| StorageError::Write(error.to_string()))?;
    fs::rename(&tmp_path, path).map_err(|error| StorageError::Write(error.to_string()))
}

fn write_secrets(
    path: &Path,
    current: Option<&[u8]>,
    sealed: &SealedValues,
) -> Result<(), StorageError> {
    match secrets_to_json(sealed)? {
        Some(json) if current != Some(json.as_slice()) => write_atomic(path, &json),
        None if current.is_some() => {
            fs::remove_file(path).map_err(|error| StorageError::Write(error.to_string()))
        }
        _ => Ok(()),
    }
}

/// Portable view of the environments file: what version control reads,
/// compares and sends, without sealed values (the local key does not exist on
/// other machines). Sensitive variables go empty, or with this person's value
/// in plain text when `include_sensitive` (they turned the protection off in
/// the settings). `current_secrets` is only needed in that case.
pub fn environments_to_portable(
    local: &[u8],
    current_secrets: Option<&[u8]>,
    secrets: &LocalSecrets,
    include_sensitive: bool,
) -> Result<Vec<u8>, StorageError> {
    let mut file = parse_file(local)?;
    let mut sealed = SealedValues::new();
    if include_sensitive {
        sealed = parse_secrets(current_secrets)?;
        absorb_inline(&mut sealed, &file);
    }
    let mut keys = LazyKeys::new(secrets);
    for environment in &mut file.environments {
        for variable in &mut environment.variables {
            if variable.sensitive {
                if !include_sensitive {
                    variable.value.clear();
                } else if variable.value.is_empty() {
                    let stored = sealed.get(&secret_key(&environment.id, &variable.name));
                    variable.value = keys
                        .open(stored.map_or(&[], Vec::as_slice))?
                        .unwrap_or_default();
                }
            }
            variable.encrypted = None;
        }
    }
    file.version = CURRENT_VERSION;
    to_json(&file)
}

/// What receiving the portable view writes to the workspace folder.
#[derive(Debug)]
pub struct ReceivedEnvironments {
    pub environments: Vec<u8>,
    /// `None` when no sealed value is left.
    pub secrets: Option<Vec<u8>>,
}

/// Turns the portable view (from the remote) into the local files. A sensitive
/// variable that arrives empty keeps the values already sealed for the same
/// environment and name, so receiving from the remote never erases a local
/// secret; one that arrives with a value becomes this person's.
pub fn environments_from_portable(
    portable: &[u8],
    current_local: Option<&[u8]>,
    current_secrets: Option<&[u8]>,
    secrets: &LocalSecrets,
) -> Result<ReceivedEnvironments, StorageError> {
    let mut file = parse_file(portable)?;
    let local = current_local.and_then(|bytes| parse_file(bytes).ok());
    let mut stored = parse_secrets(current_secrets)?;
    if let Some(local) = &local {
        absorb_inline(&mut stored, local);
    }
    let local_plain: BTreeMap<(String, String), &str> = local
        .iter()
        .flat_map(|local| &local.environments)
        .flat_map(|environment| {
            environment
                .variables
                .iter()
                .filter(|variable| variable.sensitive && !variable.value.is_empty())
                .map(|variable| {
                    (
                        secret_key(&environment.id, &variable.name),
                        variable.value.as_str(),
                    )
                })
        })
        .collect();

    let mut keys = LazyKeys::new(secrets);
    let mut sealed = SealedValues::new();
    for environment in &mut file.environments {
        for variable in &mut environment.variables {
            variable.encrypted = None;
            if !variable.sensitive {
                continue;
            }
            let key = secret_key(&environment.id, &variable.name);
            let previous = stored.get(&key).map_or(&[][..], Vec::as_slice);
            let incoming = if variable.value.is_empty() {
                local_plain.get(&key).copied()
            } else {
                Some(variable.value.as_str())
            };
            let updated = match incoming {
                Some(value) => keys.updated_sealed(value, previous)?,
                None => previous.to_vec(),
            };
            variable.value.clear();
            if !updated.is_empty() {
                sealed.insert(key, updated);
            }
        }
    }
    file.version = CURRENT_VERSION;
    Ok(ReceivedEnvironments {
        environments: to_json(&file)?,
        secrets: secrets_to_json(&sealed)?,
    })
}

fn parse_file(raw: &[u8]) -> Result<PersistedFile, StorageError> {
    let persisted: PersistedFile =
        serde_json::from_slice(raw).map_err(|error| StorageError::Corrupted(error.to_string()))?;
    if persisted.version != CURRENT_VERSION && persisted.version != SEALED_INLINE_VERSION {
        return Err(StorageError::UnsupportedVersion(persisted.version));
    }
    Ok(persisted)
}

fn parse_secrets(raw: Option<&[u8]>) -> Result<SealedValues, StorageError> {
    let Some(raw) = raw else {
        return Ok(SealedValues::new());
    };
    let file: SecretsFile =
        serde_json::from_slice(raw).map_err(|error| StorageError::Corrupted(error.to_string()))?;
    if file.version != SECRETS_VERSION {
        return Err(StorageError::UnsupportedVersion(file.version));
    }
    Ok(file
        .secrets
        .into_iter()
        .map(|secret| ((secret.environment_id, secret.variable), secret.sealed))
        .collect())
}

/// `None` when there is nothing to keep: the file then does not exist.
fn secrets_to_json(sealed: &SealedValues) -> Result<Option<Vec<u8>>, StorageError> {
    if sealed.is_empty() {
        return Ok(None);
    }
    let file = SecretsFile {
        version: SECRETS_VERSION,
        secrets: sealed
            .iter()
            .map(|((environment_id, variable), sealed)| PersistedSecret {
                environment_id: environment_id.clone(),
                variable: variable.clone(),
                sealed: sealed.clone(),
            })
            .collect(),
    };
    serde_json::to_vec_pretty(&file)
        .map(Some)
        .map_err(|error| StorageError::Write(error.to_string()))
}

/// Adds the values a file of the earlier format still holds inline, ahead of
/// the rest: such a value was written after the secrets file existed only if
/// someone went back to an earlier Alcy, and then it is the newest one.
fn absorb_inline(sealed: &mut SealedValues, file: &PersistedFile) {
    for environment in &file.environments {
        for variable in environment.variables.iter().filter(|v| v.sensitive) {
            if let Some(value) = &variable.encrypted {
                let entry = sealed
                    .entry(secret_key(&environment.id, &variable.name))
                    .or_default();
                if !entry.contains(value) {
                    entry.insert(0, value.clone());
                }
            }
        }
    }
}

fn to_json(file: &PersistedFile) -> Result<Vec<u8>, StorageError> {
    serde_json::to_vec_pretty(file).map_err(|error| StorageError::Write(error.to_string()))
}

fn variables(file: &PersistedFile) -> impl Iterator<Item = &PersistedVariable> {
    file.environments
        .iter()
        .flat_map(|environment| &environment.variables)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_secrets::tests::{FakeKeyring, temp_key_path, test_secrets};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-environment-store-test-{nanos}-{count}"))
    }

    /// Secrets whose keyring fails: any attempt to get the key is an error,
    /// which proves it was not requested.
    fn secrets_that_must_not_be_used() -> LocalSecrets {
        LocalSecrets::new(
            Box::new(FakeKeyring {
                failing: true,
                ..FakeKeyring::default()
            }),
            temp_key_path(),
        )
    }

    fn sample_snapshot() -> EnvironmentsSnapshot {
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("token", "secret", true).unwrap(),
        ];
        let environment = Environment::new("env-1", "Development", variables).unwrap();

        EnvironmentsSnapshot {
            environments: vec![environment],
            active_environment_id: Some("env-1".to_string()),
        }
    }

    fn portable_file(token: &str) -> String {
        format!(
            r#"{{"version": 1, "active_environment_id": "env-1", "environments": [{{"id": "env-1", "name": "Development", "variables": [{{"name": "baseUrl", "value": "https://api.example.com", "sensitive": false}}, {{"name": "token", "value": "{token}", "sensitive": true}}]}}]}}"#
        )
    }

    fn value_of(snapshot: &EnvironmentsSnapshot, name: &str) -> String {
        snapshot.environments[0]
            .variables()
            .iter()
            .find(|variable| variable.name() == name)
            .map(|variable| variable.value().to_string())
            .unwrap()
    }

    #[test]
    fn load_returns_an_empty_snapshot_when_the_file_does_not_exist() {
        let store = EnvironmentStore::new(temp_root(), test_secrets());

        let loaded = store.load().unwrap();

        assert_eq!(loaded, LoadedEnvironments::default());
    }

    #[test]
    fn save_then_load_round_trips_the_snapshot() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), test_secrets());
        let snapshot = sample_snapshot();

        store.save(&snapshot).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded.snapshot, snapshot);
        assert!(!loaded.needs_migration);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sensitive_values_are_sealed_apart_from_the_shared_file() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        store.save(&sample_snapshot()).unwrap();
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        let secrets = fs::read_to_string(root.join(SECRETS_FILE_NAME)).unwrap();

        assert!(!raw.contains("\"secret\""));
        assert!(!raw.contains("v1:"));
        assert!(raw.contains("https://api.example.com"));
        assert!(!secrets.contains("\"secret\""));
        assert!(secrets.contains("\"v1:"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_saved_file_is_exactly_what_version_control_commits() {
        let secrets = test_secrets();
        let (root, local, sealed) = saved_local_file(&secrets);

        assert_eq!(
            environments_to_portable(&local, sealed.as_deref(), &secrets, false).unwrap(),
            local
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_workspace_without_secrets_has_no_secrets_file() {
        let root = temp_root();
        EnvironmentStore::new(root.clone(), test_secrets())
            .save(&snapshot_with("https://a", "", true))
            .unwrap();

        assert!(!root.join(SECRETS_FILE_NAME).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn saving_again_does_not_touch_an_unchanged_secret() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), test_secrets());
        store.save(&sample_snapshot()).unwrap();
        let before = fs::read(root.join(SECRETS_FILE_NAME)).unwrap();

        store.save(&sample_snapshot()).unwrap();

        assert_eq!(fs::read(root.join(SECRETS_FILE_NAME)).unwrap(), before);
        fs::remove_dir_all(&root).ok();
    }

    /// A file of the earlier format, with one value sealed inline.
    fn inline_file(sealed: &str) -> String {
        format!(
            r#"{{"version": 2, "active_environment_id": "env-1", "environments": [{{"id": "env-1", "name": "Development", "variables": [{{"name": "baseUrl", "value": "https://api.example.com", "sensitive": false}}, {{"name": "token", "value": "", "sensitive": true, "encrypted": "{sealed}"}}]}}]}}"#
        )
    }

    #[test]
    fn a_value_changed_in_an_earlier_version_replaces_the_older_one() {
        let root = temp_root();
        let ana = test_secrets();
        let store = EnvironmentStore::new(root.clone(), ana.clone());
        store
            .save(&snapshot_with("https://api.example.com", "older", true))
            .unwrap();
        let newer = ana.keys().unwrap().encrypt("newer").unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), inline_file(&newer)).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(value_of(&loaded.snapshot, "token"), "newer");
        store.save(&loaded.snapshot).unwrap();

        assert_eq!(token_seen_by(&root, &ana), "newer");
        let sealed = fs::read_to_string(root.join(SECRETS_FILE_NAME)).unwrap();
        assert_eq!(sealed.matches("v1:").count(), 1, "the older value is gone");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn values_sealed_inline_move_to_the_secrets_file() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let (ana, bia) = (test_secrets(), test_secrets());
        let sealed = ana.keys().unwrap().encrypt("ana").unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), inline_file(&sealed)).unwrap();

        let loaded = EnvironmentStore::new(root.clone(), ana.clone())
            .load()
            .unwrap();
        assert!(loaded.needs_migration);
        assert_eq!(value_of(&loaded.snapshot, "token"), "ana");

        // Whoever opens it first moves it, even if the value is not theirs.
        let bia_store = EnvironmentStore::new(root.clone(), bia.clone());
        let loaded = bia_store.load().unwrap();
        bia_store.save(&loaded.snapshot).unwrap();

        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(!raw.contains("encrypted"));
        assert!(raw.contains("\"version\": 1"));
        assert_eq!(token_seen_by(&root, &ana), "ana");
        assert_eq!(token_seen_by(&root, &bia), "");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn files_without_sensitive_values_never_touch_the_key() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), secrets_that_must_not_be_used());
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("empty", "", true).unwrap(),
        ];
        let snapshot = EnvironmentsSnapshot {
            environments: vec![Environment::new("env-1", "Development", variables).unwrap()],
            active_environment_id: None,
        };

        store.save(&snapshot).unwrap();

        assert_eq!(store.load().unwrap().snapshot, snapshot);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_reads_version_1_and_asks_for_migration() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), portable_file("secret")).unwrap();
        let store = EnvironmentStore::new(root.clone(), secrets_that_must_not_be_used());

        let loaded = store.load().unwrap();

        assert_eq!(loaded.snapshot, sample_snapshot());
        assert!(loaded.needs_migration);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn version_1_without_sensitive_values_needs_no_migration() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), portable_file("")).unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        assert!(!store.load().unwrap().needs_migration);
        fs::remove_dir_all(&root).ok();
    }

    fn snapshot_with(base_url: &str, token: &str, sensitive: bool) -> EnvironmentsSnapshot {
        let variables = vec![
            EnvironmentVariable::new("baseUrl", base_url, false).unwrap(),
            EnvironmentVariable::new("token", token, sensitive).unwrap(),
        ];
        EnvironmentsSnapshot {
            environments: vec![Environment::new("env-1", "Development", variables).unwrap()],
            active_environment_id: Some("env-1".to_string()),
        }
    }

    fn token_seen_by(root: &std::path::Path, secrets: &LocalSecrets) -> String {
        let loaded = EnvironmentStore::new(root.to_path_buf(), secrets.clone())
            .load()
            .unwrap();
        value_of(&loaded.snapshot, "token")
    }

    #[test]
    fn a_value_sealed_by_someone_else_loads_empty() {
        let root = temp_root();
        EnvironmentStore::new(root.clone(), test_secrets())
            .save(&sample_snapshot())
            .unwrap();

        let loaded = EnvironmentStore::new(root.clone(), test_secrets())
            .load()
            .unwrap();

        assert_eq!(value_of(&loaded.snapshot, "token"), "");
        assert_eq!(
            value_of(&loaded.snapshot, "baseUrl"),
            "https://api.example.com"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn each_person_sharing_a_folder_keeps_their_own_sensitive_value() {
        let root = temp_root();
        let (ana, bia) = (test_secrets(), test_secrets());
        let ana_store = EnvironmentStore::new(root.clone(), ana.clone());
        let bia_store = EnvironmentStore::new(root.clone(), bia.clone());
        let url = "https://api.example.com";

        ana_store.save(&snapshot_with(url, "ana", true)).unwrap();
        bia_store.save(&snapshot_with(url, "bia", true)).unwrap();
        assert_eq!(token_seen_by(&root, &ana), "ana");
        assert_eq!(token_seen_by(&root, &bia), "bia");

        ana_store.save(&snapshot_with(url, "ana-2", true)).unwrap();
        assert_eq!(token_seen_by(&root, &ana), "ana-2");
        assert_eq!(token_seen_by(&root, &bia), "bia");

        let raw = fs::read_to_string(root.join(SECRETS_FILE_NAME)).unwrap();
        assert_eq!(raw.matches("v1:").count(), 2, "one value per person");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn saving_without_a_value_keeps_what_others_have() {
        let root = temp_root();
        let (ana, bia) = (test_secrets(), test_secrets());
        EnvironmentStore::new(root.clone(), ana.clone())
            .save(&snapshot_with("https://a", "ana", true))
            .unwrap();

        // Bia never filled the token and changes a shared variable.
        EnvironmentStore::new(root.clone(), bia.clone())
            .save(&snapshot_with("https://b", "", true))
            .unwrap();

        assert_eq!(token_seen_by(&root, &ana), "ana");
        assert_eq!(token_seen_by(&root, &bia), "");
        let loaded = EnvironmentStore::new(root.clone(), ana).load().unwrap();
        assert_eq!(value_of(&loaded.snapshot, "baseUrl"), "https://b");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn clearing_a_value_removes_only_your_own() {
        let root = temp_root();
        let (ana, bia) = (test_secrets(), test_secrets());
        let ana_store = EnvironmentStore::new(root.clone(), ana.clone());
        let url = "https://api.example.com";
        ana_store.save(&snapshot_with(url, "ana", true)).unwrap();
        EnvironmentStore::new(root.clone(), bia.clone())
            .save(&snapshot_with(url, "bia", true))
            .unwrap();

        ana_store.save(&snapshot_with(url, "", true)).unwrap();

        assert_eq!(token_seen_by(&root, &ana), "");
        assert_eq!(token_seen_by(&root, &bia), "bia");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_variable_no_longer_sensitive_is_shared_by_everyone() {
        let root = temp_root();
        let (ana, bia) = (test_secrets(), test_secrets());
        EnvironmentStore::new(root.clone(), ana.clone())
            .save(&snapshot_with("https://a", "ana", true))
            .unwrap();

        EnvironmentStore::new(root.clone(), bia.clone())
            .save(&snapshot_with("https://a", "public", false))
            .unwrap();

        assert_eq!(token_seen_by(&root, &ana), "public");
        assert!(!root.join(SECRETS_FILE_NAME).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn saving_over_an_unreadable_file_is_refused() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), "not json").unwrap();

        let error = EnvironmentStore::new(root.clone(), test_secrets())
            .save(&sample_snapshot())
            .unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));
        assert_eq!(
            fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap(),
            "not json"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn saving_over_an_unreadable_secrets_file_is_refused() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(SECRETS_FILE_NAME), "not json").unwrap();

        let error = EnvironmentStore::new(root.clone(), test_secrets())
            .save(&sample_snapshot())
            .unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_does_not_leave_a_temporary_file_behind() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        store.save(&sample_snapshot()).unwrap();

        assert!(!root.join(MANIFEST_FILE_NAME).with_extension("tmp").exists());
        assert!(!root.join(SECRETS_FILE_NAME).with_extension("tmp").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), "not json").unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 99, "active_environment_id": null, "environments": []}"#,
        )
        .unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        let error = store.load().unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_data_that_violates_domain_invariants() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "active_environment_id": null, "environments": [{"id": "env-1", "name": "", "variables": []}]}"#,
        )
        .unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    fn files_in(root: &std::path::Path) -> (Vec<u8>, Option<Vec<u8>>) {
        (
            fs::read(root.join(MANIFEST_FILE_NAME)).unwrap(),
            fs::read(root.join(SECRETS_FILE_NAME)).ok(),
        )
    }

    fn saved_local_file(secrets: &LocalSecrets) -> (PathBuf, Vec<u8>, Option<Vec<u8>>) {
        let root = temp_root();
        EnvironmentStore::new(root.clone(), secrets.clone())
            .save(&sample_snapshot())
            .unwrap();
        let (local, sealed) = files_in(&root);
        (root, local, sealed)
    }

    fn write_received(root: &std::path::Path, received: &ReceivedEnvironments) {
        fs::write(root.join(MANIFEST_FILE_NAME), &received.environments).unwrap();
        match &received.secrets {
            Some(secrets) => fs::write(root.join(SECRETS_FILE_NAME), secrets).unwrap(),
            None => {
                fs::remove_file(root.join(SECRETS_FILE_NAME)).ok();
            }
        }
    }

    fn canonical(json: &str) -> Vec<u8> {
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        let file: PersistedFile = serde_json::from_value(value).unwrap();
        to_json(&file).unwrap()
    }

    #[test]
    fn portable_view_strips_sensitive_values_by_default() {
        let secrets = test_secrets();
        let (root, local, sealed) = saved_local_file(&secrets);

        let portable =
            environments_to_portable(&local, sealed.as_deref(), &secrets, false).unwrap();

        assert_eq!(portable, canonical(&portable_file("")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn portable_view_carries_plain_values_when_allowed() {
        let secrets = test_secrets();
        let (root, local, sealed) = saved_local_file(&secrets);

        let portable = environments_to_portable(&local, sealed.as_deref(), &secrets, true).unwrap();

        assert_eq!(portable, canonical(&portable_file("secret")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stripping_does_not_need_the_key() {
        let secrets = test_secrets();
        let (root, local, sealed) = saved_local_file(&secrets);

        let portable = environments_to_portable(
            &local,
            sealed.as_deref(),
            &secrets_that_must_not_be_used(),
            false,
        )
        .unwrap();

        assert_eq!(portable, canonical(&portable_file("")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn receiving_an_empty_secret_keeps_the_local_one() {
        let secrets = test_secrets();
        let (root, local, sealed) = saved_local_file(&secrets);
        let remote = canonical(&portable_file(""));

        let received =
            environments_from_portable(&remote, Some(&local), sealed.as_deref(), &secrets).unwrap();
        write_received(&root, &received);

        let loaded = EnvironmentStore::new(root.clone(), secrets.clone())
            .load()
            .unwrap();
        assert_eq!(loaded.snapshot, sample_snapshot());
        assert_eq!(received.environments, remote);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn receiving_a_plain_secret_encrypts_it() {
        let secrets = test_secrets();
        let remote = canonical(&portable_file("secret"));

        let received = environments_from_portable(&remote, None, None, &secrets).unwrap();

        let environments = String::from_utf8(received.environments.clone()).unwrap();
        let sealed = received.secrets.unwrap();
        assert!(!environments.contains("\"secret\""));
        assert!(!String::from_utf8_lossy(&sealed).contains("\"secret\""));
        assert_eq!(
            environments_to_portable(&received.environments, Some(&sealed), &secrets, true)
                .unwrap(),
            remote
        );
    }

    #[test]
    fn receiving_keeps_a_plain_secret_from_a_version_1_local_file_encrypted() {
        let secrets = test_secrets();
        let local = portable_file("secret").into_bytes();
        let remote = canonical(&portable_file(""));

        let received = environments_from_portable(&remote, Some(&local), None, &secrets).unwrap();

        let environments = String::from_utf8(received.environments.clone()).unwrap();
        assert!(!environments.contains("\"secret\""));
        assert_eq!(
            environments_to_portable(
                &received.environments,
                received.secrets.as_deref(),
                &secrets,
                true
            )
            .unwrap(),
            canonical(&portable_file("secret"))
        );
    }

    /// Local files where `ana` and `bia` each keep their own token.
    fn files_shared_by(
        ana: &LocalSecrets,
        bia: &LocalSecrets,
    ) -> (PathBuf, Vec<u8>, Option<Vec<u8>>) {
        let root = temp_root();
        let url = "https://api.example.com";
        EnvironmentStore::new(root.clone(), ana.clone())
            .save(&snapshot_with(url, "ana", true))
            .unwrap();
        EnvironmentStore::new(root.clone(), bia.clone())
            .save(&snapshot_with(url, "bia", true))
            .unwrap();
        let (local, sealed) = files_in(&root);
        (root, local, sealed)
    }

    #[test]
    fn the_portable_view_never_carries_anyone_elses_value() {
        let (ana, bia) = (test_secrets(), test_secrets());
        let (root, local, sealed) = files_shared_by(&ana, &bia);

        assert_eq!(
            environments_to_portable(&local, sealed.as_deref(), &ana, false).unwrap(),
            canonical(&portable_file(""))
        );
        assert_eq!(
            environments_to_portable(&local, sealed.as_deref(), &ana, true).unwrap(),
            canonical(&portable_file("ana"))
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn receiving_keeps_the_values_of_everyone_sharing_the_folder() {
        let (ana, bia) = (test_secrets(), test_secrets());
        let (root, local, sealed) = files_shared_by(&ana, &bia);

        let empty = environments_from_portable(
            &canonical(&portable_file("")),
            Some(&local),
            sealed.as_deref(),
            &ana,
        )
        .unwrap();
        write_received(&root, &empty);
        assert_eq!(token_seen_by(&root, &ana), "ana");
        assert_eq!(token_seen_by(&root, &bia), "bia");

        let filled = environments_from_portable(
            &canonical(&portable_file("new")),
            Some(&empty.environments),
            empty.secrets.as_deref(),
            &ana,
        )
        .unwrap();
        write_received(&root, &filled);
        assert_eq!(token_seen_by(&root, &ana), "new");
        assert_eq!(token_seen_by(&root, &bia), "bia");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn portable_conversion_rejects_invalid_content() {
        let secrets = test_secrets();

        assert!(matches!(
            environments_to_portable(b"not json", None, &secrets, false),
            Err(StorageError::Corrupted(_))
        ));
        assert!(matches!(
            environments_from_portable(
                br#"{"version": 99, "active_environment_id": null, "environments": []}"#,
                None,
                None,
                &secrets
            ),
            Err(StorageError::UnsupportedVersion(99))
        ));
    }
}
