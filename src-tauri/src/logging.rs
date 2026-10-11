//! Logs locais do Alcy.
//!
//! Cada linha vai para `~/Documentos/Alcy/logs/alcy.log` (com rotação; os
//! arquivos rotacionados são apagados depois de uma hora). Nada sai da máquina.
//!
//! Regra de privacidade: nunca registrar headers, corpos, tokens,
//! chaves, valores de variáveis/segredos nem query strings. De URLs, só
//! esquema, host e caminho (`url_for_log`). Registre ids, tipos, status,
//! contagens, durações e o `kind` dos erros.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use log::LevelFilter;
use tauri::{Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Pastas do Alcy visíveis ao usuário (`~/Documentos/Alcy/...`).
pub struct AlcyDirs {
    pub logs: PathBuf,
    /// Cópias dos workspaces feitas antes de cada atualização (spec 0120).
    pub backups: PathBuf,
}

const LOG_FILE_NAME: &str = "alcy";
const MAX_LOG_FILE_BYTES: u128 = 5 * 1024 * 1024;
const KEPT_LOG_FILES: usize = 10;
/// Idade (última escrita) a partir da qual um arquivo rotacionado é apagado.
const MAX_ROTATED_LOG_AGE: Duration = Duration::from_secs(60 * 60);
/// Intervalo entre as limpezas de logs antigos enquanto o app está aberto.
const LOG_CLEANUP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Resolve `~/Documentos/Alcy` (ou a pasta de dados do app, se o sistema
/// não tiver pasta de documentos).
pub fn alcy_dirs<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<AlcyDirs> {
    let base = match app.path().document_dir() {
        Ok(documents) => documents.join("Alcy"),
        Err(_) => app.path().app_data_dir()?,
    };
    Ok(AlcyDirs {
        logs: base.join("logs"),
        backups: base.join("backups"),
    })
}

/// Plugin de log: arquivo rotativo (+ stdout em debug).
pub fn plugin<R: Runtime>(logs_dir: &Path) -> tauri::plugin::TauriPlugin<R> {
    let mut targets = vec![Target::new(TargetKind::Folder {
        path: logs_dir.to_path_buf(),
        file_name: Some(LOG_FILE_NAME.to_string()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }

    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets(targets)
        // `timezone_strategy` redefine o formato; precisa vir antes de `format`.
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} {:<5} [{}] {}",
                timestamp(),
                record.level(),
                record.target(),
                message
            ))
        })
        .rotation_strategy(RotationStrategy::KeepSome(KEPT_LOG_FILES))
        .max_file_size(MAX_LOG_FILE_BYTES)
        .level(LevelFilter::Info)
        // Bibliotecas de janela/rede são verbosas em Info.
        .level_for("tao", LevelFilter::Warn)
        .level_for("wry", LevelFilter::Warn)
        .level_for("hyper", LevelFilter::Warn)
        .level_for("hyper_util", LevelFilter::Warn)
        .level_for("reqwest", LevelFilter::Warn)
        .level_for("rustls", LevelFilter::Warn)
        .build()
}

/// Apaga os arquivos rotacionados (`alcy_<data>.log`) escritos pela última
/// vez há mais de `MAX_ROTATED_LOG_AGE`. O arquivo ativo (`alcy.log`) fica.
/// Devolve quantos arquivos saíram.
fn remove_expired_logs(dir: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let prefix = format!("{LOG_FILE_NAME}_");
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let rotated =
            name.starts_with(&prefix) && (name.ends_with(".log") || name.ends_with(".log.bak"));
        let expired = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| {
                now.duration_since(modified)
                    .is_ok_and(|age| age > MAX_ROTATED_LOG_AGE)
            });
        if rotated && expired && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Limpa os logs expirados agora e a cada `LOG_CLEANUP_INTERVAL`, numa thread
/// própria que dorme entre as passadas.
pub fn spawn_expired_logs_cleanup(dir: PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("alcy-log-cleanup".to_string())
        .spawn(move || loop {
            let removed = remove_expired_logs(&dir, SystemTime::now());
            if removed > 0 {
                log::info!(target: "alcy::logs", "{removed} arquivo(s) de log antigo(s) apagado(s)");
            }
            std::thread::sleep(LOG_CLEANUP_INTERVAL);
        });
    if spawned.is_err() {
        log::warn!(target: "alcy::logs", "limpeza de logs antigos não iniciou");
    }
}

/// `2026-10-01T12:00:00.123-03:00` no fuso local (UTC se o sistema não
/// informar o fuso).
fn timestamp() -> String {
    let now = TimezoneStrategy::UseLocal.get_now();
    let offset = now.offset();
    let offset_minutes =
        i32::from(offset.whole_hours()) * 60 + i32::from(offset.minutes_past_hour());
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let abs = offset_minutes.abs();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{sign}{:02}:{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond(),
        abs / 60,
        abs % 60
    )
}

#[cfg(test)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// Versão de uma URL segura para log: esquema, host, porta e caminho, sem
/// credenciais, query nem fragmento. Modelos com `{{variável}}` que ainda não
/// são URL mantêm só os nomes das variáveis (nunca os valores), também sem
/// query, fragmento nem credenciais.
pub fn url_for_log(raw: &str) -> String {
    let raw = raw.trim();
    if let Ok(url) = url::Url::parse(raw) {
        if url.has_host() {
            let host = url.host_str().unwrap_or_default();
            let port = url
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            return format!("{}://{host}{port}{}", url.scheme(), url.path());
        }
    }
    let without_query = raw.split(['?', '#']).next().unwrap_or_default();
    let without_credentials = match without_query.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            let host = authority.rsplit('@').next().unwrap_or_default();
            format!("{scheme}://{host}{path}")
        }
        None => without_query.to_string(),
    };
    without_credentials.chars().take(200).collect()
}

/// Commands chamados com frequência (autosave, leitura em janelas, polling,
/// o próprio envio de logs): não entram no rastro de IPC para não afogar os
/// eventos relevantes.
const QUIET_COMMANDS: &[&str] = &[
    "write_frontend_logs",
    "read_response_body_chunk",
    "release_response_body",
    "save_tab_session",
    "save_collections",
    "save_environments",
    "save_flows",
    "save_value_monitors",
    "evaluate_value_monitors",
    "get_flow_node_output",
    "get_collection_run_output",
    "get_local_version_status",
    "get_log_location",
    "check_body_files",
    "list_history",
    "list_request_sends",
];

/// Rastro de IPC: o nome de cada command chamado pelo frontend (nunca os
/// argumentos).
pub fn log_invoke(command: &str) {
    if !QUIET_COMMANDS.contains(&command) {
        log::info!(target: "alcy::ipc", "command {command}");
    }
}

/// Registra a falha de uma operação (só o `kind` do erro) e devolve o
/// resultado intacto.
pub fn logged<T, E: serde::Serialize>(
    target: &str,
    operation: &str,
    result: Result<T, E>,
) -> Result<T, E> {
    if let Err(error) = &result {
        log::warn!(target: target, "{operation} falhou ({})", error_kind(error));
    }
    result
}

/// Variante de `logged` para corpos síncronos com `?`: executa `work` e
/// registra a falha.
pub fn logged_with<T, E: serde::Serialize>(
    target: &str,
    operation: &str,
    work: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    logged(target, operation, work())
}

/// O `kind` de um erro de command (todos serializam com `tag = "kind"`).
pub fn error_kind<E: serde::Serialize>(error: &E) -> String {
    serde_json::to_value(error)
        .ok()
        .and_then(|value| {
            value
                .get("kind")
                .and_then(|kind| kind.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "desconhecido".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_lose_credentials_query_and_fragment() {
        assert_eq!(
            url_for_log("https://user:pass@api.example.com:8443/v1/items?token=abc#x"),
            "https://api.example.com:8443/v1/items"
        );
        assert_eq!(url_for_log("{{baseUrl}}/x?token={{t}}"), "{{baseUrl}}/x");
        assert_eq!(
            url_for_log("https://u:p@{{host}}/a?b=1"),
            "https://{{host}}/a"
        );
    }

    #[test]
    fn error_kind_reads_the_serde_tag() {
        #[derive(serde::Serialize)]
        #[serde(tag = "kind", rename_all = "camelCase")]
        enum Sample {
            NotFound { message: String },
        }
        let error = Sample::NotFound {
            message: "segredo".to_string(),
        };
        assert_eq!(error_kind(&error), "notFound");
        assert_eq!(error_kind(&"texto"), "desconhecido");
    }

    #[test]
    fn expired_logs_cleanup_removes_only_old_rotated_files() {
        let dir = std::env::temp_dir().join(format!(
            "alcy-logs-cleanup-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "alcy.log",
            "alcy_2026-10-01_10-00-00.log",
            "alcy_2026-10-01_10-00-00.log.bak",
            "outro.log",
        ] {
            std::fs::write(dir.join(name), "linha").unwrap();
        }

        assert_eq!(remove_expired_logs(&dir, SystemTime::now()), 0);

        let later = SystemTime::now() + MAX_ROTATED_LOG_AGE + Duration::from_secs(60);
        assert_eq!(remove_expired_logs(&dir, later), 2);
        let mut left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["alcy.log", "outro.log"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
