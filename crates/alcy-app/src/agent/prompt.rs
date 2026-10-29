/// Workbench item the user attached to a message with `@`. Only a short
/// summary goes with the message; the model reads details through tools.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextReference {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub summary: String,
}

pub const MAX_CONTEXT_REFERENCES: usize = 20;
const MAX_CONTEXT_SUMMARY_BYTES: usize = 2 * 1024;

/// Language of the interface, used to answer in the same one by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLanguage {
    PortugueseBrazil,
    English,
}

pub fn agent_system_prompt(language: AgentLanguage) -> String {
    let language = match language {
        AgentLanguage::PortugueseBrazil => "Brazilian Portuguese",
        AgentLanguage::English => "English",
    };
    format!(
        "You are the assistant inside Alcy, a local-first desktop client for REST and GraphQL APIs. \
You help the user build, change, send and understand requests by using the workbench tools.\n\
\n\
- Look before you act: read the open tabs, the request or the collections instead of guessing ids.\n\
- Edit open tabs with update_request or new_request_tab; they stay unsaved until the user or save_request saves them.\n\
- send_request, save_request, create_collection, create_folder and the environment tools wait for the user's approval; \
if the user declines, do not retry the same call, ask what to change.\n\
- Reference environment variables as {{{{name}}}}. Never ask for or write secret values; masked values appear as ••••.\n\
- When explaining a response, be concrete: status, the fields that matter, errors and likely causes.\n\
- Keep answers short and use Markdown for code and JSON.\n\
- Answer in the language the user writes in; when unclear, use {language}."
    )
}

/// The user's text plus the attached context, as one message for the model.
pub fn compose_user_message(text: &str, context: &[ContextReference]) -> String {
    if context.is_empty() {
        return text.to_string();
    }
    let mut message = String::from(text);
    message.push_str("\n\n<attached_context>\n");
    for reference in context.iter().take(MAX_CONTEXT_REFERENCES) {
        message.push_str(&format!(
            "- {} \"{}\" (id: {})\n",
            reference.kind, reference.label, reference.id
        ));
        let summary = truncate_utf8(reference.summary.trim(), MAX_CONTEXT_SUMMARY_BYTES);
        if !summary.is_empty() {
            for line in summary.lines() {
                message.push_str("  ");
                message.push_str(line);
                message.push('\n');
            }
        }
    }
    message.push_str("</attached_context>");
    message
}

/// Longest prefix of `text` within `max_bytes`, cut on a char boundary.
pub(crate) fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_names_the_fallback_language_and_variable_syntax() {
        let prompt = agent_system_prompt(AgentLanguage::PortugueseBrazil);
        assert!(prompt.contains("Brazilian Portuguese"));
        assert!(prompt.contains("{{name}}"));
    }

    #[test]
    fn plain_text_without_context_is_unchanged() {
        assert_eq!(compose_user_message("hi", &[]), "hi");
    }

    #[test]
    fn context_is_listed_after_the_text() {
        let message = compose_user_message(
            "explain",
            &[ContextReference {
                kind: "request".into(),
                id: "r1".into(),
                label: "List users".into(),
                summary: "GET {{base}}/users".into(),
            }],
        );
        assert!(message.starts_with("explain\n\n<attached_context>"));
        assert!(message.contains("- request \"List users\" (id: r1)"));
        assert!(message.contains("  GET {{base}}/users"));
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        assert_eq!(truncate_utf8("ação", 2), "a");
        assert_eq!(truncate_utf8("ação", 3), "aç");
    }
}
