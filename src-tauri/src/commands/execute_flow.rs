use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alcy_app::{
    CapturedRequest, FlowNodeOutcome, FlowNodeSkipReason, FlowRunError, FlowRunSink,
    RequestCallDetails, execute_flow as run_flow,
};
use alcy_domain::{
    BodyEncoding, EnvironmentVariable, EnvironmentVariableError, Flow, HistoryRetention, Response,
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
use crate::commands::execute_graphql_request::{
    ConnectionInfoOutput, CookieOutput, ResponseBodyEncodingOutput, ResponseHeaderOutput,
};
use crate::commands::flow_execution_registry::{FlowExecutionRegistry, WatchCancellation};
use crate::commands::flow_run_outputs::{FlowNodeOutput, FlowRunOutputs, MAX_STORED_BODY_BYTES};
use crate::commands::flows::{FlowEdgeDto, FlowNodeDto, edges_from_dto, nodes_from_dto};
use crate::commands::general_settings::{HistoryPreferences, HistoryPreferencesState};
use crate::commands::protocol_dispatching_executor::ProtocolDispatchingExecutor;
use crate::commands::response_body_cache::char_boundary_window;
use crate::commands::scripting::{EnvironmentChangeOutput, ScopedChangeOutput, ScriptingExecutor};
use crate::mock_runtime::{FlowMockControl, MockServerRuntime};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteFlowInput {
    pub flow_execution_id: String,
    pub root_path: String,
    /// Flow name labels historical runs only.
    #[serde(default)]
    pub flow_name: Option<String>,
    pub nodes: Vec<FlowNodeDto>,
    pub edges: Vec<FlowEdgeDto>,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    /// Emit `NodeExchange` for each response, only while the HAR recorder is on.
    #[serde(default)]
    pub record_exchanges: bool,
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

/// rename_all_fields converts variant fields into frontend camelCase.
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
    /// Request template, resolved URL and variables, emitted after NodeStarted.
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
    /// If/mock condition result; mock true/false blocks may include a message.
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
    /// Completed Log/Display/SetVariables/Sleep with redacted text.
    NodeCompleted {
        node_id: String,
        message: Option<String>,
    },
    /// While iteration started; emitted once per iteration (spec 0084).
    NodeLoopIteration {
        node_id: String,
        iteration: u32,
    },
    /// While took done after the given iteration count.
    NodeLoopFinished {
        node_id: String,
        iterations: u32,
    },
    /// Full exchange of a request node for the HAR recorder, before its NodeSucceeded/NodeFailed.
    /// Only sent when the input asks for it, never recorded in history; `url` carries real values.
    NodeExchange {
        node_id: String,
        exchange: Box<FlowExchangeDto>,
    },
    /// Accumulated script effects emitted once before RunFinished when present.
    ScriptsFinished {
        environment_changes: Vec<EnvironmentChangeOutput>,
        /// Collection/folder script writes (ADR 0031).
        scoped_changes: Vec<ScopedChangeOutput>,
        logs: Vec<String>,
    },
    RunFinished {
        cancelled: bool,
    },
}

/// Request/response of one request node execution. The response body keeps only
/// its first `MAX_STORED_BODY_BYTES` (binary bodies above that are dropped), so a
/// loop of large responses never floods the channel.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowExchangeDto {
    /// URL actually sent; None when the call details could not be resolved.
    pub url: Option<String>,
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub body: String,
    pub body_encoding: ResponseBodyEncodingOutput,
    pub truncated: bool,
    pub headers: Vec<ResponseHeaderOutput>,
    pub request_headers: Vec<ResponseHeaderOutput>,
    pub cookies: Vec<CookieOutput>,
    pub connection: ConnectionInfoOutput,
    pub final_url: Option<String>,
    pub waiting_ms: u64,
}

impl FlowExchangeDto {
    fn from_response(url: Option<String>, response: &Response) -> Self {
        let (body, truncated) = match response.encoding {
            // Cut base64 decodes to nothing: keep it whole or drop it.
            BodyEncoding::Base64 if response.body.len() > MAX_STORED_BODY_BYTES => {
                (String::new(), true)
            }
            BodyEncoding::Base64 => (response.body.clone(), false),
            BodyEncoding::Text => {
                let (window, next) = char_boundary_window(&response.body, 0, MAX_STORED_BODY_BYTES);
                (window.to_string(), next.is_some())
            }
        };
        let headers = |headers: &[alcy_domain::ResponseHeader]| {
            headers
                .iter()
                .cloned()
                .map(ResponseHeaderOutput::from)
                .collect()
        };
        Self {
            url,
            status_code: response.status_code,
            duration_ms: response.duration_ms,
            size_bytes: response.size_bytes,
            body,
            body_encoding: response.encoding.into(),
            truncated,
            headers: headers(&response.headers),
            request_headers: headers(&response.request_headers),
            cookies: response
                .cookies
                .iter()
                .cloned()
                .map(CookieOutput::from)
                .collect(),
            connection: response.connection.clone().into(),
            final_url: response.final_url.clone(),
            waiting_ms: response.waiting_ms,
        }
    }
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
    body_capture: &'a alcy_storage::FlowBodyCapture,
    history_outputs: Mutex<HashMap<String, FlowNodeOutput>>,
    save_responses: bool,
    flow_execution_id: &'a str,
    /// Timestamped events persisted at run completion.
    recorded: Mutex<Vec<RecordedFlowEvent>>,
    record_exchanges: bool,
    /// Sent URL of each node's current call, kept until its response arrives.
    sent_urls: Mutex<HashMap<String, String>>,
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
        self.body_capture.capture(
            node_id,
            &response.body,
            response.encoding == BodyEncoding::Base64,
        );
        let preview = self
            .outputs
            .store(self.flow_execution_id, node_id, response);
        if self.save_responses {
            self.history_outputs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(node_id.into(), preview);
        }
        if self.record_exchanges {
            let url = self
                .sent_urls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(node_id);
            let _ = self.channel.send(FlowRunEventDto::NodeExchange {
                node_id: node_id.to_string(),
                exchange: Box::new(FlowExchangeDto::from_response(url, response)),
            });
        }
    }

    fn node_request(&self, node_id: &str, request: &CapturedRequest) {
        self.body_capture.capture(node_id, &request.body, false);
        let preview = self
            .outputs
            .store_request(self.flow_execution_id, node_id, request);
        if self.save_responses {
            self.history_outputs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(node_id.into(), preview);
        }
    }

    fn node_call(&self, node_id: &str, details: &RequestCallDetails) {
        if self.record_exchanges {
            self.sent_urls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(node_id.to_string(), details.sent_url.clone());
        }
        let variables: Vec<CallVariableDto> = details
            .variables
            .iter()
            .map(|variable| CallVariableDto {
                name: variable.name.clone(),
                value: variable.value.clone(),
                sensitive: variable.sensitive,
            })
            .collect();
        // Never persist sensitive variable values.
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

/// Restore live-channel event shape so frontend reducers also replay history.
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

/// Persist a run as one history entry in background; log failures without delaying runFinished.
fn record_flow_run(
    root_path: &str,
    record: FlowRunRecord,
    retention: HistoryRetention,
) -> tauri::async_runtime::JoinHandle<()> {
    let store = FlowRunHistoryStore::new(PathBuf::from(root_path), retention.duration());
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = store.record(&record) {
            log::warn!("failed to persist flow history: {error}");
        }
    })
}

/// Build a transient Flow, load collections, and stream progress. Only the visual canvas is canonical. Cancel using the execution ID (ADR 0014).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_flow(
    app: tauri::AppHandle,
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
        "{flow_execution_id}: starting flow ({} nodes, {} edges)",
        input.nodes.len(),
        input.edges.len()
    );
    let result = execute_flow_inner(
        Some(&app),
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
            "{flow_execution_id}: flow finished in {} ms",
            started.elapsed().as_millis()
        ),
        Err(error) => log::warn!(
            target: "alcy::flow",
            "{flow_execution_id}: flow failed ({})",
            crate::logging::error_summary(error)
        ),
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_flow_inner(
    app: Option<&tauri::AppHandle>,
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

    // Read/parse collections through spawn_blocking outside async workers.
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
            app,
            graphql: graphql_executor,
            rest: rest_executor,
            workspace_root: Path::new(&input.root_path),
        },
        &collections,
        input.environment_variables,
    );
    flow_outputs.begin(&input.flow_execution_id);
    let archive = alcy_storage::FlowBodyCapture::new();
    flow_outputs.attach_archive(archive.clone());
    let sink = ChannelSink {
        channel: on_event,
        outputs: flow_outputs,
        body_capture: &archive,
        history_outputs: Mutex::new(HashMap::new()),
        save_responses: history.save_responses && !history.retention.is_disabled(),
        flow_execution_id: &input.flow_execution_id,
        recorded: Mutex::new(Vec::new()),
        record_exchanges: input.record_exchanges,
        sent_urls: Mutex::new(HashMap::new()),
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

    let archive_destination =
        if result.is_ok() && history.save_responses && !history.retention.is_disabled() {
            alcy_storage::flow_body_directory(Path::new(&input.root_path), &input.flow_execution_id)
        } else {
            None
        };
    let finishing_archive = archive.clone();
    let _ =
        tauri::async_runtime::spawn_blocking(move || finishing_archive.finish(archive_destination))
            .await;
    let summary = result?;

    // A run becomes one history entry; invalid graphs without events have nothing to record.
    let events = sink.take_recorded();
    if !events.is_empty() && !history.retention.is_disabled() {
        let record = FlowRunRecord {
            id: input.flow_execution_id.clone(),
            flow,
            started_at,
            finished_at: SystemTime::now(),
            cancelled: summary.cancelled,
            events,
            // With Save responses disabled, retain events/status/duration without bodies/headers.
            outputs: if history.save_responses {
                std::mem::take(
                    &mut *sink
                        .history_outputs
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()),
                )
                .into_iter()
                .map(|(node_id, output)| recorded_output(node_id, output))
                .collect()
            } else {
                Vec::new()
            },
        };
        // Await persistence before runFinished triggers history reload.
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

    /// Capture ChannelSink test events directly without a Tauri runtime/AppHandle.
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
            app: None,
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
            app: None,
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
            _ = &mut run_future => panic!("must not finish before cancellation"),
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

    fn exchange_response(body: String) -> Response {
        Response::new(
            201,
            12,
            body,
            vec![alcy_domain::ResponseHeader {
                name: "content-type".to_string(),
                value: "application/json".to_string(),
            }],
            alcy_domain::ResponseMetadata {
                request_headers: vec![alcy_domain::ResponseHeader {
                    name: "authorization".to_string(),
                    value: "Bearer secret".to_string(),
                }],
                waiting_ms: 5,
                ..Default::default()
            },
        )
    }

    #[test]
    fn a_node_exchange_serializes_the_sent_url_and_both_sides_of_the_call() {
        let event = serde_json::to_value(FlowRunEventDto::NodeExchange {
            node_id: "req".to_string(),
            exchange: Box::new(FlowExchangeDto::from_response(
                Some("https://api.example.com/users?key=secret".to_string()),
                &exchange_response("{\"ok\":true}".to_string()),
            )),
        })
        .unwrap();

        assert_eq!(event["type"], "nodeExchange");
        assert_eq!(event["nodeId"], "req");
        let exchange = &event["exchange"];
        assert_eq!(exchange["url"], "https://api.example.com/users?key=secret");
        assert_eq!(exchange["statusCode"], 201);
        assert_eq!(exchange["body"], "{\"ok\":true}");
        assert_eq!(exchange["bodyEncoding"], "text");
        assert_eq!(exchange["truncated"], false);
        assert_eq!(exchange["requestHeaders"][0]["value"], "Bearer secret");
        assert_eq!(exchange["headers"][0]["name"], "content-type");
        assert_eq!(exchange["waitingMs"], 5);
    }

    #[test]
    fn a_node_exchange_keeps_only_the_start_of_a_large_body() {
        let body = "a".repeat(MAX_STORED_BODY_BYTES + 10);
        let exchange = FlowExchangeDto::from_response(None, &exchange_response(body));

        assert_eq!(exchange.body.len(), MAX_STORED_BODY_BYTES);
        assert!(exchange.truncated);
        assert_eq!(exchange.size_bytes, MAX_STORED_BODY_BYTES + 10);
    }
}
