//! OpenAI Chat Completions, streamed: OpenCode Zen and local servers such as
//! Ollama or LM Studio.

use std::future::Future;

use alcy_app::{
    AgentMessage, AgentRole, ChatModel, ChatModelError, ChatRequest, ChatResponse, ContentBlock,
    ModelInfo, StopReason, TokenUsage,
};
use alcy_http_proxy::SharedHttpClient;
use reqwest::RequestBuilder;
use serde_json::{Value, json};

use crate::anthropic::parse_arguments;
use crate::transport::{error_message, for_each_event, json, parse_event_json, send};

pub struct OpenAiCompatibleChat<'a> {
    pub http: &'a SharedHttpClient,
    /// Including the version, e.g. `https://opencode.ai/inference/openai/v1`.
    pub base_url: &'a str,
    /// Local servers usually need none.
    pub api_key: Option<&'a str>,
}

impl OpenAiCompatibleChat<'_> {
    fn authorized(&self, request: RequestBuilder) -> RequestBuilder {
        match self.api_key {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ChatModelError> {
        let client = self.http.get().await;
        let body = json(self.authorized(client.get(format!("{}/models", self.base_url)))).await?;
        let mut models: Vec<ModelInfo> = body["data"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        let id = model["id"].as_str()?.to_string();
                        Some(ModelInfo {
                            label: id.clone(),
                            id,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(models)
    }
}

impl ChatModel for OpenAiCompatibleChat<'_> {
    fn complete(
        &self,
        request: &ChatRequest<'_>,
        on_text: &(dyn Fn(&str) + Sync),
    ) -> impl Future<Output = Result<ChatResponse, ChatModelError>> + Send {
        let body = request_body(request);
        async move {
            let client = self.http.get().await;
            let response = send(
                self.authorized(client.post(format!("{}/chat/completions", self.base_url)))
                    .header("content-type", "application/json")
                    .body(body.to_string()),
            )
            .await?;
            let mut stream = StreamState::default();
            for_each_event(response, |event| stream.apply(&event.data, on_text)).await?;
            stream.finish()
        }
    }
}

pub(crate) fn request_body(request: &ChatRequest<'_>) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
    for message in request.messages {
        append_messages(&mut messages, message);
    }
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                },
            })
        })
        .collect();
    json!({
        "model": request.model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": messages,
        "tools": tools,
    })
}

/// One neutral message may become several here: tool results are separate
/// `tool` messages that must directly follow the assistant's calls.
fn append_messages(messages: &mut Vec<Value>, message: &AgentMessage) {
    let mut text = String::new();
    match message.role {
        AgentRole::User => {
            for block in &message.content {
                match block {
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => {
                        let content = if *is_error {
                            format!("Error: {content}")
                        } else {
                            content.clone()
                        };
                        messages.push(json!({ "role": "tool", "tool_call_id": tool_use_id, "content": content }));
                    }
                    ContentBlock::Text { text: piece } => join_text(&mut text, piece),
                    ContentBlock::ToolUse { .. } => {}
                }
            }
            if !text.is_empty() {
                messages.push(json!({ "role": "user", "content": text }));
            }
        }
        AgentRole::Assistant => {
            let mut calls = Vec::new();
            for block in &message.content {
                match block {
                    ContentBlock::Text { text: piece } => join_text(&mut text, piece),
                    ContentBlock::ToolUse { id, name, input } => {
                        let arguments = if input.is_object() {
                            input.to_string()
                        } else {
                            "{}".to_string()
                        };
                        calls.push(json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": arguments },
                        }));
                    }
                    ContentBlock::ToolResult { .. } => {}
                }
            }
            let mut assistant = json!({
                "role": "assistant",
                "content": if text.is_empty() { Value::Null } else { Value::String(text) },
            });
            if !calls.is_empty() {
                assistant["tool_calls"] = Value::Array(calls);
            }
            messages.push(assistant);
        }
    }
}

fn join_text(text: &mut String, piece: &str) {
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(piece);
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
pub(crate) struct StreamState {
    text: String,
    calls: Vec<PartialCall>,
    stop_reason: Option<StopReason>,
    usage: TokenUsage,
    done: bool,
}

impl StreamState {
    pub(crate) fn apply(
        &mut self,
        data: &str,
        on_text: &(dyn Fn(&str) + Sync),
    ) -> Result<bool, ChatModelError> {
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(false);
        }
        let chunk = parse_event_json(data)?;
        if let Some(message) = error_message(&chunk) {
            return Err(ChatModelError::Provider { status: 0, message });
        }
        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            self.usage = TokenUsage {
                input_tokens: usage["prompt_tokens"].as_u64().unwrap_or(0),
                output_tokens: usage["completion_tokens"].as_u64().unwrap_or(0),
            };
        }
        let Some(choice) = chunk["choices"].get(0) else {
            return Ok(true);
        };
        let delta = &choice["delta"];
        if let Some(piece) = delta["content"].as_str().filter(|piece| !piece.is_empty()) {
            on_text(piece);
            self.text.push_str(piece);
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                self.apply_call_delta(call);
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.stop_reason = Some(match reason {
                "stop" => StopReason::EndTurn,
                "tool_calls" | "function_call" => StopReason::ToolUse,
                "length" => StopReason::MaxTokens,
                _ => StopReason::Other,
            });
        }
        Ok(true)
    }

    fn apply_call_delta(&mut self, delta: &Value) {
        // Servers that send each call whole omit `index`: a new entry.
        let index = delta["index"]
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < 128)
            .unwrap_or(self.calls.len());
        while self.calls.len() <= index {
            self.calls.push(PartialCall::default());
        }
        let call = &mut self.calls[index];
        if let Some(id) = delta["id"].as_str().filter(|id| !id.is_empty()) {
            call.id = id.to_string();
        }
        let function = &delta["function"];
        if let Some(name) = function["name"].as_str() {
            call.name.push_str(name);
        }
        match &function["arguments"] {
            Value::String(piece) => call.arguments.push_str(piece),
            // Some local servers send the arguments already parsed.
            Value::Object(_) => call.arguments = function["arguments"].to_string(),
            _ => {}
        }
    }

    pub(crate) fn finish(self) -> Result<ChatResponse, ChatModelError> {
        if !self.done && self.stop_reason.is_none() {
            return Err(ChatModelError::Network(
                "the reply was interrupted before it ended".into(),
            ));
        }
        let mut content = Vec::new();
        if !self.text.is_empty() {
            content.push(ContentBlock::Text { text: self.text });
        }
        for (index, call) in self.calls.into_iter().enumerate() {
            if call.name.is_empty() {
                continue;
            }
            content.push(ContentBlock::ToolUse {
                id: if call.id.is_empty() {
                    format!("call_{index}")
                } else {
                    call.id
                },
                name: call.name,
                input: parse_arguments(call.arguments),
            });
        }
        let has_calls = content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse { .. }));
        let stop_reason = match self.stop_reason {
            // Some servers report "stop" even when they called tools.
            Some(StopReason::EndTurn) | None if has_calls => StopReason::ToolUse,
            Some(reason) => reason,
            None => StopReason::EndTurn,
        };
        Ok(ChatResponse {
            content,
            stop_reason,
            usage: self.usage,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn run_stream(events: &[&str]) -> (Result<ChatResponse, ChatModelError>, String) {
        let seen = Mutex::new(String::new());
        let on_text = |text: &str| seen.lock().unwrap().push_str(text);
        let mut state = StreamState::default();
        for event in events {
            match state.apply(event, &on_text) {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => return (Err(error), seen.into_inner().unwrap()),
            }
        }
        (state.finish(), seen.into_inner().unwrap())
    }

    #[test]
    fn assembles_fragmented_tool_calls() {
        let (response, text) = run_stream(&[
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":"Checking"}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_request","arguments":""}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"tabId\""}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"t1\"}"}},{"index":1,"id":"call_b","function":{"name":"list_open_tabs","arguments":"{}"}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":9}}"#,
            "[DONE]",
        ]);
        let response = response.unwrap();
        assert_eq!(text, "Checking");
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        assert_eq!(response.usage.input_tokens, 30);
        assert_eq!(
            response.content,
            vec![
                ContentBlock::Text {
                    text: "Checking".into()
                },
                ContentBlock::ToolUse {
                    id: "call_a".into(),
                    name: "get_request".into(),
                    input: json!({ "tabId": "t1" }),
                },
                ContentBlock::ToolUse {
                    id: "call_b".into(),
                    name: "list_open_tabs".into(),
                    input: json!({}),
                },
            ]
        );
    }

    #[test]
    fn whole_calls_without_index_and_stop_reason_are_tool_use() {
        let (response, _) = run_stream(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"list_open_tabs","arguments":{}}}]},"finish_reason":"stop"}]}"#,
        ]);
        let response = response.unwrap();
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        assert!(matches!(
            &response.content[0],
            ContentBlock::ToolUse { id, .. } if id == "call_0"
        ));
    }

    #[test]
    fn errors_inside_the_stream_and_cut_streams_fail() {
        let (response, _) = run_stream(&[r#"{"error":{"message":"model not found"}}"#]);
        assert_eq!(
            response.unwrap_err(),
            ChatModelError::Provider {
                status: 0,
                message: "model not found".into()
            }
        );
        let (response, _) = run_stream(&[r#"{"choices":[{"delta":{"content":"hi"}}]}"#]);
        assert!(matches!(response, Err(ChatModelError::Network(_))));
    }

    #[test]
    fn tool_results_follow_the_assistant_calls() {
        let messages = vec![
            AgentMessage::user_text("hi"),
            AgentMessage {
                role: AgentRole::Assistant,
                content: vec![
                    ContentBlock::Text {
                        text: "looking".into(),
                    },
                    ContentBlock::ToolUse {
                        id: "c1".into(),
                        name: "get_request".into(),
                        input: json!({ "tabId": "t" }),
                    },
                ],
            },
            AgentMessage {
                role: AgentRole::User,
                content: vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "c1".into(),
                        content: "nope".into(),
                        is_error: true,
                    },
                    ContentBlock::Text {
                        text: "and now?".into(),
                    },
                ],
            },
        ];
        let body = request_body(&ChatRequest {
            model: "m",
            system_prompt: "sys",
            messages: &messages,
            tools: &[],
            max_tokens: 10,
        });
        let sent = body["messages"].as_array().unwrap();
        assert_eq!(sent[0]["role"], "system");
        assert_eq!(
            sent[2]["tool_calls"][0]["function"]["arguments"],
            "{\"tabId\":\"t\"}"
        );
        assert_eq!(sent[3]["role"], "tool");
        assert_eq!(sent[3]["content"], "Error: nope");
        assert_eq!(sent[4]["content"], "and now?");
    }
}
