use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use serde_json::Value;

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
pub struct TabSessionStore {
    path: PathBuf,
}

impl TabSessionStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join(FILE_NAME),
        }
    }

    /// `None` quando o workspace ainda não tem sessão gravada.
    pub fn load(&self) -> Result<Option<Value>, StorageError> {
        let raw = match fs::read(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(StorageError::Read(error.to_string())),
        };
        let session: Value = serde_json::from_slice(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        validate_envelope(&session)?;
        Ok(Some(session))
    }

    pub fn save(&self, session: &Value) -> Result<(), StorageError> {
        validate_envelope(session)?;
        let json =
            serde_json::to_vec(session).map_err(|error| StorageError::Write(error.to_string()))?;
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

    #[test]
    fn returns_none_without_a_saved_session() {
        assert_eq!(TabSessionStore::new(temp_root()).load().unwrap(), None);
    }

    #[test]
    fn saves_and_loads_the_session() {
        let store = TabSessionStore::new(temp_root());
        store.save(&session()).unwrap();
        assert_eq!(store.load().unwrap(), Some(session()));
    }

    #[test]
    fn rejects_an_invalid_envelope() {
        let store = TabSessionStore::new(temp_root());
        assert!(matches!(
            store.save(&json!({ "version": 2, "tabs": [] })),
            Err(StorageError::UnsupportedVersion(2))
        ));
        assert!(matches!(
            store.save(&json!({ "version": 1, "tabs": {} })),
            Err(StorageError::Corrupted(_))
        ));
        assert!(matches!(
            store.save(&json!([])),
            Err(StorageError::Corrupted(_))
        ));
    }

    #[test]
    fn reports_a_corrupted_file() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(FILE_NAME), b"{ not json").unwrap();
        assert!(matches!(
            TabSessionStore::new(root).load(),
            Err(StorageError::Corrupted(_))
        ));
    }

    #[test]
    fn rejects_a_session_above_the_size_limit() {
        let store = TabSessionStore::new(temp_root());
        let huge = json!({
            "version": 1,
            "activeTabId": null,
            "tabs": [{ "draft": "x".repeat(MAX_TAB_SESSION_BYTES) }]
        });
        assert!(matches!(store.save(&huge), Err(StorageError::Write(_))));
        assert_eq!(store.load().unwrap(), None);
    }
}
