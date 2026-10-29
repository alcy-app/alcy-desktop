use alcy_app::{CredentialError, CredentialStore};
use keyring::{Entry, Error};

/// `CredentialStore` sobre o chaveiro do sistema (Credential Manager no
/// Windows, Secret Service no Linux, Keychain no macOS).
pub struct KeyringCredentialStore {
    service: String,
}

impl KeyringCredentialStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, key: &str) -> Result<Entry, CredentialError> {
        Entry::new(&self.service, key).map_err(map_error)
    }
}

fn map_error(error: Error) -> CredentialError {
    match error {
        // The store is set up once per process; its own error says why it is
        // missing (e.g. a session bus address left stale by a bus restart).
        Error::NoDefaultStore => CredentialError::Unavailable(match Entry::store_status() {
            Err(reason) => reason.to_string(),
            Ok(()) => error.to_string(),
        }),
        Error::NoStorageAccess(_) | Error::PlatformFailure(_) => {
            CredentialError::Unavailable(error.to_string())
        }
        other => CredentialError::Failed(other.to_string()),
    }
}

impl CredentialStore for KeyringCredentialStore {
    fn load(&self, key: &str) -> Result<Option<String>, CredentialError> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(map_error(error)),
        }
    }

    fn save(&self, key: &str, secret: &str) -> Result<(), CredentialError> {
        self.entry(key)?.set_password(secret).map_err(map_error)
    }

    fn delete(&self, key: &str) -> Result<(), CredentialError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(map_error(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Usa o chaveiro real da máquina; sem chaveiro (ex.: CI sem Secret
    /// Service) o teste é ignorado em vez de falhar.
    #[tokio::test(flavor = "multi_thread")]
    async fn roundtrips_a_secret_from_inside_an_async_runtime() {
        let store = KeyringCredentialStore::new("alcy-test");
        let key = format!("roundtrip-{}", std::process::id());

        match store.save(&key, "segredo") {
            Err(CredentialError::Unavailable(reason)) => {
                eprintln!("chaveiro indisponível, teste ignorado: {reason}");
                return;
            }
            other => other.unwrap(),
        }

        assert_eq!(store.load(&key).unwrap().as_deref(), Some("segredo"));
        store.delete(&key).unwrap();
        assert_eq!(store.load(&key).unwrap(), None);
        store.delete(&key).unwrap();
    }
}
