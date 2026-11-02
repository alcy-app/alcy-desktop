//! WebSocket capability (spec 0140, ADR 0067).
//!
//! The opening handshake goes through the app's shared HTTP client, so the
//! proxy, custom CAs, TLS options and every authentication type apply like on
//! REST; `tokio-tungstenite` only frames messages on the upgraded
//! connection. Like the other protocol crates, it is dispatched to only from
//! the composition root.

mod handshake;
mod session;

pub use handshake::{
    ConnectError, ConnectInput, Connection, Handshake, MAX_MESSAGE_BYTES, connect, http_url_of,
};
pub use session::{
    CloseEvent, Direction, MAX_EVENT_PREVIEW_BYTES, MAX_SESSION_BYTES, MAX_SESSION_MESSAGES,
    MessageEvent, MessageFormat, Outgoing, SendError, SessionAction, SessionEvent, SessionMode,
    Transcript, TranscriptMessage, decode_binary, run,
};
