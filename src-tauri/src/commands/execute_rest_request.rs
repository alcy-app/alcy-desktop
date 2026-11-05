use std::path::Path;

use alcy_app::{
    StatusClass, TemplateError, apply_route_parameters, execute_request, resolve_variables,
};
use alcy_domain::{
    Authentication, BodyPayload, Endpoint, EndpointError, EnvironmentVariable,
    EnvironmentVariableError, ExecutionError, FormDataField, FormDataFieldValue, HeaderEntry,
    HeaderError, HttpMethod, ProtocolId, RawBodyLanguage, Request, RequestDocument, RouteParameter,
    UrlEncodedField, strip_json_comments,
};
use alcy_rest::ReqwestRestExecutor;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::commands::cookie_jar::CookieJar;
use crate::commands::environments::{EnvironmentVariableDto, redact_sensitive_variables};
use crate::commands::execute_graphql_request::{
    AuthenticationInput, ConnectionInfoOutput, CookieOutput, HeaderInput,
    ResponseBodyEncodingOutput, ResponseBodyOutput, ResponseHeaderOutput, cancellation_signal,
    history_outcome_from, history_request, record_history, resolve_inherited_authentication,
    response_body_output,
};
use crate::commands::execution_registry::ExecutionRegistry;
use crate::commands::failure_cause::{InvalidRequestCause, NetworkCauseOutput};
use crate::commands::general_settings::{HistoryPreferences, HistoryPreferencesState};
use crate::commands::response_body_cache::ResponseBodyCache;
use crate::commands::scripting::{
    EnvironmentChangeOutput, ExecutionFailure, ScopedChangeOutput, ScriptEffects,
    ScriptErrorOutput, ScriptTestOutput, ScriptedRequest, run_post_response, run_pre_request,
};
use crate::commands::session_cookies::SessionCookies;
use crate::commands::usage_events::{request_answered, request_failed};
use crate::commands::variable_scopes::{VariableScopeDto, scopes_from_dto, with_scoped_variables};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HttpMethodInput {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
}

impl HttpMethodInput {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::Post => "post",
            Self::Put => "put",
            Self::Patch => "patch",
            Self::Delete => "delete",
            Self::Head => "head",
            Self::Options => "options",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "get" => Some(Self::Get),
            "post" => Some(Self::Post),
            "put" => Some(Self::Put),
            "patch" => Some(Self::Patch),
            "delete" => Some(Self::Delete),
            "head" => Some(Self::Head),
            "options" => Some(Self::Options),
            _ => None,
        }
    }
}

impl From<HttpMethodInput> for HttpMethod {
    fn from(method: HttpMethodInput) -> Self {
        match method {
            HttpMethodInput::Get => HttpMethod::Get,
            HttpMethodInput::Post => HttpMethod::Post,
            HttpMethodInput::Put => HttpMethod::Put,
            HttpMethodInput::Patch => HttpMethod::Patch,
            HttpMethodInput::Delete => HttpMethod::Delete,
            HttpMethodInput::Head => HttpMethod::Head,
            HttpMethodInput::Options => HttpMethod::Options,
        }
    }
}

impl From<HttpMethod> for HttpMethodInput {
    fn from(method: HttpMethod) -> Self {
        match method {
            HttpMethod::Get => HttpMethodInput::Get,
            HttpMethod::Post => HttpMethodInput::Post,
            HttpMethod::Put => HttpMethodInput::Put,
            HttpMethod::Patch => HttpMethodInput::Patch,
            HttpMethod::Delete => HttpMethodInput::Delete,
            HttpMethod::Head => HttpMethodInput::Head,
            HttpMethod::Options => HttpMethodInput::Options,
        }
    }
}

/// Raw language is retained for UI round trips and Content-Type synchronization; execution only reads it to remove JSON comments (spec 0146).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RawBodyLanguageInput {
    Text,
    Javascript,
    Json,
    Html,
    Xml,
}

impl From<RawBodyLanguageInput> for RawBodyLanguage {
    fn from(language: RawBodyLanguageInput) -> Self {
        match language {
            RawBodyLanguageInput::Text => RawBodyLanguage::Text,
            RawBodyLanguageInput::Javascript => RawBodyLanguage::JavaScript,
            RawBodyLanguageInput::Json => RawBodyLanguage::Json,
            RawBodyLanguageInput::Html => RawBodyLanguage::Html,
            RawBodyLanguageInput::Xml => RawBodyLanguage::Xml,
        }
    }
}

impl From<RawBodyLanguage> for RawBodyLanguageInput {
    fn from(language: RawBodyLanguage) -> Self {
        match language {
            RawBodyLanguage::Text => RawBodyLanguageInput::Text,
            RawBodyLanguage::JavaScript => RawBodyLanguageInput::Javascript,
            RawBodyLanguage::Json => RawBodyLanguageInput::Json,
            RawBodyLanguage::Html => RawBodyLanguageInput::Html,
            RawBodyLanguage::Xml => RawBodyLanguageInput::Xml,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UrlEncodedFieldInput {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

/// Flat form-data DTO uses kind for text/file, matching frontend RestBodyInput.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
// rename_all renames tags; rename_all_fields converts variant fields such as file_path into camelCase.
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FormDataFieldInput {
    Text {
        name: String,
        enabled: bool,
        value: String,
    },
    File {
        name: String,
        enabled: bool,
        file_path: String,
    },
}

/// REST body matches the UI selector: none/raw/urlencoded yield text; form-data/binary keep structured payloads for asynchronous encoding.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BodyInput {
    None,
    Raw {
        content: String,
        raw_language: RawBodyLanguageInput,
    },
    #[serde(rename = "urlencoded")]
    UrlEncoded {
        fields: Vec<UrlEncodedFieldInput>,
    },
    FormData {
        fields: Vec<FormDataFieldInput>,
    },
    Binary {
        file_path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteParameterInput {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRestRequestInput {
    pub execution_id: String,
    pub root_path: String,
    pub endpoint_url: String,
    #[serde(default)]
    pub route_params: Vec<RouteParameterInput>,
    pub method: HttpMethodInput,
    pub body: BodyInput,
    pub headers: Vec<HeaderInput>,
    pub authentication: AuthenticationInput,
    /// Saved request ID resolves inherited authentication.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Sending tab ID links history before request saving (ADR 0036).
    #[serde(default)]
    pub tab_id: Option<String>,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    /// Scopes run from collection root to direct parent; empty for unsaved tabs (ADR 0031).
    #[serde(default)]
    pub variable_scopes: Vec<VariableScopeDto>,
    #[serde(default)]
    pub pre_request_script: String,
    #[serde(default)]
    pub post_response_script: String,
    /// One-shot unlimited resend; absence preserves response size limits.
    #[serde(default)]
    pub ignore_response_size_limit: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRestRequestOutput {
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub body: ResponseBodyOutput,
    pub body_encoding: ResponseBodyEncodingOutput,
    pub headers: Vec<ResponseHeaderOutput>,
    pub request_headers: Vec<ResponseHeaderOutput>,
    pub cookies: Vec<CookieOutput>,
    pub connection: ConnectionInfoOutput,
    pub final_url: Option<String>,
    pub waiting_ms: u64,
    /// Final environment values written by scripts.
    pub environment_changes: Vec<EnvironmentChangeOutput>,
    /// Collection/folder script writes (ADR 0031).
    pub scoped_changes: Vec<ScopedChangeOutput>,
    pub script_logs: Vec<String>,
    /// Post-response script failure; retain the response.
    pub script_error: Option<ScriptErrorOutput>,
    /// Testes registrados com `al.test` pelos scripts (spec 0072).
    pub test_results: Vec<ScriptTestOutput>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecuteRestRequestError {
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
    /// Stop oversized downloads without partial data; UI offers unlimited resend.
    #[serde(rename_all = "camelCase")]
    ResponseTooLarge {
        limit_bytes: u64,
        received_bytes: u64,
    },
    Cancelled,
}

impl From<ExecutionError> for ExecuteRestRequestError {
    fn from(error: ExecutionError) -> Self {
        match error {
            ExecutionError::Network(failure) => Self::Network {
                cause: failure.cause.map(NetworkCauseOutput::from),
                message: failure.detail,
            },
            ExecutionError::Timeout => Self::Timeout,
            // REST never emits InvalidVariables; keep shared domain matches exhaustive.
            ExecutionError::InvalidVariables(message) => Self::InvalidRequest {
                message,
                cause: None,
            },
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

impl From<ScriptErrorOutput> for ExecuteRestRequestError {
    fn from(error: ScriptErrorOutput) -> Self {
        Self::Script {
            phase: error.phase,
            message: error.message,
        }
    }
}

impl ExecuteRestRequestError {
    fn header(name: &str, error: HeaderError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::header(name, &error)),
            message: error.to_string(),
        }
    }
}

impl From<EndpointError> for ExecuteRestRequestError {
    fn from(error: EndpointError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

impl From<TemplateError> for ExecuteRestRequestError {
    fn from(error: TemplateError) -> Self {
        Self::InvalidRequest {
            cause: InvalidRequestCause::template(&error),
            message: error.to_string(),
        }
    }
}

impl From<EnvironmentVariableError> for ExecuteRestRequestError {
    fn from(error: EnvironmentVariableError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

/// Interpolate templates against active environment variables.
fn resolve(
    template: &str,
    variables: &[EnvironmentVariable],
) -> Result<String, ExecuteRestRequestError> {
    Ok(resolve_variables(template, variables)?)
}

pub(crate) fn build_request(
    input: ExecuteRestRequestInput,
) -> Result<Request, ExecuteRestRequestError> {
    let unlimited_response_size = input.ignore_response_size_limit;
    let environment_variables = input
        .environment_variables
        .into_iter()
        .map(|variable| EnvironmentVariable::new(variable.name, variable.value, variable.sensitive))
        .collect::<Result<Vec<_>, _>>()?;

    let route_parameters = input
        .route_params
        .into_iter()
        .map(|parameter| {
            Ok(RouteParameter {
                name: parameter.name,
                value: resolve(&parameter.value, &environment_variables)?,
            })
        })
        .collect::<Result<Vec<_>, ExecuteRestRequestError>>()?;
    let endpoint_url = apply_route_parameters(
        &resolve(&input.endpoint_url, &environment_variables)?,
        &route_parameters,
    );
    let endpoint = Endpoint::new(endpoint_url)?;

    // Every REST body format supports templates, unlike GraphQL query text.
    let (body_text, body_payload) = resolve_body(input.body, &environment_variables)?;
    let document = RequestDocument::new(ProtocolId::Rest, body_text);

    let headers = input
        .headers
        .into_iter()
        .map(|header| -> Result<HeaderEntry, ExecuteRestRequestError> {
            let value = resolve(&header.value, &environment_variables)?;
            HeaderEntry::new(&header.name, value, header.enabled)
                .map_err(|error| ExecuteRestRequestError::header(&header.name, error))
        })
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
        Request::new(endpoint, document, "", headers, authentication)
            .with_method(input.method.into())
            .with_body_payload(body_payload)
            .with_route_parameters(route_parameters)
            .with_unlimited_response_size(unlimited_response_size),
    )
}

/// Scripts edit raw body text. Other formats contain structured fields/file paths, so text edits have no transport effect.
fn script_body_text(body: &BodyInput) -> String {
    match body {
        BodyInput::Raw { content, .. } => content.clone(),
        _ => String::new(),
    }
}

/// A raw JSON body runs without its comments (spec 0146): the pre-request
/// script, variable resolution, sending and history all see it that way.
fn strip_body_comments(body: &mut BodyInput) {
    if let BodyInput::Raw {
        content,
        raw_language: RawBodyLanguageInput::Json,
    } = body
        && let std::borrow::Cow::Owned(stripped) = strip_json_comments(content)
    {
        *content = stripped;
    }
}

/// Apply script body text only to raw requests.
fn apply_scripted_body(body: &mut BodyInput, scripted_text: String) {
    if let BodyInput::Raw { content, .. } = body {
        *content = scripted_text;
    }
}

/// Resolve body templates into text and structured payload. Form-data/binary leave document text empty; alcy-rest encodes/reads asynchronously.
fn resolve_body(
    body: BodyInput,
    variables: &[EnvironmentVariable],
) -> Result<(String, BodyPayload), ExecuteRestRequestError> {
    body_to_domain(body, |text| resolve(text, variables))
}

/// Convert body DTO through map_text: interpolate during execution, preserve while saving. Encode only enabled urlencoded fields while retaining disabled fields in structured payload.
pub(crate) fn body_to_domain<E>(
    body: BodyInput,
    map_text: impl Fn(&str) -> Result<String, E>,
) -> Result<(String, BodyPayload), E> {
    match body {
        BodyInput::None => Ok((String::new(), BodyPayload::None)),
        BodyInput::Raw {
            content,
            raw_language,
        } => Ok((
            map_text(&content)?,
            BodyPayload::Raw {
                language: raw_language.into(),
            },
        )),
        BodyInput::UrlEncoded { fields } => {
            let mut mapped = Vec::with_capacity(fields.len());
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for field in fields {
                let name = map_text(&field.name)?;
                let value = map_text(&field.value)?;
                if field.enabled {
                    serializer.append_pair(&name, &value);
                }
                mapped.push(UrlEncodedField {
                    name,
                    value,
                    enabled: field.enabled,
                });
            }
            Ok((serializer.finish(), BodyPayload::UrlEncoded(mapped)))
        }
        BodyInput::FormData { fields } => {
            let mapped = fields
                .into_iter()
                .map(|field| -> Result<FormDataField, E> {
                    Ok(match field {
                        FormDataFieldInput::Text {
                            name,
                            enabled,
                            value,
                        } => FormDataField {
                            name: map_text(&name)?,
                            enabled,
                            value: FormDataFieldValue::Text(map_text(&value)?),
                        },
                        FormDataFieldInput::File {
                            name,
                            enabled,
                            file_path,
                        } => FormDataField {
                            name: map_text(&name)?,
                            enabled,
                            value: FormDataFieldValue::File {
                                file_path: map_text(&file_path)?,
                            },
                        },
                    })
                })
                .collect::<Result<Vec<_>, E>>()?;
            Ok((String::new(), BodyPayload::FormData(mapped)))
        }
        BodyInput::Binary { file_path } => Ok((
            String::new(),
            BodyPayload::Binary {
                file_path: map_text(&file_path)?,
            },
        )),
    }
}

/// Reverse body_to_domain without interpolation for saved/history reopening.
pub(crate) fn body_input_from_domain(text: &str, payload: &BodyPayload) -> BodyInput {
    match payload {
        BodyPayload::None => BodyInput::None,
        BodyPayload::Raw { language } => BodyInput::Raw {
            content: text.to_string(),
            raw_language: (*language).into(),
        },
        BodyPayload::UrlEncoded(fields) => BodyInput::UrlEncoded {
            fields: fields
                .iter()
                .map(|field| UrlEncodedFieldInput {
                    name: field.name.clone(),
                    value: field.value.clone(),
                    enabled: field.enabled,
                })
                .collect(),
        },
        BodyPayload::FormData(fields) => BodyInput::FormData {
            fields: fields
                .iter()
                .map(|field| match &field.value {
                    FormDataFieldValue::Text(value) => FormDataFieldInput::Text {
                        name: field.name.clone(),
                        enabled: field.enabled,
                        value: value.clone(),
                    },
                    FormDataFieldValue::File { file_path } => FormDataFieldInput::File {
                        name: field.name.clone(),
                        enabled: field.enabled,
                        file_path: file_path.clone(),
                    },
                })
                .collect(),
        },
        BodyPayload::Binary { file_path } => BodyInput::Binary {
            file_path: file_path.clone(),
        },
    }
}

/// Execute cancellable REST through the same protocol-neutral registry and cancel command as GraphQL.
#[tauri::command]
pub async fn execute_rest_request(
    input: ExecuteRestRequestInput,
    registry: tauri::State<'_, ExecutionRegistry>,
    executor: tauri::State<'_, ReqwestRestExecutor>,
    body_cache: tauri::State<'_, ResponseBodyCache>,
    session_cookies: tauri::State<'_, SessionCookies>,
    history: tauri::State<'_, HistoryPreferencesState>,
    usage: tauri::State<'_, alcy_app::UsageHub>,
) -> Result<ExecuteRestRequestOutput, ExecutionFailure<ExecuteRestRequestError>> {
    let execution_id = input.execution_id.clone();
    let started = std::time::Instant::now();
    let method = input.method.as_str().to_ascii_uppercase();
    log::info!(
        target: "alcy::request",
        "rest {execution_id}: enviando {:?} {}",
        input.method,
        crate::logging::url_for_log(&input.endpoint_url)
    );
    let result = execute_rest_request_inner(
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
            "rest {execution_id}: HTTP {} em {} ms ({} bytes)",
            output.status_code,
            output.duration_ms,
            output.size_bytes
        ),
        Err(failure) => log::warn!(
            target: "alcy::request",
            "rest {execution_id}: falhou ({})",
            crate::logging::error_summary(failure)
        ),
    }
    usage.record(match &result {
        Ok(output) => request_answered(
            ProtocolId::Rest,
            Some(&method),
            StatusClass::from_status(output.status_code),
            None,
            output.duration_ms,
        ),
        Err(failure) => request_failed(
            ProtocolId::Rest,
            Some(&method),
            failure,
            alcy_app::millis(started.elapsed()),
        ),
    });
    result
}

async fn execute_rest_request_inner(
    input: ExecuteRestRequestInput,
    registry: &ExecutionRegistry,
    executor: &ReqwestRestExecutor,
    body_cache: &ResponseBodyCache,
    cookies: &CookieJar,
    history: HistoryPreferences,
) -> Result<ExecuteRestRequestOutput, ExecutionFailure<ExecuteRestRequestError>> {
    let mut input = input;
    strip_body_comments(&mut input.body);
    let execution_id = input.execution_id.clone();
    let root_path = input.root_path.clone();
    let history_source = (input.request_id.clone(), input.tab_id.clone());
    let post_script = std::mem::take(&mut input.post_response_script);
    let mut effects = ScriptEffects::default();
    let mut scopes = scopes_from_dto(std::mem::take(&mut input.variable_scopes))
        .map_err(|error| ExecutionFailure::new(error, ScriptEffects::default()))?;

    let mut scripted = ScriptedRequest {
        grpc: None,
        websocket: None,
        url: input.endpoint_url.clone(),
        method: input.method.as_str().to_string(),
        body: script_body_text(&input.body),
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
    apply_scripted_body(&mut input.body, scripted.body.clone());
    input.headers = scripted.headers.clone();
    if let Some(method) = HttpMethodInput::parse(&scripted.method) {
        input.method = method;
    }
    // Scripts receive environment/scopes separately; interpolation overlays them (ADR 0031).
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
            ExecuteRestRequestInput {
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
    // History retains saved workspace-relative paths; execution resolves absolute paths.
    let mut executable = request.clone();
    executable.body_payload = request
        .body_payload
        .with_files_resolved_against(Path::new(&root_path));
    // Only execution copies receive jar cookies; history excludes them.
    cookies.apply_to(&mut executable);

    let (sender, receiver) = oneshot::channel();
    registry.register(execution_id.clone(), sender);

    let outcome = execute_request(executor, &executable, cancellation_signal(receiver)).await;

    registry.remove(&execution_id);

    if let (Some(history_outcome), Some(history_request)) =
        (history_outcome_from(&outcome), history_request)
        && !history.retention.is_disabled()
    {
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

    Ok(ExecuteRestRequestOutput {
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
        scoped_changes: effects.scoped_output(),
        environment_changes: effects.environment_changes,
        script_logs: effects.logs,
        script_error,
        test_results: effects.tests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{HistoryOutcome, HistoryRetention};
    use alcy_storage::{HistoryStore, HistorySummary, HistorySummaryOutcome};
    use base64::Engine;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-execute-rest-cmd-test-{nanos}-{count}"))
    }

    fn valid_input() -> ExecuteRestRequestInput {
        ExecuteRestRequestInput {
            request_id: None,
            tab_id: None,
            execution_id: "exec-1".to_string(),
            root_path: temp_root().to_string_lossy().to_string(),
            endpoint_url: "https://api.example.com/users".to_string(),
            route_params: vec![],
            method: HttpMethodInput::Get,
            body: BodyInput::Raw {
                content: String::new(),
                raw_language: RawBodyLanguageInput::Json,
            },
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

    /// O contrato JSON precisa bater com `RestBodyInput` em
    /// `execute-rest-request.ts` — campos das variantes em camelCase.
    #[test]
    fn body_input_uses_the_same_json_shape_as_the_frontend() {
        let raw: BodyInput =
            serde_json::from_str(r#"{"type":"raw","content":"{}","rawLanguage":"xml"}"#).unwrap();
        assert_eq!(
            raw,
            BodyInput::Raw {
                content: "{}".to_string(),
                raw_language: RawBodyLanguageInput::Xml,
            }
        );

        let form: BodyInput = serde_json::from_str(
            r#"{"type":"formData","fields":[{"kind":"file","name":"f","enabled":true,"filePath":"a.png"},{"kind":"text","name":"t","enabled":false,"value":"v"}]}"#,
        )
        .unwrap();
        assert_eq!(
            form,
            BodyInput::FormData {
                fields: vec![
                    FormDataFieldInput::File {
                        name: "f".to_string(),
                        enabled: true,
                        file_path: "a.png".to_string(),
                    },
                    FormDataFieldInput::Text {
                        name: "t".to_string(),
                        enabled: false,
                        value: "v".to_string(),
                    },
                ],
            }
        );

        let binary: BodyInput =
            serde_json::from_str(r#"{"type":"binary","filePath":"a.bin"}"#).unwrap();
        assert_eq!(
            binary,
            BodyInput::Binary {
                file_path: "a.bin".to_string(),
            }
        );

        let urlencoded: BodyInput = serde_json::from_str(
            r#"{"type":"urlencoded","fields":[{"name":"a","value":"1","enabled":true}]}"#,
        )
        .unwrap();
        assert!(matches!(urlencoded, BodyInput::UrlEncoded { .. }));

        assert_eq!(
            serde_json::to_value(&raw).unwrap(),
            serde_json::json!({"type": "raw", "content": "{}", "rawLanguage": "xml"})
        );
        assert_eq!(
            serde_json::to_value(&binary).unwrap(),
            serde_json::json!({"type": "binary", "filePath": "a.bin"})
        );
        assert_eq!(
            serde_json::to_value(BodyInput::None).unwrap(),
            serde_json::json!({"type": "none"})
        );
    }

    #[test]
    fn builds_a_domain_request_from_a_valid_input() {
        let request = build_request(valid_input()).unwrap();

        assert_eq!(request.endpoint.url(), "https://api.example.com/users");
        assert_eq!(request.method, HttpMethod::Get);
        assert_eq!(request.document.protocol, ProtocolId::Rest);
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
            ExecuteRestRequestError::InvalidRequest {
                message: EndpointError::Empty.to_string(),
                cause: Some(InvalidRequestCause::EmptyEndpoint),
            }
        );
    }

    #[test]
    fn interpolates_environment_variables_including_the_body() {
        let mut input = valid_input();
        input.endpoint_url = "{{baseUrl}}/users".to_string();
        input.body = BodyInput::Raw {
            content: "{\"token\":\"{{token}}\"}".to_string(),
            raw_language: RawBodyLanguageInput::Json,
        };
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

        assert_eq!(request.endpoint.url(), "https://api.example.com/users");
        assert_eq!(request.document.body, "{\"token\":\"secret\"}");
    }

    #[test]
    fn applies_route_parameters_after_resolving_their_values() {
        let mut input = valid_input();
        input.endpoint_url = "https://api.example.com/users/:userId?next=/:userId".to_string();
        input.route_params = vec![RouteParameterInput {
            name: "userId".to_string(),
            value: "{{selectedUser}}".to_string(),
        }];
        input.environment_variables = vec![EnvironmentVariableDto {
            name: "selectedUser".to_string(),
            value: "42".to_string(),
            sensitive: false,
        }];

        let request = build_request(input).unwrap();

        assert_eq!(
            request.endpoint.url(),
            "https://api.example.com/users/42?next=/:userId"
        );
        assert_eq!(
            request.route_parameters,
            vec![RouteParameter {
                name: "userId".to_string(),
                value: "42".to_string(),
            }]
        );
    }

    #[test]
    fn an_unreadable_body_file_keeps_its_path_as_the_cause() {
        let error = ExecuteRestRequestError::from(ExecutionError::BodyFileUnreadable {
            path: "/tmp/payload.json".to_string(),
            detail: "No such file or directory (os error 2)".to_string(),
        });

        assert_eq!(
            error,
            ExecuteRestRequestError::InvalidRequest {
                message: "No such file or directory (os error 2)".to_string(),
                cause: Some(InvalidRequestCause::BodyFileUnreadable {
                    path: "/tmp/payload.json".to_string(),
                }),
            }
        );
    }

    #[test]
    fn preserves_undefined_variables_when_building_a_request() {
        let mut input = valid_input();
        input.endpoint_url = "{{baseUrl}}/users".to_string();

        let request = build_request(input).unwrap();

        assert_eq!(request.endpoint.url(), "{{baseUrl}}/users");
    }

    #[tokio::test]
    async fn sends_requests_with_undefined_header_and_body_variables() {
        use wiremock::matchers::{body_string, header};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header("X-Name", "{{name}}"))
            .and(body_string(r#"{"name":"{{ name }}"}"#))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .expect(1)
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.method = HttpMethodInput::Post;
        input.headers.push(HeaderInput {
            name: "X-Name".to_string(),
            value: "{{name}}".to_string(),
            enabled: true,
        });
        input.body = BodyInput::Raw {
            content: r#"{"name":"{{ name }}"}"#.to_string(),
            raw_language: RawBodyLanguageInput::Json,
        };
        let root_path = input.root_path.clone();

        let output = execute_rest_request_inner(
            input,
            &ExecutionRegistry::default(),
            &ReqwestRestExecutor::new(),
            &ResponseBodyCache::default(),
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.status_code, 200);
        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn a_response_over_the_limit_fails_unless_the_send_ignores_the_limit() {
        let server = MockServer::start().await;
        let body = "x".repeat(1024 * 1024 + 1);
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body.clone()))
            .mount(&server)
            .await;
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        executor.set_response_size_limit(alcy_domain::ResponseSizeLimit::Megabytes(1));
        let body_cache = ResponseBodyCache::default();
        let jar = CookieJar::default();
        let input = ExecuteRestRequestInput {
            endpoint_url: server.uri(),
            ..valid_input()
        };

        let failure = execute_rest_request_inner(
            input.clone(),
            &registry,
            &executor,
            &body_cache,
            &jar,
            HistoryPreferences::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            failure.error,
            ExecuteRestRequestError::ResponseTooLarge {
                limit_bytes: 1024 * 1024,
                received_bytes: 1024 * 1024 + 1,
            }
        );
        assert_eq!(
            serde_json::to_value(&failure.error).unwrap(),
            serde_json::json!({
                "kind": "responseTooLarge",
                "limitBytes": 1024 * 1024,
                "receivedBytes": 1024 * 1024 + 1,
            })
        );

        let unlimited = ExecuteRestRequestInput {
            ignore_response_size_limit: true,
            ..input
        };
        let output = execute_rest_request_inner(
            unlimited,
            &registry,
            &executor,
            &body_cache,
            &jar,
            HistoryPreferences::default(),
        )
        .await
        .unwrap();
        assert_eq!(output.size_bytes, body.len());
    }

    #[tokio::test]
    async fn the_session_jar_sends_back_the_cookies_received_in_earlier_requests() {
        use wiremock::matchers::{header, path};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/login"))
            .respond_with(ResponseTemplate::new(200).insert_header("Set-Cookie", "sid=abc; Path=/"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("cookie", "sid=abc"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();
        let jar = CookieJar::default();
        let input_for = |path: &str| ExecuteRestRequestInput {
            endpoint_url: format!("{}{path}", server.uri()),
            ..valid_input()
        };

        execute_rest_request_inner(
            input_for("/login"),
            &registry,
            &executor,
            &body_cache,
            &jar,
            HistoryPreferences::default(),
        )
        .await
        .unwrap();
        let output = execute_rest_request_inner(
            input_for("/me"),
            &registry,
            &executor,
            &body_cache,
            &jar,
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.status_code, 200);
        assert!(output.request_headers.contains(&ResponseHeaderOutput {
            name: "cookie".to_string(),
            value: "sid=abc".to_string(),
        }));
    }

    #[tokio::test]
    async fn sends_a_json_body_without_its_comments() {
        use wiremock::matchers::body_string;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string("{\n  \"name\": \"Ana\"\n}"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .expect(1)
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.method = HttpMethodInput::Post;
        input.body = BodyInput::Raw {
            content: "{\n  \"name\": \"{{name}}\", // who\n  // \"age\": {{missing}}\n}"
                .to_string(),
            raw_language: RawBodyLanguageInput::Json,
        };
        input.environment_variables = vec![EnvironmentVariableDto {
            name: "name".to_string(),
            value: "Ana".to_string(),
            sensitive: false,
        }];
        // The script sees the body already without comments: `json()` parses it.
        input.pre_request_script =
            "al.environment.set('keys', Object.keys(al.request.json()).join(','));".to_string();

        let output = execute_rest_request_inner(
            input,
            &ExecutionRegistry::default(),
            &ReqwestRestExecutor::new(),
            &ResponseBodyCache::default(),
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.status_code, 200);
        assert_eq!(
            output.environment_changes,
            vec![EnvironmentChangeOutput {
                name: "keys".to_string(),
                value: Some("name".to_string()),
            }]
        );
    }

    #[tokio::test]
    async fn sends_a_text_body_with_slashes_as_it_is() {
        use wiremock::matchers::body_string;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string("a // b\n/* c */"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .expect(1)
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.method = HttpMethodInput::Post;
        input.body = BodyInput::Raw {
            content: "a // b\n/* c */".to_string(),
            raw_language: RawBodyLanguageInput::Text,
        };

        let output = execute_rest_request_inner(
            input,
            &ExecutionRegistry::default(),
            &ReqwestRestExecutor::new(),
            &ResponseBodyCache::default(),
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.status_code, 200);
    }

    #[tokio::test]
    async fn scripts_change_the_request_and_return_environment_changes() {
        use wiremock::matchers::header;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header("x-token", "abc"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"id\":9}"))
            .expect(1)
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = "{{base}}".to_string();
        input.method = HttpMethodInput::Get;
        input.environment_variables = vec![
            EnvironmentVariableDto {
                name: "base".to_string(),
                value: "placeholder".to_string(),
                sensitive: false,
            },
            EnvironmentVariableDto {
                name: "token".to_string(),
                value: "abc".to_string(),
                sensitive: true,
            },
        ];
        input.pre_request_script = format!(
            "al.environment.set('base', '{}'); al.request.method = 'POST'; \
             al.request.headers.set('X-Token', al.environment.get('token'));",
            server.uri()
        );
        input.post_response_script =
            "al.environment.set('id', String(al.response.json().id)); al.console.log('ok');"
                .to_string();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
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
        assert_eq!(output.script_error, None);
        assert_eq!(output.script_logs, vec!["ok"]);
        assert_eq!(
            output.environment_changes,
            vec![
                EnvironmentChangeOutput {
                    name: "base".to_string(),
                    value: Some(server.uri()),
                },
                EnvironmentChangeOutput {
                    name: "id".to_string(),
                    value: Some("9".to_string()),
                },
            ]
        );
    }

    #[tokio::test]
    async fn folder_variables_resolve_and_scripts_write_to_their_scope() {
        use crate::commands::collections::ScopedVariableDto;
        use crate::commands::variable_scopes::VariableScopeKindDto;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/folder/7"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .expect(1)
            .mount(&server)
            .await;
        let variable = |name: &str, value: &str| ScopedVariableDto {
            name: name.to_string(),
            value: value.to_string(),
        };

        let mut input = valid_input();
        input.method = HttpMethodInput::Get;
        input.endpoint_url = "{{base}}/{{segment}}/{{id}}".to_string();
        input.environment_variables = vec![EnvironmentVariableDto {
            name: "segment".to_string(),
            value: "env".to_string(),
            sensitive: false,
        }];
        input.variable_scopes = vec![
            VariableScopeDto {
                node_id: "c".to_string(),
                kind: VariableScopeKindDto::Collection,
                variables: vec![
                    variable("base", &server.uri()),
                    variable("segment", "collection"),
                ],
            },
            VariableScopeDto {
                node_id: "f".to_string(),
                kind: VariableScopeKindDto::Folder,
                variables: vec![variable("segment", "folder")],
            },
        ];
        input.pre_request_script =
            "al.folder.set('id', 7); al.console.log(al.environment.get('segment'));".to_string();
        input.post_response_script = "al.collection.set('done', 'yes');".to_string();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
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
        assert_eq!(output.script_logs, vec!["env"]);
        assert!(output.environment_changes.is_empty());
        assert_eq!(
            output.scoped_changes,
            vec![
                ScopedChangeOutput {
                    node_id: "f".to_string(),
                    name: "id".to_string(),
                    value: Some("7".to_string()),
                },
                ScopedChangeOutput {
                    node_id: "c".to_string(),
                    name: "done".to_string(),
                    value: Some("yes".to_string()),
                },
            ]
        );
    }

    #[tokio::test]
    async fn a_failing_pre_script_prevents_the_request() {
        let mut input = valid_input();
        input.pre_request_script = "boom();".to_string();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let error = execute_rest_request_inner(
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
            ExecuteRestRequestError::Script { ref phase, .. } if phase == "preRequest"
        ));
    }

    #[tokio::test]
    async fn a_failing_post_script_keeps_the_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;
        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.post_response_script = "al.response.json();".to_string();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
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
            output.script_error.map(|error| error.phase),
            Some("postResponse".to_string())
        );
    }

    #[tokio::test]
    async fn maps_a_successful_execution_to_the_output_dto() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
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
                body: "[]".to_string()
            }
        );
        assert_eq!(output.body_encoding, ResponseBodyEncodingOutput::Text);

        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn maps_an_image_response_to_a_base64_encoded_output_dto() {
        let raw_bytes: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x10];
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(raw_bytes)
                    .insert_header("Content-Type", "image/png"),
            )
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.body_encoding, ResponseBodyEncodingOutput::Base64);
        assert_eq!(output.size_bytes, raw_bytes.len());
        assert_eq!(
            output.body,
            ResponseBodyOutput::Inline {
                body: base64::engine::general_purpose::STANDARD.encode(raw_bytes)
            }
        );

        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn maps_transport_metadata_to_the_output_dto() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("[]")
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
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
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

        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn sends_the_requests_method_and_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.method = HttpMethodInput::Post;
        input.body = BodyInput::Raw {
            content: "{\"name\":\"acme\"}".to_string(),
            raw_language: RawBodyLanguageInput::Json,
        };
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
            input,
            &registry,
            &executor,
            &body_cache,
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        assert_eq!(output.status_code, 201);

        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn removes_the_execution_from_the_registry_when_it_finishes() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.execution_id = "exec-cleanup".to_string();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        execute_rest_request_inner(
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

        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn cancelling_before_the_response_arrives_yields_a_cancelled_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.execution_id = "exec-cancel".to_string();

        let registry = Arc::new(ExecutionRegistry::default());
        let registry_for_task = registry.clone();
        let executor = Arc::new(ReqwestRestExecutor::new());
        let executor_for_task = executor.clone();
        let body_cache = Arc::new(ResponseBodyCache::default());
        let body_cache_for_task = body_cache.clone();

        let handle = tokio::spawn(async move {
            execute_rest_request_inner(
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

        assert_eq!(error, ExecuteRestRequestError::Cancelled);
    }

    fn history_entries(root_path: &str) -> Vec<HistorySummary> {
        HistoryStore::new(PathBuf::from(root_path), Duration::from_secs(3600))
            .load_summaries()
            .unwrap()
    }

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
    async fn records_a_successful_execution_in_the_workspace_history_with_its_protocol_and_method()
    {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        execute_rest_request_inner(
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
        assert_eq!(entries[0].protocol, ProtocolId::Rest);
        assert!(matches!(
            entries[0].outcome,
            HistorySummaryOutcome::Success { .. }
        ));

        fs_cleanup(&root_path);
    }

    /// Execute a GET returning `{"ok":true}` and return the persisted entry.
    async fn send_and_load_history_entry(history: HistoryPreferences) -> alcy_domain::HistoryEntry {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"ok":true}"#))
            .mount(&server)
            .await;
        let mut input = valid_input();
        input.endpoint_url = server.uri();
        let root_path = input.root_path.clone();

        execute_rest_request_inner(
            input,
            &ExecutionRegistry::default(),
            &ReqwestRestExecutor::new(),
            &ResponseBodyCache::default(),
            &CookieJar::default(),
            history,
        )
        .await
        .unwrap();
        wait_for_history_entries(&root_path, 1).await;

        let entry = HistoryStore::new(PathBuf::from(&root_path), Duration::from_secs(3600))
            .load_entry("exec-1")
            .unwrap()
            .unwrap();
        fs_cleanup(&root_path);
        entry
    }

    #[tokio::test]
    async fn by_default_records_only_the_response_summary() {
        let entry = send_and_load_history_entry(HistoryPreferences::default()).await;

        assert!(entry.response_omitted);
        let HistoryOutcome::Success(response) = entry.outcome else {
            panic!("o envio deu certo");
        };
        assert_eq!(response.status_code, 200);
        assert_eq!(response.size_bytes, r#"{"ok":true}"#.len());
        assert!(response.body.is_empty());
    }

    #[tokio::test]
    async fn records_the_response_body_when_saving_responses() {
        let entry = send_and_load_history_entry(HistoryPreferences {
            save_responses: true,
            ..HistoryPreferences::default()
        })
        .await;

        assert!(!entry.response_omitted);
        let HistoryOutcome::Success(response) = entry.outcome else {
            panic!("o envio deu certo");
        };
        assert_eq!(response.body, r#"{"ok":true}"#);
    }

    #[tokio::test]
    async fn records_the_request_and_tab_of_origin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"a":1}"#))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.request_id = Some("req-1".to_string());
        input.tab_id = Some("tab-1".to_string());
        let root_path = input.root_path.clone();

        execute_rest_request_inner(
            input,
            &ExecutionRegistry::default(),
            &ReqwestRestExecutor::new(),
            &ResponseBodyCache::default(),
            &CookieJar::default(),
            HistoryPreferences::default(),
        )
        .await
        .unwrap();

        let entries = wait_for_history_entries(&root_path, 1).await;

        assert_eq!(entries[0].request_id.as_deref(), Some("req-1"));
        assert_eq!(entries[0].tab_id.as_deref(), Some("tab-1"));

        fs_cleanup(&root_path);
    }

    fn history_detail_text(root_path: &str) -> String {
        std::fs::read_dir(PathBuf::from(root_path).join("alcy-history"))
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn history_keeps_the_placeholder_of_sensitive_variables_instead_of_their_value() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::header("x-api-key", "s3cr3t"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = format!("{}/users?key={{{{token}}}}", server.uri());
        input.headers.push(HeaderInput {
            name: "X-Api-Key".to_string(),
            value: "{{token}}".to_string(),
            enabled: true,
        });
        input.authentication = AuthenticationInput::Bearer {
            token: "{{token}}".to_string(),
        };
        input.environment_variables = vec![EnvironmentVariableDto {
            name: "token".to_string(),
            value: "s3cr3t".to_string(),
            sensitive: true,
        }];
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let output = execute_rest_request_inner(
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

        assert_eq!(output.status_code, 200);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].endpoint.contains("{{token}}"));
        let manifest =
            std::fs::read_to_string(PathBuf::from(&root_path).join("alcy-history.json")).unwrap();
        let detail = history_detail_text(&root_path);
        assert!(!manifest.contains("s3cr3t"));
        assert!(!detail.contains("s3cr3t"));
        assert!(detail.contains("{{token}}"));

        fs_cleanup(&root_path);
    }

    #[test]
    fn a_failure_serializes_as_the_error_plus_the_script_effects() {
        let failure = ExecutionFailure::<ExecuteRestRequestError>::new(
            ExecuteRestRequestError::Timeout,
            ScriptEffects {
                scoped_changes: Vec::new(),
                environment_changes: vec![EnvironmentChangeOutput {
                    name: "token".to_string(),
                    value: Some("abc".to_string()),
                }],
                logs: vec!["pre".to_string()],
                tests: Vec::new(),
                ..ScriptEffects::default()
            },
        );

        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({
                "kind": "timeout",
                "environmentChanges": [{ "name": "token", "value": "abc" }],
                "scopedChanges": [],
                "scriptLogs": ["pre"],
                "testResults": [],
            })
        );
    }

    #[tokio::test]
    async fn a_failed_request_still_returns_the_pre_script_effects() {
        let mut input = valid_input();
        input.endpoint_url = "http://127.0.0.1:1/users".to_string();
        input.pre_request_script =
            "al.environment.set('token', 'abc'); al.console.log('pre');".to_string();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        let failure = execute_rest_request_inner(
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
            ExecuteRestRequestError::Network { .. }
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
        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn records_a_network_failure_in_the_workspace_history() {
        let mut input = valid_input();
        input.endpoint_url = "http://127.0.0.1:1/users".to_string();
        let root_path = input.root_path.clone();
        let registry = ExecutionRegistry::default();
        let executor = ReqwestRestExecutor::new();
        let body_cache = ResponseBodyCache::default();

        execute_rest_request_inner(
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
                kind: alcy_domain::HistoryFailureKind::Network,
            }
        ));

        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn does_not_record_when_the_history_is_disabled() {
        let mut input = valid_input();
        input.endpoint_url = "http://127.0.0.1:1/users".to_string();
        let root_path = input.root_path.clone();

        execute_rest_request_inner(
            input,
            &ExecutionRegistry::default(),
            &ReqwestRestExecutor::new(),
            &ResponseBodyCache::default(),
            &CookieJar::default(),
            HistoryPreferences {
                retention: HistoryRetention::days(0).unwrap(),
                save_responses: true,
            },
        )
        .await
        .unwrap_err();

        // Disabled history schedules no background writes.
        assert!(history_entries(&root_path).is_empty());

        fs_cleanup(&root_path);
    }

    #[tokio::test]
    async fn does_not_record_a_cancelled_execution() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;

        let mut input = valid_input();
        input.endpoint_url = server.uri();
        input.execution_id = "exec-not-recorded".to_string();
        let root_path = input.root_path.clone();

        let registry = Arc::new(ExecutionRegistry::default());
        let registry_for_task = registry.clone();
        let executor = Arc::new(ReqwestRestExecutor::new());
        let executor_for_task = executor.clone();
        let body_cache = Arc::new(ResponseBodyCache::default());
        let body_cache_for_task = body_cache.clone();

        let handle = tokio::spawn(async move {
            execute_rest_request_inner(
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

        fs_cleanup(&root_path);
    }

    fn fs_cleanup(root_path: &str) {
        std::fs::remove_dir_all(root_path).ok();
    }
}
