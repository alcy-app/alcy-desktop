use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

/// Header com o caminho de destino, codificado com `encodeURIComponent`
/// porque headers só aceitam ASCII (ver `bindings/export-png.ts`).
const PATH_HEADER: &str = "x-alcy-path";

/// Assinatura de todo arquivo PNG.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Teto do corpo aceito. A imagem de compartilhamento tem altura limitada no
/// frontend (`screenshot-layout.ts`), então fica bem abaixo disso.
const MAX_PNG_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportPngError {
    Invalid { message: String },
    Storage { message: String },
}

fn invalid(message: &str) -> ExportPngError {
    ExportPngError::Invalid {
        message: message.to_string(),
    }
}

/// Grava a imagem de compartilhamento da requisição (PNG gerado no
/// frontend) no arquivo escolhido pelo usuário. Os bytes chegam como corpo
/// binário cru da IPC, uma única vez e com teto de tamanho (ADR 0029).
#[tauri::command]
pub async fn export_png(
    request: Request<'_>,
    usage: tauri::State<'_, alcy_app::UsageHub>,
) -> Result<(), ExportPngError> {
    let result: Result<(), ExportPngError> = async {
        let path = path_from_headers(&request)?;
        let bytes = bytes_from_body(request.body())?;
        tauri::async_runtime::spawn_blocking(move || write_png(&path, &bytes))
            .await
            .unwrap_or_else(|error| {
                Err(ExportPngError::Storage {
                    message: error.to_string(),
                })
            })
    }
    .await;
    crate::commands::usage_events::record_export(&usage, "png", &result);
    crate::logging::logged("alcy::export", "exportar PNG", result)
}

fn path_from_headers(request: &Request<'_>) -> Result<PathBuf, ExportPngError> {
    let encoded = request
        .headers()
        .get(PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| invalid("caminho de destino ausente"))?;
    let decoded = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| invalid("caminho de destino inválido"))?;
    Ok(PathBuf::from(decoded.as_ref()))
}

/// Corpo cru; quando a IPC cai no transporte por `postMessage`, os bytes
/// chegam como array JSON de números.
fn bytes_from_body(body: &InvokeBody) -> Result<Vec<u8>, ExportPngError> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|byte| u8::try_from(byte).ok())
                    .ok_or_else(|| invalid("conteúdo da imagem inválido"))
            })
            .collect(),
        InvokeBody::Json(_) => Err(invalid("conteúdo da imagem inválido")),
    }
}

fn write_png(path: &Path, bytes: &[u8]) -> Result<(), ExportPngError> {
    let has_png_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"));
    if !has_png_extension {
        return Err(invalid("o arquivo deve ter a extensão .png"));
    }
    if bytes.len() > MAX_PNG_BYTES {
        return Err(invalid("a imagem excede o tamanho máximo"));
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err(invalid("o conteúdo não é uma imagem PNG"));
    }

    fs::write(path, bytes).map_err(|error| ExportPngError::Storage {
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
        let root = std::env::temp_dir().join(format!("alcy-png-cmd-test-{nanos}-{count}"));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn png_bytes() -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(b"rest-of-image");
        bytes
    }

    #[test]
    fn writes_png_bytes_to_file() {
        let root = temp_root();
        let path = root.join("evidência.png");

        write_png(&path, &png_bytes()).expect("write");

        assert_eq!(fs::read(&path).expect("read"), png_bytes());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_path_without_png_extension() {
        let root = temp_root();
        let path = root.join("evidence.jpg");

        let error = write_png(&path, &png_bytes()).expect_err("must reject");

        assert!(matches!(error, ExportPngError::Invalid { .. }));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_bytes_that_are_not_png() {
        let root = temp_root();
        let path = root.join("evidence.png");

        let error = write_png(&path, b"not an image").expect_err("must reject");

        assert!(matches!(error, ExportPngError::Invalid { .. }));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_raw_and_json_array_bodies() {
        assert_eq!(
            bytes_from_body(&InvokeBody::Raw(vec![1, 2, 3])).expect("raw"),
            vec![1, 2, 3]
        );
        assert_eq!(
            bytes_from_body(&InvokeBody::Json(serde_json::json!([4, 5, 255]))).expect("json array"),
            vec![4, 5, 255]
        );
        assert!(bytes_from_body(&InvokeBody::Json(serde_json::json!([256]))).is_err());
        assert!(bytes_from_body(&InvokeBody::Json(serde_json::json!({ "path": "x" }))).is_err());
    }
}
