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

/// Index of the message holding the user's last text, if any.
pub fn last_user_text_index(transcript: &[AgentMessage]) -> Option<usize> {
    last_user_text(transcript).map(|(message, _)| message)
}

fn last_user_text(transcript: &[AgentMessage]) -> Option<(usize, usize)> {
    transcript
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| {
            if message.role != AgentRole::User {
                return None;
            }
            message
                .content
                .iter()
                .rposition(|block| matches!(block, ContentBlock::Text { .. }))
                .map(|block| (index, block))
        })
}

/// Removes the user's last text and everything after it, so that turn can be
/// sent again (retried or edited). Tool results of an interrupted turn that
/// share the message stay, so the assistant's tool calls keep their results.
/// Returns whether there was a text to remove.
pub fn remove_last_user_text(transcript: &mut Vec<AgentMessage>) -> bool {
    let Some((message, block)) = last_user_text(transcript) else {
        return false;
    };
    transcript.truncate(message + 1);
    if let Some(last) = transcript.last_mut() {
        last.content.truncate(block);
        if last.content.is_empty() {
            transcript.pop();
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant_text(text: &str) -> AgentMessage {
        AgentMessage {
            role: AgentRole::Assistant,
            content: vec![ContentBlock::Text { text: text.into() }],
        }
    }

    fn tool_result(id: &str) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: id.into(),
            content: "ok".into(),
            is_error: false,
        }
    }

    #[test]
    fn removing_the_last_user_text_drops_its_turn() {
        let mut transcript = vec![
            AgentMessage::user_text("first"),
            assistant_text("one"),
            AgentMessage::user_text("second"),
            assistant_text("two"),
        ];
        assert_eq!(last_user_text_index(&transcript), Some(2));
        assert!(remove_last_user_text(&mut transcript));
        assert_eq!(
            transcript,
            vec![AgentMessage::user_text("first"), assistant_text("one")]
        );
    }

    #[test]
    fn removing_keeps_tool_results_that_share_the_message() {
        let mut transcript = vec![
            AgentMessage::user_text("first"),
            AgentMessage {
                role: AgentRole::Assistant,
                content: vec![ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "list_open_tabs".into(),
                    input: serde_json::json!({}),
                }],
            },
            AgentMessage {
                role: AgentRole::User,
                content: vec![
                    tool_result("t1"),
                    ContentBlock::Text {
                        text: "failed once".into(),
                    },
                    ContentBlock::Text {
                        text: "failed twice".into(),
                    },
                ],
            },
        ];
        assert!(remove_last_user_text(&mut transcript));
        assert_eq!(transcript.len(), 3);
        assert_eq!(
            transcript[2].content,
            vec![
                tool_result("t1"),
                ContentBlock::Text {
                    text: "failed once".into()
                }
            ]
        );
    }

    #[test]
    fn nothing_to_remove_without_user_text() {
        let mut transcript = vec![assistant_text("hello")];
        assert_eq!(last_user_text_index(&transcript), None);
        assert!(!remove_last_user_text(&mut transcript));
        assert_eq!(transcript.len(), 1);
    }

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
