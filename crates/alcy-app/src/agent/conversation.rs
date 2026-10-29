use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRole {
    User,
    Assistant,
}

/// One piece of a message, in the provider-neutral shape the agent loop
/// keeps. Adapters translate it to each wire format.
#[derive(Debug, Clone, PartialEq)]
pub enum ContentBlock {
    Text {
        text: String,
    },
    /// The model asked to run a tool. `input` is what the model produced; a
    /// non-object value means the arguments were not valid JSON.
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentMessage {
    pub role: AgentRole,
    pub content: Vec<ContentBlock>,
}

impl AgentMessage {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: AgentRole::User,
            content: vec![ContentBlock::Text { text: text.into() }],
        }
    }
}

/// Appends user text to the transcript. A transcript that already ends with
/// a user message (tool results of an interrupted turn) gets the text in the
/// same message, so roles keep alternating as both APIs expect.
pub fn push_user_text(transcript: &mut Vec<AgentMessage>, text: String) {
    match transcript.last_mut() {
        Some(last) if last.role == AgentRole::User => {
            last.content.push(ContentBlock::Text { text });
        }
        _ => transcript.push(AgentMessage::user_text(text)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_text_after_tool_results_joins_the_same_message() {
        let mut transcript = vec![AgentMessage {
            role: AgentRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "ok".into(),
                is_error: false,
            }],
        }];
        push_user_text(&mut transcript, "next".into());
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0].content.len(), 2);
    }

    #[test]
    fn user_text_after_the_assistant_starts_a_message() {
        let mut transcript = vec![AgentMessage {
            role: AgentRole::Assistant,
            content: vec![ContentBlock::Text { text: "hi".into() }],
        }];
        push_user_text(&mut transcript, "next".into());
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[1].role, AgentRole::User);
    }
}
