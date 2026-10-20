use std::path::PathBuf;
use std::time::Duration;

use alcy_domain::{HistoryEntry, HistoryFailureKind, HistoryOutcome, HistoryRetention, ProtocolId};
use alcy_graphql::interpret_graphql_errors;
use alcy_storage::{
    CollectionRunHistoryStore, CollectionRunRecord, CollectionRunStatus, FlowRunHistoryStore,
    FlowRunRecord, FlowRunStatus, HistoryStore, HistorySummary, HistorySummaryOutcome,
    LoadFlowRunSummary, RecordedPlanItem, RecordedRunOptions, StorageError,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::collections::GrpcCallDto;
use crate::commands::execute_collection_run::{
    RunStepDto, node_output_from_recorded, step_dto_from_recorded,
};
use crate::commands::execute_flow::{FlowRunEventDto, event_dto_from_recorded};
use crate::commands::execute_graphql_request::{
    AuthenticationInput, GraphqlErrorOutput, HeaderInput, ResponseBodyEncodingOutput,
    ResponseBodyOutput, ResponseHeaderOutput, response_body_output,
};
use crate::commands::execute_rest_request::{BodyInput, HttpMethodInput, body_input_from_domain};
use crate::commands::flow_run_outputs::{FlowNodeOutput, RequestLineOutput};
use crate::commands::flows::{FlowEdgeDto, FlowNodeDto, flow_to_dto};
use crate::commands::general_settings::HistoryPreferencesState;
use crate::commands::response_body_cache::ResponseBodyCache;

/// Retention is irrelevant to detail reads; list_history prunes using the configured preference.
const DEFAULT_HISTORY_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListHistoryInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHistoryEntryInput {
    pub root_path: String,
    pub id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HistoryOutcomeSummaryDto {
    // Serde's enum rename_all renames variant tags, not variant fields; repeat the field convention to preserve camelCase IPC bindings.
    #[serde(rename_all = "camelCase")]
    Success {
        status_code: u16,
        duration_ms: u64,
        size_bytes: usize,
    },
    Failed {
        kind: String,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestHistorySummaryDto {
    pub id: String,
    pub protocol: String,
    pub endpoint: String,
    pub executed_at_ms: u64,
    pub outcome: HistoryOutcomeSummaryDto,
}

/// One complete flow run represented as a single history entry.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunHistorySummaryDto {
    pub id: String,
    pub flow_name: String,
    pub executed_at_ms: u64,
    pub duration_ms: u64,
    /// `"completed"`, `"failed"` ou `"cancelled"`.
    pub status: String,
}

/// One collection runner execution represented as a single history entry.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRunHistorySummaryDto {
    pub id: String,
    pub scope_name: String,
    pub executed_at_ms: u64,
    pub duration_ms: u64,
    /// `"completed"`, `"failed"` ou `"cancelled"`.
    pub status: String,
    pub passed: u32,
    pub total: u32,
}

/// Load summary without metrics, thresholds or samples.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadRunHistorySummaryDto {
    pub id: String,
    pub flow_id: String,
    pub flow_name: String,
    pub executed_at_ms: u64,
    pub duration_ms: u64,
    pub status: String,
    pub passed: bool,
    pub requests: u64,
    pub failed_requests: u64,
}

/// Origin distinguishes individual requests, standard flows, collection runners and load runs.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "origin", rename_all = "camelCase")]
pub enum HistoryEntrySummaryDto {
    Collection(RequestHistorySummaryDto),
    Flow(FlowRunHistorySummaryDto),
    Runner(CollectionRunHistorySummaryDto),
    Load(LoadRunHistorySummaryDto),
}

impl HistoryEntrySummaryDto {
    fn executed_at_ms(&self) -> u64 {
        match self {
            Self::Collection(entry) => entry.executed_at_ms,
            Self::Flow(entry) => entry.executed_at_ms,
            Self::Runner(entry) => entry.executed_at_ms,
            Self::Load(entry) => entry.executed_at_ms,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HistoryOutcomeDetailDto {
    // As in HistoryOutcomeSummaryDto, repeat camelCase on enum variant fields.
    #[serde(rename_all = "camelCase")]
    Success {
        status_code: u16,
        duration_ms: u64,
        size_bytes: usize,
        body: ResponseBodyOutput,
        body_encoding: ResponseBodyEncodingOutput,
        headers: Vec<ResponseHeaderOutput>,
        graphql_errors: Vec<GraphqlErrorOutput>,
        /// The persisted body may be a bounded prefix; size_bytes retains the original response size.
        body_truncated: bool,
        /// False when response saving was disabled and only status, duration and size were stored.
        response_stored: bool,
    },
    Failed {
        kind: String,
        message: String,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDetailDto {
    pub id: String,
    pub protocol: String,
    pub endpoint: String,
    pub method: HttpMethodInput,
    pub body: String,
    /// Structured REST body, absent for GraphQL; see SavedRequestDto.
    pub rest_body: Option<BodyInput>,
    pub variables: String,
    pub headers: Vec<HeaderInput>,
    pub authentication: AuthenticationInput,
    pub executed_at_ms: u64,
    pub outcome: HistoryOutcomeDetailDto,
    /// gRPC method and schema source (`None` for the other protocols).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grpc: Option<GrpcCallDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryCommandError {
    Storage {
        message: String,
    },
    NotFound,
    /// Comparison requested a run whose response was not stored.
    ResponseNotStored,
}

impl From<StorageError> for HistoryCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

pub(crate) fn protocol_to_str(protocol: ProtocolId) -> &'static str {
    match protocol {
        ProtocolId::GraphQl => "graphql",
        ProtocolId::Rest => "rest",
        ProtocolId::Grpc => "grpc",
    }
}

pub(crate) fn failure_kind_to_str(kind: HistoryFailureKind) -> &'static str {
    match kind {
        HistoryFailureKind::Network => "network",
        HistoryFailureKind::Timeout => "timeout",
    }
}

fn flow_run_status_to_str(status: FlowRunStatus) -> &'static str {
    match status {
        FlowRunStatus::Completed => "completed",
        FlowRunStatus::Failed => "failed",
        FlowRunStatus::Cancelled => "cancelled",
    }
}

pub(crate) fn executed_at_ms(instant: std::time::SystemTime) -> u64 {
    instant
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

pub(crate) fn outcome_summary_dto(outcome: HistorySummaryOutcome) -> HistoryOutcomeSummaryDto {
    match outcome {
        HistorySummaryOutcome::Success {
            status_code,
            duration_ms,
            size_bytes,
        } => HistoryOutcomeSummaryDto::Success {
            status_code,
            duration_ms,
            size_bytes,
        },
        HistorySummaryOutcome::Failed { kind } => HistoryOutcomeSummaryDto::Failed {
            kind: failure_kind_to_str(kind).to_string(),
        },
    }
}

fn summary_from_entry(entry: HistorySummary) -> RequestHistorySummaryDto {
    RequestHistorySummaryDto {
        id: entry.id,
        protocol: protocol_to_str(entry.protocol).to_string(),
        endpoint: entry.endpoint,
        executed_at_ms: executed_at_ms(entry.executed_at),
        outcome: outcome_summary_dto(entry.outcome),
    }
}

/// History cache handles use a separate namespace to avoid collisions with live execution IDs in the shared response body cache.
const HISTORY_BODY_HANDLE_PREFIX: &str = "history:";

fn detail_from_entry(entry: HistoryEntry, body_cache: &ResponseBodyCache) -> HistoryEntryDetailDto {
    let executed_at_ms = executed_at_ms(entry.executed_at);
    let body_handle = format!("{HISTORY_BODY_HANDLE_PREFIX}{}", entry.id);

    let is_graphql = entry.request.document.protocol == ProtocolId::GraphQl;
    let body_truncated = entry.response_body_truncated;
    let response_stored = !entry.response_omitted;
    let outcome = match entry.outcome {
        HistoryOutcome::Success(response) => {
            // REST responses cannot have GraphQL errors; avoid parsing potentially large bodies for an errors field.
            let graphql_errors = if is_graphql {
                interpret_graphql_errors(&response.body)
                    .into_iter()
                    .map(GraphqlErrorOutput::from)
                    .collect()
            } else {
                Vec::new()
            };
            let headers = response
                .headers
                .into_iter()
                .map(ResponseHeaderOutput::from)
                .collect();
            let size_bytes = response.size_bytes;
            let body_encoding = ResponseBodyEncodingOutput::from(response.encoding);
            let body = response_body_output(&body_handle, response.body, size_bytes, body_cache);

            HistoryOutcomeDetailDto::Success {
                status_code: response.status_code,
                duration_ms: response.duration_ms,
                size_bytes,
                body,
                body_encoding,
                headers,
                graphql_errors,
                body_truncated,
                response_stored,
            }
        }
        HistoryOutcome::Failed { kind, message } => HistoryOutcomeDetailDto::Failed {
            kind: failure_kind_to_str(kind).to_string(),
            message,
        },
    };

    let authentication = AuthenticationInput::from(entry.request.authentication);

    HistoryEntryDetailDto {
        id: entry.id,
        protocol: protocol_to_str(entry.request.document.protocol).to_string(),
        endpoint: entry.request.endpoint.url().to_string(),
        method: entry.request.method.into(),
        rest_body: (entry.request.document.protocol == ProtocolId::Rest).then(|| {
            body_input_from_domain(&entry.request.document.body, &entry.request.body_payload)
        }),
        grpc: (entry.request.document.protocol == ProtocolId::Grpc)
            .then(|| GrpcCallDto::from(&entry.request.grpc)),
        body: entry.request.document.body,
        variables: entry.request.variables,
        headers: entry
            .request
            .headers
            .iter()
            .map(|header| HeaderInput {
                name: header.name().to_string(),
                value: header.value().to_string(),
                enabled: header.enabled,
            })
            .collect(),
        authentication,
        executed_at_ms,
        outcome,
    }
}

/// List newest-first history metadata without request or response bodies. Prune with the current retention preference before reading, including existing entries when retention is shortened or disabled.
#[tauri::command]
pub async fn list_history(
    input: ListHistoryInput,
    history: State<'_, HistoryPreferencesState>,
) -> Result<Vec<HistoryEntrySummaryDto>, HistoryCommandError> {
    let retention = history.get().retention;
    let result =
        run_blocking(move || list_history_inner(PathBuf::from(input.root_path), retention)).await;
    crate::logging::logged("alcy::history", "listar histórico", result)
}

/// Read and parse history on blocking workers, never the interface's main thread.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, HistoryCommandError> + Send + 'static,
) -> Result<T, HistoryCommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(HistoryCommandError::Storage {
                message: error.to_string(),
            })
        })
}

fn list_history_inner(
    root: PathBuf,
    retention: HistoryRetention,
) -> Result<Vec<HistoryEntrySummaryDto>, HistoryCommandError> {
    let requests = HistoryStore::new(root.clone(), retention.duration());
    let runs = FlowRunHistoryStore::new(root.clone(), retention.duration());
    let collection_runs = CollectionRunHistoryStore::new(root.clone(), retention.duration());
    // Best effort: a pruning failure must not prevent listing available entries.
    for pruned in [requests.prune(), runs.prune(), collection_runs.prune()] {
        if let Err(error) = pruned {
            log::warn!(target: "alcy::history", "falha ao podar o histórico: {error}");
        }
    }
    let requests = requests.load_summaries()?;
    let runs = runs.load_summaries()?;
    let load_runs =
        FlowRunHistoryStore::new(root.clone(), retention.duration()).load_load_summaries()?;
    let collection_runs = collection_runs.load_summaries()?;

    let mut entries: Vec<HistoryEntrySummaryDto> = requests
        .into_iter()
        .map(|entry| HistoryEntrySummaryDto::Collection(summary_from_entry(entry)))
        .chain(runs.into_iter().map(|run| {
            HistoryEntrySummaryDto::Flow(FlowRunHistorySummaryDto {
                id: run.id,
                flow_name: run.flow_name,
                executed_at_ms: executed_at_ms(run.started_at),
                duration_ms: run
                    .finished_at
                    .duration_since(run.started_at)
                    .unwrap_or(Duration::ZERO)
                    .as_millis() as u64,
                status: flow_run_status_to_str(run.status).to_string(),
            })
        }))
        .chain(collection_runs.into_iter().map(|run| {
            HistoryEntrySummaryDto::Runner(CollectionRunHistorySummaryDto {
                id: run.id,
                scope_name: run.scope_name,
                executed_at_ms: executed_at_ms(run.started_at),
                duration_ms: run
                    .finished_at
                    .duration_since(run.started_at)
                    .unwrap_or(Duration::ZERO)
                    .as_millis() as u64,
                status: collection_run_status_to_str(run.status).to_string(),
                passed: run.passed,
                total: run.total,
            })
        }))
        .chain(
            load_runs
                .into_iter()
                .map(load_run_summary_from_entry)
                .map(HistoryEntrySummaryDto::Load),
        )
        .collect();
    // Mais recente primeiro, intercalando as origens.
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.executed_at_ms()));
    Ok(entries)
}

fn load_run_summary_from_entry(run: LoadFlowRunSummary) -> LoadRunHistorySummaryDto {
    LoadRunHistorySummaryDto {
        id: run.id,
        flow_id: run.flow_id,
        flow_name: run.flow_name,
        executed_at_ms: executed_at_ms(run.started_at),
        duration_ms: run
            .finished_at
            .duration_since(run.started_at)
            .unwrap_or(Duration::ZERO)
            .as_millis() as u64,
        status: flow_run_status_to_str(run.status).to_string(),
        passed: run.passed,
        requests: run.requests,
        failed_requests: run.failed_requests,
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimedFlowRunEventDto {
    pub at_ms: u64,
    pub event: FlowRunEventDto,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunNodeOutputDto {
    pub node_id: String,
    #[serde(flatten)]
    pub output: FlowNodeOutput,
}

/// Executed graph, timestamped replay events and optional bounded request output previews for a historical run.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunDetailDto {
    pub id: String,
    pub flow_name: String,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub cancelled: bool,
    pub nodes: Vec<FlowNodeDto>,
    pub edges: Vec<FlowEdgeDto>,
    pub events: Vec<TimedFlowRunEventDto>,
    pub outputs: Vec<FlowRunNodeOutputDto>,
}

fn flow_run_detail_from_record(record: FlowRunRecord) -> FlowRunDetailDto {
    let flow = flow_to_dto(&record.flow);
    FlowRunDetailDto {
        id: record.id,
        flow_name: flow.name,
        started_at_ms: executed_at_ms(record.started_at),
        finished_at_ms: executed_at_ms(record.finished_at),
        cancelled: record.cancelled,
        nodes: flow.nodes,
        edges: flow.edges,
        events: record
            .events
            .iter()
            .map(|event| TimedFlowRunEventDto {
                at_ms: event.at_ms,
                event: event_dto_from_recorded(event),
            })
            .collect(),
        outputs: record
            .outputs
            .into_iter()
            .map(|output| FlowRunNodeOutputDto {
                node_id: output.node_id,
                output: FlowNodeOutput {
                    request: output.request.map(|line| RequestLineOutput {
                        method: line.method,
                        path: line.path,
                    }),
                    status_code: output.status_code,
                    duration_ms: output.duration_ms,
                    size_bytes: output.size_bytes,
                    headers: output
                        .headers
                        .into_iter()
                        .map(|(name, value)| ResponseHeaderOutput { name, value })
                        .collect(),
                    body: output.body,
                    body_encoding: if output.base64 {
                        ResponseBodyEncodingOutput::Base64
                    } else {
                        ResponseBodyEncodingOutput::Text
                    },
                    truncated: output.truncated,
                },
            })
            .collect(),
    }
}

fn collection_run_status_to_str(status: CollectionRunStatus) -> &'static str {
    match status {
        CollectionRunStatus::Completed => "completed",
        CollectionRunStatus::Failed => "failed",
        CollectionRunStatus::Cancelled => "cancelled",
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRunOutputDto {
    pub iteration: u32,
    pub position: usize,
    #[serde(flatten)]
    pub output: FlowNodeOutput,
}

/// Persisted runner options, plan, requestFinished events and retained responses.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRunDetailDto {
    pub id: String,
    pub scope_name: String,
    pub environment_name: Option<String>,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub cancelled: bool,
    pub stopped_on_error: bool,
    pub iterations: u32,
    pub options: RecordedRunOptions,
    pub plan: Vec<RecordedPlanItem>,
    pub steps: Vec<RunStepDto>,
    pub outputs: Vec<CollectionRunOutputDto>,
}

fn collection_run_detail_from_record(record: CollectionRunRecord) -> CollectionRunDetailDto {
    let outputs: Vec<CollectionRunOutputDto> = record
        .outputs
        .iter()
        .map(|output| CollectionRunOutputDto {
            iteration: output.iteration,
            position: output.position,
            output: node_output_from_recorded(output),
        })
        .collect();
    let steps = record
        .steps
        .into_iter()
        .map(|step| {
            let has_output = outputs
                .iter()
                .any(|o| o.iteration == step.iteration && o.position == step.position);
            step_dto_from_recorded(step, has_output)
        })
        .collect();
    CollectionRunDetailDto {
        id: record.id,
        scope_name: record.scope_name,
        environment_name: record.environment_name,
        started_at_ms: executed_at_ms(record.started_at),
        finished_at_ms: executed_at_ms(record.finished_at),
        cancelled: record.cancelled,
        stopped_on_error: record.stopped_on_error,
        iterations: record.iterations,
        options: record.options,
        plan: record.plan,
        steps,
        outputs,
    }
}

/// Read a collection runner execution from history.
#[tauri::command]
pub async fn get_collection_run_history(
    input: GetHistoryEntryInput,
) -> Result<CollectionRunDetailDto, HistoryCommandError> {
    let result = run_blocking(move || {
        get_collection_run_history_inner(PathBuf::from(input.root_path), &input.id)
    })
    .await;
    crate::logging::logged("alcy::history", "abrir histórico de execução", result)
}

fn get_collection_run_history_inner(
    root: PathBuf,
    id: &str,
) -> Result<CollectionRunDetailDto, HistoryCommandError> {
    CollectionRunHistoryStore::new(root, DEFAULT_HISTORY_RETENTION)
        .load_record(id)?
        .map(collection_run_detail_from_record)
        .ok_or(HistoryCommandError::NotFound)
}

/// Read the flow graph snapshot and replay metadata; output previews are optional.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFlowHistoryInput {
    pub root_path: String,
    pub id: String,
    pub include_outputs: Option<bool>,
}

#[tauri::command]
pub async fn get_flow_run_history(
    input: GetFlowHistoryInput,
) -> Result<FlowRunDetailDto, HistoryCommandError> {
    let result = run_blocking(move || {
        let mut detail = get_flow_run_history_inner(PathBuf::from(input.root_path), &input.id)?;
        if input.include_outputs == Some(false) {
            detail.outputs.clear();
        }
        Ok(detail)
    })
    .await;
    crate::logging::logged("alcy::history", "abrir histórico de flow", result)
}

fn get_flow_run_history_inner(
    root: PathBuf,
    id: &str,
) -> Result<FlowRunDetailDto, HistoryCommandError> {
    FlowRunHistoryStore::new(root, DEFAULT_HISTORY_RETENTION)
        .load_record(id)?
        .map(flow_run_detail_from_record)
        .ok_or(HistoryCommandError::NotFound)
}

/// Restore a historical request and response as a workbench draft. Reuse live inline/windowed body transport and preserve persisted truncation. File reading and deserialization use spawn_blocking; only DTO and cache composition run in the async adapter.
#[tauri::command]
pub async fn get_history_entry(
    input: GetHistoryEntryInput,
    body_cache: State<'_, ResponseBodyCache>,
) -> Result<HistoryEntryDetailDto, HistoryCommandError> {
    let root = PathBuf::from(input.root_path);
    let id = input.id;
    let result = run_blocking(move || load_history_entry(root, &id))
        .await
        .map(|entry| detail_from_entry(entry, &body_cache));
    crate::logging::logged("alcy::history", "abrir entrada do histórico", result)
}

fn load_history_entry(root: PathBuf, id: &str) -> Result<HistoryEntry, HistoryCommandError> {
    HistoryStore::new(root, DEFAULT_HISTORY_RETENTION)
        .load_entry(id)?
        .ok_or(HistoryCommandError::NotFound)
}

/// Synchronous command implementation used by tests.
#[cfg(test)]
fn get_history_entry_inner(
    root: PathBuf,
    id: &str,
    body_cache: &ResponseBodyCache,
) -> Result<HistoryEntryDetailDto, HistoryCommandError> {
    load_history_entry(root, id).map(|entry| detail_from_entry(entry, body_cache))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::execute_graphql_request::LARGE_RESPONSE_BODY_THRESHOLD_BYTES;
    use alcy_domain::{
        Authentication, Endpoint, HeaderEntry, HttpMethod, Request, RequestDocument, Response,
        ResponseHeader, ResponseMetadata,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-history-cmd-test-{nanos}-{count}"))
    }

    fn sample_request() -> Request {
        Request::new(
            Endpoint::new("https://api.example.com/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![HeaderEntry::new("Accept", "application/json", true).unwrap()],
            Authentication::Bearer {
                token: "secret".to_string(),
            },
        )
    }

    fn success_entry(id: &str) -> HistoryEntry {
        let response = Response::new(
            200,
            10,
            "{\"data\":{}}",
            vec![ResponseHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            ResponseMetadata::default(),
        );
        HistoryEntry::new(
            id,
            sample_request(),
            HistoryOutcome::Success(response),
            SystemTime::now(),
        )
    }

    #[test]
    fn lists_no_entries_when_nothing_is_persisted() {
        let root = temp_root();

        let entries = list_history_inner(root.clone(), HistoryRetention::default()).unwrap();

        assert!(entries.is_empty());

        fs::remove_dir_all(&root).ok();
    }

    fn as_collection(entry: &HistoryEntrySummaryDto) -> &RequestHistorySummaryDto {
        match entry {
            HistoryEntrySummaryDto::Collection(summary) => summary,
            HistoryEntrySummaryDto::Flow(_)
            | HistoryEntrySummaryDto::Runner(_)
            | HistoryEntrySummaryDto::Load(_) => {
                panic!("esperava uma entrada de collection")
            }
        }
    }

    fn flow_run_record(id: &str) -> FlowRunRecord {
        use alcy_domain::{Flow, FlowEdge, FlowNode, FlowNodeKind, FlowPosition};
        use alcy_storage::{RecordedEventKind, RecordedFlowEvent, RecordedNodeOutput};

        let now = SystemTime::now();
        FlowRunRecord {
            id: id.to_string(),
            flow: Flow::new(
                id,
                "Meu flow",
                vec![
                    FlowNode {
                        id: "start".to_string(),
                        kind: FlowNodeKind::Start,
                        position: FlowPosition { x: 0.0, y: 0.0 },
                    },
                    FlowNode {
                        id: "req".to_string(),
                        kind: FlowNodeKind::Request {
                            request_id: "r1".to_string(),
                        },
                        position: FlowPosition { x: 1.0, y: 2.0 },
                    },
                ],
                vec![FlowEdge {
                    id: "e1".to_string(),
                    source_node_id: "start".to_string(),
                    target_node_id: "req".to_string(),
                    source_handle: None,
                }],
                now,
                now,
            )
            .unwrap(),
            started_at: now,
            finished_at: now,
            cancelled: false,
            events: vec![RecordedFlowEvent {
                at_ms: 5,
                node_id: "req".to_string(),
                kind: RecordedEventKind::Succeeded {
                    status_code: 200,
                    duration_ms: 3,
                },
            }],
            outputs: vec![RecordedNodeOutput {
                node_id: "req".to_string(),
                status_code: 200,
                duration_ms: 3,
                size_bytes: 2,
                headers: vec![],
                body: "{}".to_string(),
                base64: false,
                truncated: false,
                request: None,
            }],
        }
    }

    #[test]
    fn lists_a_flow_run_as_a_single_flow_origin_entry() {
        let root = temp_root();
        FlowRunHistoryStore::new(root.clone(), Duration::from_secs(3600))
            .record(&flow_run_record("run-1"))
            .unwrap();
        HistoryStore::new(root.clone(), Duration::from_secs(3600))
            .record(success_entry("entry-1"))
            .unwrap();

        let entries = list_history_inner(root.clone(), HistoryRetention::default()).unwrap();
        let origins: Vec<_> = entries
            .iter()
            .map(|entry| serde_json::to_value(entry).unwrap()["origin"].clone())
            .collect();

        assert_eq!(entries.len(), 2);
        assert!(origins.contains(&serde_json::json!("flow")));
        assert!(origins.contains(&serde_json::json!("collection")));
        let flow = entries
            .iter()
            .find_map(|entry| match entry {
                HistoryEntrySummaryDto::Flow(run) => Some(run),
                _ => None,
            })
            .unwrap();
        assert_eq!(flow.flow_name, "Meu flow");
        assert_eq!(flow.status, "completed");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn listing_with_the_history_disabled_prunes_what_was_recorded() {
        let root = temp_root();
        FlowRunHistoryStore::new(root.clone(), Duration::from_secs(3600))
            .record(&flow_run_record("run-1"))
            .unwrap();
        HistoryStore::new(root.clone(), Duration::from_secs(3600))
            .record(success_entry("entry-1"))
            .unwrap();

        let disabled = HistoryRetention::days(0).unwrap();
        assert!(
            list_history_inner(root.clone(), disabled)
                .unwrap()
                .is_empty()
        );
        assert!(
            list_history_inner(root.clone(), HistoryRetention::default())
                .unwrap()
                .is_empty()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_flow_run_detail_serializes_events_in_the_live_channel_shape() {
        let root = temp_root();
        FlowRunHistoryStore::new(root.clone(), Duration::from_secs(3600))
            .record(&flow_run_record("run-1"))
            .unwrap();

        let detail = get_flow_run_history_inner(root.clone(), "run-1").unwrap();
        let json = serde_json::to_value(&detail).unwrap();

        assert_eq!(json["flowName"], "Meu flow");
        assert_eq!(json["events"][0]["atMs"], 5);
        assert_eq!(json["events"][0]["event"]["type"], "nodeSucceeded");
        assert_eq!(json["events"][0]["event"]["nodeId"], "req");
        assert_eq!(json["outputs"][0]["nodeId"], "req");
        assert_eq!(json["outputs"][0]["bodyEncoding"], "text");
        assert_eq!(
            get_flow_run_history_inner(root.clone(), "missing"),
            Err(HistoryCommandError::NotFound)
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn lists_a_collection_run_and_returns_its_detail() {
        use alcy_storage::{RecordedRunStep, RecordedStepOutcome, RecordedStepOutput};

        let root = temp_root();
        let started_at = std::time::SystemTime::now();
        let step = |position: usize, outcome| RecordedRunStep {
            at_ms: 5,
            iteration: 0,
            position,
            request_id: format!("r{position}"),
            name: "Login".to_string(),
            protocol: Some("rest".to_string()),
            method: "post".to_string(),
            resolved_url: "https://api.test/login".to_string(),
            outcome,
            status_code: Some(200),
            duration_ms: Some(4),
            size_bytes: Some(2),
            error_message: None,
            tests: Vec::new(),
            logs: Vec::new(),
        };
        CollectionRunHistoryStore::new(root.clone(), Duration::from_secs(3600))
            .record(&CollectionRunRecord {
                id: "cr-1".to_string(),
                scope_name: "Loja".to_string(),
                environment_name: Some("Dev".to_string()),
                started_at,
                finished_at: started_at + Duration::from_millis(40),
                cancelled: false,
                stopped_on_error: false,
                iterations: 1,
                options: RecordedRunOptions {
                    iterations: 1,
                    delay_ms: 0,
                    stop_on_error: false,
                    http_errors_fail: true,
                    keep_variable_values: true,
                    share_cookies: true,
                    persist_responses: true,
                    disable_logs: false,
                    data_file_name: None,
                },
                plan: Vec::new(),
                steps: vec![
                    step(0, RecordedStepOutcome::Passed),
                    step(1, RecordedStepOutcome::Failed),
                ],
                outputs: vec![RecordedStepOutput {
                    iteration: 0,
                    position: 1,
                    status_code: 200,
                    duration_ms: 4,
                    size_bytes: 2,
                    headers: Vec::new(),
                    body: "{}".to_string(),
                    base64: false,
                    truncated: false,
                }],
            })
            .unwrap();

        let entries = list_history_inner(root.clone(), HistoryRetention::default()).unwrap();
        let json = serde_json::to_value(&entries[0]).unwrap();
        assert_eq!(json["origin"], "runner");
        assert_eq!(json["scopeName"], "Loja");
        assert_eq!(json["status"], "failed");
        assert_eq!(json["durationMs"], 40);
        assert_eq!(
            (json["passed"].clone(), json["total"].clone()),
            (1.into(), 2.into())
        );

        let detail =
            serde_json::to_value(get_collection_run_history_inner(root.clone(), "cr-1").unwrap())
                .unwrap();
        assert_eq!(detail["steps"][0]["hasOutput"], false);
        assert_eq!(detail["steps"][1]["hasOutput"], true);
        assert_eq!(detail["outputs"][0]["position"], 1);
        assert_eq!(detail["outputs"][0]["body"], "{}");
        assert_eq!(detail["options"]["httpErrorsFail"], true);
        assert_eq!(detail["environmentName"], "Dev");
        assert_eq!(
            get_collection_run_history_inner(root.clone(), "missing"),
            Err(HistoryCommandError::NotFound)
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn lists_a_summary_without_body_or_request_content() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(3600));
        store.record(success_entry("entry-1")).unwrap();

        let entries = list_history_inner(root.clone(), HistoryRetention::default()).unwrap();

        assert_eq!(entries.len(), 1);
        let entry = as_collection(&entries[0]);
        assert_eq!(entry.id, "entry-1");
        assert_eq!(entry.endpoint, "https://api.example.com/graphql");
        assert_eq!(
            entry.outcome,
            HistoryOutcomeSummaryDto::Success {
                status_code: 200,
                duration_ms: 10,
                size_bytes: "{\"data\":{}}".len(),
            }
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn gets_the_full_detail_of_an_entry_including_the_response_body() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(3600));
        store.record(success_entry("entry-1")).unwrap();
        let cache = ResponseBodyCache::default();

        let detail = get_history_entry_inner(root.clone(), "entry-1", &cache).unwrap();

        assert_eq!(detail.id, "entry-1");
        assert_eq!(detail.body, "query { ping }");
        assert_eq!(
            detail.authentication,
            AuthenticationInput::Bearer {
                token: "secret".to_string()
            }
        );
        match detail.outcome {
            HistoryOutcomeDetailDto::Success { body, .. } => {
                assert_eq!(
                    body,
                    ResponseBodyOutput::Inline {
                        body: "{\"data\":{}}".to_string()
                    }
                );
            }
            HistoryOutcomeDetailDto::Failed { .. } => panic!("esperava sucesso"),
        }

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn windows_a_response_body_above_the_threshold_under_a_prefixed_handle() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(3600));
        let large_body = "x".repeat(LARGE_RESPONSE_BODY_THRESHOLD_BYTES + 1);
        let response = Response::new(200, 10, &large_body, vec![], ResponseMetadata::default());
        store
            .record(HistoryEntry::new(
                "entry-large",
                sample_request(),
                HistoryOutcome::Success(response),
                SystemTime::now(),
            ))
            .unwrap();
        let cache = ResponseBodyCache::default();

        let detail = get_history_entry_inner(root.clone(), "entry-large", &cache).unwrap();

        match detail.outcome {
            HistoryOutcomeDetailDto::Success { body, .. } => match body {
                ResponseBodyOutput::Windowed {
                    handle,
                    total_bytes,
                    ..
                } => {
                    assert_eq!(handle, "history:entry-large");
                    assert_eq!(total_bytes, large_body.len());
                    assert!(cache.get(&handle).is_some());
                }
                ResponseBodyOutput::Inline { .. } => panic!("expected a windowed body"),
            },
            HistoryOutcomeDetailDto::Failed { .. } => panic!("esperava sucesso"),
        }

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn gets_the_method_of_a_rest_entry() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(3600));
        let request = Request::new(
            Endpoint::new("https://api.example.com/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, "{\"name\":\"acme\"}"),
            "",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Put);
        let response = Response::new(200, 10, "{}", vec![], ResponseMetadata::default());
        store
            .record(HistoryEntry::new(
                "entry-rest",
                request,
                HistoryOutcome::Success(response),
                SystemTime::now(),
            ))
            .unwrap();
        let cache = ResponseBodyCache::default();

        let detail = get_history_entry_inner(root.clone(), "entry-rest", &cache).unwrap();

        assert_eq!(detail.protocol, "rest");
        assert_eq!(detail.method, HttpMethodInput::Put);
        assert_eq!(detail.body, "{\"name\":\"acme\"}");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn get_history_entry_fails_with_not_found_for_an_unknown_id() {
        let root = temp_root();
        let cache = ResponseBodyCache::default();

        let error = get_history_entry_inner(root.clone(), "missing", &cache).unwrap_err();

        assert_eq!(error, HistoryCommandError::NotFound);

        fs::remove_dir_all(&root).ok();
    }

    /// Serialize enum variants in regression tests: comparing Rust structs alone cannot detect accidental snake_case wire fields.
    #[test]
    fn serializes_the_summary_success_outcome_with_camel_case_keys() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(3600));
        store.record(success_entry("entry-1")).unwrap();

        let entries = list_history_inner(root.clone(), HistoryRetention::default()).unwrap();
        let json = serde_json::to_value(&as_collection(&entries[0]).outcome).unwrap();

        assert!(
            json.get("statusCode").is_some(),
            "esperava statusCode em {json}"
        );
        assert!(
            json.get("durationMs").is_some(),
            "esperava durationMs em {json}"
        );
        assert!(
            json.get("sizeBytes").is_some(),
            "esperava sizeBytes em {json}"
        );
        assert!(
            json.get("status_code").is_none(),
            "não deveria sobrar status_code em {json}"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn serializes_the_detail_success_outcome_with_camel_case_keys() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(3600));
        store.record(success_entry("entry-1")).unwrap();

        let cache = ResponseBodyCache::default();
        let detail = get_history_entry_inner(root.clone(), "entry-1", &cache).unwrap();
        let json = serde_json::to_value(&detail.outcome).unwrap();

        assert!(
            json.get("statusCode").is_some(),
            "esperava statusCode em {json}"
        );
        assert!(
            json.get("durationMs").is_some(),
            "esperava durationMs em {json}"
        );
        assert!(
            json.get("sizeBytes").is_some(),
            "esperava sizeBytes em {json}"
        );
        assert!(
            json.get("graphqlErrors").is_some(),
            "esperava graphqlErrors em {json}"
        );
        assert!(
            json.get("graphql_errors").is_none(),
            "não deveria sobrar graphql_errors em {json}"
        );

        fs::remove_dir_all(&root).ok();
    }
}
