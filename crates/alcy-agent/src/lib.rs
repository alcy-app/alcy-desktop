//! Model providers for the agent (ADR 0064): Anthropic Messages and OpenAI
//! Chat Completions, streamed over SSE. Both implement the `ChatModel` port
//! from `alcy-app` and go through `SharedHttpClient`, so the app's proxy and
//! certificates apply.

mod anthropic;
mod openai_compat;
mod sse;
mod transport;

use std::time::Duration;

use alcy_app::{ChatModel, ChatModelError, ChatRequest, ChatResponse, ModelInfo};
use alcy_domain::{AgentProvider, AgentProviderKind};
use alcy_http_proxy::{ProxyError, ProxyPlan, SharedHttpClient};

pub use anthropic::AnthropicChat;
pub use openai_compat::OpenAiCompatibleChat;

/// HTTP client of the agent. Replies stream for as long as the model writes,
/// so there is no overall timeout; a stalled stream fails on its own.
pub struct AgentHttpClient {
    http: SharedHttpClient,
}

impl AgentHttpClient {
    pub fn new() -> Self {
        let http = SharedHttpClient::new(Duration::from_secs(60));
        // Only fails while starting the TLS backend; then the 60 s limit stays.
        let _ = http.set_timeout(None);
        Self { http }
    }

    pub fn reconfigure_proxy(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.http.reconfigure(plan)
    }

    pub fn set_custom_ca_certificates(&self, certificates: &[String]) -> Result<(), ProxyError> {
        self.http.set_custom_ca_certificates(certificates)
    }

    /// The chat model for `provider`. `api_key` is `None` when the user
    /// stored none (local servers).
    pub fn chat<'a>(
        &'a self,
        provider: &'a AgentProvider,
        api_key: Option<&'a str>,
    ) -> Result<AgentChat<'a>, ChatModelError> {
        match provider.kind {
            AgentProviderKind::Anthropic => Ok(AgentChat::Anthropic(AnthropicChat {
                http: &self.http,
                base_url: &provider.base_url,
                api_key: api_key.ok_or(ChatModelError::Unauthorized)?,
            })),
            AgentProviderKind::OpenAiCompatible => {
                Ok(AgentChat::OpenAiCompatible(OpenAiCompatibleChat {
                    http: &self.http,
                    base_url: &provider.base_url,
                    api_key,
                }))
            }
        }
    }
}

impl Default for AgentHttpClient {
    fn default() -> Self {
        Self::new()
    }
}

/// A provider's chat model, chosen at runtime from the settings.
pub enum AgentChat<'a> {
    Anthropic(AnthropicChat<'a>),
    OpenAiCompatible(OpenAiCompatibleChat<'a>),
}

impl AgentChat<'_> {
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ChatModelError> {
        match self {
            Self::Anthropic(chat) => chat.list_models().await,
            Self::OpenAiCompatible(chat) => chat.list_models().await,
        }
    }
}

impl ChatModel for AgentChat<'_> {
    async fn complete(
        &self,
        request: &ChatRequest<'_>,
        on_text: &(dyn Fn(&str) + Sync),
    ) -> Result<ChatResponse, ChatModelError> {
        match self {
            Self::Anthropic(chat) => chat.complete(request, on_text).await,
            Self::OpenAiCompatible(chat) => chat.complete(request, on_text).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use alcy_app::{AgentMessage, ContentBlock, StopReason};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    fn provider(kind: AgentProviderKind, base_url: String) -> AgentProvider {
        AgentProvider {
            id: "p".into(),
            kind,
            label: "P".into(),
            base_url,
            model: "m".into(),
        }
    }

    fn request<'a>(messages: &'a [AgentMessage]) -> ChatRequest<'a> {
        ChatRequest {
            model: "m",
            system_prompt: "sys",
            messages,
            tools: &[],
            max_tokens: 64,
        }
    }

    #[tokio::test]
    async fn streams_an_anthropic_reply_over_http() {
        let server = MockServer::start().await;
        let body = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Olá\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "secret"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream"))
            .mount(&server)
            .await;

        let client = AgentHttpClient::new();
        let provider = provider(AgentProviderKind::Anthropic, server.uri());
        let chat = client.chat(&provider, Some("secret")).unwrap();
        let messages = [AgentMessage::user_text("oi")];
        let response = chat.complete(&request(&messages), &|_| {}).await.unwrap();
        assert_eq!(response.stop_reason, StopReason::EndTurn);
        assert_eq!(
            response.content,
            vec![ContentBlock::Text {
                text: "Olá".into()
            }]
        );
    }

    #[tokio::test]
    async fn maps_http_errors_without_leaking_the_key() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(401).set_body_string("{\"error\":{\"message\":\"bad key\"}}"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_string("{\"error\":{\"message\":\"no models here\"}}"),
            )
            .mount(&server)
            .await;

        let client = AgentHttpClient::new();
        let provider = provider(AgentProviderKind::OpenAiCompatible, server.uri());
        let chat = client.chat(&provider, Some("secret")).unwrap();
        let messages = [AgentMessage::user_text("oi")];
        assert_eq!(
            chat.complete(&request(&messages), &|_| {}).await,
            Err(ChatModelError::Unauthorized)
        );
        assert_eq!(
            chat.list_models().await,
            Err(ChatModelError::Provider {
                status: 400,
                message: "no models here".into()
            })
        );
    }

    #[tokio::test]
    async fn lists_models_from_the_gateway_when_the_api_path_has_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/inference/openai/v1/models"))
            .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/inference/v1/models"))
            .and(header("authorization", "Bearer secret"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"data":[{"id":"kimi-k2.6"},{"id":"claude-sonnet-5-5"}]}"#),
            )
            .mount(&server)
            .await;

        let client = AgentHttpClient::new();
        let provider = provider(
            AgentProviderKind::OpenAiCompatible,
            format!("{}/inference/openai/v1", server.uri()),
        );
        let models = client
            .chat(&provider, Some("secret"))
            .unwrap()
            .list_models()
            .await
            .unwrap();
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, vec!["claude-sonnet-5-5", "kimi-k2.6"]);
    }

    #[test]
    fn anthropic_requires_a_key() {
        let client = AgentHttpClient::new();
        let provider = provider(AgentProviderKind::Anthropic, "https://x".into());
        assert!(matches!(
            client.chat(&provider, None),
            Err(ChatModelError::Unauthorized)
        ));
    }
}
