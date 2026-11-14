use std::fs;
use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::commands::response_body_cache::ResponseBodyCache;
use crate::commands::save_dialog::{SaveFilter, SaveOutcome, choose_save_path, safe_file_name};

/// How the received body is written: text as is, or binary in base64
/// (mirrors `ResponseBodyEncodingOutput`, see ADR 0009).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveResponseBodyEncoding {
    Text,
    Base64,
}

/// Where the body comes from: whole, when it already crossed the IPC
/// (`Inline`), or the handle of a large body kept in `ResponseBodyCache`
/// (`Windowed`) — the frontend only has a window of it, so the full body
/// never goes back through the IPC.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveResponseBodySource {
    Inline { body: String },
    Windowed { handle: String },
}

/// No destination path: the backend asks for it in the save dialog
/// (ADR 0081).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponseBodyInput {
    pub suggested_name: String,
    /// Label of the dialog's "all files" filter, in the interface language.
    pub all_files_label: String,
    pub encoding: SaveResponseBodyEncoding,
    pub source: SaveResponseBodySource,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveResponseBodyError {
    /// The handle is no longer in the cache (released or evicted by the cap).
    NotFound,
    Invalid {
        message: String,
    },
    Storage {
        message: String,
    },
}

/// Saves a response body where the person chooses ("Download response").
/// Base64 bodies are decoded to the original bytes before the dialog opens,
/// so an invalid body never asks for a destination.
#[tauri::command]
pub async fn save_response_body(
    input: SaveResponseBodyInput,
    window: tauri::WebviewWindow,
    cache: tauri::State<'_, ResponseBodyCache>,
) -> Result<SaveOutcome, SaveResponseBodyError> {
    let result: Result<SaveOutcome, SaveResponseBodyError> = async {
        let body = response_body(input.source, &cache)?;
        let bytes = body_bytes(body, input.encoding)?;
        let file_name = safe_file_name(&input.suggested_name, "response", None);
        let extension = Path::new(&file_name)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_string);
        let label = extension.as_deref().map(str::to_uppercase);
        let typed = extension.as_deref().map(|extension| [extension]);
        let mut filters = Vec::new();
        if let (Some(label), Some(typed)) = (label.as_deref(), typed.as_ref()) {
            filters.push(SaveFilter {
                name: label,
                extensions: typed,
            });
        }
        filters.push(SaveFilter {
            name: &input.all_files_label,
            extensions: &["*"],
        });
        let Some(path) = choose_save_path(&window, file_name, &filters).await else {
            return Ok(SaveOutcome::Cancelled);
        };
        tauri::async_runtime::spawn_blocking(move || write_body(&path, &bytes))
            .await
            .unwrap_or_else(|error| {
                Err(SaveResponseBodyError::Storage {
                    message: error.to_string(),
                })
            })?;
        Ok(SaveOutcome::Saved)
    }
    .await;
    crate::logging::logged("alcy::export", "salvar resposta", result)
}

fn response_body(
    source: SaveResponseBodySource,
    cache: &ResponseBodyCache,
) -> Result<Arc<str>, SaveResponseBodyError> {
    match source {
        SaveResponseBodySource::Inline { body } => Ok(body.into()),
        SaveResponseBodySource::Windowed { handle } => {
            cache.get(&handle).ok_or(SaveResponseBodyError::NotFound)
        }
    }
}

/// The bytes to write: the text as is, or the decoded base64.
enum BodyBytes {
    Text(Arc<str>),
    Binary(Vec<u8>),
}

impl BodyBytes {
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Text(text) => text.as_bytes(),
            Self::Binary(bytes) => bytes,
        }
    }
}

fn body_bytes(
    body: Arc<str>,
    encoding: SaveResponseBodyEncoding,
) -> Result<BodyBytes, SaveResponseBodyError> {
    match encoding {
        SaveResponseBodyEncoding::Text => Ok(BodyBytes::Text(body)),
        SaveResponseBodyEncoding::Base64 => base64::engine::general_purpose::STANDARD
            .decode(body.as_bytes())
            .map(BodyBytes::Binary)
            .map_err(|_| SaveResponseBodyError::Invalid {
                message: "o corpo da resposta não é base64 válido".to_string(),
            }),
    }
}

fn write_body(path: &Path, bytes: &BodyBytes) -> Result<(), SaveResponseBodyError> {
    fs::write(path, bytes.as_slice()).map_err(|error| SaveResponseBodyError::Storage {
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("alcy-response-cmd-test-{nanos}-{count}"));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn writes_an_inline_text_body() {
        let root = temp_root();
        let path = root.join("resposta.json");
        let cache = ResponseBodyCache::new(5);

        let body = response_body(
            SaveResponseBodySource::Inline {
                body: r#"{"ok":"é"}"#.to_string(),
            },
            &cache,
        )
        .expect("body");
        let bytes = body_bytes(body, SaveResponseBodyEncoding::Text).expect("bytes");
        write_body(&path, &bytes).expect("write");

        assert_eq!(fs::read_to_string(&path).expect("read"), r#"{"ok":"é"}"#);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decodes_a_base64_body_to_the_original_bytes() {
        let root = temp_root();
        let path = root.join("imagem.png");
        let raw = [0x89_u8, b'P', b'N', b'G', 0x00, 0xFF];
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);

        let bytes = body_bytes(encoded.into(), SaveResponseBodyEncoding::Base64).expect("bytes");
        write_body(&path, &bytes).expect("write");

        assert_eq!(fs::read(&path).expect("read"), raw);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_a_windowed_body_from_the_cache() {
        let cache = ResponseBodyCache::new(5);
        let body = "x".repeat(4096);
        cache.insert("exec-1".to_string(), Arc::from(body.as_str()));

        let found = response_body(
            SaveResponseBodySource::Windowed {
                handle: "exec-1".to_string(),
            },
            &cache,
        )
        .expect("body");

        assert_eq!(found.as_ref(), body);
    }

    #[test]
    fn fails_with_not_found_for_an_unknown_handle() {
        let cache = ResponseBodyCache::new(5);

        let error = response_body(
            SaveResponseBodySource::Windowed {
                handle: "does-not-exist".to_string(),
            },
            &cache,
        )
        .expect_err("must fail");

        assert_eq!(error, SaveResponseBodyError::NotFound);
    }

    #[test]
    fn rejects_an_invalid_base64_body() {
        let error = body_bytes("não é base64!".into(), SaveResponseBodyEncoding::Base64)
            .err()
            .expect("must fail");

        assert!(matches!(error, SaveResponseBodyError::Invalid { .. }));
    }

    #[test]
    fn deserializes_the_camel_case_input() {
        let input: SaveResponseBodyInput = serde_json::from_value(serde_json::json!({
            "suggestedName": "a.bin",
            "allFilesLabel": "All files",
            "encoding": "base64",
            "source": { "kind": "windowed", "handle": "exec-1" }
        }))
        .expect("deserialize");

        assert_eq!(input.encoding, SaveResponseBodyEncoding::Base64);
        assert_eq!(input.suggested_name, "a.bin");
        assert!(
            matches!(input.source, SaveResponseBodySource::Windowed { ref handle } if handle == "exec-1")
        );
    }
}
