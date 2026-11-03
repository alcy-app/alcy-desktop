use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHarInput {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportHarError {
    Invalid { message: String },
    Storage { message: String },
}

/// Grava o HAR já serializado pelo frontend no arquivo escolhido pelo
/// usuário. O conteúdo é limitado pela gravação em memória (ver
/// `use-recorder-state.ts`), então não viola o invariante de dados grandes.
#[tauri::command]
pub async fn export_har(
    input: ExportHarInput,
    usage: tauri::State<'_, alcy_app::UsageHub>,
) -> Result<(), ExportHarError> {
    let result: Result<(), ExportHarError> = async {
        let path = PathBuf::from(input.path);
        let content = input.content;
        tauri::async_runtime::spawn_blocking(move || write_har(&path, &content))
            .await
            .unwrap_or_else(|error| {
                Err(ExportHarError::Storage {
                    message: error.to_string(),
                })
            })
    }
    .await;
    crate::commands::usage_events::record_export(&usage, "har", &result);
    crate::logging::logged("alcy::export", "exportar HAR", result)
}

fn write_har(path: &Path, content: &str) -> Result<(), ExportHarError> {
    let has_har_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("har"));
    if !has_har_extension {
        return Err(ExportHarError::Invalid {
            message: "o arquivo deve ter a extensão .har".to_string(),
        });
    }

    fs::write(path, content).map_err(|error| ExportHarError::Storage {
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("alcy-har-cmd-test-{nanos}-{count}"));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn writes_content_to_har_file() {
        let root = temp_root();
        let path = root.join("session.har");

        write_har(&path, "{\"log\":{}}").expect("write");

        assert_eq!(fs::read_to_string(&path).expect("read"), "{\"log\":{}}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_path_without_har_extension() {
        let root = temp_root();
        let path = root.join("session.json");

        let error = write_har(&path, "{}").expect_err("must reject");

        assert!(matches!(error, ExportHarError::Invalid { .. }));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reports_storage_error_when_directory_is_missing() {
        let root = temp_root();
        let path = root.join("missing").join("session.har");

        let error = write_har(&path, "{}").expect_err("must fail");

        assert!(matches!(error, ExportHarError::Storage { .. }));
        let _ = fs::remove_dir_all(&root);
    }
}
