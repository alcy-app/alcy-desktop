//! A short title for a new chat, written by the model from the first message,
//! as other chats do. The chat keeps its first line as the title until (or
//! unless) this one arrives.

use super::chat_model::{ChatModel, ChatModelError, ChatRequest, TokenUsage};
use super::conversation::{AgentMessage, ContentBlock};
use super::prompt::{AgentLanguage, truncate_utf8};

/// Enough for a few words, also for models that think out loud first.
const MAX_TITLE_OUTPUT_TOKENS: u32 = 64;
/// The start of a long first message says what it is about.
const MAX_MESSAGE_BYTES: usize = 4 * 1024;
pub const MAX_SESSION_TITLE_CHARS: usize = 60;

/// The model's title for a chat that starts with `first_message`, and the
/// tokens it took. `None` when the reply is not usable as a title.
pub async fn generate_session_title<M: ChatModel>(
    chat: &M,
    model: &str,
    first_message: &str,
    language: AgentLanguage,
) -> Result<(Option<String>, TokenUsage), ChatModelError> {
    let fallback = match language {
        AgentLanguage::PortugueseBrazil => "Brazilian Portuguese",
        AgentLanguage::English => "English",
    };
    let system_prompt = format!(
        "You name chats in an API client. Reply with only a title of 2 to 6 words saying what the user wants, \
in the language of their message ({fallback} when unclear). No quotes, no trailing period, no emoji, no explanation."
    );
    let messages = [AgentMessage::user_text(format!(
        "<message>\n{}\n</message>",
        truncate_utf8(first_message.trim(), MAX_MESSAGE_BYTES)
    ))];
    let response = chat
        .complete(
            &ChatRequest {
                model,
                system_prompt: &system_prompt,
                messages: &messages,
                tools: &[],
                max_tokens: MAX_TITLE_OUTPUT_TOKENS,
            },
            &|_| {},
        )
        .await?;
    let text: String = response
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    Ok((clean_title(&text), response.usage))
}

/// First meaningful line of the reply, without quotes, Markdown marks or a
/// final period, cut to the title length.
fn clean_title(reply: &str) -> Option<String> {
    // Reasoning models may put their thinking before the answer.
    let answer = reply.rsplit("</think>").next().unwrap_or(reply);
    let line = answer
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let line = line.trim_start_matches(['#', '*', '-', ' ']);
    let line = line
        .strip_prefix("Title:")
        .or_else(|| line.strip_prefix("Título:"))
        .unwrap_or(line);
    let line = line
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '“' | '”'))
        .trim_end_matches(['.', '!'])
        .trim();
    let title = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    Some(match title.char_indices().nth(MAX_SESSION_TITLE_CHARS) {
        Some((end, _)) => format!("{}…", title[..end].trim_end()),
        None => title,
    })
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::Mutex;

    use super::*;
    use crate::agent::chat_model::{ChatResponse, StopReason};

    struct TitleModel {
        reply: &'static str,
        seen: Mutex<Option<(String, usize, u32)>>,
    }

    impl ChatModel for TitleModel {
        fn complete(
            &self,
            request: &ChatRequest<'_>,
            _on_text: &(dyn Fn(&str) + Sync),
        ) -> impl Future<Output = Result<ChatResponse, ChatModelError>> + Send {
            *self.seen.lock().unwrap() = Some((
                request.system_prompt.to_string(),
                request.tools.len(),
                request.max_tokens,
            ));
            let reply = self.reply;
            async move {
                Ok(ChatResponse {
                    content: vec![ContentBlock::Text { text: reply.into() }],
                    stop_reason: StopReason::EndTurn,
                    usage: TokenUsage {
                        input_tokens: 40,
                        output_tokens: 5,
                    },
                })
            }
        }
    }

    #[tokio::test]
    async fn asks_for_a_short_title_without_tools_and_reports_its_tokens() {
        let model = TitleModel {
            reply: "\"Listar usuários da API.\"",
            seen: Mutex::new(None),
        };
        let (title, usage) = generate_session_title(
            &model,
            "m",
            "me liste os usuários",
            AgentLanguage::PortugueseBrazil,
        )
        .await
        .unwrap();
        assert_eq!(title.as_deref(), Some("Listar usuários da API"));
        assert_eq!(usage.output_tokens, 5);
        let (system_prompt, tools, max_tokens) = model.seen.lock().unwrap().clone().unwrap();
        assert!(system_prompt.contains("Brazilian Portuguese"));
        assert_eq!((tools, max_tokens), (0, MAX_TITLE_OUTPUT_TOKENS));
    }

    #[test]
    fn cleans_what_models_wrap_around_the_title() {
        assert_eq!(
            clean_title("## Title: **Debug login 401**\n\nBecause…").as_deref(),
            Some("Debug login 401")
        );
        assert_eq!(
            clean_title("<think>the user wants…</think>\n“Criar flow de checkout”").as_deref(),
            Some("Criar flow de checkout")
        );
        assert_eq!(clean_title("  \n  "), None);
        assert_eq!(clean_title("\"\""), None);
        let long = clean_title(&"palavra ".repeat(20)).unwrap();
        assert!(long.ends_with('…'));
        assert!(long.chars().count() <= MAX_SESSION_TITLE_CHARS + 1);
    }
}
