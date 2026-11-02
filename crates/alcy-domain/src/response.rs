/// Read-only received header. Names may repeat, including multiple Set-Cookie values, unlike editable HeaderEntry keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHeader {
    pub name: String,
    pub value: String,
}

/// Interpret response body as text or base64 binary while preserving the shared string contract for cache/windowing/IPC (ADR 0009).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyEncoding {
    Text,
    Base64,
}

/// Received cookie with optional attributes absent unless Set-Cookie declares them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub expires: Option<String>,
    pub max_age_seconds: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<String>,
}

/// Missing peer/address data stays None/false. Certificate verification is disabled only by explicit user configuration (ADR 0058).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConnectionInfo {
    pub remote_address: Option<String>,
    pub http_version: String,
    pub tls_certificate_present: bool,
    pub certificate_verification_disabled: bool,
}

/// Transport data grouped separately from body/headers: actual sent headers, cookies, connection, redirected final URL and time to response headers. Keep constructors stable.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ResponseMetadata {
    pub request_headers: Vec<ResponseHeader>,
    pub cookies: Vec<Cookie>,
    pub connection: ConnectionInfo,
    pub final_url: Option<String>,
    pub waiting_ms: u64,
}

/// Status and trailing metadata of a gRPC call. Message JSON stays in the
/// response body; wire status headers also preserve it in existing history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrpcResponseStatus {
    pub code: i32,
    pub code_name: String,
    pub message: String,
    pub trailers: Vec<ResponseHeader>,
}

/// Who ended a WebSocket connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebSocketClosedBy {
    /// Alcy closed it: the person disconnected or a run finished collecting.
    Client,
    /// The server sent a close frame.
    Server,
    /// The connection dropped without a close handshake.
    Transport,
    /// The server answered the upgrade with another HTTP status; the
    /// response holds that status, headers and body.
    Rejected,
}

/// How a WebSocket connection ended (spec 0140). The exchanged messages stay
/// in the response body; close code and reason are also written as
/// pseudo-headers so existing history keeps them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSocketOutcome {
    /// `None` when the close frame carried no code (1005) or none arrived.
    pub close_code: Option<u16>,
    pub close_reason: String,
    pub closed_by: WebSocketClosedBy,
    /// Subprotocol the server accepted, if any.
    pub subprotocol: Option<String>,
    pub sent: u32,
    pub received: u32,
}

impl WebSocketOutcome {
    /// Normal closure (1000), going away (1001) or no status (1005), or a
    /// normal close by Alcy. Anything else — an error code, a dropped
    /// connection, a rejected upgrade — is a failure for runs and flows.
    pub fn is_clean(&self) -> bool {
        match self.closed_by {
            WebSocketClosedBy::Client => matches!(self.close_code, None | Some(1000)),
            WebSocketClosedBy::Transport | WebSocketClosedBy::Rejected => false,
            WebSocketClosedBy::Server => {
                matches!(self.close_code, None | Some(1000) | Some(1001) | Some(1005))
            }
        }
    }
}

/// Received response including non-success HTTP/protocol statuses. Transport failures use ExecutionError instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub grpc: Option<Box<GrpcResponseStatus>>,
    pub websocket: Option<Box<WebSocketOutcome>>,
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub body: String,
    pub encoding: BodyEncoding,
    pub headers: Vec<ResponseHeader>,
    pub request_headers: Vec<ResponseHeader>,
    pub cookies: Vec<Cookie>,
    pub connection: ConnectionInfo,
    pub final_url: Option<String>,
    pub waiting_ms: u64,
}

impl Response {
    /// A protocol-level failure independent of the transport's HTTP status.
    pub fn protocol_failure(&self) -> Option<String> {
        if let Some(outcome) = self
            .websocket
            .as_ref()
            .filter(|outcome| !outcome.is_clean())
        {
            return Some(match (outcome.closed_by, outcome.close_code) {
                (WebSocketClosedBy::Rejected, _) => format!(
                    "WebSocket handshake rejected with HTTP {}",
                    self.status_code
                ),
                (WebSocketClosedBy::Transport, _) | (_, None) => {
                    "WebSocket: connection closed without a close frame".to_string()
                }
                (_, Some(code)) if outcome.close_reason.is_empty() => {
                    format!("WebSocket closed with {code}")
                }
                (_, Some(code)) => {
                    format!("WebSocket closed with {code}: {}", outcome.close_reason)
                }
            });
        }
        self.grpc
            .as_ref()
            .filter(|status| status.code != 0)
            .map(|status| {
                format!(
                    "gRPC {}{}",
                    status.code_name,
                    if status.message.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", status.message)
                    }
                )
            })
    }

    pub fn new(
        status_code: u16,
        duration_ms: u64,
        body: impl Into<String>,
        headers: Vec<ResponseHeader>,
        metadata: ResponseMetadata,
    ) -> Self {
        let body = body.into();
        let size_bytes = body.len();
        Self {
            grpc: None,
            websocket: None,
            status_code,
            duration_ms,
            size_bytes,
            body,
            encoding: BodyEncoding::Text,
            headers,
            request_headers: metadata.request_headers,
            cookies: metadata.cookies,
            connection: metadata.connection,
            final_url: metadata.final_url,
            waiting_ms: metadata.waiting_ms,
        }
    }

    /// Binary body already base64-encoded. size_bytes is original binary size, not encoded string length.
    pub fn new_binary(
        status_code: u16,
        duration_ms: u64,
        size_bytes: usize,
        base64_body: impl Into<String>,
        headers: Vec<ResponseHeader>,
        metadata: ResponseMetadata,
    ) -> Self {
        Self {
            grpc: None,
            websocket: None,
            status_code,
            duration_ms,
            size_bytes,
            body: base64_body.into(),
            encoding: BodyEncoding::Base64,
            headers,
            request_headers: metadata.request_headers,
            cookies: metadata.cookies,
            connection: metadata.connection,
            final_url: metadata.final_url,
            waiting_ms: metadata.waiting_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn websocket_response(closed_by: WebSocketClosedBy, close_code: Option<u16>) -> Response {
        let mut response = Response::new(101, 5, "[]", vec![], ResponseMetadata::default());
        response.websocket = Some(Box::new(WebSocketOutcome {
            close_code,
            close_reason: String::new(),
            closed_by,
            subprotocol: None,
            sent: 0,
            received: 0,
        }));
        response
    }

    #[test]
    fn websocket_failure_follows_how_the_connection_ended() {
        assert_eq!(
            websocket_response(WebSocketClosedBy::Client, Some(1000)).protocol_failure(),
            None
        );
        assert_eq!(
            websocket_response(WebSocketClosedBy::Client, Some(1009))
                .protocol_failure()
                .as_deref(),
            Some("WebSocket closed with 1009")
        );
        assert_eq!(
            websocket_response(WebSocketClosedBy::Rejected, None)
                .protocol_failure()
                .as_deref(),
            Some("WebSocket handshake rejected with HTTP 101")
        );
        for code in [None, Some(1000), Some(1001), Some(1005)] {
            assert_eq!(
                websocket_response(WebSocketClosedBy::Server, code).protocol_failure(),
                None
            );
        }
        assert_eq!(
            websocket_response(WebSocketClosedBy::Server, Some(1011))
                .protocol_failure()
                .as_deref(),
            Some("WebSocket closed with 1011")
        );
        assert!(
            websocket_response(WebSocketClosedBy::Transport, None)
                .protocol_failure()
                .is_some()
        );
    }

    #[test]
    fn derives_size_in_bytes_from_the_body() {
        let response = Response::new(200, 42, "café", vec![], ResponseMetadata::default());

        assert_eq!(response.status_code, 200);
        assert_eq!(response.duration_ms, 42);
        assert_eq!(response.size_bytes, 5); // Five UTF-8 bytes.
        assert_eq!(response.body, "café");
        assert_eq!(response.encoding, BodyEncoding::Text);
        assert_eq!(response.headers, vec![]);
    }

    #[test]
    fn new_binary_uses_the_given_size_instead_of_the_base64_bodys_length() {
        let response = Response::new_binary(
            200,
            10,
            3,
            "base64bytes",
            vec![],
            ResponseMetadata::default(),
        );

        assert_eq!(response.size_bytes, 3);
        assert_eq!(response.body, "base64bytes");
        assert_eq!(response.encoding, BodyEncoding::Base64);
    }

    #[test]
    fn keeps_the_response_headers_as_given() {
        let headers = vec![ResponseHeader {
            name: "Content-Type".to_string(),
            value: "application/json".to_string(),
        }];

        let response = Response::new(200, 1, "{}", headers.clone(), ResponseMetadata::default());

        assert_eq!(response.headers, headers);
    }

    #[test]
    fn carries_transport_metadata_from_the_metadata_struct() {
        let metadata = ResponseMetadata {
            request_headers: vec![ResponseHeader {
                name: "Authorization".to_string(),
                value: "Bearer token".to_string(),
            }],
            cookies: vec![Cookie {
                name: "session".to_string(),
                value: "abc".to_string(),
                secure: true,
                ..Default::default()
            }],
            connection: ConnectionInfo {
                remote_address: Some("127.0.0.1:8080".to_string()),
                http_version: "HTTP/1.1".to_string(),
                tls_certificate_present: false,
                certificate_verification_disabled: false,
            },
            final_url: Some("https://example.com/final".to_string()),
            waiting_ms: 12,
        };

        let response = Response::new(200, 42, "{}", vec![], metadata.clone());

        assert_eq!(response.request_headers, metadata.request_headers);
        assert_eq!(response.cookies, metadata.cookies);
        assert_eq!(response.connection, metadata.connection);
        assert_eq!(response.final_url, metadata.final_url);
        assert_eq!(response.waiting_ms, metadata.waiting_ms);
    }
}
