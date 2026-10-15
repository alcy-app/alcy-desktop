use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alcy_app::{
    CapturedRequest, FlowNodeOutcome, FlowNodeSkipReason, FlowRunError, FlowRunSink,
    RequestCallDetails, execute_flow as run_flow,
};
use alcy_domain::{
    EnvironmentVariable, EnvironmentVariableError, Flow, HistoryRetention, Response,
};
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{
    CollectionsStore, FlowRunHistoryStore, FlowRunRecord, RecordedCallVariable, RecordedEventKind,
    RecordedFlowEvent, RecordedNodeOutput, RecordedRequestLine, RecordedSkipReason,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::commands::environments::EnvironmentVariableDto;
use crate::commands::execute_graphql_request::ResponseBodyEncodingOutput;
use crate::commands::flow_execution_registry::{FlowExecutionRegistry, WatchCancellation};
use crate::commands::flow_run_outputs::{FlowNodeOutput, FlowRunOutputs};
use crate::commands::flows::{FlowEdgeDto, FlowNodeDto, edges_from_dto, nodes_from_dto};
use crate::commands::general_settings::{HistoryPreferences, HistoryPreferencesState};
use crate::commands::protocol_dispatching_executor::ProtocolDispatchingExecutor;
use crate::commands::scripting::{EnvironmentChangeOutput, ScopedChangeOutput, ScriptingExecutor};
use crate::mock_runtime::{FlowMockControl, MockServerRuntime};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteFlowInput {
    pub flow_execution_id: String,
    pub root_path: String,
    /// Nome do flow, só para rotular o run no histórico.
    #[serde(default)]
    pub flow_name: Option<String>,
    pub nodes: Vec<FlowNodeDto>,
    pub edges: Vec<FlowEdgeDto>,
    pub environment_variables: Vec<EnvironmentVariableDto>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FlowNodeSkipReasonDto {
    NotRunnable,
    Unreachable,
    Cancelled,
    BranchNotTaken,
    LoopInterrupted,
}

impl From<RecordedSkipReason> for FlowNodeSkipReasonDto {
    fn from(reason: RecordedSkipReason) -> Self {
        match reason {
            RecordedSkipReason::NotRunnable => Self::NotRunnable,
            RecordedSkipReason::Unreachable => Self::Unreachable,
            RecordedSkipReason::Cancelled => Self::Cancelled,
            RecordedSkipReason::BranchNotTaken => Self::BranchNotTaken,
            RecordedSkipReason::LoopInterrupted => Self::LoopInterrupted,
        }
    }
}

impl From<FlowNodeSkipReason> for FlowNodeSkipReasonDto {
    fn from(reason: FlowNodeSkipReason) -> Self {
        match reason {
            FlowNodeSkipReason::NotRunnable => Self::NotRunnable,
            FlowNodeSkipReason::Unreachable => Self::Unreachable,
            FlowNodeSkipReason::Cancelled => Self::Cancelled,
            FlowNodeSkipReason::BranchNotTaken => Self::BranchNotTaken,
            FlowNodeSkipReason::LoopInterrupted => Self::LoopInterrupted,
        }
    }
}

/// `rename_all_fields`: sem ele os campos saem em snake_case (`node_id`) e o
/// frontend, que lê `nodeId`/`statusCode`/`durationMs`, nunca os encontra.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallVariableDto {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FlowRunEventDto {
    NodeStarted {
        node_id: String,
    },
    /// URL chamada por um node de requisição (template, resolvida e variáveis
    /// usadas), emitido logo após `NodeStarted`.
    NodeCallResolved {
        node_id: String,
        request_url: String,
        resolved_url: String,
        variables: Vec<CallVariableDto>,
    },
    NodeSucceeded {
        node_id: String,
        status_code: u16,
        duration_ms: u64,
    },
    /// Resultado da condição de um node `If`, ou dos nodes de mock com
    /// saídas `true`/`false` (spec 0121), que explicam o resultado em
    /// `message`.
    NodeBranched {
        node_id: String,
        result: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    NodeFailed {
        node_id: String,
        message: String,
    },
    NodeCancelled {
        node_id: String,
    },
    NodeSkipped {
        node_id: String,
        reason: FlowNodeSkipReasonDto,
    },
    /// Conclusão de um node sem resposta HTTP (`Log`, `Display`,
    /// `SetVariables`, `Sleep` — spec 0083), com o texto já mascarado.
    NodeCompleted {
        node_id: String,
        message: Option<String>,
    },
    /// Um `While` começou a iteração `iteration` (spec 0084); emitido uma vez
    /// por iteração.
    NodeLoopIteration {
        node_id: String,
        iteration: u32,
    },
    /// Um `While` saiu pela saída `done` depois de `iterations` iterações.
    NodeLoopFinished {
        node_id: String,
        iterations: u32,
    },
    /// Efeitos dos scripts do run (variáveis de ambiente gravadas e logs),
    /// emitido uma vez antes de `RunFinished` e só quando houve algum.
    ScriptsFinished {
        environment_changes: Vec<EnvironmentChangeOutput>,
        /// Variáveis de coleção/pasta gravadas (ADR 0031).
        scoped_changes: Vec<ScopedChangeOutput>,
        logs: Vec<String>,
    },
    RunFinished {
        cancelled: bool,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecuteFlowError {
    InvalidGraph {
        message: String,
    },
    CyclicGraph,
    MissingStartNode,
    /// Corpo de `While` aberto (ADR 0033).
    InvalidLoopBody {
        while_node_id: String,
    },
    Storage {
        message: String,
    },
}

impl From<FlowRunError> for ExecuteFlowError {
    fn from(error: FlowRunError) -> Self {
        match error {
            FlowRunError::MissingStartNode => Self::MissingStartNode,
            FlowRunError::CyclicGraph => Self::CyclicGraph,
            FlowRunError::InvalidLoopBody { while_node_id } => {
                Self::InvalidLoopBody { while_node_id }
            }
        }
    }
}

struct ChannelSink<'a> {
    channel: &'a Channel<FlowRunEventDto>,
    outputs: &'a FlowRunOutputs,
    flow_execution_id: &'a str,
    /// Eventos do run com o instante de chegada, gravados no histórico ao fim.
    recorded: Mutex<Vec<RecordedFlowEvent>>,
}

impl ChannelSink<'_> {
    fn emit(&self, node_id: &str, kind: RecordedEventKind, event: FlowRunEventDto) {
        self.recorded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(RecordedFlowEvent {
                at_ms: millis(SystemTime::now()),
                node_id: node_id.to_string(),
                kind,
            });
        let _ = self.channel.send(event);
    }

    fn take_recorded(&self) -> Vec<RecordedFlowEvent> {
        std::mem::take(
            &mut *self
                .recorded
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }
}

fn millis(instant: SystemTime) -> u64 {
    instant
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

impl From<FlowNodeSkipReasonDto> for RecordedSkipReason {
    fn from(reason: FlowNodeSkipReasonDto) -> Self {
        match reason {
            FlowNodeSkipReasonDto::NotRunnable => Self::NotRunnable,
            FlowNodeSkipReasonDto::Unreachable => Self::Unreachable,
            FlowNodeSkipReasonDto::Cancelled => Self::Cancelled,
            FlowNodeSkipReasonDto::BranchNotTaken => Self::BranchNotTaken,
            FlowNodeSkipReasonDto::LoopInterrupted => Self::LoopInterrupted,
        }
    }
}

impl FlowRunSink for ChannelSink<'_> {
    fn node_output(&self, node_id: &str, response: &Response) {
        self.outputs
            .store(self.flow_execution_id, node_id, response);
    }

    fn node_request(&self, node_id: &str, request: &CapturedRequest) {
        self.outputs
            .store_request(self.flow_execution_id, node_id, request);
    }

    fn node_call(&self, node_id: &str, details: &RequestCallDetails) {
        let variables: Vec<CallVariableDto> = details
            .variables
            .iter()
            .map(|variable| CallVariableDto {
                name: variable.name.clone(),
                value: variable.value.clone(),
                sensitive: variable.sensitive,
            })
            .collect();
        // O valor de uma variável sensível nunca vai para o disco.
        let recorded_variables = variables
            .iter()
            .map(|variable| RecordedCallVariable {
                name: variable.name.clone(),
                value: if variable.sensitive {
                    String::new()
                } else {
                    variable.value.clone()
                },
                sensitive: variable.sensitive,
            })
            .collect();
        self.emit(
            node_id,
            RecordedEventKind::CallResolved {
                request_url: details.request_url.clone(),
                resolved_url: details.resolved_url.clone(),
                variables: recorded_variables,
            },
            FlowRunEventDto::NodeCallResolved {
                node_id: node_id.to_string(),
                request_url: details.request_url.clone(),
                resolved_url: details.resolved_url.clone(),
                variables,
            },
        );
    }

    fn node_started(&self, node_id: &str) {
        self.emit(
            node_id,
            RecordedEventKind::NodeStarted,
            FlowRunEventDto::NodeStarted {
                node_id: node_id.to_string(),
            },
        );
    }

    fn node_finished(&self, node_id: &str, outcome: FlowNodeOutcome) {
        let (kind, event) = match outcome {
            FlowNodeOutcome::Success {
                status_code,
                duration_ms,
            } => (
                RecordedEventKind::Succeeded {
                    status_code,
                    duration_ms,
                },
                FlowRunEventDto::NodeSucceeded {
                    node_id: node_id.to_string(),
                    status_code,
                    duration_ms,
                },
            ),
            FlowNodeOutcome::Branched { result, message } => (
                RecordedEventKind::Branched {
                    result,
                    message: message.clone(),
                },
                FlowRunEventDto::NodeBranched {
                    node_id: node_id.to_string(),
                    result,
                    message,
                },
            ),
            FlowNodeOutcome::Failed { message } => (
                RecordedEventKind::Failed {
                    message: message.clone(),
                },
                FlowRunEventDto::NodeFailed {
                    node_id: node_id.to_string(),
                    message,
                },
            ),
            FlowNodeOutcome::Completed { message } => (
                RecordedEventKind::Completed {
                    message: message.clone(),
                },
                FlowRunEventDto::NodeCompleted {
                    node_id: node_id.to_string(),
                    message,
                },
            ),
            FlowNodeOutcome::LoopIteration { iteration } => (
                RecordedEventKind::LoopIteration { iteration },
                FlowRunEventDto::NodeLoopIteration {
                    node_id: node_id.to_string(),
                    iteration,
                },
            ),
            FlowNodeOutcome::LoopFinished { iterations } => (
                RecordedEventKind::LoopFinished { iterations },
                FlowRunEventDto::NodeLoopFinished {
                    node_id: node_id.to_string(),
                    iterations,
                },
            ),
            FlowNodeOutcome::Cancelled => (
                RecordedEventKind::Cancelled,
                FlowRunEventDto::NodeCancelled {
                    node_id: node_id.to_string(),
                },
            ),
            FlowNodeOutcome::Skipped(reason) => {
                let reason: FlowNodeSkipReasonDto = reason.into();
                (
                    RecordedEventKind::Skipped {
                        reason: reason.into(),
                    },
                    FlowRunEventDto::NodeSkipped {
                        node_id: node_id.to_string(),
                        reason,
                    },
                )
            }
        };
        self.emit(node_id, kind, event);
    }
}

/// Evento gravado de volta ao formato do canal ao vivo, para o frontend
/// reexecutá-lo pelos mesmos redutores do run em andamento.
pub(crate) fn event_dto_from_recorded(event: &RecordedFlowEvent) -> FlowRunEventDto {
    let node_id = event.node_id.clone();
    match &event.kind {
        RecordedEventKind::NodeStarted => FlowRunEventDto::NodeStarted { node_id },
        RecordedEventKind::CallResolved {
            request_url,
            resolved_url,
            variables,
        } => FlowRunEventDto::NodeCallResolved {
            node_id,
            request_url: request_url.clone(),
            resolved_url: resolved_url.clone(),
            variables: variables
                .iter()
                .map(|variable| CallVariableDto {
                    name: variable.name.clone(),
                    value: variable.value.clone(),
                    sensitive: variable.sensitive,
                })
                .collect(),
        },
        RecordedEventKind::Succeeded {
            status_code,
            duration_ms,
        } => FlowRunEventDto::NodeSucceeded {
            node_id,
            status_code: *status_code,
            duration_ms: *duration_ms,
        },
        RecordedEventKind::Branched { result, message } => FlowRunEventDto::NodeBranched {
            node_id,
            result: *result,
            message: message.clone(),
        },
        RecordedEventKind::Failed { message } => FlowRunEventDto::NodeFailed {
            node_id,
            message: message.clone(),
        },
        RecordedEventKind::Cancelled => FlowRunEventDto::NodeCancelled { node_id },
        RecordedEventKind::Completed { message } => FlowRunEventDto::NodeCompleted {
            node_id,
            message: message.clone(),
        },
        RecordedEventKind::LoopIteration { iteration } => FlowRunEventDto::NodeLoopIteration {
            node_id,
            iteration: *iteration,
        },
        RecordedEventKind::LoopFinished { iterations } => FlowRunEventDto::NodeLoopFinished {
            node_id,
            iterations: *iterations,
        },
        RecordedEventKind::Skipped { reason } => FlowRunEventDto::NodeSkipped {
            node_id,
            reason: (*reason).into(),
        },
    }
}

fn recorded_output(node_id: String, output: FlowNodeOutput) -> RecordedNodeOutput {
    RecordedNodeOutput {
        node_id,
        status_code: output.status_code,
        duration_ms: output.duration_ms,
        size_bytes: output.size_bytes,
        headers: output
            .headers
            .into_iter()
            .map(|header| (header.name, header.value))
            .collect(),
        body: output.body,
        base64: output.body_encoding == ResponseBodyEncodingOutput::Base64,
        truncated: output.truncated,
        request: output.request.map(|line| RecordedRequestLine {
            method: line.method,
            path: line.path,
        }),
    }
}

/// Grava o run como um único evento de histórico, best-effort e
/// fire-and-forget (o disco não atrasa o `runFinished`): uma falha é só logada.
fn record_flow_run(
    root_path: &str,
    record: FlowRunRecord,
    retention: HistoryRetention,
) -> tauri::async_runtime::JoinHandle<()> {
    let store = FlowRunHistoryStore::new(PathBuf::from(root_path), retention.duration());
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = store.record(&record) {
            log::warn!("falha ao gravar histórico de flow: {error}");
        }
    })
}

/// Executa um flow: monta um `Flow` transiente (nunca persistido — só o
/// canvas visual persiste, via `save_flows`) a partir do grafo enviado pelo
/// frontend, carrega as coleções do workspace para resolver nodes de
/// requisição, e transmite o progresso por `on_event` conforme cada node
/// termina (ver ADR 0014). Cancelável via `cancel_flow` com o mesmo
/// `flow_execution_id`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn execute_flow(
    input: ExecuteFlowInput,
    on_event: Channel<FlowRunEventDto>,
    flow_registry: tauri::State<'_, FlowExecutionRegistry>,
    flow_outputs: tauri::State<'_, FlowRunOutputs>,
    graphql_executor: tauri::State<'_, ReqwestGraphqlExecutor>,
    rest_executor: tauri::State<'_, ReqwestRestExecutor>,
    history: tauri::State<'_, HistoryPreferencesState>,
    mock_runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<(), ExecuteFlowError> {
    let flow_execution_id = input.flow_execution_id.clone();
    let started = std::time::Instant::now();
    log::info!(
        target: "alcy::flow",
        "{flow_execution_id}: iniciando flow ({} nós, {} conexões)",
        input.nodes.len(),
        input.edges.len()
    );
    let result = execute_flow_inner(
        input,
        &on_event,
        &flow_registry,
        &flow_outputs,
        &graphql_executor,
        &rest_executor,
        history.get(),
        &mock_runtime,
    )
    .await;
    match &result {
        Ok(()) => log::info!(
            target: "alcy::flow",
            "{flow_execution_id}: flow terminou em {} ms",
            started.elapsed().as_millis()
        ),
        Err(error) => log::warn!(
            target: "alcy::flow",
            "{flow_execution_id}: flow falhou ({})",
            crate::logging::error_kind(error)
        ),
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_flow_inner(
    input: ExecuteFlowInput,
    on_event: &Channel<FlowRunEventDto>,
    flow_registry: &FlowExecutionRegistry,
    flow_outputs: &FlowRunOutputs,
    graphql_executor: &ReqwestGraphqlExecutor,
    rest_executor: &ReqwestRestExecutor,
    history: HistoryPreferences,
    mock_runtime: &MockServerRuntime,
) -> Result<(), ExecuteFlowError> {
    let environment_variables = input
        .environment_variables
        .iter()
        .map(|variable| {
            EnvironmentVariable::new(
                variable.name.clone(),
                variable.value.clone(),
                variable.sensitive,
            )
        })
        .collect::<Result<Vec<_>, EnvironmentVariableError>>()
        .map_err(|error| ExecuteFlowError::InvalidGraph {
            message: error.to_string(),
        })?;

    let nodes = nodes_from_dto(input.nodes)
        .map_err(|message| ExecuteFlowError::InvalidGraph { message })?;
    let edges = edges_from_dto(input.edges);
    let now = SystemTime::now();
    let flow_name = input
        .flow_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Flow".to_string());
    let flow = Flow::new(
        input.flow_execution_id.clone(),
        flow_name,
        nodes,
        edges,
        now,
        now,
    )
    .map_err(|error| ExecuteFlowError::InvalidGraph {
        message: error.to_string(),
    })?;

    // Arquivo inteiro de coleções: lido em `spawn_blocking`, fora da task
    // assíncrona (mesmo motivo de `execute_collection_run`).
    let collections_root = PathBuf::from(&input.root_path);
    let collections = tauri::async_runtime::spawn_blocking(move || {
        CollectionsStore::new(collections_root).load()
    })
    .await
    .map_err(|error| ExecuteFlowError::Storage {
        message: error.to_string(),
    })?
    .map_err(|error| ExecuteFlowError::Storage {
        message: error.to_string(),
    })?;

    let (sender, receiver) = watch::channel(false);
    flow_registry.register(input.flow_execution_id.clone(), sender);
    let cancellation = WatchCancellation(receiver);

    let executor = ScriptingExecutor::new(
        ProtocolDispatchingExecutor {
            graphql: graphql_executor,
            rest: rest_executor,
            workspace_root: Path::new(&input.root_path),
        },
        &collections,
        input.environment_variables,
    );
    flow_outputs.begin(&input.flow_execution_id);
    let sink = ChannelSink {
        channel: on_event,
        outputs: flow_outputs,
        flow_execution_id: &input.flow_execution_id,
        recorded: Mutex::new(Vec::new()),
    };

    let mocks = FlowMockControl::new(
        mock_runtime,
        PathBuf::from(&input.root_path),
        input.flow_execution_id.clone(),
    );

    let started_at = SystemTime::now();
    let result = run_flow(
        &flow,
        &collections,
        &executor,
        &environment_variables,
        &sink,
        &cancellation,
        &mocks,
    )
    .await;

    flow_registry.remove(&input.flow_execution_id);

    let summary = result?;

    // Um run vira um único evento de histórico. Sem eventos (grafo inválido
    // já foi devolvido acima) não há o que gravar.
    let events = sink.take_recorded();
    if !events.is_empty() && !history.retention.is_disabled() {
        let record = FlowRunRecord {
            id: input.flow_execution_id.clone(),
            flow,
            started_at,
            finished_at: SystemTime::now(),
            cancelled: summary.cancelled,
            events,
            // Com "Salvar respostas" desligado, o run guarda só os eventos
            // (status e tempo de cada node), sem corpo nem headers.
            outputs: if history.save_responses {
                flow_outputs
                    .all(&input.flow_execution_id)
                    .into_iter()
                    .map(|(node_id, output)| recorded_output(node_id, output))
                    .collect()
            } else {
                Vec::new()
            },
        };
        // Aguarda a escrita (é rápida) para o histórico já estar em disco
        // quando o frontend receber `runFinished` e recarregar a lista.
        let _ = record_flow_run(&input.root_path, record, history.retention).await;
    }

    let effects = executor.take_effects();
    if !effects.environment_changes.is_empty()
        || !effects.scoped_changes.is_empty()
        || !effects.logs.is_empty()
    {
        let _ = on_event.send(FlowRunEventDto::ScriptsFinished {
            scoped_changes: effects.scoped_output(),
            environment_changes: effects.environment_changes,
            logs: effects.logs,
        });
    }

    let _ = on_event.send(FlowRunEventDto::RunFinished {
        cancelled: summary.cancelled,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{
        Authentication, Collection, Endpoint, ProtocolId, Request, RequestDocument, SavedRequest,
    };
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
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
        std::env::temp_dir().join(format!("alcy-execute-flow-test-{nanos}-{count}"))
    }

    /// Canal de teste: em vez de um `Channel` real do Tauri (que precisa de
    /// um `AppHandle`), captura os eventos emitidos por `ChannelSink`
    /// diretamente, testando a orquestração sem depender do runtime do
    /// Tauri.
    #[derive(Default, Clone)]
    struct RecordingSink {
        events: Arc<Mutex<Vec<FlowRunEventDto>>>,
    }

    impl FlowRunSink for RecordingSink {
        fn node_started(&self, node_id: &str) {
            self.events
                .lock()
                .unwrap()
                .push(FlowRunEventDto::NodeStarted {
                    node_id: node_id.to_string(),
                });
        }

        fn node_finished(&self, node_id: &str, outcome: FlowNodeOutcome) {
            let event = match outcome {
                FlowNodeOutcome::Success {
                    status_code,
                    duration_ms,
                } => FlowRunEventDto::NodeSucceeded {
                    node_id: node_id.to_string(),
                    status_code,
                    duration_ms,
                },
                FlowNodeOutcome::Branched { result, message } => FlowRunEventDto::NodeBranched {
                    node_id: node_id.to_string(),
                    result,
                    message,
                },
                FlowNodeOutcome::Failed { message } => FlowRunEventDto::NodeFailed {
                    node_id: node_id.to_string(),
                    message,
                },
                FlowNodeOutcome::Completed { message } => FlowRunEventDto::NodeCompleted {
                    node_id: node_id.to_string(),
                    message,
                },
                FlowNodeOutcome::LoopIteration { iteration } => {
                    FlowRunEventDto::NodeLoopIteration {
                        node_id: node_id.to_string(),
                        iteration,
                    }
                }
                FlowNodeOutcome::LoopFinished { iterations } => FlowRunEventDto::NodeLoopFinished {
                    node_id: node_id.to_string(),
                    iterations,
                },
                FlowNodeOutcome::Cancelled => FlowRunEventDto::NodeCancelled {
                    node_id: node_id.to_string(),
                },
                FlowNodeOutcome::Skipped(reason) => FlowRunEventDto::NodeSkipped {
                    node_id: node_id.to_string(),
                    reason: reason.into(),
                },
            };
            self.events.lock().unwrap().push(event);
        }
    }

    fn sample_request(endpoint_url: &str) -> Request {
        Request::new(
            Endpoint::new(endpoint_url).unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        )
    }

    fn save_collection_with_request(root: &Path, request_id: &str, endpoint_url: &str) {
        let saved = SavedRequest::new(request_id, "Ping", sample_request(endpoint_url)).unwrap();
        let collection =
            Collection::new("collection-1", "Customer API", vec![], vec![saved]).unwrap();
        CollectionsStore::new(root.to_path_buf())
            .save(&[collection])
            .unwrap();
    }

    fn node_dto(id: &str, kind: FlowNodeKindDtoForTest) -> FlowNodeDto {
        use crate::commands::flows::FlowNodeKindDto;
        FlowNodeDto {
            id: id.to_string(),
            kind: match kind {
                FlowNodeKindDtoForTest::Start => FlowNodeKindDto::Start,
                FlowNodeKindDtoForTest::Request(request_id) => {
                    FlowNodeKindDto::Request { request_id }
                }
                FlowNodeKindDtoForTest::If(condition) => FlowNodeKindDto::If { condition },
            },
            x: 0.0,
            y: 0.0,
        }
    }

    enum FlowNodeKindDtoForTest {
        Start,
        Request(String),
        If(crate::commands::flows::ConditionDto),
    }

    fn edge_dto(id: &str, source: &str, target: &str) -> FlowEdgeDto {
        FlowEdgeDto {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: None,
        }
    }

    fn handled_edge_dto(id: &str, source: &str, target: &str, source_handle: &str) -> FlowEdgeDto {
        FlowEdgeDto {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: Some(source_handle.to_string()),
        }
    }

    async fn run(
        root: &Path,
        flow_execution_id: &str,
        nodes: Vec<FlowNodeDto>,
        edges: Vec<FlowEdgeDto>,
    ) -> (Result<(), ExecuteFlowError>, RecordingSink) {
        let sink = RecordingSink::default();
        let registry = FlowExecutionRegistry::default();
        let graphql_executor = ReqwestGraphqlExecutor::new();
        let rest_executor = ReqwestRestExecutor::new();

        let environment_variables = vec![];
        let flow = Flow::new(
            "run",
            "run",
            nodes_from_dto(nodes).unwrap(),
            edges_from_dto(edges),
            SystemTime::now(),
            SystemTime::now(),
        )
        .unwrap();
        let collections = CollectionsStore::new(root.to_path_buf()).load().unwrap();

        let (sender, receiver) = watch::channel(false);
        registry.register(flow_execution_id.to_string(), sender);
        let cancellation = WatchCancellation(receiver);
        let executor = ProtocolDispatchingExecutor {
            graphql: &graphql_executor,
            rest: &rest_executor,
            workspace_root: Path::new(""),
        };

        let result = run_flow(
            &flow,
            &collections,
            &executor,
            &environment_variables,
            &sink,
            &cancellation,
            &alcy_app::NoMockServers,
        )
        .await
        .map(|_| ())
        .map_err(ExecuteFlowError::from);

        registry.remove(flow_execution_id);

        (result, sink)
    }

    #[test]
    fn a_recorded_event_maps_back_to_the_live_channel_event() {
        let event = RecordedFlowEvent {
            at_ms: 1,
            node_id: "n".to_string(),
            kind: RecordedEventKind::Skipped {
                reason: RecordedSkipReason::BranchNotTaken,
            },
        };

        assert_eq!(
            event_dto_from_recorded(&event),
            FlowRunEventDto::NodeSkipped {
                node_id: "n".to_string(),
                reason: FlowNodeSkipReasonDto::BranchNotTaken,
            }
        );
    }

    #[tokio::test]
    async fn a_request_node_executes_and_reports_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
        let root = temp_root();
        save_collection_with_request(&root, "request-1", &server.uri());

        let (result, sink) = run(
            &root,
            "flow-exec-1",
            vec![
                node_dto("start", FlowNodeKindDtoForTest::Start),
                node_dto(
                    "req-1",
                    FlowNodeKindDtoForTest::Request("request-1".to_string()),
                ),
            ],
            vec![edge_dto("edge-1", "start", "req-1")],
        )
        .await;

        result.unwrap();
        let events = sink.events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            FlowRunEventDto::NodeSucceeded { node_id, status_code: 200, .. } if node_id == "req-1"
        )));

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn a_cyclic_graph_is_rejected_before_dispatching_any_node() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();

        let (result, sink) = run(
            &root,
            "flow-exec-cycle",
            vec![
                node_dto("start", FlowNodeKindDtoForTest::Start),
                node_dto(
                    "req-1",
                    FlowNodeKindDtoForTest::Request("request-1".to_string()),
                ),
                node_dto(
                    "req-2",
                    FlowNodeKindDtoForTest::Request("request-2".to_string()),
                ),
            ],
            vec![
                edge_dto("edge-1", "start", "req-1"),
                handled_edge_dto("edge-2", "req-1", "req-2", "success"),
                handled_edge_dto("edge-3", "req-2", "req-1", "success"),
            ],
        )
        .await;

        assert_eq!(result.unwrap_err(), ExecuteFlowError::CyclicGraph);
        assert!(sink.events.lock().unwrap().is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn cancelling_while_a_node_is_in_flight_stops_the_rest_of_the_run() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;
        let root = temp_root();
        save_collection_with_request(&root, "request-1", &server.uri());

        let sink = RecordingSink::default();
        let registry = Arc::new(FlowExecutionRegistry::default());
        let graphql_executor = ReqwestGraphqlExecutor::new();
        let rest_executor = ReqwestRestExecutor::new();
        let flow = Flow::new(
            "run",
            "run",
            nodes_from_dto(vec![
                node_dto("start", FlowNodeKindDtoForTest::Start),
                node_dto(
                    "req-1",
                    FlowNodeKindDtoForTest::Request("request-1".to_string()),
                ),
            ])
            .unwrap(),
            edges_from_dto(vec![edge_dto("edge-1", "start", "req-1")]),
            SystemTime::now(),
            SystemTime::now(),
        )
        .unwrap();
        let collections = CollectionsStore::new(root.clone()).load().unwrap();

        let (sender, receiver) = watch::channel(false);
        registry.register("flow-exec-cancel".to_string(), sender);
        let cancellation = WatchCancellation(receiver);
        let executor = ProtocolDispatchingExecutor {
            graphql: &graphql_executor,
            rest: &rest_executor,
            workspace_root: Path::new(""),
        };

        let run_future = run_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &cancellation,
            &alcy_app::NoMockServers,
        );
        tokio::pin!(run_future);

        let timeout = tokio::time::sleep(Duration::from_millis(20));
        tokio::pin!(timeout);
        tokio::select! {
            _ = &mut run_future => panic!("não deveria terminar antes do cancelamento"),
            _ = &mut timeout => {}
        }

        registry.cancel("flow-exec-cancel");
        let summary = run_future.await.unwrap();

        assert!(summary.cancelled);
        let events = sink.events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event, FlowRunEventDto::NodeCancelled { node_id } if node_id == "req-1")));

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn an_if_node_branches_and_skips_the_other_side_through_the_full_dto_wiring() {
        use crate::commands::flows::{ComparisonOperatorDto, ConditionDto};

        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();

        let (result, sink) = run(
            &root,
            "flow-exec-if",
            vec![
                node_dto("start", FlowNodeKindDtoForTest::Start),
                node_dto(
                    "if-1",
                    FlowNodeKindDtoForTest::If(ConditionDto {
                        left: "1".to_string(),
                        operator: ComparisonOperatorDto::Equals,
                        right: "1".to_string(),
                    }),
                ),
                node_dto(
                    "on-true",
                    FlowNodeKindDtoForTest::Request("request-1".to_string()),
                ),
            ],
            vec![
                edge_dto("edge-1", "start", "if-1"),
                handled_edge_dto("edge-2", "if-1", "on-true", "true"),
            ],
        )
        .await;

        result.unwrap();
        let events = sink.events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            FlowRunEventDto::NodeBranched { node_id, result: true, .. } if node_id == "if-1"
        )));

        std::fs::remove_dir_all(&root).ok();
    }

    fn raw_node_dto(id: &str, kind: crate::commands::flows::FlowNodeKindDto) -> FlowNodeDto {
        FlowNodeDto {
            id: id.to_string(),
            kind,
            x: 0.0,
            y: 0.0,
        }
    }

    fn set_variable_dto(name: &str, value: &str) -> crate::commands::flows::FlowNodeKindDto {
        use crate::commands::flows::{
            FlowNodeKindDto, VariableAssignmentDto, VariableOperationDto,
        };
        FlowNodeKindDto::SetVariables {
            assignments: vec![VariableAssignmentDto {
                name: name.to_string(),
                operation: VariableOperationDto::Set {
                    value: value.to_string(),
                },
            }],
        }
    }

    fn while_dto(left: &str, right: &str) -> crate::commands::flows::FlowNodeKindDto {
        use crate::commands::flows::{ComparisonOperatorDto, ConditionDto, FlowNodeKindDto};
        FlowNodeKindDto::While {
            condition: ConditionDto {
                left: left.to_string(),
                operator: ComparisonOperatorDto::NotEquals,
                right: right.to_string(),
            },
            max_iterations: 10,
        }
    }

    #[tokio::test]
    async fn a_while_polls_a_real_endpoint_until_it_answers_200() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
        let root = temp_root();
        save_collection_with_request(&root, "request-1", &server.uri());

        let (result, sink) = run(
            &root,
            "flow-exec-while",
            vec![
                node_dto("start", FlowNodeKindDtoForTest::Start),
                raw_node_dto("init", set_variable_dto("status", "0")),
                raw_node_dto("while", while_dto("{{status}}", "200")),
                node_dto(
                    "req",
                    FlowNodeKindDtoForTest::Request("request-1".to_string()),
                ),
                raw_node_dto(
                    "save",
                    set_variable_dto("status", "{{nodes.req.response.status}}"),
                ),
            ],
            vec![
                edge_dto("e1", "start", "init"),
                edge_dto("e2", "init", "while"),
                handled_edge_dto("e3", "while", "req", "loop"),
                handled_edge_dto("e4", "req", "save", "success"),
            ],
        )
        .await;

        result.unwrap();
        let events = sink.events.lock().unwrap();
        let request_statuses: Vec<u16> = events
            .iter()
            .filter_map(|event| match event {
                FlowRunEventDto::NodeSucceeded {
                    node_id,
                    status_code,
                    ..
                } if node_id == "req" => Some(*status_code),
                _ => None,
            })
            .collect();
        assert_eq!(request_statuses, vec![503, 503, 200]);
        assert!(events.iter().any(|event| matches!(
            event,
            FlowRunEventDto::NodeLoopFinished { node_id, iterations: 3 } if node_id == "while"
        )));

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn an_open_while_body_is_rejected_before_dispatching_any_node() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();

        let (result, sink) = run(
            &root,
            "flow-exec-open-body",
            vec![
                node_dto("start", FlowNodeKindDtoForTest::Start),
                raw_node_dto("while", while_dto("1", "2")),
                raw_node_dto("inside", set_variable_dto("a", "1")),
                raw_node_dto("outside", set_variable_dto("b", "1")),
            ],
            vec![
                edge_dto("e1", "start", "while"),
                handled_edge_dto("e2", "while", "inside", "loop"),
                handled_edge_dto("e3", "while", "outside", "done"),
                edge_dto("e4", "inside", "outside"),
            ],
        )
        .await;

        let error = result.unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"kind": "invalidLoopBody", "whileNodeId": "while"})
        );
        assert!(sink.events.lock().unwrap().is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn an_inline_request_runs_without_any_collection_through_the_full_dto_wiring() {
        use crate::commands::collections::{SavedRequestAuthenticationDto, SavedRequestDto};
        use crate::commands::execute_rest_request::HttpMethodInput;
        use crate::commands::flows::FlowNodeKindDto;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(201).set_body_string("{}"))
            .mount(&server)
            .await;
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();

        let (result, sink) = run(
            &root,
            "flow-exec-inline",
            vec![
                node_dto("start", FlowNodeKindDtoForTest::Start),
                raw_node_dto(
                    "inline",
                    FlowNodeKindDto::InlineRequest {
                        request: Box::new(SavedRequestDto {
                            id: "inline".to_string(),
                            name: "Avulsa".to_string(),
                            protocol: "graphql".to_string(),
                            endpoint: server.uri(),
                            method: HttpMethodInput::Post,
                            body: "query { ping }".to_string(),
                            rest_body: None,
                            variables: "{}".to_string(),
                            route_params: vec![],
                            headers: vec![],
                            authentication: SavedRequestAuthenticationDto::Inherit,
                            pre_request_script: String::new(),
                            post_response_script: String::new(),
                            docs_ref: None,
                            grpc: None,
                        }),
                    },
                ),
            ],
            vec![edge_dto("e1", "start", "inline")],
        )
        .await;

        result.unwrap();
        let events = sink.events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            FlowRunEventDto::NodeSucceeded { node_id, status_code: 201, .. } if node_id == "inline"
        )));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn run_events_serialize_with_camel_case_fields() {
        let succeeded = serde_json::to_value(FlowRunEventDto::NodeSucceeded {
            node_id: "n".to_string(),
            status_code: 200,
            duration_ms: 7,
        })
        .unwrap();
        assert_eq!(
            succeeded,
            serde_json::json!({"type": "nodeSucceeded", "nodeId": "n", "statusCode": 200, "durationMs": 7})
        );

        let skipped = serde_json::to_value(FlowRunEventDto::NodeSkipped {
            node_id: "n".to_string(),
            reason: FlowNodeSkipReasonDto::BranchNotTaken,
        })
        .unwrap();
        assert_eq!(
            skipped,
            serde_json::json!({"type": "nodeSkipped", "nodeId": "n", "reason": "branchNotTaken"})
        );
    }
}
