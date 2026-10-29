//! What part of a chat goes to the model (spec 0135). The transcript keeps
//! everything; requests carry the summary of its oldest part, the recent
//! messages, and only the latest tool results in full.

use super::chat_model::ToolDefinition;
use super::conversation::{AgentMessage, AgentRole, ContentBlock};
use super::prompt::truncate_utf8;

/// Tool results sent in full; older ones become a short note.
pub const KEEP_FULL_TOOL_RESULTS: usize = 8;
const BYTES_PER_TOKEN: usize = 4;
/// Results shorter than this stay as they are: the note would not save much.
const MIN_OMITTED_RESULT_BYTES: usize = 300;
/// Start summarizing when a turn would use this share of the budget.
pub const COMPACT_AT_PERCENT: usize = 80;
/// After summarizing, the recent messages kept fit in this share.
pub const KEEP_AFTER_COMPACTION_PERCENT: usize = 40;
/// Text of the old part handed to the summarizer.
const MAX_SUMMARY_INPUT_BYTES: usize = 120 * 1024;
const MAX_RENDERED_TOOL_BYTES: usize = 1500;

/// A chat as the loop sees it: the full transcript plus the summary that
/// replaces its oldest part in requests.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentConversation {
    pub messages: Vec<AgentMessage>,
    pub summary: Option<String>,
    /// Messages before this index are covered by `summary`.
    pub summarized_until: usize,
}

impl AgentConversation {
    pub fn new(messages: Vec<AgentMessage>) -> Self {
        Self {
            messages,
            summary: None,
            summarized_until: 0,
        }
    }
}

fn block_bytes(block: &ContentBlock) -> usize {
    match block {
        ContentBlock::Text { text } => text.len(),
        ContentBlock::ToolUse { name, input, .. } => name.len() + input.to_string().len(),
        ContentBlock::ToolResult { content, .. } => content.len(),
    }
}

fn message_tokens(message: &AgentMessage) -> usize {
    message.content.iter().map(block_bytes).sum::<usize>() / BYTES_PER_TOKEN + 4
}

/// Rough token count: about four bytes per token.
pub fn estimate_tokens(messages: &[AgentMessage]) -> usize {
    messages.iter().map(message_tokens).sum()
}

/// Tokens of what every request repeats: the system prompt and the tools.
pub fn fixed_tokens(system_prompt: &str, tools: &[ToolDefinition]) -> usize {
    let tools: usize = tools
        .iter()
        .map(|tool| tool.name.len() + tool.description.len() + tool.input_schema.to_string().len())
        .sum();
    (system_prompt.len() + tools) / BYTES_PER_TOKEN
}

/// The messages sent to the model for `conversation`.
pub fn request_messages(conversation: &AgentConversation) -> Vec<AgentMessage> {
    let start = conversation
        .summarized_until
        .min(conversation.messages.len());
    let mut messages = conversation.messages[start..].to_vec();

    let results = messages
        .iter()
        .flat_map(|message| &message.content)
        .filter(|block| matches!(block, ContentBlock::ToolResult { .. }))
        .count();
    let mut to_omit = results.saturating_sub(KEEP_FULL_TOOL_RESULTS);
    for block in messages.iter_mut().flat_map(|message| &mut message.content) {
        if to_omit == 0 {
            break;
        }
        if let ContentBlock::ToolResult { content, .. } = block {
            if content.len() >= MIN_OMITTED_RESULT_BYTES {
                *content = format!(
                    "[Earlier tool result omitted to save context ({} bytes). Call the tool again if you need it.]",
                    content.len()
                );
            }
            to_omit -= 1;
        }
    }

    if let Some(summary) = conversation.summary.as_deref().filter(|_| start > 0)
        && let Some(first) = messages.first_mut()
    {
        first.content.insert(
            0,
            ContentBlock::Text {
                text: format!(
                    "<conversation_summary>\nSummary of the earlier part of this chat:\n{summary}\n</conversation_summary>"
                ),
            },
        );
    }
    messages
}

/// A user message that starts a turn: text only, no tool results. Cutting
/// there never separates a tool call from its result.
fn starts_turn(message: &AgentMessage) -> bool {
    message.role == AgentRole::User
        && message
            .content
            .iter()
            .all(|block| matches!(block, ContentBlock::Text { .. }))
}

/// Index from which messages stay in full after summarizing the rest: the
/// earliest turn start whose following messages fit in `keep_tokens`, or the
/// last turn start when even that turn is larger. `None` when there is
/// nothing new to summarize.
pub fn compaction_cut(conversation: &AgentConversation, keep_tokens: usize) -> Option<usize> {
    let messages = &conversation.messages;
    let first = conversation.summarized_until + 1;
    let mut kept = 0;
    let mut best = None;
    let mut last_start = None;
    for index in (first..messages.len()).rev() {
        kept += message_tokens(&messages[index]);
        if !starts_turn(&messages[index]) {
            continue;
        }
        last_start.get_or_insert(index);
        if kept > keep_tokens {
            break;
        }
        best = Some(index);
    }
    best.or(last_start)
}

/// The old part of the chat as plain text for the summarizer, with the
/// previous summary first. Tool calls and results are shortened.
pub fn summary_input(previous: Option<&str>, messages: &[AgentMessage]) -> String {
    let mut text = String::new();
    if let Some(previous) = previous {
        text.push_str("Summary so far:\n");
        text.push_str(previous);
        text.push_str("\n\nConversation that follows:\n");
    }
    for message in messages {
        let speaker = match message.role {
            AgentRole::User => "User",
            AgentRole::Assistant => "Assistant",
        };
        for block in &message.content {
            match block {
                ContentBlock::Text { text: body } => {
                    text.push_str(&format!("{speaker}: {body}\n"));
                }
                ContentBlock::ToolUse { name, input, .. } => {
                    let input = input.to_string();
                    text.push_str(&format!(
                        "Assistant called {name} {}\n",
                        truncate_utf8(&input, MAX_RENDERED_TOOL_BYTES)
                    ));
                }
                ContentBlock::ToolResult {
                    content, is_error, ..
                } => {
                    let label = if *is_error {
                        "Tool error"
                    } else {
                        "Tool result"
                    };
                    text.push_str(&format!(
                        "{label}: {}\n",
                        truncate_utf8(content, MAX_RENDERED_TOOL_BYTES)
                    ));
                }
            }
        }
    }
    truncate_utf8(&text, MAX_SUMMARY_INPUT_BYTES).to_string()
}

pub const SUMMARY_SYSTEM_PROMPT: &str = "You compress the earlier part of a chat between a user and the assistant of Alcy, an API client. \
Write a concise summary (at most about 300 words) that lets the assistant continue the chat: the user's goals and preferences, \
decisions made, ids and names of tabs, requests, collections and environments, URLs, what was changed, sent or saved and with what result, \
and anything still pending. Write in the language of the chat. Never include secret values.";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(id: &str, size: usize) -> AgentMessage {
        AgentMessage {
            role: AgentRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: "r".repeat(size),
                is_error: false,
            }],
        }
    }

    fn call(id: &str) -> AgentMessage {
        AgentMessage {
            role: AgentRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: id.into(),
                name: "get_response".into(),
                input: json!({}),
            }],
        }
    }

    fn answer(text: &str) -> AgentMessage {
        AgentMessage {
            role: AgentRole::Assistant,
            content: vec![ContentBlock::Text { text: text.into() }],
        }
    }

    #[test]
    fn only_the_latest_tool_results_go_in_full() {
        let mut messages = vec![AgentMessage::user_text("start")];
        for index in 0..(KEEP_FULL_TOOL_RESULTS + 2) {
            messages.push(call(&format!("t{index}")));
            messages.push(result(&format!("t{index}"), 1000));
        }
        let conversation = AgentConversation::new(messages.clone());
        let sent = request_messages(&conversation);
        let omitted = sent
            .iter()
            .flat_map(|message| &message.content)
            .filter(|block| matches!(block, ContentBlock::ToolResult { content, .. } if content.starts_with("[Earlier")))
            .count();
        assert_eq!(omitted, 2);
        assert_eq!(
            conversation.messages, messages,
            "the transcript is untouched"
        );
    }

    #[test]
    fn the_summary_replaces_the_old_part() {
        let conversation = AgentConversation {
            messages: vec![
                AgentMessage::user_text("old"),
                answer("old answer"),
                AgentMessage::user_text("new"),
            ],
            summary: Some("they asked about users".into()),
            summarized_until: 2,
        };
        let sent = request_messages(&conversation);
        assert_eq!(sent.len(), 1);
        let ContentBlock::Text { text } = &sent[0].content[0] else {
            panic!("expected the summary first");
        };
        assert!(text.contains("they asked about users"));
        assert_eq!(
            sent[0].content[1],
            ContentBlock::Text { text: "new".into() }
        );
    }

    #[test]
    fn the_cut_falls_on_a_turn_start_and_keeps_tool_pairs() {
        let conversation = AgentConversation::new(vec![
            AgentMessage::user_text("a".repeat(4000)),
            call("t1"),
            result("t1", 4000),
            answer("done"),
            AgentMessage::user_text("second"),
            call("t2"),
            result("t2", 40),
            answer("ok"),
            AgentMessage::user_text("third"),
        ]);
        assert_eq!(compaction_cut(&conversation, 100), Some(4));
        // Too small even for the last turn: keep only that turn.
        assert_eq!(compaction_cut(&conversation, 1), Some(8));
    }

    #[test]
    fn nothing_new_to_summarize_gives_no_cut() {
        let conversation = AgentConversation {
            messages: vec![
                AgentMessage::user_text("old"),
                answer("x"),
                AgentMessage::user_text("new"),
            ],
            summary: Some("s".into()),
            summarized_until: 2,
        };
        assert_eq!(compaction_cut(&conversation, 1), None);
    }

    #[test]
    fn the_summary_input_shortens_tools_and_keeps_the_previous_summary() {
        let input = summary_input(
            Some("earlier"),
            &[AgentMessage::user_text("hi"), call("t"), result("t", 5000)],
        );
        assert!(input.starts_with("Summary so far:\nearlier"));
        assert!(input.contains("User: hi"));
        assert!(input.contains("Assistant called get_response {}"));
        assert!(input.len() < 2500);
    }
}
