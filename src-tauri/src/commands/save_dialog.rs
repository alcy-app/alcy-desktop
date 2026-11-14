//! Native save dialog opened by the backend (ADR 0081). A command that
//! writes a file chosen by the person takes a suggested name, never a path:
//! the destination comes from the dialog, so code running in the WebView
//! cannot write anywhere without the person choosing where.

use std::path::PathBuf;

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

/// What a command that writes a chosen file did. Cancelling the dialog is
/// not an error.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveOutcome {
    Saved,
    Cancelled,
}

/// A file type offered by the dialog.
pub struct SaveFilter<'a> {
    pub name: &'a str,
    pub extensions: &'a [&'a str],
}

/// Longest name kept from the suggestion, in characters; file systems cap
/// names at 255 bytes.
const MAX_NAME_CHARS: usize = 120;

/// Reduces a name suggested by the interface to a bare file name: only the
/// last path component, without characters that are invalid on Windows or
/// control characters, without leading or trailing dots and spaces. Falls
/// back to `fallback` when nothing is left. When `extension` is given and
/// the name does not end with it, it is appended.
pub fn safe_file_name(suggested: &str, fallback: &str, extension: Option<&str>) -> String {
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let name = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    match extension {
        Some(extension) if !has_suffix(name, extension) => format!("{name}.{extension}"),
        _ => name.to_string(),
    }
}

fn has_suffix(name: &str, extension: &str) -> bool {
    let suffix = format!(".{extension}");
    name.len() > suffix.len()
        && name
            .get(name.len() - suffix.len()..)
            .is_some_and(|end| end.eq_ignore_ascii_case(&suffix))
}

/// Opens the native save dialog over `window` with `file_name` filled in
/// and waits for the choice. `None` when the person cancels.
pub async fn choose_save_path(
    window: &tauri::WebviewWindow,
    file_name: String,
    filters: &[SaveFilter<'_>],
) -> Option<PathBuf> {
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(window)
        .set_file_name(file_name);
    for filter in filters {
        dialog = dialog.add_filter(filter.name, filter.extensions);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.save_file(move |picked| {
        let _ = sender.send(picked);
    });
    receiver.await.ok().flatten()?.into_path().ok()
}

/// Records the export usage event only when something was written.
pub fn record_saved_export<E>(
    usage: &alcy_app::UsageHub,
    format: &str,
    result: &Result<SaveOutcome, E>,
) {
    if !matches!(result, Ok(SaveOutcome::Cancelled)) {
        crate::commands::usage_events::record_export(usage, format, result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_plain_name() {
        assert_eq!(
            safe_file_name("resposta.json", "response", None),
            "resposta.json"
        );
        assert_eq!(
            safe_file_name("Relatório de execução.html", "run", Some("html")),
            "Relatório de execução.html"
        );
    }

    #[test]
    fn drops_every_directory_component() {
        assert_eq!(
            safe_file_name("../../.config/autostart/x.desktop", "f", None),
            "x.desktop"
        );
        assert_eq!(safe_file_name("/home/user/.bashrc", "f", None), "bashrc");
        assert_eq!(
            safe_file_name(r"C:\Users\x\AppData\Roaming\evil.bat", "f", None),
            "evil.bat"
        );
        assert_eq!(safe_file_name("..\\..\\a.har", "f", Some("har")), "a.har");
    }

    #[test]
    fn removes_invalid_and_control_characters() {
        assert_eq!(
            safe_file_name("a<b>c:d\"e|f?g*h\u{0}\n.txt", "f", None),
            "abcdefgh.txt"
        );
    }

    #[test]
    fn falls_back_when_nothing_is_left() {
        assert_eq!(
            safe_file_name("", "collection", Some("json")),
            "collection.json"
        );
        assert_eq!(safe_file_name("..", "collection", None), "collection");
        assert_eq!(safe_file_name("dir/", "run", Some("xml")), "run.xml");
        assert_eq!(safe_file_name(" . ", "run", None), "run");
    }

    #[test]
    fn appends_the_extension_only_when_missing() {
        assert_eq!(safe_file_name("session", "f", Some("har")), "session.har");
        assert_eq!(
            safe_file_name("session.HAR", "f", Some("har")),
            "session.HAR"
        );
        assert_eq!(
            safe_file_name("flow.flow.alcy.json", "f", Some("json")),
            "flow.flow.alcy.json"
        );
        assert_eq!(
            safe_file_name("x.json.txt", "f", Some("json")),
            "x.json.txt.json"
        );
    }

    #[test]
    fn caps_the_length() {
        let long = "a".repeat(500);
        let name = safe_file_name(&long, "f", Some("png"));
        assert_eq!(name.len(), MAX_NAME_CHARS + ".png".len());
    }
}
