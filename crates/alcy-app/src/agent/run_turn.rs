use std::future::Future;
use std::sync::Mutex;

use serde_json::Value;

use super::chat_model::{
    ChatModel, ChatModelError, ChatRequest, StopReason, TokenUsage, ToolDefinition,
};
use super::context_window::{
    AgentConversation, COMPACT_AT_PERCENT, KEEP_AFTER_COMPACTION_PERCENT, SUMMARY_SYSTEM_PROMPT,
    compaction_cut, estimate_tokens, fixed_tokens, request_messages, summary_input,
};
use super::conversation::{AgentMessage, AgentRole, ContentBlock};
use super::prompt::truncate_utf8;
use super::tools::{ToolClass, agent_tool_class, normalize_tool_arguments};
use crate::FlowCancellation;

/// Model rounds that may request tools in one turn before the loop stops.
pub const MAX_TOOL_ROUNDS: usize = 20;
/// Tool output kept in the transcript; the rest is cut with a note.
pub const MAX_TOOL_RESULT_BYTES: usize = 32 * 1024;
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 8192;
const SUMMARY_MAX_OUTPUT_TOKENS: u32 = 1024;

pub struct ToolCall<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub input: &'a Value,
    pub class: ToolClass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    pub content: String,
    pub is_error: bool,
}

impl ToolOutcome {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: message.into(),
            is_error: true,
        }
    }
}

/// Port that runs a tool where the state it touches lives (the workbench,
/// in the UI). Asking the user for approval is part of running it.
pub trait AgentToolHost: Sync {
    fn call(&self, call: &ToolCall<'_>) -> impl Future<Output = ToolOutcome> + Send;
}

/// Progress of a turn, for the UI.
pub trait AgentTurnSink: Sync {
    fn text_delta(&self, text: &str);
    fn tool_finished(&self, call_id: &str, is_error: bool);
    /// The oldest part of the chat was replaced by a summary in requests.
    fn context_compacted(&self);
}

pub struct AgentTurnRequest<'a> {
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub tools: &'a [ToolDefinition],
    pub max_tokens: u32,
    /// Estimated tokens the provider's context window allows (spec 0135).
    pub context_budget_tokens: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnStop {
    /// The model finished its answer.
    EndTurn,
    /// The answer hit the output token limit.
    MaxTokens,
    /// The model kept calling tools past `MAX_TOOL_ROUNDS`.
    RoundLimit,
    Cancelled,
    /// The provider stopped for another reason (refusal, filter…).
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentTurnOutcome {
    pub stop: TurnStop,
    pub usage: TokenUsage,
}

/// Runs one user turn: asks the model, runs the tools it requests through
/// `host` and feeds the results back until it answers without tools.
///
/// The user message must already be in the conversation. Assistant replies
/// and tool results are appended as they happen, so on error or cancellation
/// the transcript stays valid for the next turn (every tool call has a
/// result). A conversation near the context budget is summarized first.
pub async fn run_agent_turn<M, H, S, C>(
    model: &M,
    host: &H,
    sink: &S,
    cancellation: &C,
    conversation: &mut AgentConversation,
    request: AgentTurnRequest<'_>,
) -> Result<AgentTurnOutcome, ChatModelError>
where
    M: ChatModel,
    H: AgentToolHost,
    S: AgentTurnSink,
    C: FlowCancellation,
{
    let mut usage = TokenUsage::default();
    tokio::select! {
        // Biased: a turn that needs no summary must not lose a race it never ran.
        biased;
        compacted = compact_if_needed(model, conversation, &request) => {
            if let Some(summary_usage) = compacted {
                usage.accumulate(summary_usage);
                sink.context_compacted();
            }
        }
        _ = cancellation.cancelled() => {
            return Ok(AgentTurnOutcome { stop: TurnStop::Cancelled, usage });
        }
    }
    for _ in 0..MAX_TOOL_ROUNDS {
        if cancellation.is_cancelled() {
            return Ok(AgentTurnOutcome {
                stop: TurnStop::Cancelled,
                usage,
            });
        }
        let streamed = Mutex::new(String::new());
        let on_text = |text: &str| {
            sink.text_delta(text);
            streamed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push_str(text);
        };
        let messages = request_messages(conversation);
        let chat = ChatRequest {
            model: request.model,
            system_prompt: request.system_prompt,
            messages: &messages,
            tools: request.tools,
            max_tokens: request.max_tokens,
        };
        let response = tokio::select! {
            response = model.complete(&chat, &on_text) => response?,
            _ = cancellation.cancelled() => {
                let partial = streamed
                    .into_inner()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if !partial.is_empty() {
                    conversation.messages.push(AgentMessage {
                        role: AgentRole::Assistant,
                        content: vec![ContentBlock::Text { text: partial }],
                    });
                }
                return Ok(AgentTurnOutcome { stop: TurnStop::Cancelled, usage });
            }
        };
        usage.accumulate(response.usage);

        let calls: Vec<(String, String, Value)> = response
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, name, input } => {
                    Some((id.clone(), name.clone(), input.clone()))
                }
                _ => None,
            })
            .collect();
        if !response.content.is_empty() {
            conversation.messages.push(AgentMessage {
                role: AgentRole::Assistant,
                content: response.content,
            });
        }
        if calls.is_empty() {
            let stop = match response.stop_reason {
                StopReason::EndTurn | StopReason::ToolUse => TurnStop::EndTurn,
                StopReason::MaxTokens => TurnStop::MaxTokens,
                StopReason::Other => TurnStop::Other,
            };
            return Ok(AgentTurnOutcome { stop, usage });
        }

        let mut results = Vec::with_capacity(calls.len());
        let mut cancelled = false;
        for (id, name, input) in &calls {
            let outcome = if cancelled {
                ToolOutcome::error("Cancelled by the user before it ran.")
            } else {
                tokio::select! {
                    outcome = run_tool(host, id, name, input) => outcome,
                    _ = cancellation.cancelled() => {
                        cancelled = true;
                        ToolOutcome::error("Cancelled by the user.")
                    }
                }
            };
            sink.tool_finished(id, outcome.is_error);
            results.push(ContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content: limit_tool_output(outcome.content),
                is_error: outcome.is_error,
            });
        }
        conversation.messages.push(AgentMessage {
            role: AgentRole::User,
            content: results,
        });
        if cancelled {
            return Ok(AgentTurnOutcome {
                stop: TurnStop::Cancelled,
                usage,
            });
        }
    }
    Ok(AgentTurnOutcome {
        stop: TurnStop::RoundLimit,
        usage,
    })
}

/// Summarizes the oldest part of the chat when the next request would pass
/// `COMPACT_AT_PERCENT` of the budget. Returns the usage of the summary call,
/// or `None` when nothing was summarized; a failed summary is not an error,
/// the turn just goes on without it.
async fn compact_if_needed<M: ChatModel>(
    model: &M,
    conversation: &mut AgentConversation,
    request: &AgentTurnRequest<'_>,
) -> Option<TokenUsage> {
    let budget = request.context_budget_tokens;
    let fixed = fixed_tokens(request.system_prompt, request.tools);
    let estimate = fixed + estimate_tokens(&request_messages(conversation));
    if estimate * 100 <= budget * COMPACT_AT_PERCENT {
        return None;
    }
    let keep = (budget * KEEP_AFTER_COMPACTION_PERCENT / 100).saturating_sub(fixed);
    let cut = compaction_cut(conversation, keep)?;
    summarize_conversation(model, conversation, request.model, cut)
        .await
        .ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCompactionOutcome {
    Unchanged,
    Compacted(TokenUsage),
    Cancelled,
}

/// Explicitly summarizes all new transcript messages without adding a user turn
/// or running tools. The next user message receives the saved summary.
pub async fn compact_agent_conversation<M: ChatModel, C: FlowCancellation>(
    model: &M,
    cancellation: &C,
    conversation: &mut AgentConversation,
    model_name: &str,
) -> Result<AgentCompactionOutcome, ChatModelError> {
    if cancellation.is_cancelled() {
        return Ok(AgentCompactionOutcome::Cancelled);
    }
    let cut = conversation.messages.len();
    if cut <= conversation.summarized_until {
        return Ok(AgentCompactionOutcome::Unchanged);
    }
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Ok(AgentCompactionOutcome::Cancelled),
        result = summarize_conversation(model, conversation, model_name, cut) => {
            result.map(AgentCompactionOutcome::Compacted)
        }
    }
}

async fn summarize_conversation<M: ChatModel>(
    model: &M,
    conversation: &mut AgentConversation,
    model_name: &str,
    cut: usize,
) -> Result<TokenUsage, ChatModelError> {
    let input = summary_input(
        conversation.summary.as_deref(),
        &conversation.messages[conversation.summarized_until..cut],
    );
    let messages = [AgentMessage::user_text(input)];
    let summary_request = ChatRequest {
        model: model_name,
        system_prompt: SUMMARY_SYSTEM_PROMPT,
        messages: &messages,
        tools: &[],
        max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    };
    let response = model.complete(&summary_request, &|_| {}).await?;
    let summary: String = response
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if summary.trim().is_empty() {
        return Err(ChatModelError::InvalidResponse(
            "the summary is empty".into(),
        ));
    }
    conversation.summary = Some(summary.trim().to_string());
    conversation.summarized_until = cut;
    Ok(response.usage)
}

async fn run_tool<H: AgentToolHost>(host: &H, id: &str, name: &str, input: &Value) -> ToolOutcome {
    let Some(class) = agent_tool_class(name) else {
        return ToolOutcome::error(format!("Unknown tool '{name}'."));
    };
    let input = match normalize_tool_arguments(name, input) {
        Some(Ok(input)) => input,
        Some(Err(message)) => {
            return ToolOutcome::error(format!(
                "{message} Fix the arguments and call {name} again."
            ));
        }
        None => return ToolOutcome::error(format!("Unknown tool '{name}'.")),
    };
    host.call(&ToolCall {
        id,
        name,
        input: &input,
        class,
    })
    .await
}

fn limit_tool_output(content: String) -> String {
    if content.len() <= MAX_TOOL_RESULT_BYTES {
        return content;
    }
    let kept = truncate_utf8(&content, MAX_TOOL_RESULT_BYTES);
    format!(
        "{kept}\n[truncated: {} more bytes not shown]",
        content.len() - kept.len()
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;

    use super::*;
    use crate::agent::chat_model::ChatResponse;
    use crate::agent::tools::agent_tool_catalog;

    struct ScriptedModel {
        replies: Mutex<VecDeque<ChatResponse>>,
        seen_lengths: Mutex<Vec<usize>>,
        hang: bool,
    }

    impl ScriptedModel {
        fn new(replies: Vec<ChatResponse>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                seen_lengths: Mutex::new(Vec::new()),
                hang: false,
            }
        }
    }

    impl ChatModel for ScriptedModel {
        fn complete(
            &self,
            request: &ChatRequest<'_>,
            on_text: &(dyn Fn(&str) + Sync),
        ) -> impl Future<Output = Result<ChatResponse, ChatModelError>> + Send {
            self.seen_lengths
                .lock()
                .unwrap()
                .push(request.messages.len());
            let reply = self.replies.lock().unwrap().pop_front();
            if let Some(ChatResponse { content, .. }) = &reply {
                for block in content {
                    if let ContentBlock::Text { text } = block {
                        on_text(text);
                    }
                }
            }
            let hang = self.hang;
            async move {
                if hang {
                    std::future::pending::<()>().await;
                }
                reply.ok_or(ChatModelError::InvalidResponse("no more replies".into()))
            }
        }
    }

    #[derive(Default)]
    struct RecordingHost {
        calls: Mutex<Vec<(String, ToolClass)>>,
        decline_side_effects: bool,
    }

    impl AgentToolHost for RecordingHost {
        fn call(&self, call: &ToolCall<'_>) -> impl Future<Output = ToolOutcome> + Send {
            self.calls
                .lock()
                .unwrap()
                .push((call.name.to_string(), call.class));
            let outcome = if self.decline_side_effects && call.class == ToolClass::SideEffect {
                ToolOutcome::error("The user declined.")
            } else {
                ToolOutcome {
                    content: format!("ran {}", call.name),
                    is_error: false,
                }
            };
            async move { outcome }
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        text: Mutex<String>,
        finished: Mutex<Vec<(String, bool)>>,
        compacted: Mutex<usize>,
    }

    impl AgentTurnSink for RecordingSink {
        fn text_delta(&self, text: &str) {
            self.text.lock().unwrap().push_str(text);
        }
        fn tool_finished(&self, call_id: &str, is_error: bool) {
            self.finished
                .lock()
                .unwrap()
                .push((call_id.to_string(), is_error));
        }
        fn context_compacted(&self) {
            *self.compacted.lock().unwrap() += 1;
        }
    }

    #[derive(Default)]
    struct Flag(AtomicBool);

    impl FlowCancellation for Flag {
        fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
        fn cancelled(&self) -> impl Future<Output = ()> + Send {
            let cancelled = self.is_cancelled();
            async move {
                if !cancelled {
                    std::future::pending::<()>().await;
                }
            }
        }
    }

    fn text(text: &str) -> ChatResponse {
        ChatResponse {
            content: vec![ContentBlock::Text { text: text.into() }],
            stop_reason: StopReason::EndTurn,
            usage: TokenUsage {
                input_tokens: 10,
                output_tokens: 5,
            },
        }
    }

    fn tool_use(calls: &[(&str, &str)]) -> ChatResponse {
        ChatResponse {
            content: calls
                .iter()
                .map(|(id, name)| ContentBlock::ToolUse {
                    id: (*id).into(),
                    name: (*name).into(),
                    input: json!({}),
                })
                .collect(),
            stop_reason: StopReason::ToolUse,
            usage: TokenUsage {
                input_tokens: 10,
                output_tokens: 5,
            },
        }
    }

    async fn run(
        model: &ScriptedModel,
        host: &RecordingHost,
        sink: &RecordingSink,
        cancellation: &Flag,
        transcript: &mut Vec<AgentMessage>,
    ) -> Result<AgentTurnOutcome, ChatModelError> {
        let mut conversation = AgentConversation::new(std::mem::take(transcript));
        let outcome = run_with_budget(
            model,
            host,
            sink,
            cancellation,
            &mut conversation,
            1_000_000,
        )
        .await;
        *transcript = conversation.messages;
        outcome
    }

    async fn run_with_budget(
        model: &ScriptedModel,
        host: &RecordingHost,
        sink: &RecordingSink,
        cancellation: &impl FlowCancellation,
        conversation: &mut AgentConversation,
        context_budget_tokens: usize,
    ) -> Result<AgentTurnOutcome, ChatModelError> {
        let tools = agent_tool_catalog();
        run_agent_turn(
            model,
            host,
            sink,
            cancellation,
            conversation,
            AgentTurnRequest {
                model: "m",
                system_prompt: "s",
                tools: &tools,
                max_tokens: 100,
                context_budget_tokens,
            },
        )
        .await
    }

    #[tokio::test]
    async fn answers_without_tools_in_one_round() {
        let model = ScriptedModel::new(vec![text("hello")]);
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut transcript = vec![AgentMessage::user_text("hi")];
        let outcome = run(&model, &host, &sink, &Flag::default(), &mut transcript)
            .await
            .unwrap();
        assert_eq!(outcome.stop, TurnStop::EndTurn);
        assert_eq!(outcome.usage.output_tokens, 5);
        assert_eq!(*sink.text.lock().unwrap(), "hello");
        assert_eq!(transcript.len(), 2);
    }

    #[tokio::test]
    async fn runs_tools_and_feeds_results_back() {
        let model = ScriptedModel::new(vec![
            tool_use(&[("t1", "list_open_tabs"), ("t2", "send_request")]),
            text("done"),
        ]);
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut transcript = vec![AgentMessage::user_text("send it")];
        let outcome = run(&model, &host, &sink, &Flag::default(), &mut transcript)
            .await
            .unwrap();

        assert_eq!(outcome.stop, TurnStop::EndTurn);
        assert_eq!(outcome.usage.input_tokens, 20);
        assert_eq!(
            *host.calls.lock().unwrap(),
            vec![
                ("list_open_tabs".to_string(), ToolClass::Read),
                ("send_request".to_string(), ToolClass::SideEffect),
            ]
        );
        // user, assistant (tools), user (results), assistant (text)
        assert_eq!(transcript.len(), 4);
        assert_eq!(*model.seen_lengths.lock().unwrap(), vec![1, 3]);
        let ContentBlock::ToolResult { content, .. } = &transcript[2].content[1] else {
            panic!("expected a tool result");
        };
        assert_eq!(content, "ran send_request");
    }

    #[tokio::test]
    async fn a_declined_side_effect_reaches_the_model_as_an_error() {
        let model = ScriptedModel::new(vec![tool_use(&[("t1", "send_request")]), text("ok")]);
        let host = RecordingHost {
            decline_side_effects: true,
            ..RecordingHost::default()
        };
        let sink = RecordingSink::default();
        let mut transcript = vec![AgentMessage::user_text("send")];
        run(&model, &host, &sink, &Flag::default(), &mut transcript)
            .await
            .unwrap();
        assert_eq!(*sink.finished.lock().unwrap(), vec![("t1".into(), true)]);
        assert!(matches!(
            &transcript[2].content[0],
            ContentBlock::ToolResult { is_error: true, .. }
        ));
    }

    #[tokio::test]
    async fn unknown_tools_and_bad_arguments_never_reach_the_host() {
        let model = ScriptedModel::new(vec![
            ChatResponse {
                content: vec![
                    ContentBlock::ToolUse {
                        id: "t1".into(),
                        name: "delete_everything".into(),
                        input: json!({}),
                    },
                    ContentBlock::ToolUse {
                        id: "t2".into(),
                        name: "get_request".into(),
                        input: json!("{not json"),
                    },
                ],
                stop_reason: StopReason::ToolUse,
                usage: TokenUsage::default(),
            },
            text("sorry"),
        ]);
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut transcript = vec![AgentMessage::user_text("x")];
        run(&model, &host, &sink, &Flag::default(), &mut transcript)
            .await
            .unwrap();
        assert!(host.calls.lock().unwrap().is_empty());
        assert_eq!(
            *sink.finished.lock().unwrap(),
            vec![("t1".into(), true), ("t2".into(), true)]
        );
    }

    #[tokio::test]
    async fn stops_after_the_round_limit() {
        let replies = (0..MAX_TOOL_ROUNDS)
            .map(|_| tool_use(&[("t", "list_open_tabs")]))
            .collect();
        let model = ScriptedModel::new(replies);
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut transcript = vec![AgentMessage::user_text("loop")];
        let outcome = run(&model, &host, &sink, &Flag::default(), &mut transcript)
            .await
            .unwrap();
        assert_eq!(outcome.stop, TurnStop::RoundLimit);
        assert_eq!(host.calls.lock().unwrap().len(), MAX_TOOL_ROUNDS);
        assert_eq!(transcript.last().unwrap().role, AgentRole::User);
    }

    #[tokio::test]
    async fn cancelling_while_streaming_keeps_the_partial_text() {
        let mut model = ScriptedModel::new(vec![text("partial")]);
        model.hang = true;
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut conversation = AgentConversation::new(vec![AgentMessage::user_text("x")]);
        let outcome = run_with_budget(
            &model,
            &host,
            &sink,
            &AlwaysCancelledAfterStart,
            &mut conversation,
            1_000_000,
        )
        .await
        .unwrap();
        assert_eq!(outcome.stop, TurnStop::Cancelled);
        assert_eq!(
            conversation.messages.last().unwrap().content,
            vec![ContentBlock::Text {
                text: "partial".into()
            }]
        );
    }

    /// Not cancelled when the round starts, cancelled while waiting.
    struct AlwaysCancelledAfterStart;

    impl FlowCancellation for AlwaysCancelledAfterStart {
        fn is_cancelled(&self) -> bool {
            false
        }
        async fn cancelled(&self) {}
    }

    /// A chat whose old turns are large: three turns of about 2k tokens each.
    fn long_conversation() -> AgentConversation {
        let mut messages = Vec::new();
        for turn in 0..3 {
            messages.push(AgentMessage::user_text(format!(
                "question {turn} {}",
                "q".repeat(8000)
            )));
            messages.push(AgentMessage {
                role: AgentRole::Assistant,
                content: vec![ContentBlock::Text {
                    text: format!("answer {turn}"),
                }],
            });
        }
        messages.push(AgentMessage::user_text("latest question"));
        AgentConversation::new(messages)
    }

    #[tokio::test]
    async fn manual_compaction_preserves_transcript_and_summarizes_new_messages_once() {
        let model = ScriptedModel::new(vec![text("A saved summary")]);
        let mut conversation = AgentConversation::new(vec![
            AgentMessage::user_text("question"),
            AgentMessage {
                role: AgentRole::Assistant,
                content: vec![ContentBlock::Text {
                    text: "answer".into(),
                }],
            },
        ]);
        let original = conversation.messages.clone();
        let outcome = compact_agent_conversation(&model, &Flag::default(), &mut conversation, "m")
            .await
            .unwrap();
        assert!(matches!(outcome, AgentCompactionOutcome::Compacted(_)));
        assert_eq!(conversation.messages, original);
        assert_eq!(conversation.summarized_until, original.len());
        assert_eq!(conversation.summary.as_deref(), Some("A saved summary"));
        assert_eq!(
            compact_agent_conversation(&model, &Flag::default(), &mut conversation, "m")
                .await
                .unwrap(),
            AgentCompactionOutcome::Unchanged
        );
        assert_eq!(*model.seen_lengths.lock().unwrap(), vec![1]);
        conversation.push_user_text("next question".into());
        let sent = request_messages(&conversation);
        assert_eq!(sent.len(), 1);
        assert!(
            matches!(&sent[0].content[0], ContentBlock::Text { text } if text.contains("A saved summary"))
        );
        assert!(
            matches!(&sent[0].content[1], ContentBlock::Text { text } if text == "next question")
        );
    }

    #[tokio::test]
    async fn new_text_after_compacting_an_interrupted_user_turn_stays_in_the_request() {
        let model = ScriptedModel::new(vec![text("Previous question")]);
        let mut conversation =
            AgentConversation::new(vec![AgentMessage::user_text("interrupted question")]);
        compact_agent_conversation(&model, &Flag::default(), &mut conversation, "m")
            .await
            .unwrap();
        conversation.push_user_text("new question".into());
        assert_eq!(conversation.messages.len(), 2);
        let sent = request_messages(&conversation);
        assert_eq!(sent.len(), 1);
        assert!(
            matches!(&sent[0].content[0], ContentBlock::Text { text } if text.contains("Previous question"))
        );
        assert!(
            matches!(&sent[0].content[1], ContentBlock::Text { text } if text == "new question")
        );
    }

    #[tokio::test]
    async fn manual_compaction_failure_or_empty_summary_keeps_previous_context() {
        for replies in [vec![], vec![text("  ")]] {
            let model = ScriptedModel::new(replies);
            let mut conversation = long_conversation();
            conversation.summary = Some("previous summary".into());
            conversation.summarized_until = 2;
            let original = conversation.clone();
            assert!(
                compact_agent_conversation(&model, &Flag::default(), &mut conversation, "m")
                    .await
                    .is_err()
            );
            assert_eq!(conversation, original);
        }
    }

    #[tokio::test]
    async fn manual_compaction_cancels_pending_summary_without_changes() {
        struct CancelAfterYield;
        impl FlowCancellation for CancelAfterYield {
            fn is_cancelled(&self) -> bool {
                false
            }
            async fn cancelled(&self) {
                tokio::task::yield_now().await;
            }
        }
        let mut model = ScriptedModel::new(vec![]);
        model.hang = true;
        let mut conversation = long_conversation();
        let original = conversation.clone();
        let result = compact_agent_conversation(&model, &CancelAfterYield, &mut conversation, "m")
            .await
            .unwrap();
        assert_eq!(result, AgentCompactionOutcome::Cancelled);
        assert_eq!(conversation, original);
        assert_eq!(*model.seen_lengths.lock().unwrap(), vec![1]);
    }

    #[tokio::test]
    async fn a_conversation_near_the_budget_is_summarized_first() {
        let model = ScriptedModel::new(vec![text("they asked three questions"), text("final")]);
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut conversation = long_conversation();
        let outcome = run_with_budget(
            &model,
            &host,
            &sink,
            &Flag::default(),
            &mut conversation,
            7000,
        )
        .await
        .unwrap();

        assert_eq!(outcome.stop, TurnStop::EndTurn);
        assert_eq!(*sink.compacted.lock().unwrap(), 1);
        assert_eq!(
            conversation.summary.as_deref(),
            Some("they asked three questions")
        );
        assert!(conversation.summarized_until > 0);
        // The summary call sees one message; the turn sees only what follows the cut.
        let seen = model.seen_lengths.lock().unwrap().clone();
        assert_eq!(seen[0], 1);
        assert_eq!(
            seen[1],
            conversation.messages.len() - 1 - conversation.summarized_until
        );
        assert_eq!(
            conversation.messages.len(),
            8,
            "the transcript keeps everything"
        );
    }

    #[tokio::test]
    async fn a_failed_summary_does_not_fail_the_turn() {
        let model = ScriptedModel::new(vec![]);
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut conversation = long_conversation();
        let result = run_with_budget(
            &model,
            &host,
            &sink,
            &Flag::default(),
            &mut conversation,
            7000,
        )
        .await;
        // The scripted model has no replies at all: the summary fails silently,
        // then the turn itself reports the model error.
        assert!(matches!(result, Err(ChatModelError::InvalidResponse(_))));
        assert_eq!(conversation.summary, None);
        assert_eq!(*sink.compacted.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn a_small_conversation_is_not_summarized() {
        let model = ScriptedModel::new(vec![text("hi")]);
        let (host, sink) = (RecordingHost::default(), RecordingSink::default());
        let mut conversation = long_conversation();
        run_with_budget(
            &model,
            &host,
            &sink,
            &Flag::default(),
            &mut conversation,
            1_000_000,
        )
        .await
        .unwrap();
        assert_eq!(*sink.compacted.lock().unwrap(), 0);
        assert_eq!(*model.seen_lengths.lock().unwrap(), vec![7]);
    }

    #[test]
    fn long_tool_output_is_cut_with_a_note() {
        let output = limit_tool_output("x".repeat(MAX_TOOL_RESULT_BYTES + 10));
        assert!(output.ends_with("[truncated: 10 more bytes not shown]"));
    }
}
