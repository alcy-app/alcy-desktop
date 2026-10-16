use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use alcy_app::{TemplateError, execute_request, resolve_variables};
use alcy_domain::{
    Authentication, BodyEncoding, ConnectionInfo, Cookie, Endpoint, EndpointError,
    EnvironmentVariable, EnvironmentVariableError, ExecutionError, HeaderEntry, HeaderError,
    HistoryEntry, HistoryFailureKind, HistoryOutcome, ProtocolId, Request, RequestDocument,
    Response, ResponseHeader, effective_authentication,
};
use alcy_graphql::{
    GraphqlError, GraphqlErrorLocation, ReqwestGraphqlExecutor, interpret_graphql_errors,
};
use alcy_storage::{CollectionsStore, HistoryStore};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::commands::cookie_jar::CookieJar;
use crate::commands::environments::{EnvironmentVariableDto, redact_sensitive_variables};
use crate::commands::execution_registry::ExecutionRegistry;
use crate::commands::failure_cause::{InvalidRequestCause, NetworkCauseOutput};
use crate::commands::general_settings::{HistoryPreferences, HistoryPreferencesState};
use crate::commands::response_body_cache::{ResponseBodyCache, char_boundary_window};
use crate::commands::scripting::{
    EnvironmentChangeOutput, ExecutionFailure, ScopedChangeOutput, ScriptEffects,
    ScriptErrorOutput, ScriptTestOutput, ScriptedRequest, run_post_response, run_pre_request,
};
use crate::commands::session_cookies::SessionCookies;
use crate::commands::variable_scopes::{VariableScopeDto, scopes_from_dto, with_scoped_variables};

/// Read-only history retention has no pruning effect; pruning uses HistoryPreferencesState.
pub(crate) const DEFAULT_HISTORY_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Bodies above this UTF-8 threshold stay in ResponseBodyCache and cross IPC in windows. Align frontend raw threshold, reduced from 5 MiB to 1 MiB after editor stalls and repeated tab remounting (ADR 0005).
pub(crate) const LARGE_RESPONSE_BODY_THRESHOLD_BYTES: usize = 1024 * 1024;

/// Tamanho do preview inicial devolvido junto com `ResponseBodyOutput::Windowed`.
const RESPONSE_BODY_PREVIEW_BYTES: usize = 200 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteGraphqlRequestInput {
    pub execution_id: String,
    pub root_path: String,
    pub endpoint_url: String,
    pub query: String,
    pub variables: String,
    pub headers: Vec<HeaderInput>,
    pub authentication: AuthenticationInput,
    /// Saved request ID resolves inherited authentication.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Sending tab ID links history even before saving the request (ADR 0036).
    #[serde(default)]
    pub tab_id: Option<String>,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    /// Collection/folder scopes from root to direct parent; empty for unsaved tabs (ADR 0031).
    #[serde(default)]
    pub variable_scopes: Vec<VariableScopeDto>,
    #[serde(default)]
    pub pre_request_script: String,
    #[serde(default)]
    pub post_response_script: String,
    /// One-shot resend without response size limit; absence preserves it.
    #[serde(default)]
    pub ignore_response_size_limit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeaderInput {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthenticationInput {
    None,
    /// Resolve authentication from the closest defined ancestor before execution.
    Inherit,
    CustomHeader {
        name: String,
        value: String,
    },
    Bearer {
        token: String,
    },
    Basic {
        username: String,
        password: String,
    },
    Digest {
        username: String,
        password: String,
    },
    OAuth2ClientCredentials {
        client_id: String,
        client_secret: String,
        token_url: String,
        scope: String,
    },
}

impl From<Authentication> for AuthenticationInput {
    fn from(authentication: Authentication) -> Self {
        match authentication {
            Authentication::None => Self::None,
            Authentication::Inherit => Self::Inherit,
            Authentication::CustomHeader { name, value } => Self::CustomHeader { name, value },
            Authentication::Bearer { token } => Self::Bearer { token },
            Authentication::Basic { username, password } => Self::Basic { username, password },
            Authentication::Digest { username, password } => Self::Digest { username, password },
            Authentication::OAuth2ClientCredentials {
                client_id,
                client_secret,
                token_url,
                scope,
            } => Self::OAuth2ClientCredentials {
                client_id,
                client_secret,
                token_url,
                scope,
            },
        }
    }
}

/// Resolve inherited authentication from saved request/closest configured ancestor. Missing request/workspace yields None; other modes pass through. Read/parse large collections in spawn_blocking.
pub(crate) async fn resolve_inherited_authentication(
    authentication: AuthenticationInput,
    request_id: Option<&str>,
    root_path: Option<&str>,
) -> AuthenticationInput {
    if !matches!(authentication, AuthenticationInput::Inherit) {
        return authentication;
    }
    let (Some(request_id), Some(root_path)) = (request_id, root_path) else {
        return AuthenticationInput::None;
    };
    let request_id = request_id.to_string();
    let root_path = PathBuf::from(root_path);
    tauri::async_runtime::spawn_blocking(move || match CollectionsStore::new(root_path).load() {
        Ok(collections) => effective_authentication(&collections, &request_id).into(),
        Err(_) => AuthenticationInput::None,
    })
    .await
    .unwrap_or(AuthenticationInput::None)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteGraphqlRequestOutput {
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub body: ResponseBodyOutput,
    pub body_encoding: ResponseBodyEncodingOutput,
    pub headers: Vec<ResponseHeaderOutput>,
    /// Actual sent headers including authentication-injected values (AuthenticatedExchange).
    pub request_headers: Vec<ResponseHeaderOutput>,
    pub cookies: Vec<CookieOutput>,
    pub connection: ConnectionInfoOutput,
    /// Final redirected URL only, not the full hop chain (ADR 0010).
    pub final_url: Option<String>,
    /// Time to response headers (TTFB, ADR 0010).
    pub waiting_ms: u64,
    pub graphql_errors: Vec<GraphqlErrorOutput>,
    /// Final environment values written by scripts.
    pub environment_changes: Vec<EnvironmentChangeOutput>,
    /// Collection/folder script writes (ADR 0031).
    pub scoped_changes: Vec<ScopedChangeOutput>,
    pub script_logs: Vec<String>,
    /// Post-response script error; retain the received response.
    pub script_error: Option<ScriptErrorOutput>,
    /// Testes registrados com `al.test` pelos scripts (spec 0072).
    pub test_results: Vec<ScriptTestOutput>,
}

/// Frontend body encoding: text or base64 binary, matching domain BodyEncoding (ADR 0009).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResponseBodyEncodingOutput {
    Text,
    Base64,
}

impl From<BodyEncoding> for ResponseBodyEncodingOutput {
    fn from(encoding: BodyEncoding) -> Self {
        match encoding {
            BodyEncoding::Text => Self::Text,
            BodyEncoding::Base64 => Self::Base64,
        }
    }
}

/// Inline body when it comfortably fits IPC, otherwise an initial cached window with later chunks on demand.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResponseBodyOutput {
    Inline {
        body: String,
    },
    // Enum rename_all affects tags; rename_all_fields converts variant fields such as total_bytes/preview_next_offset into frontend camelCase.
    #[serde(rename_all = "camelCase")]
    Windowed {
        handle: String,
        total_bytes: usize,
        preview: String,
        /// Next UTF-8 byte offset; None means complete preview. JS string length counts UTF-16 units and cannot derive it.
        preview_next_offset: Option<usize>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHeaderOutput {
    pub name: String,
    pub value: String,
}

impl From<ResponseHeader> for ResponseHeaderOutput {
    fn from(header: ResponseHeader) -> Self {
        Self {
            name: header.name,
            value: header.value,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CookieOutput {
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

impl From<Cookie> for CookieOutput {
    fn from(cookie: Cookie) -> Self {
        Self {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            max_age_seconds: cookie.max_age_seconds,
            secure: cookie.secure,
            http_only: cookie.http_only,
            same_site: cookie.same_site,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfoOutput {
    pub remote_address: Option<String>,
    pub http_version: String,
    pub tls_certificate_present: bool,
    /// TLS with certificate verification explicitly disabled.
    pub certificate_verification_disabled: bool,
}

impl From<ConnectionInfo> for ConnectionInfoOutput {
    fn from(connection: ConnectionInfo) -> Self {
        Self {
            remote_address: connection.remote_address,
            http_version: connection.http_version,
            tls_certificate_present: connection.tls_certificate_present,
            certificate_verification_disabled: connection.certificate_verification_disabled,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphqlErrorOutput {
    pub message: String,
    pub path: Vec<String>,
    pub locations: Vec<GraphqlErrorLocationOutput>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphqlErrorLocationOutput {
    pub line: u32,
    pub column: u32,
}

impl From<GraphqlError> for GraphqlErrorOutput {
    fn from(error: GraphqlError) -> Self {
        Self {
            message: error.message,
            path: error.path,
            locations: error
                .locations
                .into_iter()
                .map(GraphqlErrorLocationOutput::from)
                .collect(),
        }
    }
}

impl From<GraphqlErrorLocation> for GraphqlErrorLocationOutput {
    fn from(location: GraphqlErrorLocation) -> Self {
        Self {
            line: location.line,
            column: location.column,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecuteGraphqlRequestError {
    InvalidRequest {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cause: Option<InvalidRequestCause>,
    },
    /// Pre-request script failed; nothing was sent.
    Script {
        phase: String,
        message: String,
    },
    Network {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cause: Option<NetworkCauseOutput>,
    },
    Timeout,
    /// Download stopped at response size limit without partial data. UI offers unlimited resend.
    #[serde(rename_all = "camelCase")]
    ResponseTooLarge {
        limit_bytes: u64,
        received_bytes: u64,
    },
    InvalidVariables {
        message: String,
    },
    Cancelled,
}

impl From<ExecutionError> for ExecuteGraphqlRequestError {
    fn from(error: ExecutionError) -> Self {
        match error {
            ExecutionError::Network(failure) => Self::Network {
                cause: failure.cause.map(NetworkCauseOutput::from),
                message: failure.detail,
            },
            ExecutionError::Timeout => Self::Timeout,
            ExecutionError::InvalidVariables(message) => Self::InvalidVariables { message },
            ExecutionError::InvalidRequest(message) => Self::InvalidRequest {
                message,
                cause: None,
            },
            ExecutionError::BodyFileUnreadable { path, detail } => Self::InvalidRequest {
                message: detail,
                cause: Some(InvalidRequestCause::BodyFileUnreadable { path }),
            },
            // Only flow executors emit this; interactive commands handle script phase/message separately.
            ExecutionError::Script(message) => Self::InvalidRequest {
                message,
                cause: None,
            },
            ExecutionError::ResponseTooLarge {
                limit_bytes,
                received_bytes,
            } => Self::ResponseTooLarge {
                limit_bytes,
                received_bytes,
            },
            ExecutionError::Cancelled => Self::Cancelled,
        }
    }
}

impl From<ScriptErrorOutput> for ExecuteGraphqlRequestError {
    fn from(error: ScriptErrorOutput) -> Self {
        Self::Script {
            phase: error.phase,
            message: error.message,
        }
    }
}

impl ExecuteGraphqlRequestError {
    fn header(name: &str, error: HeaderError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::header(name, &error)),
            message: error.to_string(),
        }
    }
}

impl From<EndpointError> for ExecuteGraphqlRequestError {
    fn from(error: EndpointError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

impl From<TemplateError> for ExecuteGraphqlRequestError {
    fn from(error: TemplateError) -> Self {
        Self::InvalidRequest {
            cause: InvalidRequestCause::template(&error),
            message: error.to_string(),
        }
    }
}

impl From<EnvironmentVariableError> for ExecuteGraphqlRequestError {
    fn from(error: EnvironmentVariableError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

/// Interpolate environment templates in endpoint/headers/variables/authentication, never GraphQL query text.
fn resolve(
    template: &str,
    variables: &[EnvironmentVariable],
) -> Result<String, ExecuteGraphqlRequestError> {
    Ok(resolve_variables(template, variables)?)
}

fn build_request(input: ExecuteGraphqlRequestInput) -> Result<Request, ExecuteGraphqlRequestError> {
    let unlimited_response_size = input.ignore_response_size_limit;
    let environment_variables = input
        .environment_variables
        .into_iter()
        .map(|variable| EnvironmentVariable::new(variable.name, variable.value, variable.sensitive))
        .collect::<Result<Vec<_>, _>>()?;

    let endpoint_url = resolve(&input.endpoint_url, &environment_variables)?;
    let endpoint = Endpoint::new(endpoint_url)?;

    let document = RequestDocument::new(ProtocolId::GraphQl, input.query);

    let variables = resolve(&input.variables, &environment_variables)?;

    let headers = input
        .headers
        .into_iter()
        .map(
            |header| -> Result<HeaderEntry, ExecuteGraphqlRequestError> {
                let value = resolve(&header.value, &environment_variables)?;
                HeaderEntry::new(&header.name, value, header.enabled)
                    .map_err(|error| ExecuteGraphqlRequestError::header(&header.name, error))
            },
        )
        .collect::<Result<Vec<_>, _>>()?;

    let authentication = match input.authentication {
        AuthenticationInput::None | AuthenticationInput::Inherit => Authentication::None,
        AuthenticationInput::CustomHeader { name, value } => Authentication::CustomHeader {
            name: resolve(&name, &environment_variables)?,
            value: resolve(&value, &environment_variables)?,
        },
        AuthenticationInput::Bearer { token } => Authentication::Bearer {
            token: resolve(&token, &environment_variables)?,
        },
        AuthenticationInput::Basic { username, password } => Authentication::Basic {
            username: resolve(&username, &environment_variables)?,
            password: resolve(&password, &environment_variables)?,
        },
        AuthenticationInput::Digest { username, password } => Authentication::Digest {
            username: resolve(&username, &environment_variables)?,
            password: resolve(&password, &environment_variables)?,
        },
        AuthenticationInput::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => Authentication::OAuth2ClientCredentials {
            client_id: resolve(&client_id, &environment_variables)?,
            client_secret: resolve(&client_secret, &environment_variables)?,
            token_url: resolve(&token_url, &environment_variables)?,
            scope: resolve(&scope, &environment_variables)?,
        },
    };

    Ok(
        Request::new(endpoint, document, variables, headers, authentication)
            .with_unlimited_response_size(unlimited_response_size),
    )
}

pub(crate) async fn cancellation_signal(receiver: oneshot::Receiver<()>) {
    let _ = receiver.await;
}

/// Execute cancellable GraphQL HTTP requests using the managed executor and pooled TCP/TLS connections. Cancel using the same execution ID.
#[tauri::command]
pub async fn execute_graphql_request(
    input: ExecuteGraphqlRequestInput,
    registry: tauri::State<'_, ExecutionRegistry>,
    executor: tauri::State<'_, ReqwestGraphqlExecutor>,
    body_cache: tauri::State<'_, ResponseBodyCache>,
    session_cookies: tauri::State<'_, SessionCookies>,
    history: tauri::State<'_, HistoryPreferencesState>,
) -> Result<ExecuteGraphqlRequestOutput, ExecutionFailure<ExecuteGraphqlRequestError>> {
    let execution_id = input.execution_id.clone();
    log::info!(
        target: "alcy::request",
        "graphql {execution_id}: enviando POST {}",
        crate::logging::url_for_log(&input.endpoint_url)
    );
    let result = execute_graphql_request_inner(
        input,
        &registry,
        &executor,
        &body_cache,
        &session_cookies.0,
        history.get(),
    )
    .await;
    match &result {
        Ok(output) => log::info!(
            target: "alcy::request",
            "graphql {execution_id}: HTTP {} em {} ms ({} bytes, {} erro(s) GraphQL)",
            output.status_code,
            output.duration_ms,
            output.size_bytes,
            output.graphql_errors.len()
        ),
        Err(failure) => log::warn!(
            target: "alcy::request",
            "graphql {execution_id}: falhou ({})",
            crate::logging::error_kind(failure)
        ),
    }
    result
}

async fn execute_graphql_request_inner(
    input: ExecuteGraphqlRequestInput,
    registry: &ExecutionRegistry,
    executor: &ReqwestGraphqlExecutor,
    body_cache: &ResponseBodyCache,
    cookies: &CookieJar,
    history: HistoryPreferences,
) -> Result<ExecuteGraphqlRequestOutput, ExecutionFailure<ExecuteGraphqlRequestError>> {
    let mut input = input;
    let execution_id = input.execution_id.clone();
    let root_path = input.root_path.clone();
    let history_source = (input.request_id.clone(), input.tab_id.clone());
    let post_script = std::mem::take(&mut input.post_response_script);
    let mut effects = ScriptEffects::default();
    let mut scopes = scopes_from_dto(std::mem::take(&mut input.variable_scopes))
        .map_err(|error| ExecutionFailure::new(error, ScriptEffects::default()))?;

    // GraphQL sends POST; al.request.body contains the query.
    let mut scripted = ScriptedRequest {
        grpc: None,
        url: input.endpoint_url.clone(),
        method: "post".to_string(),
        body: input.query.clone(),
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
    input.query = scripted.body.clone();
    input.headers = scripted.headers.clone();
    // Scripts receive environment/scopes separately; template resolution overlays them (ADR 0031).
    let environment = input.environment_variables.clone();
    input.environment_variables = with_scoped_variables(&input.environment_variables, &scopes);
    input.authentication = resolve_inherited_authentication(
        input.authentication,
        input.request_id.as_deref(),
        Some(&root_path),
    )
    .await;
    let redacted_input =
        redact_sensitive_variables(&input.environment_variables).map(|environment_variables| {
            ExecuteGraphqlRequestInput {
                environment_variables,
                ..input.clone()
            }
        });
    let request = match build_request(input) {
        Ok(request) => request,
        Err(error) => return Err(ExecutionFailure::new(error, effects)),
    };
    let redacted_request = redacted_input.map(|input| build_request(input).ok());
    let history_request = history_request(&request, redacted_request.as_ref());

    let (sender, receiver) = oneshot::channel();
    registry.register(execution_id.clone(), sender);

    // Only execution copies receive jar cookies; history excludes their values.
    let mut executable = request.clone();
    cookies.apply_to(&mut executable);
    let outcome = execute_request(executor, &executable, cancellation_signal(receiver)).await;

    registry.remove(&execution_id);

    if let (Some(history_outcome), Some(history_request)) =
        (history_outcome_from(&outcome), history_request)
        && !history.retention.is_disabled()
    {
        // Do not await history writes. Explicitly drop JoinHandle because let _ on a Future triggers forgotten-await lint.
        drop(record_history(
            &root_path,
            execution_id.clone(),
            history_request,
            history_outcome,
            history_source,
            history,
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

    let graphql_errors = interpret_graphql_errors(&response.body)
        .into_iter()
        .map(GraphqlErrorOutput::from)
        .collect();
    let headers = response
        .headers
        .into_iter()
        .map(ResponseHeaderOutput::from)
        .collect();
    let request_headers = response
        .request_headers
        .into_iter()
        .map(ResponseHeaderOutput::from)
        .collect();
    let cookies = response
        .cookies
        .into_iter()
        .map(CookieOutput::from)
        .collect();
    let connection = ConnectionInfoOutput::from(response.connection);
    let final_url = response.final_url;
    let waiting_ms = response.waiting_ms;
    let body_encoding = ResponseBodyEncodingOutput::from(response.encoding);

    let body = response_body_output(
        &execution_id,
        response.body,
        response.size_bytes,
        body_cache,
    );

    Ok(ExecuteGraphqlRequestOutput {
        status_code: response.status_code,
        duration_ms: response.duration_ms,
        size_bytes: response.size_bytes,
        body,
        body_encoding,
        headers,
        request_headers,
        cookies,
        connection,
        final_url,
        waiting_ms,
        graphql_errors,
        scoped_changes: effects.scoped_output(),
        environment_changes: effects.environment_changes,
        script_logs: effects.logs,
        script_error,
        test_results: effects.tests,
    })
}

/// Window by actual body string bytes crossing IPC, not decoded size_bytes. Move large bodies into cache and send only preview. History uses the same helper with arbitrary cache handles.
pub(crate) fn response_body_output(
    execution_id: &str,
    body: String,
    size_bytes: usize,
    body_cache: &ResponseBodyCache,
) -> ResponseBodyOutput {
    if body.len() <= LARGE_RESPONSE_BODY_THRESHOLD_BYTES {
        return ResponseBodyOutput::Inline { body };
    }

    let (preview, preview_next_offset) =
        char_boundary_window(&body, 0, RESPONSE_BODY_PREVIEW_BYTES);
    let preview = preview.to_string();
    body_cache.insert(execution_id.to_string(), Arc::from(body));

    ResponseBodyOutput::Windowed {
        handle: execution_id.to_string(),
        total_bytes: size_bytes,
        preview,
        preview_next_offset,
    }
}

/// Record successful responses and actual network/timeouts. Cancellation is deliberate; invalid variables never form a valid request.
pub(crate) fn history_outcome_from(
    outcome: &Result<Response, ExecutionError>,
) -> Option<HistoryOutcome> {
    match outcome {
        Ok(response) => Some(HistoryOutcome::Success(response.clone())),
        Err(ExecutionError::Network(failure)) => Some(HistoryOutcome::Failed {
            kind: HistoryFailureKind::Network,
            message: failure.detail.clone(),
        }),
        Err(ExecutionError::Timeout) => Some(HistoryOutcome::Failed {
            kind: HistoryFailureKind::Timeout,
            message: ExecutionError::Timeout.to_string(),
        }),
        Err(ExecutionError::InvalidVariables(_))
        | Err(ExecutionError::InvalidRequest(_))
        | Err(ExecutionError::BodyFileUnreadable { .. })
        | Err(ExecutionError::Script(_))
        // Size-limited downloads have no retained response; offer unlimited resend.
        | Err(ExecutionError::ResponseTooLarge { .. })
        | Err(ExecutionError::Cancelled) => None,
    }
}

/// History retains sensitive values as placeholders. Omit entries when redacted requests cannot be built; otherwise retain the executed request when no secrets exist.
pub(crate) fn history_request<'a>(
    executed: &'a Request,
    redacted: Option<&'a Option<Request>>,
) -> Option<&'a Request> {
    match redacted {
        None => Some(executed),
        Some(Some(redacted)) => Some(redacted),
        Some(None) => {
            log::warn!(
                "execução não gravada no histórico: a versão sem valores sensíveis não pôde ser montada"
            );
            None
        }
    }
}

/// Record best effort in spawn_blocking without delaying response; log persistence failures. Return handles for tests. Source IDs link send history; preferences control writes and retained bodies.
pub(crate) fn record_history(
    root_path: &str,
    id: String,
    request: &Request,
    outcome: HistoryOutcome,
    source: (Option<String>, Option<String>),
    history: HistoryPreferences,
) -> tauri::async_runtime::JoinHandle<()> {
    let store = HistoryStore::new(PathBuf::from(root_path), history.retention.duration());
    let (request_id, tab_id) = source;
    let mut entry = HistoryEntry::new(id, request.clone(), outcome, SystemTime::now())
        .with_source(request_id, tab_id);
    if !history.save_responses {
        entry = entry.without_response_details();
    }

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = store.record(entry) {
            log::warn!("falha ao gravar histórico de requisição: {error}");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_storage::{HistorySummary, HistorySummaryOutcome};
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-execute-cmd-test-{nanos}-{count}"))
    }

    fn valid_input() -> ExecuteGraphqlRequestInput {
        ExecuteGraphqlRequestInput {
            request_id: None,
            tab_id: None,
            execution_id: "exec-1".to_string(),
            root_path: temp_root().to_string_lossy().to_string(),
            endpoint_url: "https://api.example.com/graphql".to_string(),
            query: "query { ping }".to_string(),
            variables: "{}".to_string(),
            headers: vec![HeaderInput {
                name: "Accept".to_string(),
                value: "application/json".to_string(),
                enabled: true,
            }],
            authentication: AuthenticationInput::None,
            environment_variables: vec![],
            variable_scopes: vec![],
            pre_request_script: String::new(),
            post_response_script: String::new(),
            ignore_response_size_limit: false,
        }
    }

    #[test]
    fn builds_a_domain_request_from_a_valid_input() {
        let request = build_request(valid_input()).unwrap();

        assert_eq!(request.endpoint.url(), "https://api.example.com/graphql");
        assert_eq!(request.document.body, "query { ping }");
        assert_eq!(request.headers.len(), 1);
        assert_eq!(request.authentication, Authentication::None);
    }

    #[test]
    fn rejects_an_empty_endpoint_without_touching_the_network() {
        let mut input = valid_input();
        input.endpoint_url = "".to_string();

        let error = build_request(input).unwrap_err();

        assert_eq!(
            error,
            ExecuteGraphqlRequestError::InvalidRequest {
                message: EndpointError::Empty.to_string(),
                cause: Some(InvalidRequestCause::EmptyEndpoint),
            }
        );
    }

    #[test]
    fn rejects_a_header_with_control_characters() {
        let mut input = valid_input();
        input.headers = vec![HeaderInput {
            name: "X-Bad\r\nHeader".to_string(),
            value: "1".to_string(),
            enabled: true,
        }];

        let error = build_request(input).unwrap_err();

        assert!(matches!(
            error,
            ExecuteGraphqlRequestError::InvalidRequest {
                cause: Some(InvalidRequestCause::InvalidHeaderName { ref name }),
                ..
            } if name == "X-Bad\r\nHeader"
        ));
    }

    #[test]
    fn interpolates_environment_variables_before_building_the_request() {
        let mut input = valid_input();
        input.endpoint_url = "{{baseUrl}}/graphql".to_string();
        input.headers = vec![HeaderInput {
            name: "Authorization".to_string(),
            value: "Bearer {{token}}".to_string(),
            enabled: true,
        }];
        input.environment_variables = vec![
            EnvironmentVariableDto {
                name: "baseUrl".to_string(),
                value: "https://api.example.com".to_string(),
                sensitive: false,
            },
            EnvironmentVariableDto {
                name: "token".to_string(),
                value: "secret".to_string(),
                sensitive: true,
            },
        ];

        let request = build_request(input).unwrap();

        assert_eq!(request.endpoint.url(), "https://api.example.com/graphql");
        assert_eq!(request.headers[0].value(), "Bearer secret");
    }

    #[test]
    fn rejects_a_request_referencing_an_undefined_variable() {
        let mut input = valid_input();
        input.endpoint_url = "{{baseUrl}}/graphql".to_string();

        let error = build_request(input).unwrap_err();

        assert_eq!(
            error,
            ExecuteGraphqlRequestError::InvalidRequest {
                message: TemplateError::MissingVariable("baseUrl".to_string()).to_string(),
                cause: Some(InvalidRequestCause::MissingVariable {
                    name: "baseUrl".to_string(),
                }),
            }
        );
    }

    #[tokio::test]
    async fn maps_a_successful_execution_to_the_output_dto() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"data\":{}}"))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.status_code, 200);
        assert_eq!(
            output.body,
            ResponseBodyOutput::Inline {
                body: "{\"data\":{}}".to_string()
            }
        );
        assert_eq!(output.size_bytes, "{\"data\":{}}".len());
        assert_eq!(output.body_encoding, ResponseBodyEncodingOutput::Text);
        assert_eq!(output.graphql_errors, vec![]);

        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn maps_response_headers_to_the_output_dto() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("{}")
                    .insert_header("X-Request-Id", "abc-123"),
            )
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert!(
            output
                .headers
                .iter()
                .any(|header| header.name.eq_ignore_ascii_case("x-request-id")
                    && header.value == "abc-123")
        );

        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn maps_transport_metadata_to_the_output_dto() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("{}")
                    .insert_header("Set-Cookie", "session=abc; Path=/"),
            )
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.authentication = AuthenticationInput::Bearer {
            token: "secret-token".to_string(),
        };
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert!(output.request_headers.contains(&ResponseHeaderOutput {
            name: "authorization".to_string(),
            value: "Bearer secret-token".to_string(),
        }));
        assert_eq!(output.cookies.len(), 1);
        assert_eq!(output.cookies[0].name, "session");
        assert!(
            output
                .connection
                .remote_address
                .as_deref()
                .is_some_and(|address| address.starts_with("127.0.0.1:"))
        );
        assert_eq!(output.final_url, None);

        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn maps_graphql_errors_from_a_successful_response_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "{\"data\":null,\"errors\":[{\"message\":\"Not authorized\",\"path\":[\"currentCustomer\"]}]}",
            ))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.status_code, 200);
        assert_eq!(
            output.graphql_errors,
            vec![GraphqlErrorOutput {
                message: "Not authorized".to_string(),
                path: vec!["currentCustomer".to_string()],
                locations: vec![],
            }]
        );

        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn maps_invalid_variables_to_the_output_error() {
        let mut input = valid_input();
        input.variables = "not json".to_string();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let error = execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap_err()
        .error;

        assert!(matches!(
            error,
            ExecuteGraphqlRequestError::InvalidVariables { .. }
        ));
    }

    #[tokio::test]
    async fn removes_the_execution_from_the_registry_when_it_finishes() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.execution_id = "exec-cleanup".to_string();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert!(!registry.is_registered("exec-cleanup"));

        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn cancelling_before_the_response_arrives_yields_a_cancelled_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.execution_id = "exec-cancel".to_string();

        let registry = Arc::new(ExecutionRegistry::default());
        let registry_for_task = registry.clone();
        let executor = Arc::new(ReqwestGraphqlExecutor::new());
        let executor_for_task = executor.clone();
        let body_cache = Arc::new(ResponseBodyCache::default());
        let body_cache_for_task = body_cache.clone();

        let handle = tokio::spawn(async move {
            execute_graphql_request_inner(
                input,
                &registry_for_task,
                &executor_for_task,
                &body_cache_for_task,
                &CookieJar::default(),
                HistoryPreferences::default(),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        registry.cancel("exec-cancel");

        let error = handle.await.unwrap().unwrap_err().error;

        assert_eq!(error, ExecuteGraphqlRequestError::Cancelled);
    }

    fn history_entries(root_path: &str) -> Vec<HistorySummary> {
        HistoryStore::new(PathBuf::from(root_path), Duration::from_secs(3600))
            .load_summaries()
            .unwrap()
    }

    /// History writes are asynchronous; tests retry until persistence rather than assume command return means the file exists.
    async fn wait_for_history_entries(root_path: &str, expected_len: usize) -> Vec<HistorySummary> {
        for _ in 0..50 {
            let entries = history_entries(root_path);
            if entries.len() >= expected_len {
                return entries;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        history_entries(root_path)
    }

    #[tokio::test]
    async fn records_a_successful_execution_in_the_workspace_history() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"data\":{}}"))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        let entries = wait_for_history_entries(&root_path, 1).await;

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "exec-1");
        assert!(matches!(
            entries[0].outcome,
            HistorySummaryOutcome::Success { .. }
        ));

        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn a_failed_request_still_returns_the_pre_script_effects() {
        let mut input = valid_input();
        input.endpoint_url = "http://127.0.0.1:1/graphql".to_string();
        input.pre_request_script =
            "al.environment.set('token', 'abc'); al.console.log('pre');".to_string();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let failure = execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            failure.error,
            ExecuteGraphqlRequestError::Network { .. }
        ));
        assert_eq!(
            failure.environment_changes,
            vec![EnvironmentChangeOutput {
                name: "token".to_string(),
                value: Some("abc".to_string()),
            }]
        );
        assert_eq!(failure.script_logs, vec!["pre"]);

        wait_for_history_entries(&root_path, 1).await;
        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn records_a_network_failure_in_the_workspace_history() {
        let mut input = valid_input();
        input.endpoint_url = "http://127.0.0.1:1/graphql".to_string();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestGraphqlExecutor::new();
        let body_cache = ResponseBodyCache::default();

        execute_graphql_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap_err();

        let entries = wait_for_history_entries(&root_path, 1).await;

        assert_eq!(entries.len(), 1);
        assert!(matches!(
            entries[0].outcome,
            HistorySummaryOutcome::Failed {
                kind: HistoryFailureKind::Network,
            }
        ));

        fs::remove_dir_all(&root_path).ok();
    }

    #[tokio::test]
    async fn does_not_record_a_cancelled_execution() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.execution_id = "exec-not-recorded".to_string();
        let root_path = input.root_path.clone();

        let registry = Arc::new(ExecutionRegistry::default());
        let registry_for_task = registry.clone();
        let executor = Arc::new(ReqwestGraphqlExecutor::new());
        let executor_for_task = executor.clone();
        let body_cache = Arc::new(ResponseBodyCache::default());
        let body_cache_for_task = body_cache.clone();

        let handle = tokio::spawn(async move {
            execute_graphql_request_inner(
                input,
                &registry_for_task,
                &executor_for_task,
                &body_cache_for_task,
                &CookieJar::default(),
                HistoryPreferences::default(),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        registry.cancel("exec-not-recorded");
        handle.await.unwrap().unwrap_err();

        assert!(history_entries(&root_path).is_empty());

        fs::remove_dir_all(&root_path).ok();
    }

    #[test]
    fn response_body_output_keeps_a_small_body_inline_without_touching_the_cache() {
        let cache = ResponseBodyCache::default();

        let body = response_body_output("exec-1", "{\"data\":{}}".to_string(), 12, &cache);

        assert_eq!(
            body,
            ResponseBodyOutput::Inline {
                body: "{\"data\":{}}".to_string()
            }
        );
        assert_eq!(cache.get("exec-1"), None);
    }

    #[test]
    fn response_body_output_windows_a_large_body_and_caches_it_under_the_execution_id() {
        let cache = ResponseBodyCache::default();
        let large_body = "x".repeat(LARGE_RESPONSE_BODY_THRESHOLD_BYTES + 1);

        let body = response_body_output("exec-large", large_body.clone(), large_body.len(), &cache);

        match body {
            ResponseBodyOutput::Windowed {
                handle,
                total_bytes,
                preview,
                preview_next_offset,
            } => {
                assert_eq!(handle, "exec-large");
                assert_eq!(total_bytes, large_body.len());
                assert_eq!(preview.len(), RESPONSE_BODY_PREVIEW_BYTES);
                assert_eq!(preview_next_offset, Some(RESPONSE_BODY_PREVIEW_BYTES));
            }
            ResponseBodyOutput::Inline { .. } => panic!("expected a windowed body"),
        }
        assert_eq!(
            cache.get("exec-large").as_deref(),
            Some(large_body.as_str())
        );
    }

    /// Serialize JSON in tests: Rust equality cannot detect broken serde field casing in IPC.
    #[test]
    fn windowed_body_serializes_its_fields_as_camel_case() {
        let cache = ResponseBodyCache::default();
        let large_body = "x".repeat(LARGE_RESPONSE_BODY_THRESHOLD_BYTES + 1);

        let body = response_body_output(
            "exec-large",
            large_body,
            LARGE_RESPONSE_BODY_THRESHOLD_BYTES + 1,
            &cache,
        );
        let json = serde_json::to_value(&body).unwrap();

        assert!(
            json.get("totalBytes").is_some(),
            "esperava `totalBytes`, JSON: {json}"
        );
        assert!(
            json.get("previewNextOffset").is_some(),
            "esperava `previewNextOffset`, JSON: {json}"
        );
        assert!(json.get("total_bytes").is_none());
        assert!(json.get("preview_next_offset").is_none());
    }

    /// Base64 body length exceeds decoded size_bytes. Window by encoded bytes crossing IPC/cache (ADR 0009).
    #[test]
    fn response_body_output_windows_by_the_bodys_length_even_when_size_bytes_is_smaller() {
        let cache = ResponseBodyCache::default();
        let large_base64_body = "x".repeat(LARGE_RESPONSE_BODY_THRESHOLD_BYTES + 1);
        let decoded_size_bytes = large_base64_body.len() * 3 / 4; // Approximate the decoded base64 size.

        let body =
            response_body_output("exec-image", large_base64_body, decoded_size_bytes, &cache);

        match body {
            ResponseBodyOutput::Windowed { total_bytes, .. } => {
                assert_eq!(total_bytes, decoded_size_bytes);
            }
            ResponseBodyOutput::Inline { .. } => panic!("expected a windowed body"),
        }
    }

    #[test]
    fn response_body_output_uses_exactly_the_threshold_as_the_inline_boundary() {
        let cache = ResponseBodyCache::default();
        let body_at_threshold = "x".repeat(LARGE_RESPONSE_BODY_THRESHOLD_BYTES);

        let output = response_body_output(
            "exec-boundary",
            body_at_threshold.clone(),
            body_at_threshold.len(),
            &cache,
        );

        assert_eq!(
            output,
            ResponseBodyOutput::Inline {
                body: body_at_threshold
            }
        );
        assert_eq!(cache.get("exec-boundary"), None);
    }
}
