use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::commands::response_body_cache::ResponseBodyCache;

/// Como o corpo recebido deve ser gravado: texto direto ou binário em base64
/// (espelha `ResponseBodyEncodingOutput`, ver ADR 0009).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveResponseBodyEncoding {
    Text,
    Base64,
}

/// De onde vem o corpo: inteiro, quando já cruzou a IPC (`Inline`), ou o
/// handle de um corpo grande retido em `ResponseBodyCache` (`Windowed`) — o
/// frontend só tem uma janela dele, então o corpo completo nunca volta pela
/// IPC.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveResponseBodySource {
    Inline { body: String },
    Windowed { handle: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponseBodyInput {
    pub path: String,
    pub encoding: SaveResponseBodyEncoding,
    pub source: SaveResponseBodySource,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveResponseBodyError {
    /// O handle não está mais no cache (liberado ou despejado pelo cap).
    NotFound,
    Invalid {
        message: String,
    },
    Storage {
        message: String,
    },
}

/// Grava o corpo de uma resposta no arquivo escolhido pelo usuário ("Baixar
/// resposta"). Corpos em base64 são decodificados para os bytes originais.
#[tauri::command]
pub async fn save_response_body(
    input: SaveResponseBodyInput,
    cache: tauri::State<'_, ResponseBodyCache>,
) -> Result<(), SaveResponseBodyError> {
    let result: Result<(), SaveResponseBodyError> = async {
        let path = PathBuf::from(&input.path);
        let encoding = input.encoding;
        let body = response_body(input.source, &cache)?;
        tauri::async_runtime::spawn_blocking(move || write_body(&path, &body, encoding))
            .await
            .unwrap_or_else(|error| {
                Err(SaveResponseBodyError::Storage {
                    message: error.to_string(),
                })
            })
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

fn write_body(
    path: &Path,
    body: &str,
    encoding: SaveResponseBodyEncoding,
) -> Result<(), SaveResponseBodyError> {
    let result = match encoding {
        SaveResponseBodyEncoding::Text => fs::write(path, body.as_bytes()),
        SaveResponseBodyEncoding::Base64 => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(body.as_bytes())
                .map_err(|_| SaveResponseBodyError::Invalid {
                    message: "o corpo da resposta não é base64 válido".to_string(),
                })?;
            fs::write(path, bytes)
        }
    };
    result.map_err(|error| SaveResponseBodyError::Storage {
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
        write_body(&path, &body, SaveResponseBodyEncoding::Text).expect("write");

        assert_eq!(fs::read_to_string(&path).expect("read"), r#"{"ok":"é"}"#);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decodes_a_base64_body_to_the_original_bytes() {
        let root = temp_root();
        let path = root.join("imagem.png");
        let raw = [0x89_u8, b'P', b'N', b'G', 0x00, 0xFF];
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);

        write_body(&path, &encoded, SaveResponseBodyEncoding::Base64).expect("write");

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
    fn rejects_an_invalid_base64_body_without_creating_the_file() {
        let root = temp_root();
        let path = root.join("imagem.png");

        let error = write_body(&path, "não é base64!", SaveResponseBodyEncoding::Base64)
            .expect_err("must fail");

        assert!(matches!(error, SaveResponseBodyError::Invalid { .. }));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deserializes_the_camel_case_input() {
        let input: SaveResponseBodyInput = serde_json::from_value(serde_json::json!({
            "path": "/tmp/a.bin",
            "encoding": "base64",
            "source": { "kind": "windowed", "handle": "exec-1" }
        }))
        .expect("deserialize");

        assert_eq!(input.encoding, SaveResponseBodyEncoding::Base64);
        assert!(
            matches!(input.source, SaveResponseBodySource::Windowed { ref handle } if handle == "exec-1")
        );
    }
}
