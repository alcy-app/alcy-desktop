use std::future::Future;

use serde_json::Value;
use thiserror::Error;

use super::conversation::{AgentMessage, ContentBlock};

/// A tool as the model sees it: name, what it does and the JSON Schema of
/// its arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

pub struct ChatRequest<'a> {
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub messages: &'a [AgentMessage],
    pub tools: &'a [ToolDefinition],
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    /// Anything else the provider reported (refusal, content filter…).
    Other,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl TokenUsage {
    pub(crate) fn accumulate(&mut self, other: TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
    }
}

/// One complete assistant reply, after the stream ended.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatResponse {
    pub content: Vec<ContentBlock>,
    pub stop_reason: StopReason,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// Errors never carry the API key or request bodies.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ChatModelError {
    #[error("the provider rejected the API key")]
    Unauthorized,
    #[error("the provider is rate limiting requests")]
    RateLimited,
    #[error("could not reach the provider: {0}")]
    Network(String),
    #[error("the provider answered {status}: {message}")]
    Provider { status: u16, message: String },
    #[error("unexpected answer from the provider: {0}")]
    InvalidResponse(String),
}

/// Port for a chat model that streams its reply. Implemented once per wire
/// format (`alcy-agent`); the agent loop only knows this abstraction.
///
/// `on_text` receives text as it arrives so the UI can show it before the
/// reply is complete.
pub trait ChatModel: Sync {
    fn complete(
        &self,
        request: &ChatRequest<'_>,
        on_text: &(dyn Fn(&str) + Sync),
    ) -> impl Future<Output = Result<ChatResponse, ChatModelError>> + Send;
}
