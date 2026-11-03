//! WebSocket connections (spec 0140, ADR 0067). The protocol work lives in
//! `alcy-websocket`; this adapter resolves variables, authentication and
//! session cookies, keeps the live connections by execution id, runs
//! scripts and records history, like the REST and gRPC commands.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use alcy_app::{StatusClass, UsageHub, resolve_variables};
use alcy_domain::{
    DEFAULT_REQUEST_TIMEOUT_SECONDS, EnvironmentVariable, ExecutionError, ProtocolId, Request,
    RequestDocument, Response, ResponseHeader, WebSocketCall, WebSocketMessageFormat,
    WebSocketOutcome,
};
use alcy_rest::ReqwestRestExecutor;
use alcy_scripting::ScriptWebSocketRequest;
use alcy_storage::GeneralSettingsStore;
use alcy_websocket::{
    ConnectError, ConnectInput, Connection, Direction, Handshake, MessageFormat, Outgoing,
    SendError, SessionAction, SessionEvent, SessionMode, Transcript, TranscriptMessage,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel as IpcChannel;
use tauri::{Manager, State};
use tokio::sync::{mpsc, oneshot};

use crate::commands::collections::{WebSocketCallDto, WebSocketMessageFormatDto};
use crate::commands::cookie_jar::CookieJar;
use crate::commands::environments::{EnvironmentVariableDto, redact_sensitive_variables};
use crate::commands::execute_graphql_request::{
    AuthenticationInput, ConnectionInfoOutput, CookieOutput, HeaderInput, ResponseBodyOutput,
    ResponseHeaderOutput, cancellation_signal, history_outcome_from, history_request,
    record_history, resolve_inherited_authentication, response_body_output,
};
use crate::commands::execute_rest_request::{
    BodyInput, ExecuteRestRequestError, ExecuteRestRequestInput, HttpMethodInput,
    RawBodyLanguageInput, RouteParameterInput, build_request,
};
use crate::commands::execution_registry::ExecutionRegistry;
use crate::commands::general_settings::HistoryPreferencesState;
use crate::commands::response_body_cache::ResponseBodyCache;
use crate::commands::scripting::{
    EnvironmentChangeOutput, ExecutionFailure, ScopedChangeOutput, ScriptEffects,
    ScriptErrorOutput, ScriptTestOutput, ScriptedRequest, closed_by_name, run_post_response,
    run_pre_request,
};
use crate::commands::session_cookies::SessionCookies;
use crate::commands::variable_scopes::{VariableScopeDto, scopes_from_dto, with_scoped_variables};

/// Pseudo-headers that keep how a connection ended in history, whose
/// format only stores headers (like `grpc-status` for gRPC).
const CLOSE_CODE_HEADER: &str = "websocket-close-code";
const CLOSE_REASON_HEADER: &str = "websocket-close-reason";
const CLOSED_BY_HEADER: &str = "websocket-closed-by";

/// Open connections, by execution id: they take messages and a close until
/// they end.
#[derive(Default)]
pub struct WebSocketSessions(Mutex<HashMap<String, LiveSession>>);

#[derive(Clone)]
struct LiveSession {
    sender: mpsc::Sender<SessionAction>,
    /// Variables as they were when connecting, so every message resolves
    /// `{{name}}` the same way.
    variables: Vec<EnvironmentVariableDto>,
}

impl WebSocketSessions {
    fn insert(
        &self,
        id: &str,
        sender: mpsc::Sender<SessionAction>,
        variables: Vec<EnvironmentVariableDto>,
    ) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.insert(id.to_string(), LiveSession { sender, variables });
        }
    }

    fn remove(&self, id: &str) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.remove(id);
        }
    }

    fn get(&self, id: &str) -> Option<LiveSession> {
        self.0.lock().ok()?.get(id).cloned()
    }

    /// Drops every live connection's sender: each session then closes
    /// normally. Called when the webview reloads, since nothing would be
    /// left to show or close those connections.
    pub(crate) fn close_all(&self) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.clear();
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteWebSocketRequestInput {
    pub execution_id: String,
    pub root_path: String,
    pub endpoint_url: String,
    #[serde(default)]
    pub route_params: Vec<RouteParameterInput>,
    pub headers: Vec<HeaderInput>,
    pub authentication: AuthenticationInput,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    #[serde(default)]
    pub variable_scopes: Vec<VariableScopeDto>,
    #[serde(default)]
    pub pre_request_script: String,
    #[serde(default)]
    pub post_response_script: String,
    /// The composer message (the saved body). Connecting does not send it;
    /// scripts and history see it.
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub websocket: WebSocketCallDto,
}

/// A connection's progress, as it happens.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WebSocketEventDto {
    #[serde(rename_all = "camelCase")]
    Opened {
        status: u16,
        headers: Vec<ResponseHeaderOutput>,
        subprotocol: Option<String>,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Message {
        /// `sent` or `received`.
        direction: &'static str,
        index: u32,
        /// `text` or `binary` (base64 data).
        format: &'static str,
        data: String,
        truncated: bool,
        size_bytes: usize,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Closed {
        code: Option<u16>,
        reason: String,
        closed_by: &'static str,
        elapsed_ms: u64,
    },
}

impl From<&SessionEvent> for WebSocketEventDto {
    fn from(event: &SessionEvent) -> Self {
        match event {
            SessionEvent::Message(message) => Self::Message {
                direction: direction_name(message.direction),
                index: message.index,
                format: format_name(message.format),
                data: message.preview.clone(),
                truncated: message.truncated,
                size_bytes: message.size_bytes,
                elapsed_ms: message.elapsed_ms,
            },
            SessionEvent::Closed(close) => Self::Closed {
                code: close.code,
                reason: close.reason.clone(),
                closed_by: closed_by_name(close.closed_by),
                elapsed_ms: close.elapsed_ms,
            },
        }
    }
}

fn direction_name(direction: Direction) -> &'static str {
    match direction {
        Direction::Sent => "sent",
        Direction::Received => "received",
    }
}

fn format_name(format: MessageFormat) -> &'static str {
    match format {
        MessageFormat::Text => "text",
        MessageFormat::Binary => "binary",
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketCloseOutput {
    pub code: Option<u16>,
    pub reason: String,
    /// `client`, `server`, `transport` or `rejected`.
    pub closed_by: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteWebSocketRequestOutput {
    /// 101, or the status the server refused the upgrade with.
    pub status_code: u16,
    pub duration_ms: u64,
    /// Received messages, in bytes on the wire.
    pub size_bytes: usize,
    /// The received messages: the message itself when there is one, a JSON
    /// array when there are several; the refusal body when rejected.
    pub body: ResponseBodyOutput,
    pub headers: Vec<ResponseHeaderOutput>,
    pub request_headers: Vec<ResponseHeaderOutput>,
    pub cookies: Vec<CookieOutput>,
    pub connection: ConnectionInfoOutput,
    pub waiting_ms: u64,
    pub close: WebSocketCloseOutput,
    pub subprotocol: Option<String>,
    pub sent_count: u32,
    pub received_count: u32,
    pub environment_changes: Vec<EnvironmentChangeOutput>,
    pub scoped_changes: Vec<ScopedChangeOutput>,
    pub script_logs: Vec<String>,
    pub script_error: Option<ScriptErrorOutput>,
    pub test_results: Vec<ScriptTestOutput>,
}

/// Builds the domain request: URL, route parameters, headers and every
/// authentication type resolve exactly like REST.
fn build_websocket_request(
    input: &ExecuteWebSocketRequestInput,
    environment_variables: Vec<EnvironmentVariableDto>,
) -> Result<Request, ExecuteRestRequestError> {
    let variables = environment_variables
        .iter()
        .map(|variable| {
            EnvironmentVariable::new(&variable.name, &variable.value, variable.sensitive)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let subprotocols = input
        .websocket
        .subprotocols
        .iter()
        .map(|subprotocol| resolve_variables(subprotocol, &variables))
        .collect::<Result<Vec<_>, _>>()?;
    let mut request = build_request(ExecuteRestRequestInput {
        execution_id: input.execution_id.clone(),
        root_path: input.root_path.clone(),
        endpoint_url: input.endpoint_url.clone(),
        route_params: input.route_params.clone(),
        method: HttpMethodInput::Get,
        body: BodyInput::Raw {
            content: input.message.clone(),
            raw_language: RawBodyLanguageInput::Text,
        },
        headers: input.headers.clone(),
        authentication: input.authentication.clone(),
        request_id: input.request_id.clone(),
        tab_id: input.tab_id.clone(),
        environment_variables,
        variable_scopes: Vec::new(),
        pre_request_script: String::new(),
        post_response_script: String::new(),
        ignore_response_size_limit: false,
    })?;
    request.document = RequestDocument::new(ProtocolId::WebSocket, request.document.body);
    request.body_payload = alcy_domain::BodyPayload::default();
    request.method = alcy_domain::HttpMethod::Get;
    request.websocket = WebSocketCall {
        subprotocols,
        ..WebSocketCall::from(input.websocket.clone())
    };
    Ok(request)
}

/// Opens the connection. A refused upgrade is a response (status, headers,
/// body), not a failure: it shows like any HTTP answer.
async fn open(request: &Request, rest: &ReqwestRestExecutor) -> Result<Connection, Opening> {
    let client = rest.upgrade_client().await;
    alcy_websocket::connect(ConnectInput {
        client: &client.client,
        url: request.endpoint.url(),
        headers: &request.headers,
        authentication: &request.authentication,
        subprotocols: &request.websocket.subprotocols,
        accepts_invalid_certificates: client.accepts_invalid_certificates,
    })
    .await
    .map_err(|error| match error {
        ConnectError::Execution(error) => Opening::Failed(error),
        ConnectError::InvalidUpgrade(message) => Opening::Failed(ExecutionError::network(message)),
        ConnectError::Rejected(response) => Opening::Rejected(*response),
    })
}

enum Opening {
    Failed(ExecutionError),
    Rejected(Response),
}

/// The composer message as a frame.
fn outgoing(message: String, format: WebSocketMessageFormat) -> Result<Outgoing, ExecutionError> {
    match format {
        WebSocketMessageFormat::Text | WebSocketMessageFormat::Json => Ok(Outgoing::Text(message)),
        WebSocketMessageFormat::Binary => alcy_websocket::decode_binary(&message)
            .map(Outgoing::Binary)
            .map_err(|error| match error {
                SendError::InvalidBinary(detail) => ExecutionError::InvalidRequest(format!(
                    "a mensagem binária não é base64 válido: {detail}"
                )),
                other => ExecutionError::InvalidRequest(format!("{other:?}")),
            }),
    }
}

/// Collected execution for runners, flows and scripts: connect, send the
/// saved message if any, collect replies and close (spec 0140).
pub(crate) async fn execute_saved_request(
    request: &Request,
    rest: &ReqwestRestExecutor,
    app: Option<&tauri::AppHandle>,
) -> Result<Response, ExecutionError> {
    let message = if request.document.body.trim().is_empty() {
        None
    } else {
        Some(outgoing(
            request.document.body.clone(),
            request.websocket.message_format,
        )?)
    };
    let default_wait = app
        .and_then(|app| app.state::<GeneralSettingsStore>().load().ok())
        .and_then(|settings| settings.request_timeout.duration())
        .unwrap_or(Duration::from_secs(u64::from(
            DEFAULT_REQUEST_TIMEOUT_SECONDS,
        )));
    let wait = request
        .websocket
        .collect
        .wait_ms
        .map(Duration::from_millis)
        .unwrap_or(default_wait);
    let connection = match open(request, rest).await {
        Ok(connection) => connection,
        Err(Opening::Rejected(response)) => return Ok(response),
        Err(Opening::Failed(error)) => return Err(error),
    };
    let handshake = connection.handshake.clone();
    let transcript = alcy_websocket::run(
        connection,
        SessionMode::Collect {
            message,
            expected_messages: request.websocket.collect.expected_messages(),
            wait,
        },
        |_| {},
    )
    .await;
    Ok(response_of(&handshake, &transcript))
}

/// The connection as a response: the received messages as the body, the
/// handshake headers plus the close as pseudo-headers.
pub(crate) fn response_of(handshake: &Handshake, transcript: &Transcript) -> Response {
    let received: Vec<&TranscriptMessage> = transcript.received().collect();
    let body = match received.as_slice() {
        [] => String::new(),
        [single] => single.data.clone(),
        many => format!(
            "[\n{}\n]",
            many.iter()
                .map(|message| array_element(message))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
    };
    let size_bytes = received.iter().map(|message| message.size_bytes).sum();
    let mut headers = handshake.headers.clone();
    if let Some(code) = transcript.close.code {
        headers.push(ResponseHeader {
            name: CLOSE_CODE_HEADER.to_string(),
            value: code.to_string(),
        });
    }
    if !transcript.close.reason.is_empty() {
        headers.push(ResponseHeader {
            name: CLOSE_REASON_HEADER.to_string(),
            value: transcript.close.reason.clone(),
        });
    }
    headers.push(ResponseHeader {
        name: CLOSED_BY_HEADER.to_string(),
        value: closed_by_name(transcript.close.closed_by).to_string(),
    });
    let mut response = Response::new(
        handshake.status,
        transcript.close.elapsed_ms,
        body,
        headers,
        handshake.metadata.clone(),
    );
    response.size_bytes = size_bytes;
    response.websocket = Some(Box::new(WebSocketOutcome {
        close_code: transcript.close.code,
        close_reason: transcript.close.reason.clone(),
        closed_by: transcript.close.closed_by,
        subprotocol: handshake.subprotocol.clone(),
        sent: transcript.sent,
        received: transcript.received,
    }));
    response
}

/// A message inside the body array: JSON text as is, anything else as a
/// JSON string (binary as its base64).
fn array_element(message: &TranscriptMessage) -> String {
    let is_json = message.format == MessageFormat::Text
        && serde_json::from_str::<serde::de::IgnoredAny>(&message.data).is_ok();
    if is_json {
        message.data.clone()
    } else {
        serde_json::Value::String(message.data.clone()).to_string()
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_websocket_request(
    input: ExecuteWebSocketRequestInput,
    on_event: IpcChannel<WebSocketEventDto>,
    registry: State<'_, ExecutionRegistry>,
    sessions: State<'_, WebSocketSessions>,
    rest: State<'_, ReqwestRestExecutor>,
    session_cookies: State<'_, SessionCookies>,
    body_cache: State<'_, ResponseBodyCache>,
    history: State<'_, HistoryPreferencesState>,
    usage: State<'_, UsageHub>,
) -> Result<ExecuteWebSocketRequestOutput, ExecutionFailure<ExecuteRestRequestError>> {
    let execution_id = input.execution_id.clone();
    let started = std::time::Instant::now();
    log::info!(
        target: "alcy::request",
        "websocket {execution_id}: conectando em {}",
        crate::logging::url_for_log(&input.endpoint_url)
    );
    let result = execute_inner(
        input,
        &on_event,
        &registry,
        &sessions,
        &rest,
        &session_cookies.0,
        &body_cache,
        &history,
    )
    .await;
    match &result {
        Ok(output) => log::info!(
            target: "alcy::request",
            "websocket {execution_id}: HTTP {}, fechada por {} ({:?}) em {} ms",
            output.status_code,
            output.close.closed_by,
            output.close.code,
            output.duration_ms
        ),
        Err(failure) => log::warn!(
            target: "alcy::request",
            "websocket {execution_id}: falhou ({})",
            crate::logging::error_summary(failure)
        ),
    }
    usage.record(match &result {
        Ok(output) => crate::commands::usage_events::request_answered(
            ProtocolId::WebSocket,
            None,
            StatusClass::from_status(output.status_code),
            None,
            output.duration_ms,
        ),
        Err(failure) => crate::commands::usage_events::request_failed(
            ProtocolId::WebSocket,
            None,
            failure,
            alcy_app::millis(started.elapsed()),
        ),
    });
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_inner(
    mut input: ExecuteWebSocketRequestInput,
    on_event: &IpcChannel<WebSocketEventDto>,
    registry: &ExecutionRegistry,
    sessions: &WebSocketSessions,
    rest: &ReqwestRestExecutor,
    cookies: &CookieJar,
    body_cache: &ResponseBodyCache,
    history: &HistoryPreferencesState,
) -> Result<ExecuteWebSocketRequestOutput, ExecutionFailure<ExecuteRestRequestError>> {
    let execution_id = input.execution_id.clone();
    let root_path = input.root_path.clone();
    let history_source = (input.request_id.clone(), input.tab_id.clone());
    let post_script = std::mem::take(&mut input.post_response_script);
    let mut effects = ScriptEffects::default();
    let mut scopes = scopes_from_dto(std::mem::take(&mut input.variable_scopes))
        .map_err(|error| ExecutionFailure::new(error, ScriptEffects::default()))?;

    let mut scripted = ScriptedRequest {
        grpc: None,
        websocket: Some(ScriptWebSocketRequest {
            subprotocols: input.websocket.subprotocols.clone(),
        }),
        url: input.endpoint_url.clone(),
        method: "get".to_string(),
        body: input.message.clone(),
        headers: input.headers.clone(),
    };
    run_pre_request(
        &input.pre_request_script,
        &mut scripted,
        &mut input.environment_variables,
        &mut scopes,
        &mut effects,
    )
    .await
    .map_err(|error| ExecutionFailure::new(error, ScriptEffects::default()))?;
    input.endpoint_url = scripted.url.clone();
    input.message = scripted.body.clone();
    input.headers = scripted.headers.clone();
    if let Some(websocket) = &scripted.websocket {
        input.websocket.subprotocols = websocket.subprotocols.clone();
    }
    let environment = input.environment_variables.clone();
    let variables = with_scoped_variables(&environment, &scopes);
    input.authentication = resolve_inherited_authentication(
        input.authentication,
        input.request_id.as_deref(),
        Some(&root_path),
    )
    .await;
    let redacted = redact_sensitive_variables(&variables)
        .map(|redacted| build_websocket_request(&input, redacted).ok());
    let request = match build_websocket_request(&input, variables.clone()) {
        Ok(request) => request,
        Err(error) => return Err(ExecutionFailure::new(error, effects)),
    };
    let history_request = history_request(&request, redacted.as_ref()).cloned();
    // Only the connecting copy carries jar cookies; history excludes them.
    let mut executable = request.clone();
    cookies.apply_to(&mut executable);

    let send_event = |event: WebSocketEventDto| {
        let _ = on_event.send(event);
    };
    let (cancel, cancelled) = oneshot::channel();
    registry.register(execution_id.clone(), cancel);
    let work = async {
        let connection = match open(&executable, rest).await {
            Ok(connection) => connection,
            Err(Opening::Rejected(response)) => return Ok(response),
            Err(Opening::Failed(error)) => return Err(error),
        };
        let handshake = connection.handshake.clone();
        send_event(WebSocketEventDto::Opened {
            status: handshake.status,
            headers: handshake
                .headers
                .iter()
                .cloned()
                .map(ResponseHeaderOutput::from)
                .collect(),
            subprotocol: handshake.subprotocol.clone(),
            elapsed_ms: handshake.metadata.waiting_ms,
        });
        let (sender, receiver) = mpsc::channel(8);
        sessions.insert(&execution_id, sender, variables.clone());
        let transcript =
            alcy_websocket::run(connection, SessionMode::Interactive(receiver), |event| {
                send_event(WebSocketEventDto::from(event))
            })
            .await;
        sessions.remove(&execution_id);
        Ok(response_of(&handshake, &transcript))
    };
    let outcome = tokio::select! {
        outcome = work => outcome,
        () = cancellation_signal(cancelled) => Err(ExecutionError::Cancelled),
    };
    registry.remove(&execution_id);
    sessions.remove(&execution_id);

    let preferences = history.get();
    if let (Some(history_outcome), Some(history_request)) =
        (history_outcome_from(&outcome), history_request)
        && !preferences.retention.is_disabled()
    {
        drop(record_history(
            &root_path,
            execution_id.clone(),
            &history_request,
            history_outcome,
            history_source,
            preferences,
        ));
    }

    let response = match outcome {
        Ok(response) => response,
        Err(error) => return Err(ExecutionFailure::new(error, effects)),
    };
    cookies.remember(executable.endpoint.url(), &response);
    let script_error = run_post_response(
        &post_script,
        &scripted,
        &response,
        &environment,
        &scopes,
        &mut effects,
    )
    .await
    .err();

    let close = match response.websocket.as_deref() {
        Some(outcome) => WebSocketCloseOutput {
            code: outcome.close_code,
            reason: outcome.close_reason.clone(),
            closed_by: closed_by_name(outcome.closed_by).to_string(),
        },
        None => WebSocketCloseOutput {
            code: None,
            reason: String::new(),
            closed_by: "transport".to_string(),
        },
    };
    let (subprotocol, sent_count, received_count) = response
        .websocket
        .as_deref()
        .map(|outcome| (outcome.subprotocol.clone(), outcome.sent, outcome.received))
        .unwrap_or_default();
    Ok(ExecuteWebSocketRequestOutput {
        status_code: response.status_code,
        duration_ms: response.duration_ms,
        size_bytes: response.size_bytes,
        headers: response
            .headers
            .into_iter()
            .map(ResponseHeaderOutput::from)
            .collect(),
        request_headers: response
            .request_headers
            .into_iter()
            .map(ResponseHeaderOutput::from)
            .collect(),
        cookies: response
            .cookies
            .into_iter()
            .map(CookieOutput::from)
            .collect(),
        connection: ConnectionInfoOutput::from(response.connection),
        waiting_ms: response.waiting_ms,
        body: response_body_output(
            &execution_id,
            response.body,
            response.size_bytes,
            body_cache,
        ),
        close,
        subprotocol,
        sent_count,
        received_count,
        scoped_changes: effects.scoped_output(),
        environment_changes: std::mem::take(&mut effects.environment_changes),
        script_logs: std::mem::take(&mut effects.logs),
        test_results: std::mem::take(&mut effects.tests),
        script_error,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendWebSocketMessageInput {
    pub execution_id: String,
    pub message: String,
    #[serde(default)]
    pub format: WebSocketMessageFormatDto,
}

fn not_open() -> ExecuteRestRequestError {
    ExecuteRestRequestError::InvalidRequest {
        message: "a conexão WebSocket não está aberta".to_string(),
        cause: None,
    }
}

/// Sends one message on an open connection; `{{variables}}` resolve with
/// the values captured when connecting.
#[tauri::command]
pub async fn send_websocket_message(
    input: SendWebSocketMessageInput,
    sessions: State<'_, WebSocketSessions>,
) -> Result<(), ExecuteRestRequestError> {
    let session = sessions.get(&input.execution_id).ok_or_else(not_open)?;
    let variables = session
        .variables
        .iter()
        .map(|variable| {
            EnvironmentVariable::new(&variable.name, &variable.value, variable.sensitive)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let message = resolve_variables(&input.message, &variables)?;
    let format = WebSocketCall::from(WebSocketCallDto {
        message_format: input.format,
        ..WebSocketCallDto::default()
    })
    .message_format;
    let message = outgoing(message, format).map_err(ExecuteRestRequestError::from)?;
    let (reply, sent) = oneshot::channel();
    session
        .sender
        .send(SessionAction::Send(message, reply))
        .await
        .map_err(|_| not_open())?;
    match sent.await.map_err(|_| not_open())? {
        Ok(()) => Ok(()),
        Err(SendError::NotOpen) => Err(not_open()),
        Err(SendError::InvalidBinary(detail)) => Err(ExecuteRestRequestError::InvalidRequest {
            message: detail,
            cause: None,
        }),
        Err(SendError::Transport(detail)) => Err(ExecuteRestRequestError::Network {
            message: detail,
            cause: None,
        }),
    }
}

/// Closes an open connection gracefully (1000 unless a code is given); the
/// execution then ends with the close. Does nothing when it is not open.
#[tauri::command]
pub async fn close_websocket(
    execution_id: String,
    code: Option<u16>,
    reason: Option<String>,
    sessions: State<'_, WebSocketSessions>,
) -> Result<(), ExecuteRestRequestError> {
    let code = code.unwrap_or(1000);
    // Only 1000 and the application range may be sent (RFC 6455 §7.4).
    if code != 1000 && !(3000..=4999).contains(&code) {
        return Err(ExecuteRestRequestError::InvalidRequest {
            message: format!("código de fechamento inválido: {code}"),
            cause: None,
        });
    }
    if let Some(session) = sessions.get(&execution_id) {
        let _ = session
            .sender
            .send(SessionAction::Close {
                code,
                reason: reason.unwrap_or_default(),
            })
            .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{ResponseMetadata, WebSocketClosedBy};
    use alcy_websocket::CloseEvent;

    fn message(direction: Direction, format: MessageFormat, data: &str) -> TranscriptMessage {
        TranscriptMessage {
            direction,
            format,
            data: data.to_string(),
            size_bytes: data.len(),
            elapsed_ms: 1,
        }
    }

    fn handshake() -> Handshake {
        Handshake {
            status: 101,
            headers: vec![ResponseHeader {
                name: "upgrade".to_string(),
                value: "websocket".to_string(),
            }],
            metadata: ResponseMetadata::default(),
            subprotocol: Some("chat".to_string()),
        }
    }

    fn transcript(messages: Vec<TranscriptMessage>, close: CloseEvent) -> Transcript {
        Transcript {
            sent: messages
                .iter()
                .filter(|message| message.direction == Direction::Sent)
                .count() as u32,
            received: messages
                .iter()
                .filter(|message| message.direction == Direction::Received)
                .count() as u32,
            messages,
            close,
        }
    }

    #[test]
    fn the_response_body_holds_only_the_received_messages() {
        let close = CloseEvent {
            code: Some(1000),
            reason: String::new(),
            closed_by: WebSocketClosedBy::Client,
            elapsed_ms: 20,
        };
        let one = transcript(
            vec![
                message(Direction::Sent, MessageFormat::Text, "hi"),
                message(Direction::Received, MessageFormat::Text, r#"{"ok":true}"#),
            ],
            close.clone(),
        );
        let response = response_of(&handshake(), &one);
        assert_eq!(response.status_code, 101);
        assert_eq!(response.body, r#"{"ok":true}"#);
        assert_eq!(response.duration_ms, 20);
        assert_eq!(response.protocol_failure(), None);
        let outcome = response.websocket.as_deref().unwrap();
        assert_eq!((outcome.sent, outcome.received), (1, 1));
        assert_eq!(outcome.subprotocol.as_deref(), Some("chat"));

        let many = transcript(
            vec![
                message(Direction::Received, MessageFormat::Text, r#"{"n":1}"#),
                message(Direction::Received, MessageFormat::Text, "plain"),
                message(Direction::Received, MessageFormat::Binary, "AAE="),
            ],
            close,
        );
        let response = response_of(&handshake(), &many);
        let parsed: serde_json::Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(parsed, serde_json::json!([{ "n": 1 }, "plain", "AAE="]));
        assert_eq!(response.size_bytes, 7 + 5 + 4);
    }

    #[test]
    fn the_close_is_kept_as_pseudo_headers() {
        let response = response_of(
            &handshake(),
            &transcript(
                vec![],
                CloseEvent {
                    code: Some(4001),
                    reason: "bye".to_string(),
                    closed_by: WebSocketClosedBy::Server,
                    elapsed_ms: 5,
                },
            ),
        );
        let header = |name: &str| {
            response
                .headers
                .iter()
                .find(|header| header.name == name)
                .map(|header| header.value.as_str())
        };
        assert_eq!(header(CLOSE_CODE_HEADER), Some("4001"));
        assert_eq!(header(CLOSE_REASON_HEADER), Some("bye"));
        assert_eq!(header(CLOSED_BY_HEADER), Some("server"));
        assert_eq!(
            response.protocol_failure().as_deref(),
            Some("WebSocket closed with 4001: bye")
        );
    }

    #[test]
    fn binary_composer_messages_must_be_base64() {
        assert_eq!(
            outgoing("aGk=".to_string(), WebSocketMessageFormat::Binary).unwrap(),
            Outgoing::Binary(b"hi".to_vec())
        );
        assert!(matches!(
            outgoing("%%".to_string(), WebSocketMessageFormat::Binary),
            Err(ExecutionError::InvalidRequest(_))
        ));
        assert_eq!(
            outgoing("{}".to_string(), WebSocketMessageFormat::Json).unwrap(),
            Outgoing::Text("{}".to_string())
        );
    }

    #[tokio::test]
    async fn a_saved_request_to_a_closed_port_fails_as_a_network_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let request = Request::new(
            alcy_domain::Endpoint::new(format!("ws://{address}")).unwrap(),
            RequestDocument::new(ProtocolId::WebSocket, "hello"),
            "",
            vec![],
            alcy_domain::Authentication::None,
        );

        let error = execute_saved_request(&request, &ReqwestRestExecutor::new(), None)
            .await
            .unwrap_err();

        assert!(matches!(error, ExecutionError::Network(_)), "{error:?}");
    }
}
