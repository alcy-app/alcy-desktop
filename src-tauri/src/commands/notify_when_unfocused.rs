use serde::Deserialize;
use tauri::{Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

/// Longer texts are cut: a system notification shows only a line or two.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyWhenUnfocusedInput {
    pub title: String,
    pub body: String,
}

/// Shows a system notification and asks for the user's attention (taskbar
/// flash, dock bounce), only while the window is not focused: in front of
/// the app the interface already shows it. Returns whether it was shown;
/// failing to notify is logged and never an error for the caller.
#[tauri::command]
pub fn notify_when_unfocused(
    input: NotifyWhenUnfocusedInput,
    window: tauri::WebviewWindow,
) -> bool {
    if window.is_focused().unwrap_or(false) {
        return false;
    }
    if let Err(error) = window.request_user_attention(Some(UserAttentionType::Informational)) {
        log::warn!(target: "alcy::notify", "request user attention failed ({error})");
    }
    let shown = window
        .app_handle()
        .notification()
        .builder()
        .title(capped(&input.title, MAX_TITLE_CHARS))
        .body(capped(&input.body, MAX_BODY_CHARS))
        .show();
    match shown {
        Ok(()) => true,
        Err(error) => {
            log::warn!(target: "alcy::notify", "system notification failed ({error})");
            false
        }
    }
}

fn capped(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_texts_are_cut_on_a_char_boundary() {
        assert_eq!(capped("  curto  ", 10), "curto");
        assert_eq!(capped("aprovação", 5), "aprov…");
        assert_eq!(capped("abc", 3), "abc");
    }
}
