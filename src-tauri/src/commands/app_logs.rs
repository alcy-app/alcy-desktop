use std::path::PathBuf;

use serde::Deserialize;

/// Pastas visíveis ao usuário, registradas no `setup` (ver `logging::alcy_dirs`).
pub struct AppLogLocation {
    pub backups: PathBuf,
}

/// Teto de entradas por lote vindo do frontend.
const MAX_ENTRIES_PER_BATCH: usize = 200;
/// Teto de cada mensagem do frontend, em bytes.
const MAX_MESSAGE_BYTES: usize = 2048;

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum FrontendLogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogEntry {
    pub level: FrontendLogLevel,
    pub scope: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFrontendLogsInput {
    pub entries: Vec<FrontendLogEntry>,
}

/// Grava no log do app um lote de eventos do frontend (o logger do
/// frontend agrupa e envia a cada poucos segundos, nunca por tecla).
/// `async`: a escrita no arquivo de log não ocupa a thread principal.
#[tauri::command]
pub async fn write_frontend_logs(input: WriteFrontendLogsInput) {
    let dropped = input.entries.len().saturating_sub(MAX_ENTRIES_PER_BATCH);
    for entry in input.entries.into_iter().take(MAX_ENTRIES_PER_BATCH) {
        let target = format!("frontend::{}", sanitize_scope(&entry.scope));
        let message = sanitize_message(&entry.message);
        match entry.level {
            FrontendLogLevel::Info => log::info!(target: &target, "{message}"),
            FrontendLogLevel::Warn => log::warn!(target: &target, "{message}"),
            FrontendLogLevel::Error => log::error!(target: &target, "{message}"),
        }
    }
    if dropped > 0 {
        log::warn!(target: "frontend", "{dropped} entradas de log descartadas (lote acima do limite)");
    }
}

fn sanitize_scope(scope: &str) -> String {
    let clean: String = scope
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(40)
        .collect();
    if clean.is_empty() {
        "app".to_string()
    } else {
        clean
    }
}

/// Uma linha por entrada (quebras viram `⏎`) e tamanho limitado.
fn sanitize_message(message: &str) -> String {
    let single_line = message.replace("\r\n", " ⏎ ").replace(['\n', '\r'], " ⏎ ");
    if single_line.len() <= MAX_MESSAGE_BYTES {
        return single_line;
    }
    let mut end = MAX_MESSAGE_BYTES;
    while !single_line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &single_line[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_keep_only_safe_characters() {
        assert_eq!(sanitize_scope("request/editor"), "requesteditor");
        assert_eq!(sanitize_scope("  "), "app");
        assert_eq!(
            sanitize_scope("request-workbench.send"),
            "request-workbench.send"
        );
    }

    #[test]
    fn messages_become_single_line_and_bounded() {
        assert_eq!(sanitize_message("a\nb\r\nc"), "a ⏎ b ⏎ c");
        let long = "é".repeat(MAX_MESSAGE_BYTES);
        let clean = sanitize_message(&long);
        assert!(clean.len() <= MAX_MESSAGE_BYTES + "…".len());
        assert!(clean.ends_with('…'));
    }
}
