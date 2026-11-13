use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use alcy_app::is_only_placeholders;
use serde_json::Value;

use crate::local_secrets::{LazyKeys, LocalSecrets};
use crate::storage_error::StorageError;

const CURRENT_VERSION: u64 = 1;
pub(crate) const FILE_NAME: &str = "alcy-tab-session.json";
/// Teto do arquivo serializado: rascunhos com corpos enormes não viram um
/// arquivo (nem um IPC) sem limite a cada pausa de edição.
pub const MAX_TAB_SESSION_BYTES: usize = 16 * 1024 * 1024;

/// Sessão de abas do workbench de um workspace (`alcy-tab-session.json`,
/// ADR 0039): as abas abertas e o conteúdo das que têm alterações não
/// salvas, para recuperá-las ao reabrir. É estado local desta máquina e
/// fica fora de `VERSIONED_FILES`.
///
/// O conteúdo é um snapshot da interface. Aqui só se garante o envelope
/// (`version` e `tabs` como lista) e o tamanho, e cada aba é validada pelo
/// frontend ao ler.
///
/// The one exception is the secret of each draft's authentication (spec
/// 0161): a literal value goes empty and sealed with the local key in a
/// `sealed` field of the same object, and comes back in place on load.
pub struct TabSessionStore {
    path: PathBuf,
    secrets: LocalSecrets,
}

impl TabSessionStore {
    pub fn new(root: PathBuf, secrets: LocalSecrets) -> Self {
        Self {
            path: root.join(FILE_NAME),
            secrets,
        }
    }

    /// `None` quando o workspace ainda não tem sessão gravada. A session
    /// written before spec 0161, with a literal secret, is rewritten sealed.
    pub fn load(&self) -> Result<Option<Value>, StorageError> {
        let raw = match fs::read(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(StorageError::Read(error.to_string())),
        };
        let mut session: Value = serde_json::from_slice(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        validate_envelope(&session)?;
        let mut keys = LazyKeys::new(&self.secrets);
        let mut holds_literal = false;
        for (authentication, field) in draft_secrets(&mut session) {
            if let Some(Value::String(sealed)) = authentication.remove(SEALED_FIELD) {
                let value = keys.open(&[sealed])?.unwrap_or_default();
                authentication.insert(field.to_string(), Value::String(value));
            } else if authentication
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|value| !is_only_placeholders(value))
            {
                holds_literal = true;
            }
        }
        if holds_literal {
            self.save(session.clone())?;
        }
        Ok(Some(session))
    }

    pub fn save(&self, mut session: Value) -> Result<(), StorageError> {
        validate_envelope(&session)?;
        let mut keys = LazyKeys::new(&self.secrets);
        for (authentication, field) in draft_secrets(&mut session) {
            authentication.remove(SEALED_FIELD);
            let Some(Value::String(value)) = authentication.get_mut(field) else {
                continue;
            };
            if is_only_placeholders(value) {
                continue;
            }
            let sealed = keys.seal(&std::mem::take(value))?;
            authentication.insert(SEALED_FIELD.to_string(), Value::String(sealed));
        }
        let json =
            serde_json::to_vec(&session).map_err(|error| StorageError::Write(error.to_string()))?;
        if json.len() > MAX_TAB_SESSION_BYTES {
            return Err(StorageError::Write(format!(
                "sessão de abas excede {} MB",
                MAX_TAB_SESSION_BYTES / (1024 * 1024)
            )));
        }

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }
        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.path).map_err(|error| StorageError::Write(error.to_string()))
    }
}

/// Field of a draft's authentication that holds its sealed secret.
const SEALED_FIELD: &str = "sealed";

/// Each draft's authentication object with the name of its secret field, as
/// the frontend writes it (camelCase `type` and fields).
fn draft_secrets(session: &mut Value) -> Vec<(&mut serde_json::Map<String, Value>, &'static str)> {
    let Some(tabs) = session.get_mut("tabs").and_then(Value::as_array_mut) else {
        return Vec::new();
    };
    tabs.iter_mut()
        .filter_map(|tab| {
            let authentication = tab
                .get_mut("draft")?
                .get_mut("authentication")?
                .as_object_mut()?;
            let field = match authentication.get("type")?.as_str()? {
                "customHeader" => "value",
                "bearer" => "token",
                "basic" | "digest" => "password",
                "oauth2ClientCredentials" => "clientSecret",
                _ => return None,
            };
            Some((authentication, field))
        })
        .collect()
}

fn validate_envelope(session: &Value) -> Result<(), StorageError> {
    let version = session.get("version").and_then(Value::as_u64);
    match version {
        Some(CURRENT_VERSION) => {}
        Some(other) => {
            return Err(StorageError::UnsupportedVersion(
                u32::try_from(other).unwrap_or(u32::MAX),
            ));
        }
        None => {
            return Err(StorageError::Corrupted(
                "sessão de abas sem versão".to_string(),
            ));
        }
    }
    if !session.get("tabs").is_some_and(Value::is_array) {
        return Err(StorageError::Corrupted(
            "sessão de abas sem lista de abas".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_secrets::tests::{FakeKeyring, temp_key_path, test_secrets};
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "alcy-tab-session-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn session() -> Value {
        json!({
            "version": 1,
            "activeTabId": "tab-1",
            "tabs": [{ "id": "tab-1", "requestId": null, "name": "Rascunho", "draft": { "protocol": "rest" } }]
        })
    }

    const SECRET: &str = "s3cr3t-Vh7Qk";

    /// Every authentication as the frontend writes it in a draft, with
    /// `secret` in the secret field of the variants that have one.
    fn every_authentication(secret: &str) -> Vec<Value> {
        vec![
            json!({ "type": "none" }),
            json!({ "type": "inherit" }),
            json!({ "type": "customHeader", "name": "X-Api-Key", "value": secret }),
            json!({ "type": "bearer", "token": secret }),
            json!({ "type": "basic", "username": "ana", "password": secret }),
            json!({ "type": "digest", "username": "ana", "password": secret }),
            json!({
                "type": "oauth2ClientCredentials",
                "clientId": "client-1",
                "clientSecret": secret,
                "tokenUrl": "https://auth.example.com/token",
                "scope": "read"
            }),
        ]
    }

    fn session_with(authentication: &Value) -> Value {
        json!({
            "version": 1,
            "activeTabId": "tab-1",
            "tabs": [
                { "id": "tab-1", "requestId": null, "name": "Draft", "draft": { "protocol": "rest", "authentication": authentication } },
                { "id": "tab-2", "requestId": "request-1", "name": "Clean", "draft": null }
            ]
        })
    }

    /// Secrets whose keyring fails: using them proves the key was requested.
    fn secrets_that_must_not_be_used() -> LocalSecrets {
        LocalSecrets::new(
            Box::new(FakeKeyring {
                failing: true,
                ..FakeKeyring::default()
            }),
            temp_key_path(),
        )
    }

    #[test]
    fn every_authentication_keeps_its_secret_out_of_the_session_file() {
        for authentication in every_authentication(SECRET) {
            let root = temp_root();
            let store = TabSessionStore::new(root.clone(), test_secrets());

            store.save(session_with(&authentication)).unwrap();

            let file = fs::read_to_string(root.join(FILE_NAME)).unwrap();
            assert!(!file.contains(SECRET), "{file}");
            assert_eq!(
                file.contains(r#""sealed""#),
                !matches!(authentication["type"].as_str(), Some("none" | "inherit")),
                "{file}"
            );
            assert_eq!(store.load().unwrap(), Some(session_with(&authentication)));
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn a_reference_stays_in_the_session_file_without_touching_the_keyring() {
        let root = temp_root();
        let store = TabSessionStore::new(root.clone(), secrets_that_must_not_be_used());
        let session = session_with(&json!({ "type": "bearer", "token": "{{token}}" }));

        store.save(session.clone()).unwrap();

        let file = fs::read_to_string(root.join(FILE_NAME)).unwrap();
        assert!(file.contains("{{token}}") && !file.contains(r#""sealed""#));
        assert_eq!(store.load().unwrap(), Some(session));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_secret_sealed_by_another_key_loads_empty() {
        let root = temp_root();
        TabSessionStore::new(root.clone(), test_secrets())
            .save(session_with(&json!({ "type": "bearer", "token": SECRET })))
            .unwrap();

        let loaded = TabSessionStore::new(root.clone(), test_secrets())
            .load()
            .unwrap();

        assert_eq!(
            loaded,
            Some(session_with(&json!({ "type": "bearer", "token": "" })))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn loading_a_legacy_session_seals_every_authentication() {
        for authentication in every_authentication(SECRET) {
            let root = temp_root();
            fs::create_dir_all(&root).unwrap();
            let legacy = session_with(&authentication);
            fs::write(root.join(FILE_NAME), legacy.to_string()).unwrap();
            let store = TabSessionStore::new(root.clone(), test_secrets());

            assert_eq!(store.load().unwrap(), Some(legacy.clone()));

            let file = fs::read_to_string(root.join(FILE_NAME)).unwrap();
            assert!(!file.contains(SECRET), "{file}");
            assert_eq!(store.load().unwrap(), Some(legacy));
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn returns_none_without_a_saved_session() {
        assert_eq!(
            TabSessionStore::new(temp_root(), test_secrets())
                .load()
                .unwrap(),
            None
        );
    }

    #[test]
    fn saves_and_loads_the_session() {
        let store = TabSessionStore::new(temp_root(), test_secrets());
        store.save(session()).unwrap();
        assert_eq!(store.load().unwrap(), Some(session()));
    }

    #[test]
    fn rejects_an_invalid_envelope() {
        let store = TabSessionStore::new(temp_root(), test_secrets());
        assert!(matches!(
            store.save(json!({ "version": 2, "tabs": [] })),
            Err(StorageError::UnsupportedVersion(2))
        ));
        assert!(matches!(
            store.save(json!({ "version": 1, "tabs": {} })),
            Err(StorageError::Corrupted(_))
        ));
        assert!(matches!(
            store.save(json!([])),
            Err(StorageError::Corrupted(_))
        ));
    }

    #[test]
    fn reports_a_corrupted_file() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(FILE_NAME), b"{ not json").unwrap();
        assert!(matches!(
            TabSessionStore::new(root, test_secrets()).load(),
            Err(StorageError::Corrupted(_))
        ));
    }

    #[test]
    fn rejects_a_session_above_the_size_limit() {
        let store = TabSessionStore::new(temp_root(), test_secrets());
        let huge = json!({
            "version": 1,
            "activeTabId": null,
            "tabs": [{ "draft": "x".repeat(MAX_TAB_SESSION_BYTES) }]
        });
        assert!(matches!(store.save(huge), Err(StorageError::Write(_))));
        assert_eq!(store.load().unwrap(), None);
    }
}
