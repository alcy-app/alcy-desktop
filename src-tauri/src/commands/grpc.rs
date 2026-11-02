//! gRPC requests (spec 0129): loading a server's schema and calling a method.
//! The protocol work lives in `alcy-grpc`; this adapter resolves variables,
//! authentication and app settings, keeps schemas in memory and records
//! history, like the REST and GraphQL commands.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use alcy_app::{TemplateError, resolve_variables};
use alcy_domain::{
    Authentication, Endpoint, EndpointError, EnvironmentVariable, EnvironmentVariableError,
    GrpcCall, GrpcSchemaSource, HeaderEntry, HistoryFailureKind, HistoryOutcome, ProtocolId,
    Request, RequestDocument, Response, ResponseHeader, ResponseMetadata,
};
use alcy_grpc::{
    CallOutcome, Channel, ClientAction, ConnectionSettings, DescriptorPool, GrpcError, GrpcEvent,
    GrpcStatus, GrpcTarget, MetadataEntry, MethodKind, SchemaSummary,
    compile_workspace_proto_files, connect, describe, find_method, reflect, start_call,
};
use alcy_storage::{CustomCaCertificateStore, GeneralSettingsStore};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel as IpcChannel;
use tauri::{Manager, State};
use tokio::sync::{mpsc, oneshot};

use crate::commands::collections::{GrpcCallDto, GrpcSchemaSourceDto};
use crate::commands::environments::{EnvironmentVariableDto, redact_sensitive_variables};
use crate::commands::execute_graphql_request::{
    AuthenticationInput, HeaderInput, ResponseBodyOutput, cancellation_signal, history_request,
    record_history, resolve_inherited_authentication, response_body_output,
};
use crate::commands::execution_registry::ExecutionRegistry;
use crate::commands::failure_cause::InvalidRequestCause;
use crate::commands::general_settings::HistoryPreferencesState;
use crate::commands::proxy_settings::ProxyApplyState;
use crate::commands::response_body_cache::ResponseBodyCache;
use crate::commands::scripting::{
    EnvironmentChangeOutput, ExecutionFailure, ScopedChangeOutput, ScriptEffects,
    ScriptErrorOutput, ScriptTestOutput, ScriptedRequest, run_post_response, run_pre_request,
};
use crate::commands::variable_scopes::{VariableScopeDto, scopes_from_dto, with_scoped_variables};

/// Schemas loaded in this session, by server and source: a request reuses
/// them instead of asking the server again on every call.
#[derive(Default)]
pub struct GrpcSchemaCache(Mutex<HashMap<String, DescriptorPool>>);

impl GrpcSchemaCache {
    fn get(&self, key: &str) -> Option<DescriptorPool> {
        self.0.lock().ok()?.get(key).cloned()
    }

    fn insert(&self, key: String, pool: DescriptorPool) {
        if let Ok(mut schemas) = self.0.lock() {
            schemas.insert(key, pool);
        }
    }
}

/// Largest message JSON sent in a live event; the full message stays in the
/// final output (invariant 8: large data does not cross IPC repeatedly).
const MAX_EVENT_JSON_BYTES: usize = 256 * 1024;

/// Calls whose request stream is still open, by execution id: client and
/// bidirectional streaming calls take more messages until the person ends
/// the stream.
#[derive(Default)]
pub struct GrpcCalls(Mutex<HashMap<String, LiveGrpcCall>>);

#[derive(Clone)]
struct LiveGrpcCall {
    sender: mpsc::Sender<ClientAction>,
    variables: Vec<EnvironmentVariableDto>,
}

impl GrpcCalls {
    fn insert(
        &self,
        id: &str,
        sender: mpsc::Sender<ClientAction>,
        variables: Vec<EnvironmentVariableDto>,
    ) {
        if let Ok(mut calls) = self.0.lock() {
            calls.insert(id.to_string(), LiveGrpcCall { sender, variables });
        }
    }

    fn remove(&self, id: &str) {
        if let Ok(mut calls) = self.0.lock() {
            calls.remove(id);
        }
    }

    fn get(&self, id: &str) -> Option<LiveGrpcCall> {
        self.0.lock().ok()?.get(id).cloned()
    }
}

/// A call's progress, as it happens (spec 0129).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GrpcCallEventDto {
    /// The call reached the method; client-streaming kinds accept more
    /// messages until the stream is ended.
    #[serde(rename_all = "camelCase")]
    Started { kind: MethodKind },
    #[serde(rename_all = "camelCase")]
    Sent {
        index: usize,
        json: String,
        truncated: bool,
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
        truncated: bool,
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

fn capped(json: &str) -> (String, bool) {
    if json.len() <= MAX_EVENT_JSON_BYTES {
        return (json.to_string(), false);
    }
    let mut end = MAX_EVENT_JSON_BYTES;
    while !json.is_char_boundary(end) {
        end -= 1;
    }
    (json[..end].to_string(), true)
}

impl From<&GrpcEvent> for GrpcCallEventDto {
    fn from(event: &GrpcEvent) -> Self {
        match event {
            GrpcEvent::Sent {
                index,
                json,
                size_bytes,
                elapsed_ms,
            } => {
                let (json, truncated) = capped(json);
                Self::Sent {
                    index: *index,
                    json,
                    truncated,
                    size_bytes: *size_bytes,
                    elapsed_ms: *elapsed_ms,
                }
            }
            GrpcEvent::Headers {
                metadata,
                elapsed_ms,
            } => Self::Headers {
                metadata: metadata.clone(),
                elapsed_ms: *elapsed_ms,
            },
            GrpcEvent::Received {
                index,
                json,
                size_bytes,
                elapsed_ms,
            } => {
                let (json, truncated) = capped(json);
                Self::Received {
                    index: *index,
                    json,
                    truncated,
                    size_bytes: *size_bytes,
                    elapsed_ms: *elapsed_ms,
                }
            }
            GrpcEvent::Finished {
                status,
                trailers,
                elapsed_ms,
            } => Self::Finished {
                status: status.clone(),
                trailers: trailers.clone(),
                elapsed_ms: *elapsed_ms,
            },
        }
    }
}

/// What both commands need to reach a server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcConnectionInput {
    pub root_path: String,
    pub endpoint: String,
    pub schema_source: GrpcSchemaSourceDto,
    /// Metadata (sent with reflection too, for servers that require auth).
    pub headers: Vec<HeaderInput>,
    pub authentication: AuthenticationInput,
    #[serde(default)]
    pub request_id: Option<String>,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    #[serde(default)]
    pub variable_scopes: Vec<VariableScopeDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadGrpcSchemaInput {
    pub execution_id: String,
    #[serde(flatten)]
    pub connection: GrpcConnectionInput,
    /// Ignores the schema kept for this server and asks again.
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteGrpcRequestInput {
    pub execution_id: String,
    #[serde(default)]
    pub pre_request_script: String,
    #[serde(default)]
    pub post_response_script: String,
    #[serde(flatten)]
    pub connection: GrpcConnectionInput,
    pub service: String,
    pub method: String,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
    /// The request message, as JSON.
    pub message: String,
    #[serde(default)]
    pub tab_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteGrpcRequestOutput {
    pub environment_changes: Vec<EnvironmentChangeOutput>,
    pub scoped_changes: Vec<ScopedChangeOutput>,
    pub script_logs: Vec<String>,
    pub script_error: Option<ScriptErrorOutput>,
    pub test_results: Vec<ScriptTestOutput>,
    pub status: GrpcStatus,
    pub duration_ms: u64,
    /// Received messages, in bytes on the wire.
    pub size_bytes: usize,
    pub message_count: usize,
    /// The received message as JSON; a JSON array when there are several.
    pub body: ResponseBodyOutput,
    pub headers: Vec<MetadataEntry>,
    pub trailers: Vec<MetadataEntry>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GrpcCommandError {
    Script {
        phase: String,
        message: String,
    },
    InvalidRequest {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cause: Option<InvalidRequestCause>,
    },
    /// The server could not be reached (address, network, TLS, proxy).
    Connection {
        message: String,
    },
    /// Reflection or `.proto` compilation failed.
    Schema {
        message: String,
    },
    Cancelled,
}

impl From<ScriptErrorOutput> for GrpcCommandError {
    fn from(error: ScriptErrorOutput) -> Self {
        Self::Script {
            phase: error.phase,
            message: error.message,
        }
    }
}

impl From<GrpcError> for GrpcCommandError {
    fn from(error: GrpcError) -> Self {
        let message = error.to_string();
        match error {
            GrpcError::Connection(_) | GrpcError::Certificate(_) => Self::Connection { message },
            GrpcError::ProtoFiles(_) | GrpcError::Reflection(_) => Self::Schema { message },
            GrpcError::InvalidTarget(_)
            | GrpcError::MethodNotFound(_)
            | GrpcError::InvalidMessage { .. }
            | GrpcError::InvalidMetadata { .. } => Self::InvalidRequest {
                message,
                cause: None,
            },
        }
    }
}

impl From<TemplateError> for GrpcCommandError {
    fn from(error: TemplateError) -> Self {
        Self::InvalidRequest {
            cause: InvalidRequestCause::template(&error),
            message: error.to_string(),
        }
    }
}

impl From<EnvironmentVariableError> for GrpcCommandError {
    fn from(error: EnvironmentVariableError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

impl From<EndpointError> for GrpcCommandError {
    fn from(error: EndpointError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

fn invalid(message: impl Into<String>) -> GrpcCommandError {
    GrpcCommandError::InvalidRequest {
        message: message.into(),
        cause: None,
    }
}

/// A connection input with variables (environment merged with the
/// collection/folder layers) and inherited authentication resolved.
struct ResolvedConnection {
    request: Request,
    /// The same request with sensitive values kept as `{{name}}`, for
    /// history; `None` when the environment has no sensitive variable.
    redacted: Option<Option<Request>>,
}

async fn resolve_connection(
    mut connection: GrpcConnectionInput,
    call: GrpcCall,
    message: &str,
) -> Result<ResolvedConnection, GrpcCommandError> {
    let scopes = scopes_from_dto(std::mem::take(&mut connection.variable_scopes))?;
    connection.environment_variables =
        with_scoped_variables(&connection.environment_variables, &scopes);
    connection.authentication = resolve_inherited_authentication(
        connection.authentication,
        connection.request_id.as_deref(),
        Some(&connection.root_path),
    )
    .await;
    let redacted = redact_sensitive_variables(&connection.environment_variables)
        .map(|variables| build_request(&connection, &variables, &call, message).ok());
    let request = build_request(
        &connection,
        &connection.environment_variables,
        &call,
        message,
    )?;
    Ok(ResolvedConnection { request, redacted })
}

fn build_request(
    connection: &GrpcConnectionInput,
    variables: &[EnvironmentVariableDto],
    call: &GrpcCall,
    message: &str,
) -> Result<Request, GrpcCommandError> {
    let variables = variables
        .iter()
        .map(|variable| {
            EnvironmentVariable::new(&variable.name, &variable.value, variable.sensitive)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let resolve = |template: &str| resolve_variables(template, &variables);
    let endpoint = Endpoint::new(resolve(&connection.endpoint)?)?;
    let headers = connection
        .headers
        .iter()
        .map(|header| {
            let value = resolve(&header.value)?;
            HeaderEntry::new(&header.name, value, header.enabled).map_err(|error| {
                GrpcCommandError::InvalidRequest {
                    cause: Some(InvalidRequestCause::header(&header.name, &error)),
                    message: error.to_string(),
                }
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let authentication = match &connection.authentication {
        AuthenticationInput::None | AuthenticationInput::Inherit => Authentication::None,
        AuthenticationInput::CustomHeader { name, value } => Authentication::CustomHeader {
            name: resolve(name)?,
            value: resolve(value)?,
        },
        AuthenticationInput::Bearer { token } => Authentication::Bearer {
            token: resolve(token)?,
        },
        AuthenticationInput::Basic { username, password } => Authentication::Basic {
            username: resolve(username)?,
            password: resolve(password)?,
        },
        AuthenticationInput::Digest { .. } => {
            return Err(invalid("autenticação Digest não se aplica a gRPC"));
        }
        AuthenticationInput::OAuth2ClientCredentials { .. } => {
            return Err(invalid(
                "OAuth2 (client credentials) ainda não é suportado em requisições gRPC",
            ));
        }
    };
    let document = RequestDocument::new(ProtocolId::Grpc, resolve(message)?);
    Ok(Request::new(endpoint, document, "", headers, authentication).with_grpc(call.clone()))
}

/// Enabled headers plus the authentication, as gRPC metadata.
fn metadata_of(request: &Request) -> Vec<MetadataEntry> {
    let mut metadata: Vec<MetadataEntry> = request
        .headers
        .iter()
        .filter(|header| header.enabled && !header.name().trim().is_empty())
        .map(|header| MetadataEntry {
            name: header.name().to_string(),
            value: header.value().to_string(),
        })
        .collect();
    let authorization = match &request.authentication {
        Authentication::Bearer { token } => {
            Some(("authorization".to_string(), format!("Bearer {token}")))
        }
        Authentication::Basic { username, password } => Some((
            "authorization".to_string(),
            format!(
                "Basic {}",
                base64_encode(format!("{username}:{password}").as_bytes())
            ),
        )),
        Authentication::CustomHeader { name, value } => Some((name.clone(), value.clone())),
        _ => None,
    };
    if let Some((name, value)) = authorization {
        // The Authorization tab wins over a header typed by hand.
        metadata.retain(|entry| !entry.name.eq_ignore_ascii_case(&name));
        metadata.push(MetadataEntry { name, value });
    }
    metadata
}

fn base64_encode(input: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input)
}

fn schema_source(dto: &GrpcSchemaSourceDto) -> GrpcSchemaSource {
    GrpcCall::from(GrpcCallDto {
        service: String::new(),
        method: String::new(),
        schema_source: dto.clone(),
        deadline_ms: None,
    })
    .schema_source
}

/// Connection settings from the app's custom CAs and proxy configuration.
async fn connection_settings(
    target: &GrpcTarget,
    ca_store: &CustomCaCertificateStore,
    proxy: &ProxyApplyState,
) -> ConnectionSettings {
    let custom_ca_pems = ca_store
        .load()
        .map(|certificates| {
            certificates
                .into_iter()
                .map(|certificate| certificate.pem)
                .collect()
        })
        .unwrap_or_default();
    let proxy = match (proxy.plan(), url::Url::parse(&target.uri.to_string())) {
        (Some(plan), Ok(url)) => plan.proxy_for(&url).await,
        _ => None,
    };
    ConnectionSettings {
        custom_ca_pems,
        proxy,
    }
}

fn schema_key(target: &GrpcTarget, source: &GrpcSchemaSource, root: &Path) -> String {
    match source {
        GrpcSchemaSource::Reflection => format!("{}|reflection", target.uri),
        GrpcSchemaSource::ProtoFiles {
            files,
            import_paths,
        } => format!(
            "files|{}|{}|{}",
            root.display(),
            files.join(";"),
            import_paths.join(";")
        ),
    }
}

/// The schema for `source`: from this session's cache unless `refresh`,
/// else compiled from files or reflected. Only reflection needs `channel`;
/// `connect` opens one when it is `None`.
#[allow(clippy::too_many_arguments)]
async fn schema_for(
    source: &GrpcSchemaSource,
    target: &GrpcTarget,
    root: &Path,
    channel: Option<&Channel>,
    settings: &ConnectionSettings,
    metadata: &[MetadataEntry],
    cache: &GrpcSchemaCache,
    refresh: bool,
) -> Result<DescriptorPool, GrpcCommandError> {
    let key = schema_key(target, source, root);
    if !refresh && let Some(pool) = cache.get(&key) {
        return Ok(pool);
    }
    let pool = match source {
        GrpcSchemaSource::Reflection => {
            let channel = match channel {
                Some(channel) => channel.clone(),
                None => connect(target, settings).await?,
            };
            reflect(channel, metadata).await?
        }
        GrpcSchemaSource::ProtoFiles {
            files,
            import_paths,
        } => {
            let root = root.to_path_buf();
            let files = files.clone();
            let import_paths = import_paths.clone();
            tauri::async_runtime::spawn_blocking(move || {
                compile_workspace_proto_files(&root, &files, &import_paths)
            })
            .await
            .map_err(|error| GrpcCommandError::Schema {
                message: error.to_string(),
            })??
        }
    };
    cache.insert(key, pool.clone());
    Ok(pool)
}

/// Collected execution for runners and flows. There is no interactive sender:
/// client/bidirectional calls send their saved message and half-close.
pub(crate) async fn execute_saved_request(
    request: &Request,
    root: &Path,
    app: Option<&tauri::AppHandle>,
) -> Result<Response, alcy_domain::ExecutionError> {
    async fn execute(
        request: &Request,
        root: &Path,
        app: Option<&tauri::AppHandle>,
    ) -> Result<Response, GrpcCommandError> {
        let target = GrpcTarget::parse(request.endpoint.url())?;
        let metadata = metadata_of(request);
        let fallback_cache = GrpcSchemaCache::default();
        let cache_state = app.map(|app| app.state::<GrpcSchemaCache>());
        let cache = cache_state.as_deref().unwrap_or(&fallback_cache);
        let settings = match app {
            Some(app) => {
                connection_settings(
                    &target,
                    &app.state::<CustomCaCertificateStore>(),
                    &app.state::<ProxyApplyState>(),
                )
                .await
            }
            None => ConnectionSettings::default(),
        };
        let channel = connect(&target, &settings).await?;
        let pool = schema_for(
            &request.grpc.schema_source,
            &target,
            root,
            Some(&channel),
            &settings,
            &metadata,
            cache,
            false,
        )
        .await?;
        let method = find_method(&pool, &request.grpc.service, &request.grpc.method)?;
        let default_timeout = app
            .and_then(|app| app.state::<GeneralSettingsStore>().load().ok())
            .and_then(|settings| settings.request_timeout.duration());
        let deadline = request
            .grpc
            .deadline_ms
            .map(Duration::from_millis)
            .or(default_timeout);
        let mut call = start_call(channel, &method, &metadata, deadline)?;
        call.send_json(&request.document.body).await?;
        Ok(response_of(&call.run(|_| {}, None).await))
    }
    execute(request, root, app)
        .await
        .map_err(|error| match error {
            GrpcCommandError::Connection { message } => {
                alcy_domain::ExecutionError::network(message)
            }
            GrpcCommandError::Cancelled => alcy_domain::ExecutionError::Cancelled,
            GrpcCommandError::InvalidRequest { message, .. }
            | GrpcCommandError::Schema { message } => {
                alcy_domain::ExecutionError::InvalidRequest(message)
            }
            GrpcCommandError::Script { phase, message } => {
                alcy_domain::ExecutionError::Script(format!("{phase}: {message}"))
            }
        })
}

/// Runs `work` until it ends or the execution is cancelled.
async fn cancellable<T>(
    registry: &ExecutionRegistry,
    execution_id: &str,
    work: impl Future<Output = Result<T, GrpcCommandError>>,
) -> Result<T, GrpcCommandError> {
    let (sender, receiver) = oneshot::channel();
    registry.register(execution_id.to_string(), sender);
    let result = tokio::select! {
        result = work => result,
        () = cancellation_signal(receiver) => Err(GrpcCommandError::Cancelled),
    };
    registry.remove(execution_id);
    result
}

#[tauri::command]
pub async fn load_grpc_schema(
    input: LoadGrpcSchemaInput,
    registry: State<'_, ExecutionRegistry>,
    cache: State<'_, GrpcSchemaCache>,
    ca_store: State<'_, CustomCaCertificateStore>,
    proxy: State<'_, ProxyApplyState>,
) -> Result<SchemaSummary, GrpcCommandError> {
    let execution_id = input.execution_id.clone();
    let result = cancellable(&registry, &execution_id, async {
        let source = schema_source(&input.connection.schema_source);
        let root = std::path::PathBuf::from(&input.connection.root_path);
        let resolved = resolve_connection(input.connection, GrpcCall::default(), "").await?;
        let target = GrpcTarget::parse(resolved.request.endpoint.url())?;
        let metadata = metadata_of(&resolved.request);
        let settings = connection_settings(&target, &ca_store, &proxy).await;
        let pool = schema_for(
            &source,
            &target,
            &root,
            None,
            &settings,
            &metadata,
            &cache,
            input.force_refresh,
        )
        .await?;
        Ok(describe(&pool))
    })
    .await;
    if let Err(error) = &result {
        log::warn!(target: "alcy::request", "grpc schema {execution_id}: falhou ({error:?})");
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_grpc_request(
    input: ExecuteGrpcRequestInput,
    on_event: IpcChannel<GrpcCallEventDto>,
    registry: State<'_, ExecutionRegistry>,
    calls: State<'_, GrpcCalls>,
    cache: State<'_, GrpcSchemaCache>,
    ca_store: State<'_, CustomCaCertificateStore>,
    proxy: State<'_, ProxyApplyState>,
    general_settings: State<'_, GeneralSettingsStore>,
    body_cache: State<'_, ResponseBodyCache>,
    history: State<'_, HistoryPreferencesState>,
) -> Result<ExecuteGrpcRequestOutput, ExecutionFailure<GrpcCommandError>> {
    let mut effects = ScriptEffects::default();
    let result: Result<ExecuteGrpcRequestOutput, GrpcCommandError> = async {
        let execution_id = input.execution_id.clone();
        log::info!(
            target: "alcy::request",
            "grpc {execution_id}: chamando {}/{} em {}",
            input.service,
            input.method,
            crate::logging::url_for_log(&input.connection.endpoint)
        );
        let root_path = input.connection.root_path.clone();
        let history_source = (input.connection.request_id.clone(), input.tab_id.clone());
        let mut connection = input.connection;
        let mut scopes = scopes_from_dto(std::mem::take(&mut connection.variable_scopes))?;
        let mut scripted = ScriptedRequest {
            url: connection.endpoint.clone(),
            method: "post".to_string(),
            body: input.message,
            headers: connection.headers.clone(),
            grpc: Some(alcy_scripting::ScriptGrpcRequest {
                service: input.service,
                method: input.method,
            }),
            websocket: None,
        };
        run_pre_request(
            &input.pre_request_script,
            &mut scripted,
            &mut connection.environment_variables,
            &mut scopes,
            &mut effects,
        )
        .await?;
        connection.endpoint = scripted.url.clone();
        connection.headers = scripted.headers.clone();
        let environment = connection.environment_variables.clone();
        connection.environment_variables = with_scoped_variables(&environment, &scopes);
        let source = schema_source(&connection.schema_source);
        let grpc = scripted
            .grpc
            .as_ref()
            .ok_or_else(|| invalid("missing gRPC call"))?;
        let call = GrpcCall {
            service: grpc.service.clone(),
            method: grpc.method.clone(),
            schema_source: source.clone(),
            deadline_ms: input.deadline_ms,
        };
        let resolved = resolve_connection(connection, call.clone(), &scripted.body).await?;
        let request = resolved.request;
        let history_request = history_request(&request, resolved.redacted.as_ref()).cloned();
        let default_timeout = general_settings
            .load()
            .ok()
            .and_then(|settings| settings.request_timeout.duration());
        let send_event = |event: GrpcCallEventDto| {
            let _ = on_event.send(event);
        };

        let outcome = cancellable(&registry, &execution_id, async {
            let target = GrpcTarget::parse(request.endpoint.url())?;
            let metadata = metadata_of(&request);
            let settings = connection_settings(&target, &ca_store, &proxy).await;
            let channel = connect(&target, &settings).await?;
            let pool = schema_for(
                &source,
                &target,
                Path::new(&root_path),
                Some(&channel),
                &settings,
                &metadata,
                &cache,
                false,
            )
            .await?;
            let method = find_method(&pool, &call.service, &call.method)?;
            let kind = MethodKind::of(&method);
            // The configured timeout fits a request and its reply; a stream may
            // rightly stay open longer, so it only ends at an explicit deadline.
            let deadline = call
                .deadline_ms
                .map(Duration::from_millis)
                .or(default_timeout.filter(|_| kind == MethodKind::Unary));
            let mut handle = start_call(channel, &method, &metadata, deadline)?;
            handle.send_json(&request.document.body).await?;
            let interactive = matches!(
                kind,
                MethodKind::ClientStreaming | MethodKind::BidiStreaming
            );
            let actions = interactive.then(|| {
                let (sender, receiver) = mpsc::channel(8);
                calls.insert(
                    &execution_id,
                    sender,
                    with_scoped_variables(&environment, &scopes),
                );
                receiver
            });
            send_event(GrpcCallEventDto::Started { kind });
            let outcome = handle
                .run(|event| send_event(GrpcCallEventDto::from(event)), actions)
                .await;
            calls.remove(&execution_id);
            Ok(outcome)
        })
        .await;
        calls.remove(&execution_id);

        let mut script_error = None;
        let history_outcome = match &outcome {
            Ok(outcome) => {
                let response = response_of(outcome);
                script_error = run_post_response(
                    &input.post_response_script,
                    &scripted,
                    &response,
                    &environment,
                    &scopes,
                    &mut effects,
                )
                .await
                .err();
                Some(HistoryOutcome::Success(response))
            }
            Err(GrpcCommandError::Connection { message }) => Some(HistoryOutcome::Failed {
                kind: HistoryFailureKind::Network,
                message: message.clone(),
            }),
            Err(_) => None,
        };
        if let (Some(history_outcome), Some(history_request)) = (history_outcome, history_request) {
            let preferences = history.get();
            if !preferences.retention.is_disabled() {
                drop(record_history(
                    &root_path,
                    execution_id.clone(),
                    &history_request,
                    history_outcome,
                    history_source,
                    preferences,
                ));
            }
        }

        let outcome = outcome.inspect_err(|error| {
            log::warn!(target: "alcy::request", "grpc {execution_id}: falhou ({error:?})");
        })?;
        let summary = summarize(&outcome);
        log::info!(
            target: "alcy::request",
            "grpc {execution_id}: {} em {} ms",
            summary.status.code_name,
            summary.duration_ms
        );
        Ok(ExecuteGrpcRequestOutput {
            scoped_changes: effects.scoped_output(),
            environment_changes: std::mem::take(&mut effects.environment_changes),
            script_logs: std::mem::take(&mut effects.logs),
            test_results: std::mem::take(&mut effects.tests),
            script_error,
            body: response_body_output(
                &execution_id,
                summary.body,
                summary.size_bytes,
                &body_cache,
            ),
            status: summary.status,
            duration_ms: summary.duration_ms,
            size_bytes: summary.size_bytes,
            message_count: summary.message_count,
            headers: summary.headers,
            trailers: summary.trailers,
        })
    }
    .await;
    result.map_err(|error| ExecutionFailure::new(error, effects))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendGrpcMessageInput {
    pub execution_id: String,
    /// The next request message, as JSON.
    pub message: String,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    pub variable_scopes: Vec<VariableScopeDto>,
}

fn resolve_stream_message(input: &SendGrpcMessageInput) -> Result<String, GrpcCommandError> {
    let scopes = scopes_from_dto(input.variable_scopes.clone())?;
    let variables = with_scoped_variables(&input.environment_variables, &scopes)
        .iter()
        .map(|variable| {
            EnvironmentVariable::new(&variable.name, &variable.value, variable.sensitive)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(resolve_variables(&input.message, &variables)?)
}

/// Sends one more message on a client-streaming call in progress.
#[tauri::command]
pub async fn send_grpc_message(
    mut input: SendGrpcMessageInput,
    calls: State<'_, GrpcCalls>,
) -> Result<(), GrpcCommandError> {
    let sender = calls
        .get(&input.execution_id)
        .ok_or_else(|| invalid("a chamada não aceita mais mensagens"))?;
    input.environment_variables = sender.variables;
    input.variable_scopes.clear();
    let message = resolve_stream_message(&input)?;
    let (reply, result) = oneshot::channel();
    sender
        .sender
        .send(ClientAction::Send(message, reply))
        .await
        .map_err(|_| invalid("a chamada não aceita mais mensagens"))?;
    result
        .await
        .map_err(|_| invalid("a chamada não aceita mais mensagens"))?
        .map_err(GrpcCommandError::from)
}

/// Ends the request stream of a call in progress; the server then finishes
/// the call.
#[tauri::command]
pub async fn close_grpc_send(
    execution_id: String,
    calls: State<'_, GrpcCalls>,
) -> Result<(), GrpcCommandError> {
    if let Some(sender) = calls.get(&execution_id) {
        let _ = sender.sender.send(ClientAction::Close).await;
    }
    Ok(())
}

struct Summary {
    status: GrpcStatus,
    duration_ms: u64,
    size_bytes: usize,
    message_count: usize,
    body: String,
    headers: Vec<MetadataEntry>,
    trailers: Vec<MetadataEntry>,
}

fn summarize(outcome: &CallOutcome) -> Summary {
    let mut summary = Summary {
        status: GrpcStatus {
            code: 2,
            code_name: "UNKNOWN".to_string(),
            message: "a chamada terminou sem status".to_string(),
        },
        duration_ms: 0,
        size_bytes: 0,
        message_count: 0,
        body: String::new(),
        headers: Vec::new(),
        trailers: Vec::new(),
    };
    let mut messages = Vec::new();
    for event in &outcome.events {
        match event {
            GrpcEvent::Headers { metadata, .. } => summary.headers = metadata.clone(),
            GrpcEvent::Received {
                json, size_bytes, ..
            } => {
                summary.size_bytes += size_bytes;
                messages.push(json.as_str());
            }
            GrpcEvent::Finished {
                status,
                trailers,
                elapsed_ms,
            } => {
                summary.status = status.clone();
                summary.trailers = trailers.clone();
                summary.duration_ms = *elapsed_ms;
            }
            GrpcEvent::Sent { .. } => {}
        }
    }
    summary.message_count = messages.len();
    summary.body = match messages.as_slice() {
        [] => String::new(),
        [single] => (*single).to_string(),
        many => format!("[\n{}\n]", many.join(",\n")),
    };
    summary
}

/// The call as a history response: the received messages as the body and
/// the metadata as headers, with the status as gRPC carries it on the wire
/// (`grpc-status`/`grpc-message` trailers).
fn response_of(outcome: &CallOutcome) -> Response {
    let summary = summarize(outcome);
    let mut headers: Vec<ResponseHeader> = summary
        .headers
        .iter()
        .chain(summary.trailers.iter())
        .filter(|entry| {
            !entry.name.eq_ignore_ascii_case("grpc-status")
                && !entry.name.eq_ignore_ascii_case("grpc-message")
        })
        .map(|entry| ResponseHeader {
            name: entry.name.clone(),
            value: entry.value.clone(),
        })
        .collect();
    headers.push(ResponseHeader {
        name: "grpc-status".to_string(),
        value: summary.status.code.to_string(),
    });
    if !summary.status.message.is_empty() {
        headers.push(ResponseHeader {
            name: "grpc-message".to_string(),
            value: summary.status.message.clone(),
        });
    }
    let mut response = Response::new(
        200,
        summary.duration_ms,
        summary.body,
        headers,
        ResponseMetadata::default(),
    );
    response.grpc = Some(Box::new(alcy_domain::GrpcResponseStatus {
        code: summary.status.code,
        code_name: summary.status.code_name,
        message: summary.status.message,
        trailers: summary
            .trailers
            .into_iter()
            .map(|entry| ResponseHeader {
                name: entry.name,
                value: entry.value,
            })
            .collect(),
    }));
    response.size_bytes = summary.size_bytes;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(
        authentication: AuthenticationInput,
        headers: Vec<HeaderInput>,
    ) -> GrpcConnectionInput {
        GrpcConnectionInput {
            root_path: "/ws".to_string(),
            endpoint: "{{host}}:50051".to_string(),
            schema_source: GrpcSchemaSourceDto::Reflection,
            headers,
            authentication,
            request_id: None,
            environment_variables: vec![
                EnvironmentVariableDto {
                    name: "host".to_string(),
                    value: "localhost".to_string(),
                    sensitive: false,
                },
                EnvironmentVariableDto {
                    name: "token".to_string(),
                    value: "s3cret".to_string(),
                    sensitive: true,
                },
            ],
            variable_scopes: vec![],
        }
    }

    fn header(name: &str, value: &str, enabled: bool) -> HeaderInput {
        HeaderInput {
            name: name.to_string(),
            value: value.to_string(),
            enabled,
        }
    }

    #[tokio::test]
    async fn resolves_variables_and_redacts_sensitive_ones_for_history() {
        let input = connection(
            AuthenticationInput::Bearer {
                token: "{{token}}".to_string(),
            },
            vec![
                header("x-tenant", "acme", true),
                header("x-off", "1", false),
            ],
        );
        let resolved = resolve_connection(input, GrpcCall::default(), r#"{"token": "{{token}}"}"#)
            .await
            .unwrap();

        assert_eq!(resolved.request.endpoint.url(), "localhost:50051");
        assert_eq!(resolved.request.document.protocol, ProtocolId::Grpc);
        assert_eq!(resolved.request.document.body, r#"{"token": "s3cret"}"#);
        let redacted = resolved.redacted.unwrap().unwrap();
        assert_eq!(redacted.document.body, r#"{"token": "{{token}}"}"#);
        assert_eq!(
            metadata_of(&resolved.request),
            vec![
                MetadataEntry {
                    name: "x-tenant".to_string(),
                    value: "acme".to_string()
                },
                MetadataEntry {
                    name: "authorization".to_string(),
                    value: "Bearer s3cret".to_string()
                },
            ]
        );
    }

    #[tokio::test]
    async fn basic_and_custom_header_authentication_become_metadata() {
        let basic = resolve_connection(
            connection(
                AuthenticationInput::Basic {
                    username: "ana".to_string(),
                    password: "pw".to_string(),
                },
                vec![header("Authorization", "typed by hand", true)],
            ),
            GrpcCall::default(),
            "",
        )
        .await
        .unwrap();
        assert_eq!(
            metadata_of(&basic.request),
            vec![MetadataEntry {
                name: "authorization".to_string(),
                value: "Basic YW5hOnB3".to_string()
            }]
        );

        let custom = resolve_connection(
            connection(
                AuthenticationInput::CustomHeader {
                    name: "x-api-key".to_string(),
                    value: "k".to_string(),
                },
                vec![],
            ),
            GrpcCall::default(),
            "",
        )
        .await
        .unwrap();
        assert_eq!(
            metadata_of(&custom.request),
            vec![MetadataEntry {
                name: "x-api-key".to_string(),
                value: "k".to_string()
            }]
        );
    }

    #[tokio::test]
    async fn digest_and_oauth2_are_refused_clearly() {
        for authentication in [
            AuthenticationInput::Digest {
                username: "a".to_string(),
                password: "b".to_string(),
            },
            AuthenticationInput::OAuth2ClientCredentials {
                client_id: "a".to_string(),
                client_secret: "b".to_string(),
                token_url: "https://auth".to_string(),
                scope: String::new(),
            },
        ] {
            let error =
                resolve_connection(connection(authentication, vec![]), GrpcCall::default(), "")
                    .await
                    .err()
                    .unwrap();
            assert!(matches!(error, GrpcCommandError::InvalidRequest { .. }));
        }
    }

    #[test]
    fn resolves_defined_variables_and_preserves_unknown_ones_in_additional_messages() {
        let mut input = SendGrpcMessageInput {
            execution_id: "stream".to_string(),
            message: r#"{"name":"{{name}}"}"#.to_string(),
            environment_variables: vec![EnvironmentVariableDto {
                name: "name".to_string(),
                value: "Ana".to_string(),
                sensitive: false,
            }],
            variable_scopes: vec![],
        };
        assert_eq!(resolve_stream_message(&input).unwrap(), r#"{"name":"Ana"}"#);
        input.environment_variables.clear();
        assert_eq!(
            resolve_stream_message(&input).unwrap(),
            r#"{"name":"{{name}}"}"#
        );
    }

    #[test]
    fn caps_large_messages_in_live_events_on_a_char_boundary() {
        assert_eq!(capped("{}"), ("{}".to_string(), false));
        let large = format!("\"{}\"", "é".repeat(MAX_EVENT_JSON_BYTES));
        let (json, truncated) = capped(&large);
        assert!(truncated);
        assert!(json.len() <= MAX_EVENT_JSON_BYTES);
        assert!(large.starts_with(&json));
    }

    #[test]
    fn summarizes_one_or_many_messages_and_maps_the_status_into_history_headers() {
        let status = GrpcStatus {
            code: 5,
            code_name: "NOT_FOUND".to_string(),
            message: "no such user".to_string(),
        };
        let event = |index: usize, json: &str| GrpcEvent::Received {
            index,
            json: json.to_string(),
            size_bytes: 3,
            elapsed_ms: 1,
        };
        let outcome = CallOutcome {
            events: vec![
                event(0, "{\"a\":1}"),
                event(1, "{\"a\":2}"),
                GrpcEvent::Finished {
                    status: status.clone(),
                    trailers: vec![MetadataEntry {
                        name: "x-reason".to_string(),
                        value: "gone".to_string(),
                    }],
                    elapsed_ms: 12,
                },
            ],
        };

        let summary = summarize(&outcome);
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.size_bytes, 6);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&summary.body).unwrap(),
            serde_json::json!([{"a":1},{"a":2}])
        );

        let response = response_of(&outcome);
        let headers: Vec<(&str, &str)> = response
            .headers
            .iter()
            .map(|header| (header.name.as_str(), header.value.as_str()))
            .collect();
        assert_eq!(
            headers,
            vec![
                ("x-reason", "gone"),
                ("grpc-status", "5"),
                ("grpc-message", "no such user")
            ]
        );
        assert_eq!(response.duration_ms, 12);
        assert_eq!(response.size_bytes, 6);
    }
}
