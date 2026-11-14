use std::fs;
use std::path::Path;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

use crate::commands::save_dialog::{
    SaveFilter, SaveOutcome, choose_save_path, record_saved_export, safe_file_name,
};

/// Header with the suggested file name, encoded with `encodeURIComponent`
/// because headers only take ASCII (see `bindings/export-png.ts`). The
/// destination itself comes from the save dialog (ADR 0081).
const FILE_NAME_HEADER: &str = "x-alcy-file-name";

/// Signature at the start of every PNG file.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Largest accepted body. The share image's height is capped in the
/// frontend (`screenshot-layout.ts`), so it stays well below this.
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

/// Saves the request's share image (a PNG made in the frontend) where the
/// person chooses in the save dialog. The bytes arrive once as the raw IPC
/// body, with a size cap (ADR 0029).
#[tauri::command]
pub async fn export_png(
    request: Request<'_>,
    window: tauri::WebviewWindow,
    usage: tauri::State<'_, alcy_app::UsageHub>,
) -> Result<SaveOutcome, ExportPngError> {
    let result: Result<SaveOutcome, ExportPngError> = async {
        let file_name = file_name_from_headers(&request)?;
        let bytes = bytes_from_body(request.body())?;
        check_png(&bytes)?;
        let filters = [SaveFilter {
            name: "PNG",
            extensions: &["png"],
        }];
        let Some(path) = choose_save_path(&window, file_name, &filters).await else {
            return Ok(SaveOutcome::Cancelled);
        };
        tauri::async_runtime::spawn_blocking(move || write_png(&path, &bytes))
            .await
            .unwrap_or_else(|error| {
                Err(ExportPngError::Storage {
                    message: error.to_string(),
                })
            })?;
        Ok(SaveOutcome::Saved)
    }
    .await;
    record_saved_export(&usage, "png", &result);
    crate::logging::logged("alcy::export", "exportar PNG", result)
}

fn file_name_from_headers(request: &Request<'_>) -> Result<String, ExportPngError> {
    let suggested = match request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(encoded) => percent_decode_str(encoded)
            .decode_utf8()
            .map_err(|_| invalid("nome de arquivo inválido"))?
            .into_owned(),
        None => String::new(),
    };
    Ok(safe_file_name(&suggested, "image", Some("png")))
}

/// Raw body; when the IPC falls back to the `postMessage` transport, the
/// bytes arrive as a JSON array of numbers.
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

/// Checked before the dialog opens, so invalid content never asks for a
/// destination.
fn check_png(bytes: &[u8]) -> Result<(), ExportPngError> {
    if bytes.len() > MAX_PNG_BYTES {
        return Err(invalid("a imagem excede o tamanho máximo"));
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err(invalid("o conteúdo não é uma imagem PNG"));
    }
    Ok(())
}

fn write_png(path: &Path, bytes: &[u8]) -> Result<(), ExportPngError> {
    let has_png_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"));
    if !has_png_extension {
        return Err(invalid("o arquivo deve ter a extensão .png"));
    }
    check_png(bytes)?;

    fs::write(path, bytes).map_err(|error| ExportPngError::Storage {
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
