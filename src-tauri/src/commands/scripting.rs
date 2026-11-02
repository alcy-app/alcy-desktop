//! Adapt commands to plain script values, run off async workers, and accumulate environment/scoped writes, logs and tests (spec 0054).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use alcy_app::RequestExecutor;
use alcy_domain::{
    BodyEncoding, Collection, Endpoint, ExecutionError, HeaderEntry, HttpMethod, Request, Response,
    ScopedVariableChange, VariableScope, VariableScopeKind, apply_scoped_changes,
    record_scoped_change, variable_scopes,
};
use alcy_script_packages::{
    PackageCache, PackageError, esm_sh_client, fetch_from_esm_sh, resolve_packages,
};
use alcy_scripting::{
    ScriptError, ScriptGrpcRequest, ScriptGrpcResponse, ScriptHeader, ScriptInput, ScriptIteration,
    ScriptOutput, ScriptPackages, ScriptPhase, ScriptRequest, ScriptResponse, ScriptVariable,
    ScriptWebSocketRequest, ScriptWebSocketResponse, npm_requests, run_script,
};
use serde::Serialize;

use crate::commands::environments::EnvironmentVariableDto;
use crate::commands::execute_graphql_request::HeaderInput;
use crate::commands::execute_rest_request::HttpMethodInput;
use crate::commands::protocol_dispatching_executor::ProtocolDispatchingExecutor;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentChangeOutput {
    pub name: String,
    /// Some writes a value; None removes it.
    pub value: Option<String>,
}

/// Collection/folder write from the script API; node_id identifies scope (ADR 0031).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScopedChangeOutput {
    pub node_id: String,
    pub name: String,
    /// Some writes a value; None removes it.
    pub value: Option<String>,
}

impl From<ScopedVariableChange> for ScopedChangeOutput {
    fn from(change: ScopedVariableChange) -> Self {
        Self {
            node_id: change.node_id,
            name: change.name,
            value: change.value,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptErrorOutput {
    pub phase: String,
    pub message: String,
}

/// Resultado de um `al.test` (spec 0072).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTestOutput {
    pub name: String,
    pub passed: bool,
    pub message: Option<String>,
}

impl From<ScriptError> for ScriptErrorOutput {
    fn from(error: ScriptError) -> Self {
        Self {
            phase: error.phase.as_str().to_string(),
            message: error.message,
        }
    }
}

/// Flatten execution errors with effects already produced by completed scripts so the UI applies writes/logs/tests even without a response.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFailure<E> {
    #[serde(flatten)]
    pub error: E,
    pub environment_changes: Vec<EnvironmentChangeOutput>,
    pub scoped_changes: Vec<ScopedChangeOutput>,
    pub script_logs: Vec<String>,
    pub test_results: Vec<ScriptTestOutput>,
}

impl<E> ExecutionFailure<E> {
    pub(crate) fn new(error: impl Into<E>, effects: ScriptEffects) -> Self {
        Self {
            error: error.into(),
            scoped_changes: effects.scoped_output(),
            environment_changes: effects.environment_changes,
            script_logs: effects.logs,
            test_results: effects.tests,
        }
    }
}

/// Editable script fields before template interpolation.
pub(crate) struct ScriptedRequest {
    pub grpc: Option<ScriptGrpcRequest>,
    pub websocket: Option<ScriptWebSocketRequest>,
    pub url: String,
    pub method: String,
    pub body: String,
    pub headers: Vec<HeaderInput>,
}

impl ScriptedRequest {
    /// Build script-visible fields from saved requests.
    pub(crate) fn from_request(request: &Request) -> Self {
        Self {
            grpc: (request.document.protocol == alcy_domain::ProtocolId::Grpc).then(|| {
                ScriptGrpcRequest {
                    service: request.grpc.service.clone(),
                    method: request.grpc.method.clone(),
                }
            }),
            websocket: (request.document.protocol == alcy_domain::ProtocolId::WebSocket).then(
                || ScriptWebSocketRequest {
                    subprotocols: request.websocket.subprotocols.clone(),
                },
            ),
            url: request.endpoint.url().to_string(),
            method: HttpMethodInput::from(request.method).as_str().to_string(),
            body: request.document.body.clone(),
            headers: request
                .headers
                .iter()
                .map(|header| HeaderInput {
                    name: header.name().to_string(),
                    value: header.value().to_string(),
                    enabled: header.enabled,
                })
                .collect(),
        }
    }

    /// Apply pre-request URL/body/header/method edits, including gRPC service/method.
    pub(crate) fn apply_to(&self, request: &Request) -> Result<Request, ExecutionError> {
        let mut effective = request.clone();
        effective.endpoint = Endpoint::new(self.url.clone())
            .map_err(|error| ExecutionError::Script(error.to_string()))?;
        effective.document.body = self.body.clone();
        if let Some(grpc) = &self.grpc {
            effective.grpc.service = grpc.service.clone();
            effective.grpc.method = grpc.method.clone();
        }
        if let Some(websocket) = &self.websocket {
            effective.websocket.subprotocols = websocket.subprotocols.clone();
        }
        effective.headers = self
            .headers
            .iter()
            .map(|header| HeaderEntry::new(&header.name, &header.value, header.enabled))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ExecutionError::Script(error.to_string()))?;
        if let Some(method) = HttpMethodInput::parse(&self.method) {
            effective.method = HttpMethod::from(method);
        }
        Ok(effective)
    }
}

/// How a WebSocket close is named to scripts and the interface.
pub(crate) fn closed_by_name(closed_by: alcy_domain::WebSocketClosedBy) -> &'static str {
    match closed_by {
        alcy_domain::WebSocketClosedBy::Client => "client",
        alcy_domain::WebSocketClosedBy::Server => "server",
        alcy_domain::WebSocketClosedBy::Transport => "transport",
        alcy_domain::WebSocketClosedBy::Rejected => "rejected",
    }
}

/// Accumulated execution script effects.
#[derive(Default)]
pub(crate) struct ScriptEffects {
    pub environment_changes: Vec<EnvironmentChangeOutput>,
    /// Final value of each collection/folder write.
    pub scoped_changes: Vec<ScopedVariableChange>,
    pub logs: Vec<String>,
    pub tests: Vec<ScriptTestOutput>,
    /// Ephemeral state between phases/requests in one run.
    pub(crate) local_variables: Vec<ScriptVariable>,
    pub(crate) runtime_variables: Vec<ScriptVariable>,
}

impl ScriptEffects {
    pub(crate) fn scoped_output(&self) -> Vec<ScopedChangeOutput> {
        self.scoped_changes
            .iter()
            .cloned()
            .map(ScopedChangeOutput::from)
            .collect()
    }

    fn record(&mut self, output: &ScriptOutput, scopes: &[VariableScope]) {
        for change in scoped_changes_of(output, scopes) {
            record_scoped_change(&mut self.scoped_changes, change);
        }
        for name in &output.changed_variables {
            let Some(variable) = output.environment.iter().find(|v| &v.name == name) else {
                continue;
            };
            match self
                .environment_changes
                .iter_mut()
                .find(|c| &c.name == name)
            {
                Some(existing) => existing.value = Some(variable.value.clone()),
                None => self.environment_changes.push(EnvironmentChangeOutput {
                    name: name.clone(),
                    value: Some(variable.value.clone()),
                }),
            }
        }
        for name in &output.removed_variables {
            match self
                .environment_changes
                .iter_mut()
                .find(|change| &change.name == name)
            {
                Some(change) => change.value = None,
                None => self.environment_changes.push(EnvironmentChangeOutput {
                    name: name.clone(),
                    value: None,
                }),
            }
        }
        self.logs.extend(output.logs.iter().cloned());
        self.tests
            .extend(output.tests.iter().map(|test| ScriptTestOutput {
                name: test.name.clone(),
                passed: test.passed,
                message: test.message.clone(),
            }));
    }
}

fn script_headers(headers: &[HeaderInput]) -> Vec<ScriptHeader> {
    headers
        .iter()
        .filter(|header| header.enabled)
        .map(|header| ScriptHeader {
            name: header.name.clone(),
            value: header.value.clone(),
        })
        .collect()
}

/// al.collection exposes the first scope if it is a collection.
fn collection_scope(scopes: &[VariableScope]) -> Option<&VariableScope> {
    scopes
        .first()
        .filter(|scope| scope.kind == VariableScopeKind::Collection)
}

/// al.folder exposes the last scope if it is the direct parent folder.
fn folder_scope(scopes: &[VariableScope]) -> Option<&VariableScope> {
    scopes
        .last()
        .filter(|scope| scope.kind == VariableScopeKind::Folder)
}

fn script_folder_scope(scopes: &[VariableScope]) -> Option<Vec<ScriptVariable>> {
    let folders: Vec<_> = scopes
        .iter()
        .filter(|scope| scope.kind == VariableScopeKind::Folder)
        .collect();
    if folders.is_empty() {
        return None;
    }
    let mut values: Vec<ScriptVariable> = Vec::new();
    for scope in folders {
        for variable in &scope.variables {
            if let Some(existing) = values.iter_mut().find(|item| item.name == variable.name()) {
                existing.value = variable.value().to_string();
            } else {
                values.push(ScriptVariable {
                    name: variable.name().to_string(),
                    value: variable.value().to_string(),
                });
            }
        }
    }
    Some(values)
}

fn script_scope(scope: Option<&VariableScope>) -> Option<Vec<ScriptVariable>> {
    scope.map(|scope| {
        scope
            .variables
            .iter()
            .map(|variable| ScriptVariable {
                name: variable.name().to_string(),
                value: variable.value().to_string(),
            })
            .collect()
    })
}

/// O que o script gravou em `al.collection`/`al.folder`, com o id da camada.
fn scoped_changes_of(output: &ScriptOutput, scopes: &[VariableScope]) -> Vec<ScopedVariableChange> {
    let changes =
        |scope: Option<&VariableScope>, names: &[String], values: &Option<Vec<ScriptVariable>>| {
            let (Some(scope), Some(values)) = (scope, values) else {
                return Vec::new();
            };
            names
                .iter()
                .map(|name| ScopedVariableChange {
                    node_id: scope.node_id.clone(),
                    name: name.clone(),
                    value: values
                        .iter()
                        .find(|v| &v.name == name)
                        .map(|variable| variable.value.clone()),
                })
                .collect::<Vec<_>>()
        };
    let mut all = changes(
        collection_scope(scopes),
        &output.changed_collection,
        &output.collection,
    );
    all.extend(changes(
        folder_scope(scopes),
        &output.changed_folder,
        &output.folder,
    ));
    all
}

fn script_environment(environment: &[EnvironmentVariableDto]) -> Vec<ScriptVariable> {
    environment
        .iter()
        .map(|variable| ScriptVariable {
            name: variable.name.clone(),
            value: variable.value.clone(),
        })
        .collect()
}

/// Cache of npm packages for scripts (spec 0128), set once at startup. The
/// script runners are free functions shared by requests, the collection
/// runner and flows, so the cache is process-wide instead of command state.
static SCRIPT_PACKAGES: OnceLock<PackageCache> = OnceLock::new();

/// Registers the folder that caches npm packages required by scripts.
pub(crate) fn init_script_packages(dir: PathBuf) {
    let _ = SCRIPT_PACKAGES.set(PackageCache::new(dir));
}

/// Downloads (or reads from the cache) the npm packages `source` requires.
async fn script_packages(source: &str) -> Result<ScriptPackages, PackageError> {
    let names = npm_requests(source);
    if names.is_empty() {
        return Ok(ScriptPackages::default());
    }
    let cache = SCRIPT_PACKAGES
        .get()
        .ok_or_else(|| PackageError::Cache("cache de pacotes não inicializada".to_string()))?;
    let client = esm_sh_client()?;
    resolve_packages(&names, cache, |path| {
        let client = client.clone();
        async move { fetch_from_esm_sh(&client, &path).await }
    })
    .await
}

async fn run_blocking(
    phase: ScriptPhase,
    source: String,
    mut input: ScriptInput,
) -> Result<ScriptOutput, ScriptError> {
    // Packages are downloaded here, asynchronously and outside the
    // interpreter, which never touches the network.
    input.packages = Arc::new(
        script_packages(&source)
            .await
            .map_err(|error| ScriptError {
                phase,
                message: error.to_string(),
                line: None,
            })?,
    );
    tauri::async_runtime::spawn_blocking(move || run_script(phase, &source, &input))
        .await
        .unwrap_or_else(|error| {
            Err(ScriptError {
                phase,
                message: format!("falha ao executar o script: {error}"),
                line: None,
            })
        })
}

/// Run pre-request scripts, apply request/environment/scope edits, and accumulate effects.
pub(crate) async fn run_pre_request(
    source: &str,
    request: &mut ScriptedRequest,
    environment: &mut Vec<EnvironmentVariableDto>,
    scopes: &mut [VariableScope],
    effects: &mut ScriptEffects,
) -> Result<(), ScriptErrorOutput> {
    run_pre_request_in(
        source,
        request,
        environment,
        scopes,
        &ScriptIteration::default(),
        effects,
    )
    .await
}

/// Run pre-request logic within a runner iteration.
pub(crate) async fn run_pre_request_in(
    source: &str,
    request: &mut ScriptedRequest,
    environment: &mut Vec<EnvironmentVariableDto>,
    scopes: &mut [VariableScope],
    iteration: &ScriptIteration,
    effects: &mut ScriptEffects,
) -> Result<(), ScriptErrorOutput> {
    effects.local_variables.clear();
    if source.trim().is_empty() {
        return Ok(());
    }
    let input = ScriptInput {
        request: ScriptRequest {
            grpc: request.grpc.clone(),
            websocket: request.websocket.clone(),
            url: request.url.clone(),
            method: request.method.clone(),
            body: request.body.clone(),
            headers: script_headers(&request.headers),
        },
        response: None,
        environment: script_environment(environment),
        collection: script_scope(collection_scope(scopes)),
        folder: script_folder_scope(scopes),
        local: effects.local_variables.clone(),
        runtime: effects.runtime_variables.clone(),
        iteration: iteration.clone(),
        packages: Default::default(),
    };
    let output = run_blocking(ScriptPhase::PreRequest, source.to_string(), input).await?;

    request.grpc = output.request.grpc.clone();
    request.websocket = output.request.websocket.clone();
    request.url = output.request.url.clone();
    request.method = output.request.method.clone();
    request.body = output.request.body.clone();
    // Scripts do not see disabled headers; preserve them unchanged.
    let mut headers: Vec<HeaderInput> = request
        .headers
        .iter()
        .filter(|header| !header.enabled)
        .cloned()
        .collect();
    headers.extend(output.request.headers.iter().map(|header| HeaderInput {
        name: header.name.clone(),
        value: header.value.clone(),
        enabled: true,
    }));
    request.headers = headers;

    for name in &output.changed_variables {
        let Some(variable) = output.environment.iter().find(|v| &v.name == name) else {
            environment.retain(|variable| &variable.name != name);
            continue;
        };
        match environment.iter_mut().find(|v| &v.name == name) {
            Some(existing) => existing.value = variable.value.clone(),
            None => environment.push(EnvironmentVariableDto {
                name: name.clone(),
                value: variable.value.clone(),
                sensitive: false,
            }),
        }
    }
    apply_scoped_changes(scopes, &scoped_changes_of(&output, scopes));
    effects.local_variables = output.local.clone();
    effects.runtime_variables = output.runtime.clone();
    effects.record(&output, scopes);
    Ok(())
}

fn status_text(status: u16) -> &'static str {
    match status {
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// Run post-response logic with read-only requests and accumulate effects.
pub(crate) async fn run_post_response(
    source: &str,
    request: &ScriptedRequest,
    response: &Response,
    environment: &[EnvironmentVariableDto],
    scopes: &[VariableScope],
    effects: &mut ScriptEffects,
) -> Result<(), ScriptErrorOutput> {
    run_post_response_in(
        source,
        request,
        response,
        environment,
        scopes,
        &ScriptIteration::default(),
        effects,
    )
    .await
}

/// Run post-response logic within a runner iteration.
pub(crate) async fn run_post_response_in(
    source: &str,
    request: &ScriptedRequest,
    response: &Response,
    environment: &[EnvironmentVariableDto],
    scopes: &[VariableScope],
    iteration: &ScriptIteration,
    effects: &mut ScriptEffects,
) -> Result<(), ScriptErrorOutput> {
    if source.trim().is_empty() {
        return Ok(());
    }
    let input = ScriptInput {
        request: ScriptRequest {
            grpc: request.grpc.clone(),
            websocket: request.websocket.clone(),
            url: request.url.clone(),
            method: request.method.clone(),
            body: request.body.clone(),
            headers: script_headers(&request.headers),
        },
        response: Some(ScriptResponse {
            grpc: response.grpc.as_ref().map(|grpc| ScriptGrpcResponse {
                code: grpc.code,
                code_name: grpc.code_name.clone(),
                message: grpc.message.clone(),
                trailers: grpc
                    .trailers
                    .iter()
                    .map(|entry| ScriptHeader {
                        name: entry.name.clone(),
                        value: entry.value.clone(),
                    })
                    .collect(),
            }),
            websocket: response
                .websocket
                .as_ref()
                .map(|websocket| ScriptWebSocketResponse {
                    close_code: websocket.close_code,
                    close_reason: websocket.close_reason.clone(),
                    closed_by: closed_by_name(websocket.closed_by).to_string(),
                    subprotocol: websocket.subprotocol.clone(),
                    sent: websocket.sent,
                    received: websocket.received,
                }),
            status: response.status_code,
            status_text: status_text(response.status_code).to_string(),
            time_ms: response.duration_ms,
            size_bytes: response.size_bytes,
            url: response
                .final_url
                .clone()
                .unwrap_or_else(|| request.url.clone()),
            headers: response
                .headers
                .iter()
                .map(|header| ScriptHeader {
                    name: header.name.clone(),
                    value: header.value.clone(),
                })
                .collect(),
            body: match response.encoding {
                BodyEncoding::Text => Some(response.body.clone()),
                BodyEncoding::Base64 => None,
            },
        }),
        environment: script_environment(environment),
        collection: script_scope(collection_scope(scopes)),
        folder: script_folder_scope(scopes),
        local: effects.local_variables.clone(),
        runtime: effects.runtime_variables.clone(),
        iteration: iteration.clone(),
        packages: Default::default(),
    };
    let output = run_blocking(ScriptPhase::PostResponse, source.to_string(), input).await?;
    effects.local_variables = output.local.clone();
    effects.runtime_variables = output.runtime.clone();
    effects.record(&output, scopes);
    Ok(())
}

/// Flow scripts wrap already-resolved requests. Accumulate writes for later scripts and return effects at run end; template interpolation retains existing flow environment semantics.
pub(crate) struct ScriptingExecutor<'a> {
    inner: ProtocolDispatchingExecutor<'a>,
    /// Collections provide saved-request collection/folder script scopes.
    collections: &'a [Collection],
    environment: Mutex<Vec<EnvironmentVariableDto>>,
    effects: Mutex<ScriptEffects>,
}

impl<'a> ScriptingExecutor<'a> {
    pub(crate) fn new(
        inner: ProtocolDispatchingExecutor<'a>,
        collections: &'a [Collection],
        environment: Vec<EnvironmentVariableDto>,
    ) -> Self {
        Self {
            inner,
            collections,
            environment: Mutex::new(environment),
            effects: Mutex::new(ScriptEffects::default()),
        }
    }

    /// Snapshot saved-request scopes with writes already accumulated in this run.
    fn scopes_snapshot(&self, request_id: Option<&str>) -> Vec<VariableScope> {
        let Some(request_id) = request_id else {
            return Vec::new();
        };
        let mut scopes = variable_scopes(self.collections, request_id);
        if let Ok(effects) = self.effects.lock() {
            apply_scoped_changes(&mut scopes, &effects.scoped_changes);
        }
        scopes
    }

    pub(crate) fn take_effects(&self) -> ScriptEffects {
        self.effects
            .lock()
            .map(|mut effects| std::mem::take(&mut *effects))
            .unwrap_or_default()
    }

    fn environment_snapshot(&self) -> Vec<EnvironmentVariableDto> {
        self.environment
            .lock()
            .map(|environment| environment.clone())
            .unwrap_or_default()
    }

    fn runtime_snapshot(&self) -> Vec<ScriptVariable> {
        self.effects
            .lock()
            .map(|effects| effects.runtime_variables.clone())
            .unwrap_or_default()
    }

    fn merge(&self, local: ScriptEffects) {
        if let Ok(mut environment) = self.environment.lock() {
            for change in &local.environment_changes {
                match &change.value {
                    Some(value) => match environment.iter_mut().find(|v| v.name == change.name) {
                        Some(existing) => existing.value = value.clone(),
                        None => environment.push(EnvironmentVariableDto {
                            name: change.name.clone(),
                            value: value.clone(),
                            sensitive: false,
                        }),
                    },
                    None => environment.retain(|variable| variable.name != change.name),
                }
            }
        }
        if let Ok(mut effects) = self.effects.lock() {
            for change in local.environment_changes {
                match effects
                    .environment_changes
                    .iter_mut()
                    .find(|c| c.name == change.name)
                {
                    Some(existing) => existing.value = change.value,
                    None => effects.environment_changes.push(change),
                }
            }
            for change in local.scoped_changes {
                record_scoped_change(&mut effects.scoped_changes, change);
            }
            effects.logs.extend(local.logs);
            effects.tests.extend(local.tests);
            // Runtime variables survive between requests; request-local variables reset before the next pre-script.
            effects.runtime_variables = local.runtime_variables;
        }
    }

    async fn run_with_scripts(
        &self,
        request_id: Option<&str>,
        request: &Request,
    ) -> Result<Response, ExecutionError> {
        if request.pre_request_script.trim().is_empty()
            && request.post_response_script.trim().is_empty()
        {
            return self.inner.execute(request).await;
        }

        let mut environment = self.environment_snapshot();
        let mut scopes = self.scopes_snapshot(request_id);
        let mut local = ScriptEffects {
            runtime_variables: self.runtime_snapshot(),
            ..ScriptEffects::default()
        };
        let mut scripted = ScriptedRequest::from_request(request);
        run_pre_request(
            &request.pre_request_script,
            &mut scripted,
            &mut environment,
            &mut scopes,
            &mut local,
        )
        .await
        .map_err(script_failure)?;

        let effective = scripted.apply_to(request)?;

        // Completed pre-scripts retain effects even when sending fails.
        let response = match self.inner.execute(&effective).await {
            Ok(response) => response,
            Err(error) => {
                self.merge(local);
                return Err(error);
            }
        };

        run_post_response(
            &request.post_response_script,
            &scripted,
            &response,
            &environment,
            &scopes,
            &mut local,
        )
        .await
        .map_err(script_failure)?;

        self.merge(local);
        Ok(response)
    }
}

pub(crate) fn script_failure(error: ScriptErrorOutput) -> ExecutionError {
    ExecutionError::Script(format!("script de {}: {}", error.phase, error.message))
}

impl RequestExecutor for ScriptingExecutor<'_> {
    async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
        self.run_with_scripts(None, request).await
    }

    async fn execute_saved(
        &self,
        request_id: &str,
        request: &Request,
    ) -> Result<Response, ExecutionError> {
        self.run_with_scripts(Some(request_id), request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Authentication, ProtocolId, RequestDocument};
    use alcy_graphql::ReqwestGraphqlExecutor;
    use alcy_rest::ReqwestRestExecutor;
    use wiremock::matchers::{header, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn rest_request(url: &str, pre: &str, post: &str) -> Request {
        Request::new(
            Endpoint::new(url).unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Get)
        .with_scripts(pre, post)
    }

    #[tokio::test]
    async fn runs_scripts_around_the_request_and_accumulates_effects() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("x-flow", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"token\":\"t\"}"))
            .expect(1)
            .mount(&server)
            .await;
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let executor = ScriptingExecutor::new(
            ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: std::path::Path::new(""),
            },
            &[],
            vec![],
        );
        let request = rest_request(
            &server.uri(),
            "al.request.headers.set('X-Flow', '1');",
            "al.environment.set('token', al.response.json().token);",
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 200);
        let effects = executor.take_effects();
        assert_eq!(
            effects.environment_changes,
            vec![EnvironmentChangeOutput {
                name: "token".to_string(),
                value: Some("t".to_string()),
            }]
        );
    }

    #[tokio::test]
    async fn keeps_runtime_values_between_requests_in_the_same_flow() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("x-runtime", "shared"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let executor = ScriptingExecutor::new(
            ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: std::path::Path::new(""),
            },
            &[],
            vec![],
        );

        executor
            .execute(&rest_request(
                &server.uri(),
                "al.runtime.set('token', 'shared');",
                "",
            ))
            .await
            .unwrap();
        assert_eq!(
            executor.effects.lock().unwrap().runtime_variables,
            vec![ScriptVariable {
                name: "token".to_string(),
                value: "shared".to_string(),
            }]
        );
        executor
            .execute(&rest_request(
                &server.uri(),
                "al.request.headers.set('X-Runtime', al.runtime.get('token'));",
                "",
            ))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn saved_requests_expose_their_folder_and_accumulate_its_changes() {
        use alcy_domain::{Collection, EnvironmentVariable, Folder, SavedRequest};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let request = rest_request(
            &server.uri(),
            "",
            "al.folder.set('id', String(Number(al.folder.get('id')) + 1));",
        );
        let folder = Folder::new(
            "f",
            "Pasta",
            vec![],
            vec![SavedRequest::new("r", "R", request.clone()).unwrap()],
        )
        .unwrap()
        .with_variables(vec![EnvironmentVariable::new("id", "1", false).unwrap()])
        .unwrap();
        let collections = vec![Collection::new("c", "API", vec![folder], vec![]).unwrap()];
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let executor = ScriptingExecutor::new(
            ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: std::path::Path::new(""),
            },
            &collections,
            vec![],
        );

        executor.execute_saved("r", &request).await.unwrap();
        executor.execute_saved("r", &request).await.unwrap();

        assert_eq!(
            executor.take_effects().scoped_changes,
            vec![ScopedVariableChange {
                node_id: "f".to_string(),
                name: "id".to_string(),
                value: Some("3".to_string()),
            }]
        );
    }

    #[tokio::test]
    async fn keeps_the_pre_script_effects_when_the_request_fails() {
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let executor = ScriptingExecutor::new(
            ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: std::path::Path::new(""),
            },
            &[],
            vec![],
        );
        let request = rest_request(
            "http://127.0.0.1:1",
            "al.environment.set('token', 'abc'); al.console.log('pre');",
            "",
        );

        let error = executor.execute(&request).await.unwrap_err();

        assert!(matches!(error, ExecutionError::Network(_)));
        let effects = executor.take_effects();
        assert_eq!(
            effects.environment_changes,
            vec![EnvironmentChangeOutput {
                name: "token".to_string(),
                value: Some("abc".to_string()),
            }]
        );
        assert_eq!(effects.logs, vec!["pre"]);
    }

    #[tokio::test]
    async fn a_failing_script_fails_the_request_with_a_script_error() {
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let executor = ScriptingExecutor::new(
            ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: std::path::Path::new(""),
            },
            &[],
            vec![],
        );

        let error = executor
            .execute(&rest_request("https://api.example.com", "boom();", ""))
            .await
            .unwrap_err();

        assert!(matches!(error, ExecutionError::Script(_)));
    }
}
