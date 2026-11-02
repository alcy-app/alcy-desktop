//! How a WebSocket request connects and what a non-interactive run collects
//! (spec 0140, ADR 0067). Only the WebSocket executor reads it, the same
//! pattern as `GrpcCall`. The message to send is the document body.

/// How the composer message is encoded when sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WebSocketMessageFormat {
    /// Sent as a text frame as typed.
    #[default]
    Text,
    /// Sent as a text frame; the editor highlights and checks it as JSON.
    Json,
    /// The body is base64 and is sent as a binary frame.
    Binary,
}

/// When a non-interactive run (collection runner, flows, scripts) stops
/// listening and closes the connection. The interactive editor ignores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WebSocketCollect {
    /// Longest wait for messages after connecting; `None` uses the configured
    /// request timeout.
    pub wait_ms: Option<u64>,
    /// Stops once this many messages arrived; `None` means 1, and `Some(0)`
    /// waits for the whole `wait_ms` (or until the server closes).
    pub expected_messages: Option<u32>,
}

impl WebSocketCollect {
    /// Messages a run waits for before closing; 0 = no count limit.
    pub fn expected_messages(&self) -> u32 {
        self.expected_messages.unwrap_or(1)
    }
}

/// What a WebSocket request negotiates and how its message is sent.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WebSocketCall {
    /// Offered in `Sec-WebSocket-Protocol`, in order of preference.
    pub subprotocols: Vec<String>,
    pub message_format: WebSocketMessageFormat,
    pub collect: WebSocketCollect,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_text_with_no_subprotocol_and_one_expected_message() {
        let call = WebSocketCall::default();
        assert!(call.subprotocols.is_empty());
        assert_eq!(call.message_format, WebSocketMessageFormat::Text);
        assert_eq!(call.collect.wait_ms, None);
        assert_eq!(call.collect.expected_messages(), 1);
    }

    #[test]
    fn zero_expected_messages_means_no_count_limit() {
        let collect = WebSocketCollect {
            wait_ms: Some(500),
            expected_messages: Some(0),
        };
        assert_eq!(collect.expected_messages(), 0);
    }
}
