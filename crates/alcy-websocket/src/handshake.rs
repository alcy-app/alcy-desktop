//! The opening handshake (RFC 6455 §4): an HTTP/1.1 GET with the upgrade
//! headers, sent through the shared client so proxy, certificates and
//! authentication apply like on any other request (ADR 0067).

use std::time::Instant;

use alcy_domain::{
    Authentication, ExecutionError, HeaderEntry, NetworkCause, NetworkFailure, Response,
    ResponseHeader, ResponseMetadata, WebSocketClosedBy, WebSocketOutcome,
};
use alcy_http_auth::{build_response_metadata, map_auth_error, map_reqwest_error};
use reqwest::header::{CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use reqwest::{StatusCode, Url, Version};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

/// Largest single message accepted from the server. Above it the connection
/// is closed with 1009 (message too big) instead of buffering it.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// How much of a rejected handshake's body is kept for display.
const MAX_REJECTED_BODY_BYTES: usize = 64 * 1024;

/// Headers the handshake itself owns: a value typed by the person would
/// break the upgrade (`Sec-WebSocket-Extensions` would let the server turn on
/// compression this client does not decode).
const RESERVED_HEADERS: [&str; 5] = [
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
];

/// What the handshake needs; variables are already resolved.
pub struct ConnectInput<'a> {
    pub client: &'a reqwest::Client,
    pub url: &'a str,
    pub headers: &'a [HeaderEntry],
    pub authentication: &'a Authentication,
    pub subprotocols: &'a [String],
    /// Whether the client was built with certificate verification off, to
    /// report it on the connection like the HTTP executors do.
    pub accepts_invalid_certificates: bool,
}

/// The server's answer to a successful upgrade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub status: u16,
    pub headers: Vec<ResponseHeader>,
    pub metadata: ResponseMetadata,
    /// Subprotocol the server picked among the offered ones.
    pub subprotocol: Option<String>,
}

/// Why no connection was opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    /// No HTTP answer: invalid URL, network, TLS, timeout or authentication.
    Execution(ExecutionError),
    /// The server answered the upgrade with another status. The response
    /// carries that status, its headers and the start of its body.
    Rejected(Box<Response>),
    /// The server switched protocols but not to a valid WebSocket.
    InvalidUpgrade(String),
}

/// An open connection, ready for [`crate::run`].
pub struct Connection {
    pub handshake: Handshake,
    pub(crate) stream: WebSocketStream<reqwest::Upgraded>,
    /// When the handshake started; every event's elapsed time counts from
    /// here.
    pub(crate) started: Instant,
}

/// The HTTP URL the handshake is sent to: `ws://` → `http://`,
/// `wss://` → `https://`; `http(s)://` stays; a URL without scheme is
/// `ws://`. Also what session cookies are matched against.
pub fn http_url_of(raw: &str) -> Result<Url, ExecutionError> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("ws://{raw}")
    };
    let invalid = |detail: String| {
        ExecutionError::Network(NetworkFailure {
            cause: Some(NetworkCause::InvalidUrl),
            detail,
        })
    };
    let mut url = Url::parse(&with_scheme).map_err(|error| invalid(format!("{error}: {raw}")))?;
    let scheme = match url.scheme() {
        "ws" | "http" => "http",
        "wss" | "https" => "https",
        other => {
            return Err(invalid(format!(
                "unsupported WebSocket scheme \"{other}\" (use ws:// or wss://)"
            )));
        }
    };
    if url.scheme() != scheme && url.set_scheme(scheme).is_err() {
        return Err(invalid(format!("invalid WebSocket URL: {raw}")));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(invalid(format!("WebSocket URL without host: {raw}")));
    }
    // Fragments are never sent (RFC 6455 §3).
    url.set_fragment(None);
    Ok(url)
}

/// Opens the connection: sends the upgrade, checks the answer and hands
/// the upgraded connection over to the framing layer.
pub async fn connect(input: ConnectInput<'_>) -> Result<Connection, ConnectError> {
    let started = Instant::now();
    let url = http_url_of(input.url).map_err(ConnectError::Execution)?;
    let requested_url = url.to_string();
    let key = generate_key();

    let offered: Vec<&str> = input
        .subprotocols
        .iter()
        .map(|subprotocol| subprotocol.trim())
        .filter(|subprotocol| !subprotocol.is_empty())
        .collect();
    let mut request = input.client.get(url).version(Version::HTTP_11);
    for header in input.headers.iter().filter(|header| header.enabled) {
        let name = header.name().to_ascii_lowercase();
        let owned = RESERVED_HEADERS.contains(&name.as_str())
            || (name == "sec-websocket-protocol" && !offered.is_empty());
        if !owned {
            request = request.header(header.name(), header.value());
        }
    }
    request = request
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", key.as_str());
    if !offered.is_empty() {
        request = request.header(SEC_WEBSOCKET_PROTOCOL, offered.join(", "));
    }

    let exchange = alcy_http_auth::send_authenticated(input.client, request, input.authentication)
        .await
        .map_err(|error| ConnectError::Execution(map_auth_error(error)))?;
    let waiting_ms = elapsed_ms(started);
    let response = exchange.response;
    let metadata = build_response_metadata(
        &response,
        &requested_url,
        exchange.request_headers,
        waiting_ms,
        input.accepts_invalid_certificates,
    );
    let headers: Vec<ResponseHeader> = response
        .headers()
        .iter()
        .map(|(name, value)| ResponseHeader {
            name: name.as_str().to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        })
        .collect();

    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Err(ConnectError::Rejected(Box::new(
            rejected_response(response, headers, metadata, started).await,
        )));
    }

    let header = |name: &reqwest::header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
    };
    if !header(&UPGRADE).is_some_and(|value| value.eq_ignore_ascii_case("websocket")) {
        return Err(ConnectError::InvalidUpgrade(
            "the server did not upgrade to websocket".to_string(),
        ));
    }
    if header(&SEC_WEBSOCKET_ACCEPT) != Some(derive_accept_key(key.as_bytes()).as_str()) {
        return Err(ConnectError::InvalidUpgrade(
            "invalid Sec-WebSocket-Accept from the server".to_string(),
        ));
    }
    if response.headers().contains_key("sec-websocket-extensions") {
        return Err(ConnectError::InvalidUpgrade(
            "the server enabled an extension that was not offered".to_string(),
        ));
    }
    let subprotocol = header(&SEC_WEBSOCKET_PROTOCOL)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(chosen) = &subprotocol
        && !offered.contains(&chosen.as_str())
    {
        return Err(ConnectError::InvalidUpgrade(format!(
            "the server chose subprotocol \"{chosen}\", which was not offered"
        )));
    }

    let upgraded = response
        .upgrade()
        .await
        .map_err(|error| ConnectError::Execution(map_reqwest_error(error)))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let stream = WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await;

    Ok(Connection {
        handshake: Handshake {
            status: StatusCode::SWITCHING_PROTOCOLS.as_u16(),
            headers,
            metadata,
            subprotocol,
        },
        stream,
        started,
    })
}

/// The refused upgrade as a response: status, headers and up to 64 KiB of
/// body, so the person sees why (401, 403, 404…).
async fn rejected_response(
    mut response: reqwest::Response,
    headers: Vec<ResponseHeader>,
    metadata: ResponseMetadata,
    started: Instant,
) -> Response {
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while body.len() < MAX_REJECTED_BODY_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            Ok(None) | Err(_) => break,
        }
    }
    body.truncate(MAX_REJECTED_BODY_BYTES);
    let mut rejected = Response::new(
        status,
        elapsed_ms(started),
        String::from_utf8_lossy(&body).into_owned(),
        headers,
        metadata,
    );
    rejected.websocket = Some(Box::new(WebSocketOutcome {
        close_code: None,
        close_reason: String::new(),
        closed_by: WebSocketClosedBy::Rejected,
        subprotocol: None,
        sent: 0,
        received: 0,
    }));
    rejected
}

pub(crate) fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_websocket_schemes_to_http() {
        assert_eq!(
            http_url_of("ws://localhost:8080/chat?room=1#top")
                .unwrap()
                .as_str(),
            "http://localhost:8080/chat?room=1"
        );
        assert_eq!(
            http_url_of(" wss://example.com/socket ").unwrap().as_str(),
            "https://example.com/socket"
        );
        assert_eq!(
            http_url_of("https://example.com").unwrap().as_str(),
            "https://example.com/"
        );
        assert_eq!(
            http_url_of("localhost:9000").unwrap().as_str(),
            "http://localhost:9000/"
        );
    }

    #[test]
    fn rejects_other_schemes_and_urls_without_host() {
        for raw in ["ftp://example.com", "ws://", "grpc://host:1"] {
            let error = http_url_of(raw).unwrap_err();
            assert!(
                matches!(
                    error,
                    ExecutionError::Network(NetworkFailure {
                        cause: Some(NetworkCause::InvalidUrl),
                        ..
                    })
                ),
                "{raw}: {error:?}"
            );
        }
    }
}
