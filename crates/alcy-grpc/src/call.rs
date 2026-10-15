//! One engine for the four call kinds: the request is always a stream of
//! messages and the response a stream of events. A unary call sends one
//! message and receives one; the others just send or receive more.

use std::str::FromStr;
use std::time::{Duration, Instant};

use http::uri::PathAndQuery;
use prost::Message as _;
use prost_reflect::{DynamicMessage, MessageDescriptor, MethodDescriptor};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::ReceiverStream;
use tonic::metadata::{
    AsciiMetadataKey, AsciiMetadataValue, BinaryMetadataKey, BinaryMetadataValue, KeyAndValueRef,
    MetadataMap,
};
use tonic::transport::Channel;
use tonic::{Code, Status};

use crate::codec::DynamicCodec;
use crate::connect::{MAX_MESSAGE_BYTES, describe};
use crate::schema::{message_from_json, message_to_json};
use crate::{GrpcError, base64};

const EVENT_BUFFER: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MetadataEntry {
    pub name: String,
    /// Text; base64 for binary (`*-bin`) entries.
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcStatus {
    pub code: i32,
    /// Canonical name (`OK`, `NOT_FOUND`, …).
    pub code_name: String,
    pub message: String,
}

impl GrpcStatus {
    pub fn is_ok(&self) -> bool {
        self.code == 0
    }

    fn ok() -> Self {
        Self::new(Code::Ok, String::new())
    }

    fn new(code: Code, message: String) -> Self {
        Self {
            code: code as i32,
            code_name: code_name(code).to_string(),
            message,
        }
    }

    fn from_status(status: &Status) -> Self {
        let message = if status.code() == Code::Unavailable || status.code() == Code::Unknown {
            // Transport failures keep their cause (refused, TLS, DNS…) here.
            describe(status)
        } else {
            status.message().to_string()
        };
        Self::new(status.code(), message)
    }
}

/// What happens during a call, in order. `Finished` is always last.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GrpcEvent {
    #[serde(rename_all = "camelCase")]
    Sent {
        index: usize,
        json: String,
        size_bytes: usize,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Headers {
        metadata: Vec<MetadataEntry>,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Received {
        index: usize,
        json: String,
        size_bytes: usize,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Finished {
        status: GrpcStatus,
        trailers: Vec<MetadataEntry>,
        elapsed_ms: u64,
    },
}

/// Everything a call produced, once it finished.
#[derive(Debug, Clone, PartialEq)]
pub struct CallOutcome {
    pub events: Vec<GrpcEvent>,
}

impl CallOutcome {
    pub fn status(&self) -> Option<&GrpcStatus> {
        self.events.iter().rev().find_map(|event| match event {
            GrpcEvent::Finished { status, .. } => Some(status),
            _ => None,
        })
    }

    /// Received messages, as JSON.
    pub fn messages(&self) -> Vec<&str> {
        self.events
            .iter()
            .filter_map(|event| match event {
                GrpcEvent::Received { json, .. } => Some(json.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// A call in progress. Dropping it cancels the call.
pub struct CallHandle {
    input: MessageDescriptor,
    messages: Option<mpsc::Sender<DynamicMessage>>,
    events_out: mpsc::Sender<GrpcEvent>,
    events: mpsc::Receiver<GrpcEvent>,
    started: Instant,
    sent: usize,
    task: JoinHandle<()>,
}

impl CallHandle {
    /// Sends one request message, given as JSON.
    pub async fn send_json(&mut self, json: &str) -> Result<(), GrpcError> {
        let message = message_from_json(&self.input, json)?;
        let size_bytes = message.encoded_len();
        let sender = self
            .messages
            .as_ref()
            .ok_or_else(|| GrpcError::InvalidMessage {
                message_type: self.input.full_name().to_string(),
                detail: "o envio de mensagens já foi encerrado".to_string(),
            })?;
        let pretty = message_to_json(&message);
        sender
            .send(message)
            .await
            .map_err(|_| GrpcError::InvalidMessage {
                message_type: self.input.full_name().to_string(),
                detail: "a chamada já terminou".to_string(),
            })?;
        let _ = self
            .events_out
            .send(GrpcEvent::Sent {
                index: self.sent,
                json: pretty,
                size_bytes,
                elapsed_ms: elapsed_ms(self.started),
            })
            .await;
        self.sent += 1;
        Ok(())
    }

    /// Ends the request stream: the server sees no more messages.
    pub fn close_send(&mut self) {
        self.messages = None;
    }

    /// The next event; `None` once the call finished and every event was read.
    pub async fn next_event(&mut self) -> Option<GrpcEvent> {
        self.events.recv().await
    }

    /// Closes the request stream and gathers every event until the end.
    pub async fn collect(mut self) -> CallOutcome {
        self.close_send();
        // The handle's own sender would keep the channel open forever.
        let (closed, _) = mpsc::channel(1);
        self.events_out = closed;
        let mut events = Vec::new();
        while let Some(event) = self.events.recv().await {
            events.push(event);
        }
        CallOutcome { events }
    }
}

impl Drop for CallHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts calling `method`. Messages are sent with [`CallHandle::send_json`];
/// the call ends when the server finishes it, the deadline passes or the
/// handle is dropped.
pub fn start_call(
    channel: Channel,
    method: &MethodDescriptor,
    metadata: &[MetadataEntry],
    deadline: Option<Duration>,
) -> Result<CallHandle, GrpcError> {
    let path = PathAndQuery::from_str(&format!(
        "/{}/{}",
        method.parent_service().full_name(),
        method.name()
    ))
    .map_err(|error| GrpcError::MethodNotFound(error.to_string()))?;
    let (message_sender, message_receiver) = mpsc::channel::<DynamicMessage>(16);
    let (event_sender, event_receiver) = mpsc::channel::<GrpcEvent>(EVENT_BUFFER);
    let mut request = tonic::Request::new(ReceiverStream::new(message_receiver));
    apply_metadata(request.metadata_mut(), metadata)?;
    if let Some(deadline) = deadline {
        request.set_timeout(deadline);
    }
    let codec = DynamicCodec::new(method.output());
    let started = Instant::now();
    let events = event_sender.clone();

    let task = tokio::spawn(async move {
        let run = run_call(channel, request, path, codec, events.clone(), started);
        let finished = match deadline {
            Some(deadline) => match tokio::time::timeout(deadline, run).await {
                Ok(finished) => finished,
                Err(_) => Some(GrpcEvent::Finished {
                    status: GrpcStatus::new(
                        Code::DeadlineExceeded,
                        "o prazo da chamada terminou".to_string(),
                    ),
                    trailers: Vec::new(),
                    elapsed_ms: elapsed_ms(started),
                }),
            },
            None => run.await,
        };
        let finished = finished.map(|event| deadline_reached(event, deadline));
        if let Some(finished) = finished {
            let _ = events.send(finished).await;
        }
    });

    Ok(CallHandle {
        input: method.input(),
        messages: Some(message_sender),
        events_out: event_sender,
        events: event_receiver,
        started,
        sent: 0,
        task,
    })
}

/// Servers that enforce the deadline themselves (tonic does) may end the
/// call as `CANCELLED`; past the deadline, that is the deadline expiring.
fn deadline_reached(event: GrpcEvent, deadline: Option<Duration>) -> GrpcEvent {
    match (event, deadline) {
        (
            GrpcEvent::Finished {
                status,
                trailers,
                elapsed_ms,
            },
            Some(deadline),
        ) if status.code == Code::Cancelled as i32
            && u128::from(elapsed_ms) >= deadline.as_millis() =>
        {
            GrpcEvent::Finished {
                status: GrpcStatus::new(
                    Code::DeadlineExceeded,
                    format!("o prazo da chamada terminou ({})", status.message),
                ),
                trailers,
                elapsed_ms,
            }
        }
        (event, _) => event,
    }
}

/// Runs the call, sending every event but the last, which it returns (so
/// that a deadline can replace it).
async fn run_call(
    channel: Channel,
    request: tonic::Request<ReceiverStream<DynamicMessage>>,
    path: PathAndQuery,
    codec: DynamicCodec,
    events: mpsc::Sender<GrpcEvent>,
    started: Instant,
) -> Option<GrpcEvent> {
    let finished = |status: &Status| GrpcEvent::Finished {
        status: GrpcStatus::from_status(status),
        trailers: entries_of(status.metadata()),
        elapsed_ms: elapsed_ms(started),
    };
    let mut grpc = tonic::client::Grpc::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    if let Err(error) = grpc.ready().await {
        return Some(finished(&Status::unavailable(describe(&error))));
    }
    let response = match grpc.streaming(request, path, codec).await {
        Ok(response) => response,
        Err(status) => return Some(finished(&status)),
    };
    events
        .send(GrpcEvent::Headers {
            metadata: entries_of(response.metadata()),
            elapsed_ms: elapsed_ms(started),
        })
        .await
        .ok()?;
    let mut stream = response.into_inner();
    let mut index = 0;
    loop {
        match stream.message().await {
            Ok(Some(message)) => {
                let event = GrpcEvent::Received {
                    index,
                    size_bytes: message.encoded_len(),
                    json: message_to_json(&message),
                    elapsed_ms: elapsed_ms(started),
                };
                events.send(event).await.ok()?;
                index += 1;
            }
            Ok(None) => {
                let trailers = match stream.trailers().await {
                    Ok(trailers) => trailers.map(|map| entries_of(&map)).unwrap_or_default(),
                    Err(status) => return Some(finished(&status)),
                };
                return Some(GrpcEvent::Finished {
                    status: GrpcStatus::ok(),
                    trailers,
                    elapsed_ms: elapsed_ms(started),
                });
            }
            Err(status) => return Some(finished(&status)),
        }
    }
}

/// Adds user metadata to a request. Names are lowercased; `*-bin` values
/// are base64. Pseudo-headers and `grpc-*` names belong to the protocol.
pub(crate) fn apply_metadata(
    map: &mut MetadataMap,
    entries: &[MetadataEntry],
) -> Result<(), GrpcError> {
    for entry in entries {
        let name = entry.name.trim().to_ascii_lowercase();
        let invalid = |detail: &str| GrpcError::InvalidMetadata {
            name: entry.name.clone(),
            detail: detail.to_string(),
        };
        if name.is_empty() || name.starts_with(':') || name.starts_with("grpc-") {
            return Err(invalid("nome reservado pelo protocolo"));
        }
        if name.ends_with("-bin") {
            let key = BinaryMetadataKey::from_str(&name).map_err(|_| invalid("nome inválido"))?;
            let bytes = base64::decode(&entry.value)
                .ok_or_else(|| invalid("valor binário deve estar em base64"))?;
            map.append_bin(key, BinaryMetadataValue::from_bytes(&bytes));
        } else {
            let key = AsciiMetadataKey::from_str(&name).map_err(|_| invalid("nome inválido"))?;
            let value = AsciiMetadataValue::from_str(&entry.value)
                .map_err(|_| invalid("valor com caracteres não permitidos"))?;
            map.append(key, value);
        }
    }
    Ok(())
}

fn entries_of(map: &MetadataMap) -> Vec<MetadataEntry> {
    map.iter()
        .filter_map(|entry| match entry {
            KeyAndValueRef::Ascii(key, value) => Some(MetadataEntry {
                name: key.as_str().to_string(),
                value: value.to_str().ok()?.to_string(),
            }),
            KeyAndValueRef::Binary(key, value) => Some(MetadataEntry {
                name: key.as_str().to_string(),
                value: base64::encode(&value.to_bytes().ok()?),
            }),
        })
        .collect()
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

pub(crate) fn code_name(code: Code) -> &'static str {
    match code {
        Code::Ok => "OK",
        Code::Cancelled => "CANCELLED",
        Code::Unknown => "UNKNOWN",
        Code::InvalidArgument => "INVALID_ARGUMENT",
        Code::DeadlineExceeded => "DEADLINE_EXCEEDED",
        Code::NotFound => "NOT_FOUND",
        Code::AlreadyExists => "ALREADY_EXISTS",
        Code::PermissionDenied => "PERMISSION_DENIED",
        Code::ResourceExhausted => "RESOURCE_EXHAUSTED",
        Code::FailedPrecondition => "FAILED_PRECONDITION",
        Code::Aborted => "ABORTED",
        Code::OutOfRange => "OUT_OF_RANGE",
        Code::Unimplemented => "UNIMPLEMENTED",
        Code::Internal => "INTERNAL",
        Code::Unavailable => "UNAVAILABLE",
        Code::DataLoss => "DATA_LOSS",
        Code::Unauthenticated => "UNAUTHENTICATED",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, value: &str) -> MetadataEntry {
        MetadataEntry {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn applies_text_and_binary_metadata_and_rejects_reserved_names() {
        let mut map = MetadataMap::new();
        apply_metadata(
            &mut map,
            &[entry("X-Tenant", "acme"), entry("trace-bin", "AAEC")],
        )
        .unwrap();
        assert_eq!(
            entries_of(&map),
            vec![entry("x-tenant", "acme"), entry("trace-bin", "AAEC")]
        );
        for (name, value) in [
            (":path", "x"),
            ("grpc-timeout", "1S"),
            ("x-bin", "not base64!"),
            ("bad name", "x"),
            ("x", "line\nbreak"),
        ] {
            assert!(
                apply_metadata(&mut MetadataMap::new(), &[entry(name, value)]).is_err(),
                "{name}"
            );
        }
    }
}
