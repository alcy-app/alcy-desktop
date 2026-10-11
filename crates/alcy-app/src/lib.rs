//! Casos de uso e portas da aplicação Alcy.

mod compare_responses;
mod credential_store;
mod evaluate_condition;
mod evaluate_value_monitors;
mod execute_flow;
mod execute_request;
mod flow_graph;
mod iteration_data;
mod json_path;
mod load_execution;
mod load_flow;
mod mock_control;
mod node_reference;
mod request_executor;
mod resolve_request_variables;
mod resolve_variables;
mod run_collection;
mod run_variables;
mod version_control;

pub use alcy_load::LoadVuState;
pub use alcy_load::{
    Arrival, LoadExecutor, LoadSchedule, LoadScheduleError, LoadScheduleMode, LoadStage,
};
pub use alcy_load::{
    LoadMetricError, LoadMetricKind, LoadMetricRegistry, LoadMetricSelector, LoadMetricSnapshot,
    LoadMetricStatistic, LoadThreshold, LoadThresholdComparison, LoadThresholdResult,
    MAX_LOAD_METRIC_SERIES,
};
pub use compare_responses::{
    BodyDiff, ComparedOutcome, MAX_RESPONSE_DIFF_BYTES, ResponseComparison, ResponseDiffHunk,
    compare_responses,
};
pub use credential_store::{CredentialError, CredentialStore};
pub use evaluate_value_monitors::{
    MAX_MONITOR_CANDIDATES, MonitorCandidate, ValueFinding, evaluate_value_monitors,
};
pub use execute_flow::{
    FlowCancellation, FlowNodeOutcome, FlowNodeSkipReason, FlowRunError, FlowRunSink,
    FlowRunSummary, MAX_SLEEP_MS, MAX_WHILE_ITERATIONS, RequestCallDetails, execute_flow,
};
pub use execute_request::execute_request;
pub use iteration_data::{
    IterationData, IterationDataError, MAX_ITERATION_DATA_BYTES, MAX_ITERATION_DATA_ROWS,
    parse_iteration_data,
};
pub use load_execution::{
    LOAD_PROGRESS_INTERVAL, LoadExecutionError, LoadRequestSample, LoadRunAccumulator,
    LoadRunProgress, LoadRunReport, LoadRunSink, LoadRunSummary, execute_load_flow,
    execute_load_flow_report, execute_load_plan, execute_load_plan_report,
};
pub use load_flow::{
    LoadCheckPlan, LoadDatasetAssets, LoadExtractPlan, LoadFlowError, LoadFlowPlan,
    LoadFlowPreview, LoadIterationAction, LoadMetricPlan, LoadRequestPlan, LoadScenarioPlan,
    LoadScenarioPreview, LoadScriptPhase, LoadScriptPlan, LoadSessionPlan, LoadTimerPlan,
    plan_load_flow, plan_load_flow_with_datasets, preview_load_flow,
    preview_load_flow_with_datasets,
};
pub use mock_control::{
    CapturedRequest, MockControlError, MockRouteSummary, MockRunHandle, MockServerControl,
    NoMockServers,
};
pub use node_reference::{NodeReferenceError, NodeRunHistory};
pub use request_executor::{InstrumentedResponse, RequestExecutionTimings, RequestExecutor};
pub use resolve_request_variables::{
    ResolveRequestError, apply_route_parameters, resolve_request_variables,
};
pub use resolve_variables::{
    Substitution, TemplateError, resolve_template_for_display, resolve_variables,
};
pub use run_collection::{
    CollectionRunPlan, CollectionRunSink, CollectionRunStep, CollectionRunSummary, RunIteration,
    RunStepReport, StepResult, run_collection, step_variables,
};
pub use version_control::{
    ChangeSelection, ChangedItem, CommitAction, ConflictSide, DiffHunk, DiffLine, DiffLineKind,
    FieldChange, FileDiff, FileStatus, ItemChangeKind, ItemResolution, MAX_DIFF_BYTES,
    MAX_DIFF_LINES, PreviewField, PullOutcome, PullPreview, PushOutcome, RemoteError,
    RemoteFileMeta, RemoteRepository, Resolution, ResolutionPreview, ResolutionPreviewInput,
    StructuredFileChanges, VersionControlError, VersionStatus, WorkspaceFiles, content_hash,
    file_diff, local_file_status, preview_conflict_resolution, preview_pull, pull_changes,
    push_changes, push_selected_changes, resolve_conflict, structured_file_changes,
    structured_file_changes_from_content, version_status,
};
