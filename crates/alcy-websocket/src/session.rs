//! One engine for an open connection, interactive or collecting (spec
//! 0140): it sends what it is asked to, reads what the server sends, answers
//! pings, closes gracefully and keeps a bounded transcript.

use std::time::{Duration, Instant};

use alcy_domain::WebSocketClosedBy;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::handshake::{Connection, elapsed_ms};

/// Largest text sent to the interface per event; the transcript keeps the
/// whole message.
pub const MAX_EVENT_PREVIEW_BYTES: usize = 256 * 1024;
/// A connection stops (1009) once its transcript passes either limit, so a
/// chatty server cannot grow the app's memory without bound.
pub const MAX_SESSION_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_SESSION_MESSAGES: usize = 10_000;
/// How long a close waits for the server's own close frame.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

const NORMAL_CLOSURE: u16 = 1000;
const MESSAGE_TOO_BIG: u16 = 1009;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageFormat {
    Text,
    /// Data is base64.
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Sent,
    Received,
}

/// A message to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
}

/// A message as the interface sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageEvent {
    pub direction: Direction,
    /// Position among the messages in the same direction, from 0.
    pub index: u32,
    pub format: MessageFormat,
    /// The text, or the binary data as base64; capped at
    /// [`MAX_EVENT_PREVIEW_BYTES`].
    pub preview: String,
    pub truncated: bool,
    /// Size of the message itself (bytes on the wire, not of the base64).
    pub size_bytes: usize,
    pub elapsed_ms: u64,
}

/// How and when the connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseEvent {
    pub code: Option<u16>,
    pub reason: String,
    pub closed_by: WebSocketClosedBy,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Message(MessageEvent),
    Closed(CloseEvent),
}

/// Why a message was not sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// The connection is closing or closed.
    NotOpen,
    /// The binary message is not valid base64.
    InvalidBinary(String),
    Transport(String),
}

/// What the person does on an interactive connection.
pub enum SessionAction {
    Send(Outgoing, oneshot::Sender<Result<(), SendError>>),
    Close { code: u16, reason: String },
}

/// How the session is driven.
pub enum SessionMode {
    /// Stays open until the person closes it (an action), the server closes
    /// it or every action sender is dropped (then it closes normally).
    Interactive(mpsc::Receiver<SessionAction>),
    /// Runs, flows and scripts: sends `message`, then stops at the first of
    /// server close, `expected_messages` received (0 = no count) or `wait`.
    Collect {
        message: Option<Outgoing>,
        expected_messages: u32,
        wait: Duration,
    },
}

/// One message of the transcript, whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptMessage {
    pub direction: Direction,
    pub format: MessageFormat,
    /// Text, or base64 for binary messages.
    pub data: String,
    pub size_bytes: usize,
    pub elapsed_ms: u64,
}

/// Everything that happened on the connection after the handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub messages: Vec<TranscriptMessage>,
    pub close: CloseEvent,
    pub sent: u32,
    pub received: u32,
}

impl Transcript {
    /// Received messages, in order.
    pub fn received(&self) -> impl Iterator<Item = &TranscriptMessage> {
        self.messages
            .iter()
            .filter(|message| message.direction == Direction::Received)
    }
}

/// Decodes a composer's binary message (base64; whitespace ignored).
pub fn decode_binary(base64_text: &str) -> Result<Vec<u8>, SendError> {
    let compact: String = base64_text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    BASE64
        .decode(compact)
        .map_err(|error| SendError::InvalidBinary(error.to_string()))
}

struct State<'a, F: Fn(&SessionEvent)> {
    started: Instant,
    on_event: &'a F,
    messages: Vec<TranscriptMessage>,
    retained_bytes: usize,
    sent: u32,
    received: u32,
}

impl<F: Fn(&SessionEvent)> State<'_, F> {
    fn record(&mut self, direction: Direction, format: MessageFormat, data: String, size: usize) {
        let elapsed_ms = elapsed_ms(self.started);
        let index = match direction {
            Direction::Sent => {
                self.sent += 1;
                self.sent - 1
            }
            Direction::Received => {
                self.received += 1;
                self.received - 1
            }
        };
        let (preview, truncated) = preview_of(&data);
        (self.on_event)(&SessionEvent::Message(MessageEvent {
            direction,
            index,
            format,
            preview,
            truncated,
            size_bytes: size,
            elapsed_ms,
        }));
        self.retained_bytes = self.retained_bytes.saturating_add(data.len());
        self.messages.push(TranscriptMessage {
            direction,
            format,
            data,
            size_bytes: size,
            elapsed_ms,
        });
    }

    fn over_limit(&self) -> bool {
        self.retained_bytes > MAX_SESSION_BYTES || self.messages.len() >= MAX_SESSION_MESSAGES
    }
}

/// A close Alcy started and is waiting to see answered.
struct Closing {
    code: u16,
    reason: String,
    until: tokio::time::Instant,
}

type Stream = WebSocketStream<reqwest::Upgraded>;

/// Drives the connection to its end, handing every event to `on_event`.
/// Dropping the future drops the connection without a close handshake.
pub async fn run(
    connection: Connection,
    mode: SessionMode,
    on_event: impl Fn(&SessionEvent),
) -> Transcript {
    let Connection {
        mut stream,
        started,
        ..
    } = connection;
    let mut state = State {
        started,
        on_event: &on_event,
        messages: Vec::new(),
        retained_bytes: 0,
        sent: 0,
        received: 0,
    };
    let (mut actions, collect) = match mode {
        SessionMode::Interactive(receiver) => (Some(receiver), None),
        SessionMode::Collect {
            message,
            expected_messages,
            wait,
        } => (None, Some((message, expected_messages, wait))),
    };

    let mut deadline = None;
    let mut expected = 0;
    let mut closing: Option<Closing> = None;
    if let Some((message, expected_messages, wait)) = collect {
        expected = expected_messages;
        deadline = Some(tokio::time::Instant::now() + wait);
        if let Some(message) = message
            && let Err(error) = send(&mut stream, &mut state, message).await
        {
            let reason = match error {
                SendError::InvalidBinary(detail) | SendError::Transport(detail) => detail,
                SendError::NotOpen => String::new(),
            };
            return finish(&mut state, None, reason, WebSocketClosedBy::Transport);
        }
    }

    loop {
        let mut start_close: Option<(u16, String)> = None;
        tokio::select! {
            frame = stream.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    let size = text.len();
                    state.record(Direction::Received, MessageFormat::Text, text.as_str().to_string(), size);
                    if expected > 0 && state.received >= expected && closing.is_none() {
                        start_close = Some((NORMAL_CLOSURE, String::new()));
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    state.record(Direction::Received, MessageFormat::Binary, BASE64.encode(&bytes), bytes.len());
                    if expected > 0 && state.received >= expected && closing.is_none() {
                        start_close = Some((NORMAL_CLOSURE, String::new()));
                    }
                }
                // Pings are answered by the framing layer.
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    if let Some(closing) = closing {
                        return finish(&mut state, Some(closing.code), closing.reason, WebSocketClosedBy::Client);
                    }
                    let (code, reason) = match frame {
                        Some(frame) => (Some(u16::from(frame.code)), frame.reason.as_str().to_string()),
                        None => (None, String::new()),
                    };
                    // The framing layer queued the answer; flush it and let
                    // the server end the TCP connection.
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
                        while stream.next().await.is_some() {}
                    })
                    .await;
                    return finish(&mut state, code, reason, WebSocketClosedBy::Server);
                }
                Some(Err(WsError::Capacity(error))) => {
                    let reason = error.to_string();
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, stream.close(Some(close_frame(MESSAGE_TOO_BIG, &reason)))).await;
                    return finish(&mut state, Some(MESSAGE_TOO_BIG), reason, WebSocketClosedBy::Client);
                }
                Some(Err(WsError::ConnectionClosed | WsError::AlreadyClosed)) | None => {
                    return match closing {
                        Some(closing) => finish(&mut state, Some(closing.code), closing.reason, WebSocketClosedBy::Client),
                        None => finish(&mut state, None, String::new(), WebSocketClosedBy::Transport),
                    };
                }
                Some(Err(error)) => {
                    return match closing {
                        Some(closing) => finish(&mut state, Some(closing.code), closing.reason, WebSocketClosedBy::Client),
                        None => finish(&mut state, None, error.to_string(), WebSocketClosedBy::Transport),
                    };
                }
            },
            action = async {
                match actions.as_mut() {
                    Some(receiver) => receiver.recv().await,
                    None => std::future::pending().await,
                }
            }, if actions.is_some() && closing.is_none() => match action {
                Some(SessionAction::Send(message, reply)) => {
                    let result = send(&mut stream, &mut state, message).await;
                    let failed = matches!(result, Err(SendError::Transport(_)));
                    let _ = reply.send(result);
                    if failed {
                        return finish(&mut state, None, String::new(), WebSocketClosedBy::Transport);
                    }
                }
                Some(SessionAction::Close { code, reason }) => start_close = Some((code, reason)),
                None => start_close = Some((NORMAL_CLOSURE, String::new())),
            },
            _ = sleep_until(deadline), if deadline.is_some() && closing.is_none() => {
                start_close = Some((NORMAL_CLOSURE, String::new()));
            }
            _ = sleep_until(closing.as_ref().map(|closing| closing.until)), if closing.is_some() => {
                // The server never answered the close: end it anyway.
                let Some(closing) = closing.take() else { continue };
                return finish(&mut state, Some(closing.code), closing.reason, WebSocketClosedBy::Client);
            }
        }

        if closing.is_none() && state.over_limit() {
            start_close = Some((MESSAGE_TOO_BIG, "message limit reached".to_string()));
        }
        if let Some((code, reason)) = start_close {
            if let Some(mut actions) = actions.take() {
                actions.close();
                // Sends still queued never go out.
                while let Ok(action) = actions.try_recv() {
                    if let SessionAction::Send(_, reply) = action {
                        let _ = reply.send(Err(SendError::NotOpen));
                    }
                }
            }
            if stream
                .close(Some(close_frame(code, &reason)))
                .await
                .is_err()
            {
                return finish(&mut state, Some(code), reason, WebSocketClosedBy::Client);
            }
            closing = Some(Closing {
                code,
                reason,
                until: tokio::time::Instant::now() + CLOSE_TIMEOUT,
            });
        }
    }
}

async fn send<F: Fn(&SessionEvent)>(
    stream: &mut Stream,
    state: &mut State<'_, F>,
    message: Outgoing,
) -> Result<(), SendError> {
    let (frame, format, data, size) = match message {
        Outgoing::Text(text) => {
            let size = text.len();
            (Message::text(text.clone()), MessageFormat::Text, text, size)
        }
        Outgoing::Binary(bytes) => {
            let size = bytes.len();
            let data = BASE64.encode(&bytes);
            (Message::binary(bytes), MessageFormat::Binary, data, size)
        }
    };
    stream.send(frame).await.map_err(|error| match error {
        WsError::ConnectionClosed | WsError::AlreadyClosed => SendError::NotOpen,
        other => SendError::Transport(other.to_string()),
    })?;
    state.record(Direction::Sent, format, data, size);
    Ok(())
}

fn finish<F: Fn(&SessionEvent)>(
    state: &mut State<'_, F>,
    code: Option<u16>,
    reason: String,
    closed_by: WebSocketClosedBy,
) -> Transcript {
    let close = CloseEvent {
        // 1005 means "no code in the frame"; it is never sent on the wire.
        code: code.filter(|code| *code != 1005),
        reason,
        closed_by,
        elapsed_ms: elapsed_ms(state.started),
    };
    (state.on_event)(&SessionEvent::Closed(close.clone()));
    Transcript {
        messages: std::mem::take(&mut state.messages),
        close,
        sent: state.sent,
        received: state.received,
    }
}

fn close_frame(code: u16, reason: &str) -> CloseFrame {
    // A close reason is limited to 123 bytes (the frame payload is 125).
    let mut end = reason.len().min(123);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    CloseFrame {
        code: CloseCode::from(code),
        reason: reason[..end].to_string().into(),
    }
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn preview_of(data: &str) -> (String, bool) {
    if data.len() <= MAX_EVENT_PREVIEW_BYTES {
        return (data.to_string(), false);
    }
    let mut end = MAX_EVENT_PREVIEW_BYTES;
    while !data.is_char_boundary(end) {
        end -= 1;
    }
    (data[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_binary_composer_text_ignoring_whitespace() {
        assert_eq!(decode_binary("aGVs\nbG8=").unwrap(), b"hello");
        assert!(matches!(
            decode_binary("not base64!"),
            Err(SendError::InvalidBinary(_))
        ));
    }

    #[test]
    fn previews_are_capped_on_a_char_boundary() {
        let (preview, truncated) = preview_of("short");
        assert_eq!((preview.as_str(), truncated), ("short", false));
        let long = "é".repeat(MAX_EVENT_PREVIEW_BYTES);
        let (preview, truncated) = preview_of(&long);
        assert!(truncated);
        assert!(preview.len() <= MAX_EVENT_PREVIEW_BYTES);
    }

    #[test]
    fn close_reasons_fit_in_a_control_frame() {
        let frame = close_frame(1000, &"á".repeat(100));
        assert!(frame.reason.len() <= 123);
        assert_eq!(u16::from(frame.code), 1000);
    }
}
