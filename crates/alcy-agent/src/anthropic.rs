//! Anthropic Messages API, streamed.

use std::future::Future;

use alcy_app::{
    AgentMessage, AgentRole, ChatModel, ChatModelError, ChatRequest, ChatResponse, ContentBlock,
    ModelInfo, StopReason, TokenUsage,
};
use alcy_http_proxy::SharedHttpClient;
use serde_json::{Value, json};

use crate::transport::{error_message, for_each_event, json, parse_event_json, send};

const API_VERSION: &str = "2023-06-01";

pub struct AnthropicChat<'a> {
    pub http: &'a SharedHttpClient,
    /// Without the `/v1` suffix, e.g. `https://api.anthropic.com`.
    pub base_url: &'a str,
    pub api_key: &'a str,
}

impl AnthropicChat<'_> {
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ChatModelError> {
        let client = self.http.get().await;
        let request = client
            .get(format!("{}/v1/models?limit=100", self.base_url))
            .header("x-api-key", self.api_key)
            .header("anthropic-version", API_VERSION);
        let body = json(request).await?;
        Ok(body["data"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        let id = model["id"].as_str()?.to_string();
                        let label = model["display_name"].as_str().unwrap_or(&id).to_string();
                        Some(ModelInfo { id, label })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}

impl ChatModel for AnthropicChat<'_> {
    fn complete(
        &self,
        request: &ChatRequest<'_>,
        on_text: &(dyn Fn(&str) + Sync),
    ) -> impl Future<Output = Result<ChatResponse, ChatModelError>> + Send {
        let body = request_body(request);
        async move {
            let client = self.http.get().await;
            let response = send(
                client
                    .post(format!("{}/v1/messages", self.base_url))
                    .header("x-api-key", self.api_key)
                    .header("anthropic-version", API_VERSION)
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
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            })
        })
        .collect();
    json!({
        "model": request.model,
        "max_tokens": request.max_tokens,
        "stream": true,
        // The prompt and tools are the same every round: cache them.
        "system": [{ "type": "text", "text": request.system_prompt, "cache_control": { "type": "ephemeral" } }],
        "tools": tools,
        "messages": request.messages.iter().map(message_json).collect::<Vec<_>>(),
    })
}

fn message_json(message: &AgentMessage) -> Value {
    let role = match message.role {
        AgentRole::User => "user",
        AgentRole::Assistant => "assistant",
    };
    let content: Vec<Value> = message
        .content
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
            ContentBlock::ToolUse { id, name, input } => {
                // A call whose arguments were not JSON goes back as an empty
                // object; its error result explains what happened.
                let input = if input.is_object() {
                    input.clone()
                } else {
                    json!({})
                };
                json!({ "type": "tool_use", "id": id, "name": name, "input": input })
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            }),
        })
        .collect();
    json!({ "role": role, "content": content })
}

enum PartialBlock {
    Text(String),
    ToolUse {
        id: String,
        name: String,
        json: String,
    },
    /// Block types the loop does not use (thinking, server tools…).
    Ignored,
}

#[derive(Default)]
pub(crate) struct StreamState {
    blocks: Vec<PartialBlock>,
    stop_reason: Option<StopReason>,
    usage: TokenUsage,
    finished: bool,
}

impl StreamState {
    /// Applies one event; `false` once the message is over.
    pub(crate) fn apply(
        &mut self,
        data: &str,
        on_text: &(dyn Fn(&str) + Sync),
    ) -> Result<bool, ChatModelError> {
        let event = parse_event_json(data)?;
        match event["type"].as_str().unwrap_or_default() {
            "message_start" => {
                let usage = &event["message"]["usage"];
                self.usage.input_tokens = usage["input_tokens"].as_u64().unwrap_or(0)
                    + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
                    + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let index = block_index(&event)?;
                let block = &event["content_block"];
                let partial = match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or_default();
                        if !text.is_empty() {
                            on_text(text);
                        }
                        PartialBlock::Text(text.to_string())
                    }
                    Some("tool_use") => PartialBlock::ToolUse {
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        json: String::new(),
                    },
                    _ => PartialBlock::Ignored,
                };
                while self.blocks.len() <= index {
                    self.blocks.push(PartialBlock::Ignored);
                }
                self.blocks[index] = partial;
            }
            "content_block_delta" => {
                let index = block_index(&event)?;
                let delta = &event["delta"];
                match (self.blocks.get_mut(index), delta["type"].as_str()) {
                    (Some(PartialBlock::Text(text)), Some("text_delta")) => {
                        let piece = delta["text"].as_str().unwrap_or_default();
                        on_text(piece);
                        text.push_str(piece);
                    }
                    (Some(PartialBlock::ToolUse { json, .. }), Some("input_json_delta")) => {
                        json.push_str(delta["partial_json"].as_str().unwrap_or_default());
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                self.stop_reason = event["delta"]["stop_reason"].as_str().map(stop_reason);
                if let Some(output) = event["usage"]["output_tokens"].as_u64() {
                    self.usage.output_tokens = output;
                }
            }
            "message_stop" => {
                self.finished = true;
                return Ok(false);
            }
            "error" => {
                return Err(ChatModelError::Provider {
                    status: 0,
                    message: error_message(&event)
                        .unwrap_or_else(|| "the provider ended the stream".into()),
                });
            }
            _ => {}
        }
        Ok(true)
    }

    pub(crate) fn finish(self) -> Result<ChatResponse, ChatModelError> {
        if !self.finished {
            return Err(ChatModelError::Network(
                "the reply was interrupted before it ended".into(),
            ));
        }
        let content = self
            .blocks
            .into_iter()
            .filter_map(|block| match block {
                PartialBlock::Text(text) if !text.is_empty() => Some(ContentBlock::Text { text }),
                PartialBlock::ToolUse { id, name, json } => Some(ContentBlock::ToolUse {
                    id,
                    name,
                    input: parse_arguments(json),
                }),
                _ => None,
            })
            .collect();
        Ok(ChatResponse {
            content,
            stop_reason: self.stop_reason.unwrap_or(StopReason::EndTurn),
            usage: self.usage,
        })
    }
}

fn block_index(event: &Value) -> Result<usize, ChatModelError> {
    event["index"]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
        .filter(|index| *index < 1024)
        .ok_or_else(|| ChatModelError::InvalidResponse("content block without index".into()))
}

fn stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" | "stop_sequence" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        _ => StopReason::Other,
    }
}

/// Tool arguments; an empty string means no arguments. Text that is not
/// JSON is kept as a string so the loop can report it to the model.
pub(crate) fn parse_arguments(raw: String) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(&raw).unwrap_or(Value::String(raw))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use alcy_app::{ToolDefinition, agent_tool_catalog};

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
    fn assembles_text_and_partial_tool_json() {
        let (response, text) = run_stream(&[
            r#"{"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"look."}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_request","input":{}}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"tabId\":"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"t1\"}"}}"#,
            r#"{"type":"content_block_stop","index":1}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}"#,
            r#"{"type":"message_stop"}"#,
        ]);
        let response = response.unwrap();
        assert_eq!(text, "Let me look.");
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        assert_eq!(
            response.usage,
            TokenUsage {
                input_tokens: 15,
                output_tokens: 40
            }
        );
        assert_eq!(
            response.content,
            vec![
                ContentBlock::Text {
                    text: "Let me look.".into()
                },
                ContentBlock::ToolUse {
                    id: "toolu_1".into(),
                    name: "get_request".into(),
                    input: json!({ "tabId": "t1" }),
                },
            ]
        );
    }

    #[test]
    fn a_tool_without_arguments_gets_an_empty_object() {
        let (response, _) = run_stream(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"list_open_tabs","input":{}}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}"#,
            r#"{"type":"message_stop"}"#,
        ]);
        assert!(matches!(
            &response.unwrap().content[0],
            ContentBlock::ToolUse { input, .. } if *input == json!({})
        ));
    }

    #[test]
    fn stream_errors_and_truncation_are_reported() {
        let (response, _) = run_stream(&[
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ]);
        assert_eq!(
            response.unwrap_err(),
            ChatModelError::Provider {
                status: 0,
                message: "Overloaded".into()
            }
        );

        let (response, _) = run_stream(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hi"}}"#,
        ]);
        assert!(matches!(response, Err(ChatModelError::Network(_))));
    }

    #[test]
    fn the_request_maps_tools_and_tool_results() {
        let tools: Vec<ToolDefinition> = agent_tool_catalog();
        let messages = vec![
            AgentMessage::user_text("hi"),
            AgentMessage {
                role: AgentRole::Assistant,
                content: vec![ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "x".into(),
                    input: json!("not json"),
                }],
            },
            AgentMessage {
                role: AgentRole::User,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "t1".into(),
                    content: "bad".into(),
                    is_error: true,
                }],
            },
        ];
        let body = request_body(&ChatRequest {
            model: "claude-sonnet-5-5",
            system_prompt: "sys",
            messages: &messages,
            tools: &tools,
            max_tokens: 100,
        });
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"][0]["text"], "sys");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["messages"][1]["content"][0]["input"], json!({}));
        assert_eq!(body["messages"][2]["content"][0]["is_error"], true);
    }
}
