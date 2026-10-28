use std::fs;
use std::path::PathBuf;

use alcy_domain::OnedriveAccount;
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAccount {
    id: String,
    tenant: String,
    client_id: String,
    username: String,
    name: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    accounts: Vec<PersistedAccount>,
}

/// Reads and writes the Microsoft accounts known to the app
/// (`onedrive-accounts.json`).
///
/// Holds public data only; tokens live in the system keyring.
pub struct OnedriveAccountsStore {
    path: PathBuf,
}

impl OnedriveAccountsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Without the file, there are no accounts.
    pub fn load(&self) -> Result<Vec<OnedriveAccount>, StorageError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }

        file.accounts
            .into_iter()
            .map(|account| {
                OnedriveAccount::new(
                    account.id,
                    &account.tenant,
                    &account.client_id,
                    account.username,
                    account.name,
                )
                .map_err(|error| StorageError::Corrupted(error.to_string()))
            })
            .collect()
    }

    pub fn save(&self, accounts: &[OnedriveAccount]) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            accounts: accounts
                .iter()
                .map(|account| PersistedAccount {
                    id: account.id.clone(),
                    tenant: account.tenant.clone(),
                    client_id: account.client_id.clone(),
                    username: account.username.clone(),
                    name: account.name.clone(),
                })
                .collect(),
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

    /// Inserts the account or replaces the one with the same `id`.
    pub fn upsert(&self, account: OnedriveAccount) -> Result<(), StorageError> {
        let mut accounts = self.load()?;
        match accounts
            .iter_mut()
            .find(|existing| existing.id == account.id)
        {
            Some(existing) => *existing = account,
            None => accounts.push(account),
        }
        self.save(&accounts)
    }

    pub fn remove(&self, account_id: &str) -> Result<(), StorageError> {
        let mut accounts = self.load()?;
        accounts.retain(|account| account.id != account_id);
        self.save(&accounts)
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
        std::env::temp_dir().join(format!("alcy-onedrive-accounts-test-{nanos}-{count}.json"))
    }

    fn account(id: &str, name: &str) -> OnedriveAccount {
        OnedriveAccount::new(id, "organizations", "cid", "user@x.com", name).unwrap()
    }

    #[test]
    fn missing_file_has_no_accounts() {
        assert!(
            OnedriveAccountsStore::new(temp_path())
                .load()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn upserts_replaces_and_removes_accounts() {
        let path = temp_path();
        let store = OnedriveAccountsStore::new(path.clone());

        store.upsert(account("a", "One")).unwrap();
        store.upsert(account("b", "Two")).unwrap();
        store.upsert(account("a", "One again")).unwrap();

        let accounts = store.load().unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].name, "One again");
        assert_eq!(accounts[0].tenant, "organizations");

        store.remove("a").unwrap();
        let accounts = store.load().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "b");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn file_never_contains_token_like_fields() {
        let path = temp_path();
        let store = OnedriveAccountsStore::new(path.clone());
        store.upsert(account("a", "One")).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"tenant\""));
        assert!(!raw.to_lowercase().contains("token"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_version_and_corrupted_file() {
        let path = temp_path();
        let store = OnedriveAccountsStore::new(path.clone());

        fs::write(&path, r#"{"version":99,"accounts":[]}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(99))
        ));

        fs::write(&path, "not json").unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));

        fs::write(
            &path,
            r#"{"version":1,"accounts":[{"id":"a","tenant":"a/b","clientId":"c","username":"u","name":"n"}]}"#,
        )
        .unwrap();
        assert!(matches!(store.load(), Err(StorageError::Corrupted(_))));
        let _ = fs::remove_file(path);
    }
}
