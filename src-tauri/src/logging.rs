//! Local Alcy logs.
//!
//! Lines go to `~/Documentos/Alcy/logs/alcy.log`, with rotation and removal
//! of rotated files after an hour. Nothing leaves the machine.
//!
//! Never log headers, bodies, tokens, keys, variable/secret values or query
//! strings. URLs keep only scheme, host and path (`url_for_log`). Log IDs,
//! types, status, counts, durations, error kinds and safe structured causes.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use log::LevelFilter;
use tauri::{Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// User-visible Alcy directories (`~/Documentos/Alcy/...`).
pub struct AlcyDirs {
    pub logs: PathBuf,
    /// Workspace backups made before each update (spec 0120).
    pub backups: PathBuf,
}

const LOG_FILE_NAME: &str = "alcy";
const MAX_LOG_FILE_BYTES: u128 = 5 * 1024 * 1024;
const KEPT_LOG_FILES: usize = 10;
/// Age since last write after which a rotated file is removed.
const MAX_ROTATED_LOG_AGE: Duration = Duration::from_secs(60 * 60);
/// Interval between expired-log cleanup passes while the app is open.
const LOG_CLEANUP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Resolve `~/Documentos/Alcy`, falling back to app data when the system
/// has no documents directory.
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

/// Logging plugin: rotating file, plus stdout in debug builds.
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
        // `timezone_strategy` resets the format, so it must precede `format`.
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
        // Windowing and network libraries are verbose at Info level.
        .level_for("tao", LevelFilter::Warn)
        .level_for("wry", LevelFilter::Warn)
        .level_for("hyper", LevelFilter::Warn)
        .level_for("hyper_util", LevelFilter::Warn)
        .level_for("reqwest", LevelFilter::Warn)
        .level_for("rustls", LevelFilter::Warn)
        .build()
}

/// Remove rotated files (`alcy_<date>.log`) last written more than
/// `MAX_ROTATED_LOG_AGE` ago. Keep the active `alcy.log` and return the count.
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

/// Clean up expired logs now and every `LOG_CLEANUP_INTERVAL` on a dedicated
/// thread that sleeps between passes.
pub fn spawn_expired_logs_cleanup(dir: PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("alcy-log-cleanup".to_string())
        .spawn(move || {
            loop {
                let removed = remove_expired_logs(&dir, SystemTime::now());
                if removed > 0 {
                    log::info!(target: "alcy::logs", "{removed} expired log file(s) removed");
                }
                std::thread::sleep(LOG_CLEANUP_INTERVAL);
            }
        });
    if spawned.is_err() {
        log::warn!(target: "alcy::logs", "expired log cleanup failed to start");
    }
}

/// `2026-10-01T12:00:00.123-03:00` in local time (UTC when the system
/// does not provide a timezone).
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

/// Safe URL for logging: scheme, host, port and path, without credentials,
/// query or fragment. Templates with `{{variable}}` that are not yet valid URLs
/// keep variable names only, also without query, fragment or credentials.
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

/// Frequent commands (autosave, windowed reads, polling and log submission)
/// stay out of the IPC trace to keep relevant events visible.
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

/// Trace command names called by the frontend, never their arguments.
pub fn log_invoke(command: &str) {
    if !QUIET_COMMANDS.contains(&command) {
        log::info!(target: "alcy::ipc", "command {command}");
    }
}

/// Log an operation failure with its safe structured reason, preserving the result.
pub fn logged<T, E: serde::Serialize>(
    target: &str,
    operation: &str,
    result: Result<T, E>,
) -> Result<T, E> {
    if let Err(error) = &result {
        log::warn!(target: target, "{operation} failed ({})", error_summary(error));
    }
    result
}

/// Run synchronous `work` with `?` support and log its failure.
pub fn logged_with<T, E: serde::Serialize>(
    target: &str,
    operation: &str,
    work: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    logged(target, operation, work())
}

/// Read a command error kind (all serialize with `tag = "kind"`).
pub fn error_kind<E: serde::Serialize>(error: &E) -> String {
    serde_json::to_value(error)
        .ok()
        .and_then(|value| {
            value
                .get("kind")
                .and_then(|kind| kind.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

/// Include only typed causes and numeric metadata. Technical messages, cause
/// payloads and script/server errors may contain request data or credentials.
pub fn error_summary<E: serde::Serialize>(error: &E) -> String {
    let kind = error_kind(error);
    let Ok(value) = serde_json::to_value(error) else {
        return kind;
    };
    let Some(cause) = value.get("cause") else {
        return kind;
    };
    let Some(reason) = cause.get("type").and_then(serde_json::Value::as_str) else {
        return kind;
    };
    let mut summary = format!("{kind}; reason={reason}");
    if let Some(status) = cause.get("status").and_then(serde_json::Value::as_u64) {
        summary.push_str(&format!("; status={status}"));
    }
    summary
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
            message: "sensitive message".to_string(),
        };
        assert_eq!(error_kind(&error), "notFound");
        assert_eq!(error_kind(&"text"), "unknown");
    }

    #[test]
    fn error_summary_includes_typed_reasons_without_sensitive_payloads() {
        let error = serde_json::json!({
            "kind": "invalidRequest",
            "message": "sensitive technical message",
            "cause": { "type": "invalidHeaderValue", "name": "sensitive header name" }
        });
        assert_eq!(
            error_summary(&error),
            "invalidRequest; reason=invalidHeaderValue"
        );
        assert_eq!(
            error_summary(&serde_json::json!({
                "kind": "network",
                "message": "sensitive token response",
                "cause": { "type": "oauth2TokenStatus", "status": 401 }
            })),
            "network; reason=oauth2TokenStatus; status=401"
        );
        assert_eq!(
            error_summary(
                &serde_json::json!({ "kind": "script", "message": "sensitive script output" })
            ),
            "script"
        );
        assert_eq!(error_summary(&"unstructured error"), "unknown");
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
            "other.log",
        ] {
            std::fs::write(dir.join(name), "line").unwrap();
        }

        assert_eq!(remove_expired_logs(&dir, SystemTime::now()), 0);

        let later = SystemTime::now() + MAX_ROTATED_LOG_AGE + Duration::from_secs(60);
        assert_eq!(remove_expired_logs(&dir, later), 2);
        let mut left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["alcy.log", "other.log"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
