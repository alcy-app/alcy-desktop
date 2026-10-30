//! Agent loop (ADR 0064): a chat model that uses workbench tools. The model
//! (`ChatModel`) and where tools run (`AgentToolHost`) are ports; providers
//! live in `alcy-agent` and tools run in the UI.

mod chat_model;
mod context_window;
mod conversation;
mod prompt;
mod run_turn;
mod session_title;
mod tools;

pub use chat_model::{
    ChatModel, ChatModelError, ChatRequest, ChatResponse, ModelInfo, StopReason, TokenUsage,
    ToolDefinition,
};
pub use context_window::{AgentConversation, KEEP_FULL_TOOL_RESULTS};
pub use conversation::{
    AgentMessage, AgentRole, ContentBlock, last_user_text_index, push_user_text,
    remove_last_user_text,
};
pub use prompt::{
    AgentLanguage, ContextReference, MAX_CONTEXT_REFERENCES, QUOTE_CONTEXT_KIND,
    SELECTION_CONTEXT_KIND, agent_system_prompt, compose_user_message,
};
pub use run_turn::{
    AgentToolHost, AgentTurnOutcome, AgentTurnRequest, AgentTurnSink, DEFAULT_MAX_OUTPUT_TOKENS,
    MAX_TOOL_RESULT_BYTES, MAX_TOOL_ROUNDS, ToolCall, ToolOutcome, TurnStop, run_agent_turn,
};
pub use session_title::{MAX_SESSION_TITLE_CHARS, generate_session_title};
pub use tools::{ToolClass, agent_tool_catalog, agent_tool_class};
