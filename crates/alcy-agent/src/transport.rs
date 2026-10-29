use std::time::Duration;

use alcy_app::ChatModelError;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde_json::Value;

use crate::sse::{SseEvent, SseParser};

/// Longest silence accepted in the middle of a reply. The request as a whole
/// has no deadline: a long answer keeps streaming.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Sends `request` and fails with a structured error on a non-2xx status.
pub(crate) async fn send(request: RequestBuilder) -> Result<Response, ChatModelError> {
    let response = request.send().await.map_err(network_error)?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = read_capped(response).await;
    Err(status_error(status, &body))
}

/// Feeds every SSE event of `response` to `on_event`; returning `false`
/// stops reading.
pub(crate) async fn for_each_event(
    mut response: Response,
    mut on_event: impl FnMut(SseEvent) -> Result<bool, ChatModelError>,
) -> Result<(), ChatModelError> {
    let mut parser = SseParser::default();
    loop {
        let chunk = tokio::time::timeout(IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| ChatModelError::Network("the provider stopped responding".into()))?
            .map_err(network_error)?;
        let Some(chunk) = chunk else { break };
        for event in parser
            .feed(&chunk)
            .map_err(ChatModelError::InvalidResponse)?
        {
            if !on_event(event)? {
                return Ok(());
            }
        }
    }
    if let Some(event) = parser.finish() {
        on_event(event)?;
    }
    Ok(())
}

pub(crate) async fn json(request: RequestBuilder) -> Result<Value, ChatModelError> {
    let response = send(request).await?;
    let bytes = response.bytes().await.map_err(network_error)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ChatModelError::InvalidResponse(error.to_string()))
}

pub(crate) fn parse_event_json(data: &str) -> Result<Value, ChatModelError> {
    serde_json::from_str(data).map_err(|error| ChatModelError::InvalidResponse(error.to_string()))
}

/// `error.message` as both providers report it, inside a stream or a body.
pub(crate) fn error_message(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| error.as_str().map(str::to_string))
}

fn status_error(status: StatusCode, body: &str) -> ChatModelError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ChatModelError::Unauthorized,
        StatusCode::TOO_MANY_REQUESTS => ChatModelError::RateLimited,
        _ => {
            let message = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|value| error_message(&value))
                .unwrap_or_else(|| body.chars().take(300).collect());
            ChatModelError::Provider {
                status: status.as_u16(),
                message,
            }
        }
    }
}

async fn read_capped(mut response: Response) -> String {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_ERROR_BODY_BYTES {
            body.truncate(MAX_ERROR_BODY_BYTES);
            break;
        }
    }
    String::from_utf8_lossy(&body).into_owned()
}

fn network_error(error: reqwest::Error) -> ChatModelError {
    // `without_url`: the URL may carry a key in a custom provider's query.
    ChatModelError::Network(error.without_url().to_string())
}
