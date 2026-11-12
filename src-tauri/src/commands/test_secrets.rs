//! Local key for command tests: a machine without a keyring, so the key goes
//! to a file in a temporary folder. Every test acts as the same person.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use alcy_app::{CredentialError, CredentialStore};
use alcy_storage::LocalSecrets;

struct NoKeyring;

impl CredentialStore for NoKeyring {
    fn load(&self, _key: &str) -> Result<Option<String>, CredentialError> {
        Err(CredentialError::Unavailable("no keyring".into()))
    }

    fn save(&self, _key: &str, _secret: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable("no keyring".into()))
    }

    fn delete(&self, _key: &str) -> Result<(), CredentialError> {
        Ok(())
    }
}

static SECRETS: OnceLock<LocalSecrets> = OnceLock::new();

pub(crate) fn test_secrets() -> LocalSecrets {
    SECRETS
        .get_or_init(|| {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir().join(format!(
                "alcy-command-secrets-{}-{nanos}",
                std::process::id()
            ));
            LocalSecrets::new(Box::new(NoKeyring), dir.join("test-key"))
        })
        .clone()
}
