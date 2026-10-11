use std::path::PathBuf;

use alcy_storage::{StorageError, TabSessionStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTabSessionInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTabSessionInput {
    pub root_path: String,
    pub session: Value,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TabSessionError {
    Storage { message: String },
}

impl From<StorageError> for TabSessionError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

fn load_tab_session_inner(input: LoadTabSessionInput) -> Result<Option<Value>, TabSessionError> {
    Ok(TabSessionStore::new(PathBuf::from(input.root_path)).load()?)
}

fn save_tab_session_inner(input: SaveTabSessionInput) -> Result<(), TabSessionError> {
    TabSessionStore::new(PathBuf::from(input.root_path)).save(&input.session)?;
    Ok(())
}

/// Sessão de abas do workspace (ADR 0039), ou `null` se nunca foi gravada.
#[tauri::command]
pub async fn load_tab_session(
    input: LoadTabSessionInput,
) -> Result<Option<Value>, TabSessionError> {
    let result: Result<Option<Value>, TabSessionError> =
        async { run_blocking(move || load_tab_session_inner(input)).await }.await;
    crate::logging::logged("alcy::workspace", "restaurar abas", result)
}

#[tauri::command]
pub async fn save_tab_session(input: SaveTabSessionInput) -> Result<(), TabSessionError> {
    let result: Result<(), TabSessionError> =
        async { run_blocking(move || save_tab_session_inner(input)).await }.await;
    crate::logging::logged("alcy::workspace", "salvar sessão de abas", result)
}

async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, TabSessionError> + Send + 'static,
) -> Result<T, TabSessionError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| TabSessionError::Storage {
            message: error.to_string(),
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root() -> String {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "alcy-tab-session-command-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        root.to_string_lossy().to_string()
    }

    #[test]
    fn saves_and_loads_a_session() {
        let root_path = temp_root();
        let session = json!({ "version": 1, "activeTabId": null, "tabs": [] });

        assert_eq!(
            load_tab_session_inner(LoadTabSessionInput {
                root_path: root_path.clone()
            }),
            Ok(None)
        );
        save_tab_session_inner(SaveTabSessionInput {
            root_path: root_path.clone(),
            session: session.clone(),
        })
        .unwrap();
        assert_eq!(
            load_tab_session_inner(LoadTabSessionInput { root_path }),
            Ok(Some(session))
        );
    }

    #[test]
    fn reports_an_invalid_session_as_a_storage_error() {
        let result = save_tab_session_inner(SaveTabSessionInput {
            root_path: temp_root(),
            session: json!({ "tabs": [] }),
        });
        assert!(matches!(result, Err(TabSessionError::Storage { .. })));
    }
}
