use std::path::PathBuf;
use std::time::SystemTime;

use alcy_domain::{
    ComparisonOperator, Condition, Flow, FlowEdge, FlowExecutionKind, FlowFolder, FlowNode,
    FlowNodeKind, FlowPosition, LoadNode, LoadNodeKind, MockCallCountOperator, MockServerSource,
    VariableAssignment, VariableOperation, validate_flow_folders,
};
use alcy_storage::{FlowStore, FlowsSnapshot, StorageError};

use crate::commands::collections::{
    CollectionsCommandError, SavedRequestDto, request_from_dto, request_to_dto,
};
use crate::commands::mock_servers::{MockServerDto, server_from_dto, server_to_dto};
use crate::commands::ordered_save::OrderedSaves;
use serde::{Deserialize, Serialize};

const FLOW_ASSETS_DIRECTORY: &str = "alcy-flow-assets";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ComparisonOperatorDto {
    Equals,
    NotEquals,
    GreaterThan,
    LessThan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConditionDto {
    pub left: String,
    pub operator: ComparisonOperatorDto,
    pub right: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FlowExecutionKindDto {
    #[default]
    Standard,
    Load,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoadNodeKindDto {
    Scenario,
    Request,
    Script,
    Repeat,
    ForEach,
    OncePerVu,
    TimeBox,
    Select,
    Group,
    Timer,
    Dataset,
    ConfigureSession,
    Extract,
    Check,
    Metric,
    Threshold,
}

/// `rename_all_fields` converts struct-variant fields so frontend `requestId`
/// deserializes correctly instead of requiring `request_id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FlowNodeKindDto {
    Start {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        form: Option<alcy_storage::FlowFormConfig>,
    },
    HumanAction {
        form: alcy_storage::FlowFormConfig,
    },
    Block {
        label: String,
    },
    Request {
        request_id: String,
    },
    If {
        condition: ConditionDto,
    },
    Note {
        text: String,
        width: f64,
        height: f64,
    },
    Log {
        message: String,
    },
    Display {
        template: String,
    },
    Sleep {
        duration_ms: u64,
    },
    SetVariables {
        assignments: Vec<VariableAssignmentDto>,
    },
    While {
        condition: ConditionDto,
        max_iterations: u32,
    },
    Break,
    Continue,
    /// Inline request (spec 0086), using the collection request DTO.
    InlineRequest {
        request: Box<SavedRequestDto>,
    },
    Load {
        load_kind: LoadNodeKindDto,
        label: String,
        /// Canonical block JSON, preserved without interpretation or execution.
        config: String,
    },
    /// Mock server blocks (spec 0121).
    MockStart {
        source: MockServerSourceDto,
    },
    MockStop {
        start_node_id: String,
    },
    MockWaitRequest {
        start_node_id: String,
        route_id: String,
        timeout_ms: u64,
    },
    MockSetResponse {
        start_node_id: String,
        route_id: String,
        #[serde(default)]
        response_id: Option<String>,
    },
    MockAssertCalls {
        start_node_id: String,
        route_id: String,
        operator: MockCallCountOperatorDto,
        count: u32,
    },
}

/// Saved mock ID or inline mock using the mock-server editor DTO.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MockServerSourceDto {
    Saved { server_id: String },
    Inline { server: Box<MockServerDto> },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MockCallCountOperatorDto {
    Equals,
    AtLeast,
    AtMost,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VariableAssignmentDto {
    pub name: String,
    #[serde(flatten)]
    pub operation: VariableOperationDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub enum VariableOperationDto {
    Set { value: String },
    Increment { by: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeDto {
    pub id: String,
    #[serde(flatten)]
    pub kind: FlowNodeKindDto,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdgeDto {
    pub id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    /// None for single-output nodes, true/false for If branches,
    /// and success/failure for Request branches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowDto {
    pub id: String,
    pub name: String,
    pub presentation: alcy_storage::FlowPresentationConfig,
    pub execution_kind: FlowExecutionKindDto,
    pub nodes: Vec<FlowNodeDto>,
    pub edges: Vec<FlowEdgeDto>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub presentation: alcy_storage::FlowPresentationConfig,
    #[serde(default)]
    pub execution_kind: FlowExecutionKindDto,
    pub nodes: Vec<FlowNodeDto>,
    pub edges: Vec<FlowEdgeDto>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowFolderDto {
    pub id: String,
    pub name: String,
    pub flow_ids: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowsSnapshotDto {
    pub flows: Vec<FlowDto>,
    pub folders: Vec<FlowFolderDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFlowsInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFlowsInput {
    pub root_path: String,
    pub flows: Vec<FlowInput>,
    #[serde(default)]
    pub folders: Vec<FlowFolderDto>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlowsError {
    Invalid { message: String },
    Storage { message: String },
}

impl From<StorageError> for FlowsError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

fn millis_to_system_time(millis: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(millis)
}

fn system_time_to_millis(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn comparison_operator_to_dto(operator: ComparisonOperator) -> ComparisonOperatorDto {
    match operator {
        ComparisonOperator::Equals => ComparisonOperatorDto::Equals,
        ComparisonOperator::NotEquals => ComparisonOperatorDto::NotEquals,
        ComparisonOperator::GreaterThan => ComparisonOperatorDto::GreaterThan,
        ComparisonOperator::LessThan => ComparisonOperatorDto::LessThan,
    }
}

fn comparison_operator_from_dto(operator: ComparisonOperatorDto) -> ComparisonOperator {
    match operator {
        ComparisonOperatorDto::Equals => ComparisonOperator::Equals,
        ComparisonOperatorDto::NotEquals => ComparisonOperator::NotEquals,
        ComparisonOperatorDto::GreaterThan => ComparisonOperator::GreaterThan,
        ComparisonOperatorDto::LessThan => ComparisonOperator::LessThan,
    }
}

fn condition_to_dto(condition: &Condition) -> ConditionDto {
    ConditionDto {
        left: condition.left.clone(),
        operator: comparison_operator_to_dto(condition.operator),
        right: condition.right.clone(),
    }
}

fn condition_from_dto(condition: ConditionDto) -> Condition {
    Condition {
        left: condition.left,
        operator: comparison_operator_from_dto(condition.operator),
        right: condition.right,
    }
}

fn execution_kind_to_dto(kind: FlowExecutionKind) -> FlowExecutionKindDto {
    match kind {
        FlowExecutionKind::Standard => FlowExecutionKindDto::Standard,
        FlowExecutionKind::Load => FlowExecutionKindDto::Load,
    }
}

fn execution_kind_from_dto(kind: FlowExecutionKindDto) -> FlowExecutionKind {
    match kind {
        FlowExecutionKindDto::Standard => FlowExecutionKind::Standard,
        FlowExecutionKindDto::Load => FlowExecutionKind::Load,
    }
}

fn load_node_kind_to_dto(kind: LoadNodeKind) -> LoadNodeKindDto {
    match kind {
        LoadNodeKind::Scenario => LoadNodeKindDto::Scenario,
        LoadNodeKind::Request => LoadNodeKindDto::Request,
        LoadNodeKind::Script => LoadNodeKindDto::Script,
        LoadNodeKind::Repeat => LoadNodeKindDto::Repeat,
        LoadNodeKind::ForEach => LoadNodeKindDto::ForEach,
        LoadNodeKind::OncePerVu => LoadNodeKindDto::OncePerVu,
        LoadNodeKind::TimeBox => LoadNodeKindDto::TimeBox,
        LoadNodeKind::Select => LoadNodeKindDto::Select,
        LoadNodeKind::Group => LoadNodeKindDto::Group,
        LoadNodeKind::Timer => LoadNodeKindDto::Timer,
        LoadNodeKind::Dataset => LoadNodeKindDto::Dataset,
        LoadNodeKind::ConfigureSession => LoadNodeKindDto::ConfigureSession,
        LoadNodeKind::Extract => LoadNodeKindDto::Extract,
        LoadNodeKind::Check => LoadNodeKindDto::Check,
        LoadNodeKind::Metric => LoadNodeKindDto::Metric,
        LoadNodeKind::Threshold => LoadNodeKindDto::Threshold,
    }
}

fn load_node_kind_from_dto(kind: LoadNodeKindDto) -> LoadNodeKind {
    match kind {
        LoadNodeKindDto::Scenario => LoadNodeKind::Scenario,
        LoadNodeKindDto::Request => LoadNodeKind::Request,
        LoadNodeKindDto::Script => LoadNodeKind::Script,
        LoadNodeKindDto::Repeat => LoadNodeKind::Repeat,
        LoadNodeKindDto::ForEach => LoadNodeKind::ForEach,
        LoadNodeKindDto::OncePerVu => LoadNodeKind::OncePerVu,
        LoadNodeKindDto::TimeBox => LoadNodeKind::TimeBox,
        LoadNodeKindDto::Select => LoadNodeKind::Select,
        LoadNodeKindDto::Group => LoadNodeKind::Group,
        LoadNodeKindDto::Timer => LoadNodeKind::Timer,
        LoadNodeKindDto::Dataset => LoadNodeKind::Dataset,
        LoadNodeKindDto::ConfigureSession => LoadNodeKind::ConfigureSession,
        LoadNodeKindDto::Extract => LoadNodeKind::Extract,
        LoadNodeKindDto::Check => LoadNodeKind::Check,
        LoadNodeKindDto::Metric => LoadNodeKind::Metric,
        LoadNodeKindDto::Threshold => LoadNodeKind::Threshold,
    }
}

fn node_to_dto(node: &FlowNode) -> FlowNodeDto {
    FlowNodeDto {
        id: node.id.clone(),
        kind: match &node.kind {
            FlowNodeKind::Start => FlowNodeKindDto::Start { form: None },
            FlowNodeKind::StartForm { form } => FlowNodeKindDto::Start {
                form: Some(form.clone().into()),
            },
            FlowNodeKind::HumanAction { form } => FlowNodeKindDto::HumanAction {
                form: form.clone().into(),
            },
            FlowNodeKind::Block { label } => FlowNodeKindDto::Block {
                label: label.clone(),
            },
            FlowNodeKind::Request { request_id } => FlowNodeKindDto::Request {
                request_id: request_id.clone(),
            },
            FlowNodeKind::If { condition } => FlowNodeKindDto::If {
                condition: condition_to_dto(condition),
            },
            FlowNodeKind::Note {
                text,
                width,
                height,
            } => FlowNodeKindDto::Note {
                text: text.clone(),
                width: *width,
                height: *height,
            },
            FlowNodeKind::Log { message } => FlowNodeKindDto::Log {
                message: message.clone(),
            },
            FlowNodeKind::Display { template } => FlowNodeKindDto::Display {
                template: template.clone(),
            },
            FlowNodeKind::Sleep { duration_ms } => FlowNodeKindDto::Sleep {
                duration_ms: *duration_ms,
            },
            FlowNodeKind::InlineRequest { request } => FlowNodeKindDto::InlineRequest {
                request: Box::new(request_to_dto(request)),
            },
            FlowNodeKind::Load { node } => FlowNodeKindDto::Load {
                load_kind: load_node_kind_to_dto(node.kind),
                label: node.label.clone(),
                config: node.config.clone(),
            },
            FlowNodeKind::MockStart { source } => FlowNodeKindDto::MockStart {
                source: match source {
                    MockServerSource::Saved { server_id } => MockServerSourceDto::Saved {
                        server_id: server_id.clone(),
                    },
                    MockServerSource::Inline { server } => MockServerSourceDto::Inline {
                        server: Box::new(server_to_dto((**server).clone())),
                    },
                },
            },
            FlowNodeKind::MockStop { start_node_id } => FlowNodeKindDto::MockStop {
                start_node_id: start_node_id.clone(),
            },
            FlowNodeKind::MockWaitRequest {
                start_node_id,
                route_id,
                timeout_ms,
            } => FlowNodeKindDto::MockWaitRequest {
                start_node_id: start_node_id.clone(),
                route_id: route_id.clone(),
                timeout_ms: *timeout_ms,
            },
            FlowNodeKind::MockSetResponse {
                start_node_id,
                route_id,
                response_id,
            } => FlowNodeKindDto::MockSetResponse {
                start_node_id: start_node_id.clone(),
                route_id: route_id.clone(),
                response_id: response_id.clone(),
            },
            FlowNodeKind::MockAssertCalls {
                start_node_id,
                route_id,
                operator,
                count,
            } => FlowNodeKindDto::MockAssertCalls {
                start_node_id: start_node_id.clone(),
                route_id: route_id.clone(),
                operator: match operator {
                    MockCallCountOperator::Equals => MockCallCountOperatorDto::Equals,
                    MockCallCountOperator::AtLeast => MockCallCountOperatorDto::AtLeast,
                    MockCallCountOperator::AtMost => MockCallCountOperatorDto::AtMost,
                },
                count: *count,
            },
            FlowNodeKind::Break => FlowNodeKindDto::Break,
            FlowNodeKind::Continue => FlowNodeKindDto::Continue,
            FlowNodeKind::While {
                condition,
                max_iterations,
            } => FlowNodeKindDto::While {
                condition: condition_to_dto(condition),
                max_iterations: *max_iterations,
            },
            FlowNodeKind::SetVariables { assignments } => FlowNodeKindDto::SetVariables {
                assignments: assignments
                    .iter()
                    .map(|assignment| VariableAssignmentDto {
                        name: assignment.name.clone(),
                        operation: match &assignment.operation {
                            VariableOperation::Set { value } => VariableOperationDto::Set {
                                value: value.clone(),
                            },
                            VariableOperation::Increment { by } => {
                                VariableOperationDto::Increment { by: *by }
                            }
                        },
                    })
                    .collect(),
            },
        },
        x: node.position.x,
        y: node.position.y,
    }
}

fn edge_to_dto(edge: &FlowEdge) -> FlowEdgeDto {
    FlowEdgeDto {
        id: edge.id.clone(),
        source_node_id: edge.source_node_id.clone(),
        target_node_id: edge.target_node_id.clone(),
        source_handle: edge.source_handle.clone(),
    }
}

pub(crate) fn flow_to_dto(flow: &Flow) -> FlowDto {
    FlowDto {
        id: flow.id.clone(),
        name: flow.name().to_string(),
        presentation: flow.presentation.clone().into(),
        execution_kind: execution_kind_to_dto(flow.execution_kind()),
        nodes: flow.nodes().iter().map(node_to_dto).collect(),
        edges: flow.edges().iter().map(edge_to_dto).collect(),
        created_at_ms: system_time_to_millis(flow.created_at),
        updated_at_ms: system_time_to_millis(flow.updated_at),
    }
}

fn snapshot_to_dto(snapshot: FlowsSnapshot) -> FlowsSnapshotDto {
    FlowsSnapshotDto {
        flows: snapshot.flows.iter().map(flow_to_dto).collect(),
        folders: snapshot
            .folders
            .into_iter()
            .map(|folder| FlowFolderDto {
                id: folder.id,
                name: folder.name,
                flow_ids: folder.flow_ids,
            })
            .collect(),
    }
}

/// Also used by execution to build a transient graph from the editor DTO.
/// Rejects invalid inline requests and mocks, such as those with empty names.
pub(crate) fn nodes_from_dto(nodes: Vec<FlowNodeDto>) -> Result<Vec<FlowNode>, String> {
    nodes
        .into_iter()
        .map(|node| {
            Ok(FlowNode {
                id: node.id,
                kind: match node.kind {
                    FlowNodeKindDto::Start { form } => form.map_or(FlowNodeKind::Start, |form| {
                        FlowNodeKind::StartForm { form: form.into() }
                    }),
                    FlowNodeKindDto::HumanAction { form } => {
                        FlowNodeKind::HumanAction { form: form.into() }
                    }
                    FlowNodeKindDto::Block { label } => FlowNodeKind::Block { label },
                    FlowNodeKindDto::Request { request_id } => FlowNodeKind::Request { request_id },
                    FlowNodeKindDto::If { condition } => FlowNodeKind::If {
                        condition: condition_from_dto(condition),
                    },
                    FlowNodeKindDto::Note {
                        text,
                        width,
                        height,
                    } => FlowNodeKind::Note {
                        text,
                        width,
                        height,
                    },
                    FlowNodeKindDto::Log { message } => FlowNodeKind::Log { message },
                    FlowNodeKindDto::Display { template } => FlowNodeKind::Display { template },
                    FlowNodeKindDto::Sleep { duration_ms } => FlowNodeKind::Sleep { duration_ms },
                    FlowNodeKindDto::InlineRequest { request } => FlowNodeKind::InlineRequest {
                        request: Box::new(request_from_dto(*request).map_err(
                            |error| match error {
                                CollectionsCommandError::Invalid { message }
                                | CollectionsCommandError::Storage { message } => message,
                            },
                        )?),
                    },
                    FlowNodeKindDto::Load {
                        load_kind,
                        label,
                        config,
                    } => FlowNodeKind::Load {
                        node: LoadNode {
                            kind: load_node_kind_from_dto(load_kind),
                            label,
                            config,
                        },
                    },
                    FlowNodeKindDto::MockStart { source } => FlowNodeKind::MockStart {
                        source: match source {
                            MockServerSourceDto::Saved { server_id } => {
                                MockServerSource::Saved { server_id }
                            }
                            MockServerSourceDto::Inline { server } => MockServerSource::Inline {
                                server: Box::new(
                                    server_from_dto(*server).map_err(|error| error.to_string())?,
                                ),
                            },
                        },
                    },
                    FlowNodeKindDto::MockStop { start_node_id } => {
                        FlowNodeKind::MockStop { start_node_id }
                    }
                    FlowNodeKindDto::MockWaitRequest {
                        start_node_id,
                        route_id,
                        timeout_ms,
                    } => FlowNodeKind::MockWaitRequest {
                        start_node_id,
                        route_id,
                        timeout_ms,
                    },
                    FlowNodeKindDto::MockSetResponse {
                        start_node_id,
                        route_id,
                        response_id,
                    } => FlowNodeKind::MockSetResponse {
                        start_node_id,
                        route_id,
                        response_id,
                    },
                    FlowNodeKindDto::MockAssertCalls {
                        start_node_id,
                        route_id,
                        operator,
                        count,
                    } => FlowNodeKind::MockAssertCalls {
                        start_node_id,
                        route_id,
                        operator: match operator {
                            MockCallCountOperatorDto::Equals => MockCallCountOperator::Equals,
                            MockCallCountOperatorDto::AtLeast => MockCallCountOperator::AtLeast,
                            MockCallCountOperatorDto::AtMost => MockCallCountOperator::AtMost,
                        },
                        count,
                    },
                    FlowNodeKindDto::Break => FlowNodeKind::Break,
                    FlowNodeKindDto::Continue => FlowNodeKind::Continue,
                    FlowNodeKindDto::While {
                        condition,
                        max_iterations,
                    } => FlowNodeKind::While {
                        condition: condition_from_dto(condition),
                        max_iterations,
                    },
                    FlowNodeKindDto::SetVariables { assignments } => FlowNodeKind::SetVariables {
                        assignments: assignments
                            .into_iter()
                            .map(|assignment| VariableAssignment {
                                name: assignment.name,
                                operation: match assignment.operation {
                                    VariableOperationDto::Set { value } => {
                                        VariableOperation::Set { value }
                                    }
                                    VariableOperationDto::Increment { by } => {
                                        VariableOperation::Increment { by }
                                    }
                                },
                            })
                            .collect(),
                    },
                },
                position: FlowPosition {
                    x: node.x,
                    y: node.y,
                },
            })
        })
        .collect()
}

/// See `nodes_from_dto`.
pub(crate) fn edges_from_dto(edges: Vec<FlowEdgeDto>) -> Vec<FlowEdge> {
    edges
        .into_iter()
        .map(|edge| FlowEdge {
            id: edge.id,
            source_node_id: edge.source_node_id,
            target_node_id: edge.target_node_id,
            source_handle: edge.source_handle,
        })
        .collect()
}

fn flow_from_input(input: FlowInput) -> Result<Flow, FlowsError> {
    let nodes = nodes_from_dto(input.nodes).map_err(|message| FlowsError::Invalid { message })?;
    let edges = edges_from_dto(input.edges);

    Flow::new_with_execution_kind(
        input.id,
        input.name,
        execution_kind_from_dto(input.execution_kind),
        nodes,
        edges,
        millis_to_system_time(input.created_at_ms),
        millis_to_system_time(input.updated_at_ms),
    )
    .and_then(|mut flow| {
        flow.set_presentation(input.presentation.into())?;
        Ok(flow)
    })
    .map_err(|error| FlowsError::Invalid {
        message: error.to_string(),
    })
}

fn build_snapshot(input: SaveFlowsInput) -> Result<FlowsSnapshot, FlowsError> {
    let flows = input
        .flows
        .into_iter()
        .map(flow_from_input)
        .collect::<Result<Vec<_>, FlowsError>>()?;

    let folders = input
        .folders
        .into_iter()
        .map(|folder| FlowFolder {
            id: folder.id,
            name: folder.name,
            flow_ids: folder.flow_ids,
        })
        .collect::<Vec<_>>();
    validate_flow_folders(&flows, &folders).map_err(|error| FlowsError::Invalid {
        message: error.to_string(),
    })?;
    Ok(FlowsSnapshot { flows, folders })
}

/// List flows in the workspace at `input.root_path`. An unsaved workspace
/// starts empty; flows are stored independently for each workspace.
#[tauri::command]
pub async fn list_flows(input: ListFlowsInput) -> Result<FlowsSnapshotDto, FlowsError> {
    let result = run_blocking(move || list_flows_inner(PathBuf::from(input.root_path))).await;
    crate::logging::logged("alcy::flow", "carregar flows", result)
}

fn list_flows_inner(root: PathBuf) -> Result<FlowsSnapshotDto, FlowsError> {
    let store = FlowStore::new(root);
    let snapshot = store.load()?;
    Ok(snapshot_to_dto(snapshot))
}

/// See `ordered_save`: older autosaves must never overwrite newer ones.
static FLOW_SAVES: OrderedSaves = OrderedSaves::new();

#[tauri::command]
pub async fn save_flows(input: SaveFlowsInput) -> Result<(), FlowsError> {
    let ticket = FLOW_SAVES.ticket();
    let result = run_blocking(move || {
        let root = PathBuf::from(input.root_path.clone());
        FLOW_SAVES.run(ticket, &root.clone(), || save_flows_inner(root, input))
    })
    .await;
    crate::logging::logged("alcy::flow", "salvar flows", result)
}

/// Run whole-file I/O on the blocking pool, away from the UI thread.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, FlowsError> + Send + 'static,
) -> Result<T, FlowsError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(FlowsError::Storage {
                message: error.to_string(),
            })
        })
}

fn save_flows_inner(root: PathBuf, input: SaveFlowsInput) -> Result<(), FlowsError> {
    let snapshot = build_snapshot(input)?;
    let store = FlowStore::new(root.clone());
    store.save(&snapshot)?;
    remove_orphaned_flow_assets(&root, &snapshot)?;
    Ok(())
}

/// Imported assets belong to their flow ID. Clean up only after saving the
/// canonical manifest, preserving the previous graph on save failure. Hidden
/// temporary import directories remain the importing operation's responsibility.
fn remove_orphaned_flow_assets(
    root: &std::path::Path,
    snapshot: &FlowsSnapshot,
) -> Result<(), FlowsError> {
    let assets = root.join(FLOW_ASSETS_DIRECTORY);
    if !assets.exists() {
        return Ok(());
    }
    let active: std::collections::BTreeSet<_> =
        snapshot.flows.iter().map(|flow| flow.id.as_str()).collect();
    for entry in std::fs::read_dir(&assets).map_err(|error| FlowsError::Storage {
        message: error.to_string(),
    })? {
        let entry = entry.map_err(|error| FlowsError::Storage {
            message: error.to_string(),
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.')
            || active.contains(name)
            || !entry
                .file_type()
                .map_err(|error| FlowsError::Storage {
                    message: error.to_string(),
                })?
                .is_dir()
        {
            continue;
        }
        std::fs::remove_dir_all(entry.path()).map_err(|error| FlowsError::Storage {
            message: error.to_string(),
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::UNIX_EPOCH;

    /// Exercise real IPC JSON: constructing Rust DTOs directly would miss
    /// regressions in camelCase struct-variant field deserialization.
    #[test]
    fn deserializes_a_request_node_from_camel_case_json_like_the_frontend_sends() {
        let json = r#"[
            {"id":"start","kind":"start","x":0.0,"y":0.0},
            {"id":"req-a","kind":"request","requestId":"abc","x":10.0,"y":0.0},
            {"id":"req-b","kind":"request","requestId":"def","x":20.0,"y":0.0}
        ]"#;

        let nodes: Vec<FlowNodeDto> = serde_json::from_str(json).unwrap();

        assert_eq!(
            nodes[1].kind,
            FlowNodeKindDto::Request {
                request_id: "abc".to_string()
            }
        );
        assert_eq!(
            nodes[2].kind,
            FlowNodeKindDto::Request {
                request_id: "def".to_string()
            }
        );
    }

    #[test]
    fn deserializes_note_log_display_sleep_and_set_variables_nodes_from_camel_case_json() {
        let json = r#"[
            {"id":"note","kind":"note","text":"oi","width":200.0,"height":100.0,"x":0.0,"y":0.0},
            {"id":"log","kind":"log","message":"{{a}}","x":0.0,"y":0.0},
            {"id":"display","kind":"display","template":"{{b}}","x":0.0,"y":0.0},
            {"id":"sleep","kind":"sleep","durationMs":1500,"x":0.0,"y":0.0},
            {"id":"vars","kind":"setVariables","assignments":[
                {"name":"a","operation":"set","value":"1"},
                {"name":"i","operation":"increment","by":1.0}
            ],"x":0.0,"y":0.0},
            {"id":"break","kind":"break","x":0.0,"y":0.0},
            {"id":"while","kind":"while","condition":{"left":"{{i}}","operator":"lessThan","right":"3"},"maxIterations":5,"x":0.0,"y":0.0}
        ]"#;

        let nodes = nodes_from_dto(serde_json::from_str(json).unwrap()).unwrap();

        assert_eq!(nodes[3].kind, FlowNodeKind::Sleep { duration_ms: 1500 });
        assert!(matches!(
            nodes[6].kind,
            FlowNodeKind::While {
                max_iterations: 5,
                ..
            }
        ));
        assert_eq!(
            nodes[4].kind,
            FlowNodeKind::SetVariables {
                assignments: vec![
                    VariableAssignment {
                        name: "a".to_string(),
                        operation: VariableOperation::Set {
                            value: "1".to_string()
                        },
                    },
                    VariableAssignment {
                        name: "i".to_string(),
                        operation: VariableOperation::Increment { by: 1.0 },
                    },
                ],
            }
        );
        assert_eq!(
            serde_json::to_value(node_to_dto(&nodes[3])).unwrap(),
            serde_json::json!({"id":"sleep","kind":"sleep","durationMs":1500,"x":0.0,"y":0.0})
        );
    }

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-flows-cmd-test-{nanos}-{count}"))
    }

    fn sample_flow_input() -> FlowInput {
        FlowInput {
            presentation: Default::default(),
            id: "flow-1".to_string(),
            name: "My flow".to_string(),
            execution_kind: FlowExecutionKindDto::Standard,
            nodes: vec![FlowNodeDto {
                id: "start".to_string(),
                kind: FlowNodeKindDto::Start { form: None },
                x: 0.0,
                y: 0.0,
            }],
            edges: vec![],
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn lists_no_flows_when_nothing_is_persisted() {
        let root = temp_root();

        let snapshot = list_flows_inner(root).unwrap();

        assert!(snapshot.flows.is_empty());
    }

    #[test]
    fn save_then_list_round_trips_flows() {
        let root = temp_root();
        let input = SaveFlowsInput {
            root_path: root.to_string_lossy().to_string(),
            flows: vec![sample_flow_input()],
            folders: vec![],
        };

        save_flows_inner(root.clone(), input).unwrap();
        let snapshot = list_flows_inner(root.clone()).unwrap();

        assert_eq!(snapshot.flows.len(), 1);
        assert_eq!(snapshot.flows[0].name, "My flow");
        assert_eq!(snapshot.flows[0].nodes.len(), 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn folder_membership_round_trips_through_camel_case_ipc() {
        let root = temp_root();
        let folder: FlowFolderDto = serde_json::from_value(serde_json::json!({
            "id": "folder", "name": "Checkout", "flowIds": ["flow-1"]
        }))
        .unwrap();
        save_flows_inner(
            root.clone(),
            SaveFlowsInput {
                root_path: root.to_string_lossy().into(),
                flows: vec![sample_flow_input()],
                folders: vec![folder],
            },
        )
        .unwrap();
        let snapshot = serde_json::to_value(list_flows_inner(root.clone()).unwrap()).unwrap();
        assert_eq!(
            snapshot["folders"][0]["flowIds"],
            serde_json::json!(["flow-1"])
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_missing_flow_membership_as_invalid_input() {
        let root = temp_root();
        let error = save_flows_inner(
            root.clone(),
            SaveFlowsInput {
                root_path: root.to_string_lossy().into(),
                flows: vec![],
                folders: vec![FlowFolderDto {
                    id: "folder".into(),
                    name: "Checkout".into(),
                    flow_ids: vec!["missing".into()],
                }],
            },
        )
        .unwrap_err();
        assert!(matches!(error, FlowsError::Invalid { .. }));
        assert!(!root.exists());
    }

    #[test]
    fn save_removes_only_assets_of_deleted_flows() {
        let root = temp_root();
        let assets = root.join(FLOW_ASSETS_DIRECTORY);
        std::fs::create_dir_all(assets.join("flow-1")).unwrap();
        std::fs::create_dir_all(assets.join("deleted-flow")).unwrap();
        std::fs::create_dir_all(assets.join(".interrupted.importing")).unwrap();

        save_flows_inner(
            root.clone(),
            SaveFlowsInput {
                root_path: root.to_string_lossy().to_string(),
                flows: vec![sample_flow_input()],
                folders: vec![],
            },
        )
        .unwrap();

        assert!(assets.join("flow-1").exists());
        assert!(!assets.join("deleted-flow").exists());
        assert!(assets.join(".interrupted.importing").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_rejects_invalid_flow_data() {
        let root = temp_root();
        let mut flow = sample_flow_input();
        flow.name = "".to_string();
        let input = SaveFlowsInput {
            root_path: root.to_string_lossy().to_string(),
            flows: vec![flow],
            folders: vec![],
        };

        let error = save_flows_inner(root, input).unwrap_err();

        assert!(matches!(error, FlowsError::Invalid { .. }));
    }

    #[test]
    fn flows_are_not_shared_between_workspaces() {
        let root_a = temp_root();
        let root_b = temp_root();
        let input = SaveFlowsInput {
            root_path: root_a.to_string_lossy().to_string(),
            flows: vec![sample_flow_input()],
            folders: vec![],
        };

        save_flows_inner(root_a.clone(), input).unwrap();
        let snapshot_b = list_flows_inner(root_b.clone()).unwrap();

        assert!(snapshot_b.flows.is_empty());

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }
}
