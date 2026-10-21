use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alcy_domain::{
    ComparisonOperator, Condition, Flow, FlowEdge, FlowExecutionKind, FlowFolder, FlowNode,
    FlowNodeKind, FlowPosition, LoadNode, LoadNodeKind, MockCallCountOperator, MockServerSource,
    VariableAssignment, VariableOperation, validate_flow_folders,
};
use serde::{Deserialize, Serialize};

use crate::collections_store::{PersistedRequest, persisted_from_request, request_from_persisted};
use crate::mock_server_store::{Server as PersistedMockServer, server_from, server_to};
use crate::storage_error::StorageError;

// v2 gives unnamed request edges success semantics (spec 0048 / ADR 0016).
// v3 adds load flows. v4 adds folders; older builds reject the file rather
// than silently losing workspace organization.
const CURRENT_VERSION: u32 = 5;
const LEGACY_VERSION: u32 = 1;
const PREVIOUS_VERSION: u32 = 4;
const MANIFEST_FILE_NAME: &str = "alcy-flows.json";

/// Complete workspace flow state, loaded and saved atomically.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowsSnapshot {
    pub flows: Vec<Flow>,
    pub folders: Vec<FlowFolder>,
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    flows: Vec<PersistedFlow>,
    #[serde(default)]
    folders: Vec<PersistedFlowFolder>,
}

#[derive(Serialize, Deserialize)]
struct PersistedFlowFolder {
    id: String,
    name: String,
    flow_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct PersistedFlow {
    id: String,
    name: String,
    #[serde(default)]
    presentation: crate::FlowPresentationConfig,
    #[serde(default)]
    execution_kind: PersistedFlowExecutionKind,
    nodes: Vec<PersistedNode>,
    edges: Vec<PersistedEdge>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum PersistedFlowExecutionKind {
    #[default]
    Standard,
    Load,
}

#[derive(Serialize, Deserialize)]
struct PersistedNode {
    id: String,
    #[serde(flatten)]
    kind: PersistedNodeKind,
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PersistedComparisonOperator {
    Equals,
    NotEquals,
    GreaterThan,
    LessThan,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCondition {
    left: String,
    operator: PersistedComparisonOperator,
    right: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PersistedNodeKind {
    Start {
        #[serde(default)]
        form: Option<crate::FlowFormConfig>,
    },
    HumanAction {
        form: crate::FlowFormConfig,
    },
    Block {
        label: String,
    },
    // Additive variant: earlier v1 files deserialize unchanged (spec 0043).
    Request {
        request_id: String,
    },
    // Additive variant (spec 0047), as above.
    If {
        condition: PersistedCondition,
    },
    // Additive variants (spec 0083), as above.
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
        assignments: Vec<PersistedVariableAssignment>,
    },
    // Additive variant (spec 0084), as above.
    While {
        condition: PersistedCondition,
        max_iterations: u32,
    },
    // Additive variants (spec 0085), as above.
    Break,
    Continue,
    // Additive (spec 0086): a full request in the collections storage format.
    InlineRequest {
        request: Box<PersistedRequest>,
    },
    /// v3: canonical load-block JSON, validated by the engine before execution.
    /// Saving and importing preserve it without interpretation.
    Load {
        load_kind: PersistedLoadNodeKind,
        label: String,
        config: String,
    },
    // Additive (spec 0121), like Request. Inline mocks reuse mock-server storage.
    MockStart {
        source: PersistedMockSource,
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
        operator: PersistedMockCallCountOperator,
        count: u32,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedMockSource {
    Saved { server_id: String },
    Inline { server: Box<PersistedMockServer> },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PersistedMockCallCountOperator {
    Equals,
    AtLeast,
    AtMost,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PersistedLoadNodeKind {
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

#[derive(Serialize, Deserialize)]
struct PersistedVariableAssignment {
    name: String,
    #[serde(flatten)]
    operation: PersistedVariableOperation,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum PersistedVariableOperation {
    Set { value: String },
    Increment { by: f64 },
}

#[derive(Serialize, Deserialize)]
struct PersistedEdge {
    id: String,
    source_node_id: String,
    target_node_id: String,
    // Additive (spec 0047): missing handles in older v1 files default to None.
    #[serde(default)]
    source_handle: Option<String>,
}

/// Versioned workspace flow storage using a temporary file and atomic rename.
/// Each workspace has its own independent `alcy-flows.json` manifest.
pub struct FlowStore {
    path: PathBuf,
}

impl FlowStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join(MANIFEST_FILE_NAME),
        }
    }

    pub fn load(&self) -> Result<FlowsSnapshot, StorageError> {
        if !self.path.exists() {
            return Ok(FlowsSnapshot::default());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let persisted: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if persisted.version != CURRENT_VERSION
            && persisted.version != PREVIOUS_VERSION
            && persisted.version != 3
            && persisted.version != 2
            && persisted.version != LEGACY_VERSION
        {
            return Err(StorageError::UnsupportedVersion(persisted.version));
        }

        let flows = persisted
            .flows
            .into_iter()
            .map(flow_from_persisted)
            .collect::<Result<Vec<_>, StorageError>>()?;

        let folders = persisted
            .folders
            .into_iter()
            .map(|folder| FlowFolder {
                id: folder.id,
                name: folder.name,
                flow_ids: folder.flow_ids,
            })
            .collect::<Vec<_>>();
        validate_flow_folders(&flows, &folders)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        Ok(FlowsSnapshot { flows, folders })
    }

    pub fn save(&self, snapshot: &FlowsSnapshot) -> Result<(), StorageError> {
        validate_flow_folders(&snapshot.flows, &snapshot.folders)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        let persisted = PersistedFile {
            version: CURRENT_VERSION,
            flows: snapshot.flows.iter().map(persisted_from_flow).collect(),
            folders: snapshot
                .folders
                .iter()
                .map(|folder| PersistedFlowFolder {
                    id: folder.id.clone(),
                    name: folder.name.clone(),
                    flow_ids: folder.flow_ids.clone(),
                })
                .collect(),
        };

        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }

        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.path)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        Ok(())
    }
}

fn condition_from_persisted(condition: PersistedCondition) -> Condition {
    Condition {
        left: condition.left,
        operator: match condition.operator {
            PersistedComparisonOperator::Equals => ComparisonOperator::Equals,
            PersistedComparisonOperator::NotEquals => ComparisonOperator::NotEquals,
            PersistedComparisonOperator::GreaterThan => ComparisonOperator::GreaterThan,
            PersistedComparisonOperator::LessThan => ComparisonOperator::LessThan,
        },
        right: condition.right,
    }
}

pub(crate) fn flow_from_persisted(persisted: PersistedFlow) -> Result<Flow, StorageError> {
    let nodes: Vec<FlowNode> = persisted
        .nodes
        .into_iter()
        .map(|node| {
            Ok(FlowNode {
                id: node.id,
                kind: match node.kind {
                    PersistedNodeKind::Start { form } => form.map_or(FlowNodeKind::Start, |form| {
                        FlowNodeKind::StartForm { form: form.into() }
                    }),
                    PersistedNodeKind::HumanAction { form } => {
                        FlowNodeKind::HumanAction { form: form.into() }
                    }
                    PersistedNodeKind::Block { label } => FlowNodeKind::Block { label },
                    PersistedNodeKind::Request { request_id } => {
                        FlowNodeKind::Request { request_id }
                    }
                    PersistedNodeKind::If { condition } => FlowNodeKind::If {
                        condition: condition_from_persisted(condition),
                    },
                    PersistedNodeKind::Note {
                        text,
                        width,
                        height,
                    } => FlowNodeKind::Note {
                        text,
                        width,
                        height,
                    },
                    PersistedNodeKind::Log { message } => FlowNodeKind::Log { message },
                    PersistedNodeKind::Display { template } => FlowNodeKind::Display { template },
                    PersistedNodeKind::Sleep { duration_ms } => FlowNodeKind::Sleep { duration_ms },
                    PersistedNodeKind::InlineRequest { request } => FlowNodeKind::InlineRequest {
                        request: Box::new(request_from_persisted(*request)?),
                    },
                    PersistedNodeKind::Load {
                        load_kind,
                        label,
                        config,
                    } => FlowNodeKind::Load {
                        node: LoadNode {
                            kind: load_node_kind_from_persisted(load_kind),
                            label,
                            config,
                        },
                    },
                    PersistedNodeKind::MockStart { source } => FlowNodeKind::MockStart {
                        source: match source {
                            PersistedMockSource::Saved { server_id } => {
                                MockServerSource::Saved { server_id }
                            }
                            PersistedMockSource::Inline { server } => MockServerSource::Inline {
                                server: Box::new(server_from(*server)?),
                            },
                        },
                    },
                    PersistedNodeKind::MockStop { start_node_id } => {
                        FlowNodeKind::MockStop { start_node_id }
                    }
                    PersistedNodeKind::MockWaitRequest {
                        start_node_id,
                        route_id,
                        timeout_ms,
                    } => FlowNodeKind::MockWaitRequest {
                        start_node_id,
                        route_id,
                        timeout_ms,
                    },
                    PersistedNodeKind::MockSetResponse {
                        start_node_id,
                        route_id,
                        response_id,
                    } => FlowNodeKind::MockSetResponse {
                        start_node_id,
                        route_id,
                        response_id,
                    },
                    PersistedNodeKind::MockAssertCalls {
                        start_node_id,
                        route_id,
                        operator,
                        count,
                    } => FlowNodeKind::MockAssertCalls {
                        start_node_id,
                        route_id,
                        operator: match operator {
                            PersistedMockCallCountOperator::Equals => MockCallCountOperator::Equals,
                            PersistedMockCallCountOperator::AtLeast => {
                                MockCallCountOperator::AtLeast
                            }
                            PersistedMockCallCountOperator::AtMost => MockCallCountOperator::AtMost,
                        },
                        count,
                    },
                    PersistedNodeKind::Break => FlowNodeKind::Break,
                    PersistedNodeKind::Continue => FlowNodeKind::Continue,
                    PersistedNodeKind::While {
                        condition,
                        max_iterations,
                    } => FlowNodeKind::While {
                        condition: condition_from_persisted(condition),
                        max_iterations,
                    },
                    PersistedNodeKind::SetVariables { assignments } => FlowNodeKind::SetVariables {
                        assignments: assignments
                            .into_iter()
                            .map(|assignment| VariableAssignment {
                                name: assignment.name,
                                operation: match assignment.operation {
                                    PersistedVariableOperation::Set { value } => {
                                        VariableOperation::Set { value }
                                    }
                                    PersistedVariableOperation::Increment { by } => {
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
        .collect::<Result<_, StorageError>>()?;

    // Idempotent v1 -> v2 migration: unnamed request edges become success edges,
    // preserving the original execution path for every accepted version.
    let request_node_ids: HashSet<&str> = nodes
        .iter()
        .filter(|node| matches!(node.kind, FlowNodeKind::Request { .. }))
        .map(|node| node.id.as_str())
        .collect();
    let edges = persisted
        .edges
        .into_iter()
        .map(|edge| {
            let source_handle = edge.source_handle.or_else(|| {
                request_node_ids
                    .contains(edge.source_node_id.as_str())
                    .then(|| "success".to_string())
            });
            FlowEdge {
                id: edge.id,
                source_node_id: edge.source_node_id,
                target_node_id: edge.target_node_id,
                source_handle,
            }
        })
        .collect();

    Flow::new_with_execution_kind(
        persisted.id,
        persisted.name,
        match persisted.execution_kind {
            PersistedFlowExecutionKind::Standard => FlowExecutionKind::Standard,
            PersistedFlowExecutionKind::Load => FlowExecutionKind::Load,
        },
        nodes,
        edges,
        UNIX_EPOCH + Duration::from_millis(persisted.created_at_ms),
        UNIX_EPOCH + Duration::from_millis(persisted.updated_at_ms),
    )
    .and_then(|mut flow| {
        flow.set_presentation(persisted.presentation.into())?;
        Ok(flow)
    })
    .map_err(|error| StorageError::Corrupted(error.to_string()))
}

fn condition_to_persisted(condition: &Condition) -> PersistedCondition {
    PersistedCondition {
        left: condition.left.clone(),
        operator: match condition.operator {
            ComparisonOperator::Equals => PersistedComparisonOperator::Equals,
            ComparisonOperator::NotEquals => PersistedComparisonOperator::NotEquals,
            ComparisonOperator::GreaterThan => PersistedComparisonOperator::GreaterThan,
            ComparisonOperator::LessThan => PersistedComparisonOperator::LessThan,
        },
        right: condition.right.clone(),
    }
}

fn load_node_kind_from_persisted(kind: PersistedLoadNodeKind) -> LoadNodeKind {
    match kind {
        PersistedLoadNodeKind::Scenario => LoadNodeKind::Scenario,
        PersistedLoadNodeKind::Request => LoadNodeKind::Request,
        PersistedLoadNodeKind::Script => LoadNodeKind::Script,
        PersistedLoadNodeKind::Repeat => LoadNodeKind::Repeat,
        PersistedLoadNodeKind::ForEach => LoadNodeKind::ForEach,
        PersistedLoadNodeKind::OncePerVu => LoadNodeKind::OncePerVu,
        PersistedLoadNodeKind::TimeBox => LoadNodeKind::TimeBox,
        PersistedLoadNodeKind::Select => LoadNodeKind::Select,
        PersistedLoadNodeKind::Group => LoadNodeKind::Group,
        PersistedLoadNodeKind::Timer => LoadNodeKind::Timer,
        PersistedLoadNodeKind::Dataset => LoadNodeKind::Dataset,
        PersistedLoadNodeKind::ConfigureSession => LoadNodeKind::ConfigureSession,
        PersistedLoadNodeKind::Extract => LoadNodeKind::Extract,
        PersistedLoadNodeKind::Check => LoadNodeKind::Check,
        PersistedLoadNodeKind::Metric => LoadNodeKind::Metric,
        PersistedLoadNodeKind::Threshold => LoadNodeKind::Threshold,
    }
}

fn load_node_kind_to_persisted(kind: LoadNodeKind) -> PersistedLoadNodeKind {
    match kind {
        LoadNodeKind::Scenario => PersistedLoadNodeKind::Scenario,
        LoadNodeKind::Request => PersistedLoadNodeKind::Request,
        LoadNodeKind::Script => PersistedLoadNodeKind::Script,
        LoadNodeKind::Repeat => PersistedLoadNodeKind::Repeat,
        LoadNodeKind::ForEach => PersistedLoadNodeKind::ForEach,
        LoadNodeKind::OncePerVu => PersistedLoadNodeKind::OncePerVu,
        LoadNodeKind::TimeBox => PersistedLoadNodeKind::TimeBox,
        LoadNodeKind::Select => PersistedLoadNodeKind::Select,
        LoadNodeKind::Group => PersistedLoadNodeKind::Group,
        LoadNodeKind::Timer => PersistedLoadNodeKind::Timer,
        LoadNodeKind::Dataset => PersistedLoadNodeKind::Dataset,
        LoadNodeKind::ConfigureSession => PersistedLoadNodeKind::ConfigureSession,
        LoadNodeKind::Extract => PersistedLoadNodeKind::Extract,
        LoadNodeKind::Check => PersistedLoadNodeKind::Check,
        LoadNodeKind::Metric => PersistedLoadNodeKind::Metric,
        LoadNodeKind::Threshold => PersistedLoadNodeKind::Threshold,
    }
}

pub(crate) fn persisted_from_flow(flow: &Flow) -> PersistedFlow {
    PersistedFlow {
        id: flow.id.clone(),
        name: flow.name().to_string(),
        presentation: flow.presentation.clone().into(),
        execution_kind: match flow.execution_kind() {
            FlowExecutionKind::Standard => PersistedFlowExecutionKind::Standard,
            FlowExecutionKind::Load => PersistedFlowExecutionKind::Load,
        },
        nodes: flow
            .nodes()
            .iter()
            .map(|node| PersistedNode {
                id: node.id.clone(),
                kind: match &node.kind {
                    FlowNodeKind::Start => PersistedNodeKind::Start { form: None },
                    FlowNodeKind::StartForm { form } => PersistedNodeKind::Start {
                        form: Some(form.clone().into()),
                    },
                    FlowNodeKind::HumanAction { form } => PersistedNodeKind::HumanAction {
                        form: form.clone().into(),
                    },
                    FlowNodeKind::Block { label } => PersistedNodeKind::Block {
                        label: label.clone(),
                    },
                    FlowNodeKind::Request { request_id } => PersistedNodeKind::Request {
                        request_id: request_id.clone(),
                    },
                    FlowNodeKind::If { condition } => PersistedNodeKind::If {
                        condition: condition_to_persisted(condition),
                    },
                    FlowNodeKind::Note {
                        text,
                        width,
                        height,
                    } => PersistedNodeKind::Note {
                        text: text.clone(),
                        width: *width,
                        height: *height,
                    },
                    FlowNodeKind::Log { message } => PersistedNodeKind::Log {
                        message: message.clone(),
                    },
                    FlowNodeKind::Display { template } => PersistedNodeKind::Display {
                        template: template.clone(),
                    },
                    FlowNodeKind::Sleep { duration_ms } => PersistedNodeKind::Sleep {
                        duration_ms: *duration_ms,
                    },
                    FlowNodeKind::InlineRequest { request } => PersistedNodeKind::InlineRequest {
                        request: Box::new(persisted_from_request(request)),
                    },
                    FlowNodeKind::Load { node } => PersistedNodeKind::Load {
                        load_kind: load_node_kind_to_persisted(node.kind),
                        label: node.label.clone(),
                        config: node.config.clone(),
                    },
                    FlowNodeKind::MockStart { source } => PersistedNodeKind::MockStart {
                        source: match source {
                            MockServerSource::Saved { server_id } => PersistedMockSource::Saved {
                                server_id: server_id.clone(),
                            },
                            MockServerSource::Inline { server } => PersistedMockSource::Inline {
                                server: Box::new(server_to(server)),
                            },
                        },
                    },
                    FlowNodeKind::MockStop { start_node_id } => PersistedNodeKind::MockStop {
                        start_node_id: start_node_id.clone(),
                    },
                    FlowNodeKind::MockWaitRequest {
                        start_node_id,
                        route_id,
                        timeout_ms,
                    } => PersistedNodeKind::MockWaitRequest {
                        start_node_id: start_node_id.clone(),
                        route_id: route_id.clone(),
                        timeout_ms: *timeout_ms,
                    },
                    FlowNodeKind::MockSetResponse {
                        start_node_id,
                        route_id,
                        response_id,
                    } => PersistedNodeKind::MockSetResponse {
                        start_node_id: start_node_id.clone(),
                        route_id: route_id.clone(),
                        response_id: response_id.clone(),
                    },
                    FlowNodeKind::MockAssertCalls {
                        start_node_id,
                        route_id,
                        operator,
                        count,
                    } => PersistedNodeKind::MockAssertCalls {
                        start_node_id: start_node_id.clone(),
                        route_id: route_id.clone(),
                        operator: match operator {
                            MockCallCountOperator::Equals => PersistedMockCallCountOperator::Equals,
                            MockCallCountOperator::AtLeast => {
                                PersistedMockCallCountOperator::AtLeast
                            }
                            MockCallCountOperator::AtMost => PersistedMockCallCountOperator::AtMost,
                        },
                        count: *count,
                    },
                    FlowNodeKind::Break => PersistedNodeKind::Break,
                    FlowNodeKind::Continue => PersistedNodeKind::Continue,
                    FlowNodeKind::While {
                        condition,
                        max_iterations,
                    } => PersistedNodeKind::While {
                        condition: condition_to_persisted(condition),
                        max_iterations: *max_iterations,
                    },
                    FlowNodeKind::SetVariables { assignments } => PersistedNodeKind::SetVariables {
                        assignments: assignments
                            .iter()
                            .map(|assignment| PersistedVariableAssignment {
                                name: assignment.name.clone(),
                                operation: match &assignment.operation {
                                    VariableOperation::Set { value } => {
                                        PersistedVariableOperation::Set {
                                            value: value.clone(),
                                        }
                                    }
                                    VariableOperation::Increment { by } => {
                                        PersistedVariableOperation::Increment { by: *by }
                                    }
                                },
                            })
                            .collect(),
                    },
                },
                x: node.position.x,
                y: node.position.y,
            })
            .collect(),
        edges: flow
            .edges()
            .iter()
            .map(|edge| PersistedEdge {
                id: edge.id.clone(),
                source_node_id: edge.source_node_id.clone(),
                target_node_id: edge.target_node_id.clone(),
                source_handle: edge.source_handle.clone(),
            })
            .collect(),
        created_at_ms: to_millis(flow.created_at),
        updated_at_ms: to_millis(flow.updated_at),
    }
}

fn to_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-flow-store-test-{nanos}-{count}"))
    }

    /// Match millisecond storage precision when constructing round-trip fixtures.
    fn millis_now() -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(to_millis(SystemTime::now()))
    }

    fn sample_snapshot() -> FlowsSnapshot {
        let now = millis_now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                FlowNode {
                    id: "start".to_string(),
                    kind: FlowNodeKind::Start,
                    position: FlowPosition { x: 0.0, y: 0.0 },
                },
                FlowNode {
                    id: "block-1".to_string(),
                    kind: FlowNodeKind::Block {
                        label: "Block".to_string(),
                    },
                    position: FlowPosition { x: 120.5, y: 40.0 },
                },
            ],
            vec![FlowEdge {
                id: "edge-1".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "block-1".to_string(),
                source_handle: None,
            }],
            now,
            now,
        )
        .unwrap();

        FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        }
    }

    #[test]
    fn load_returns_an_empty_snapshot_when_the_file_does_not_exist() {
        let store = FlowStore::new(temp_root());

        let snapshot = store.load().unwrap();

        assert_eq!(snapshot, FlowsSnapshot::default());
    }

    #[test]
    fn save_then_load_round_trips_a_request_node() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let now = millis_now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                FlowNode {
                    id: "start".to_string(),
                    kind: FlowNodeKind::Start,
                    position: FlowPosition { x: 0.0, y: 0.0 },
                },
                FlowNode {
                    id: "req-1".to_string(),
                    kind: FlowNodeKind::Request {
                        request_id: "request-1".to_string(),
                    },
                    position: FlowPosition { x: 120.0, y: 0.0 },
                },
                FlowNode {
                    id: "block-1".to_string(),
                    kind: FlowNodeKind::Block {
                        label: "Block".to_string(),
                    },
                    position: FlowPosition { x: 240.0, y: 0.0 },
                },
            ],
            vec![
                FlowEdge {
                    id: "edge-1".to_string(),
                    source_node_id: "start".to_string(),
                    target_node_id: "req-1".to_string(),
                    source_handle: None,
                },
                FlowEdge {
                    id: "edge-2".to_string(),
                    source_node_id: "req-1".to_string(),
                    target_node_id: "block-1".to_string(),
                    source_handle: Some("failure".to_string()),
                },
            ],
            now,
            now,
        )
        .unwrap();
        let snapshot = FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        };

        store.save(&snapshot).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, snapshot);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_saved_and_inline_mock_nodes_without_a_version_bump() {
        use alcy_domain::{HttpMethod, MockResponse, MockRoute, MockServer};

        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let now = millis_now();
        let mut inline = MockServer::new("inline-1".to_string(), "Avulso".to_string(), 4010);
        inline.routes.push(MockRoute {
            id: "route-1".to_string(),
            name: "Usuários".to_string(),
            enabled: true,
            method: HttpMethod::Post,
            path: "/users/:id".to_string(),
            default_response: MockResponse {
                id: "response-1".to_string(),
                name: "Criado".to_string(),
                enabled: true,
                status: 201,
                headers: vec![("Content-Type".to_string(), "application/json".to_string())],
                body: "{}".to_string(),
                delay_ms: 0,
                condition: None,
            },
            alternatives: vec![],
        });
        let node = |id: &str, kind: FlowNodeKind| FlowNode {
            id: id.to_string(),
            kind,
            position: FlowPosition { x: 0.0, y: 0.0 },
        };
        let flow = Flow::new(
            "flow-1",
            "Mocks",
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "saved",
                    FlowNodeKind::MockStart {
                        source: MockServerSource::Saved {
                            server_id: "server-1".to_string(),
                        },
                    },
                ),
                node(
                    "inline",
                    FlowNodeKind::MockStart {
                        source: MockServerSource::Inline {
                            server: Box::new(inline),
                        },
                    },
                ),
                node(
                    "wait",
                    FlowNodeKind::MockWaitRequest {
                        start_node_id: "inline".to_string(),
                        route_id: "route-1".to_string(),
                        timeout_ms: 30_000,
                    },
                ),
                node(
                    "force",
                    FlowNodeKind::MockSetResponse {
                        start_node_id: "inline".to_string(),
                        route_id: "route-1".to_string(),
                        response_id: None,
                    },
                ),
                node(
                    "assert",
                    FlowNodeKind::MockAssertCalls {
                        start_node_id: "inline".to_string(),
                        route_id: "route-1".to_string(),
                        operator: MockCallCountOperator::AtLeast,
                        count: 2,
                    },
                ),
                node(
                    "stop",
                    FlowNodeKind::MockStop {
                        start_node_id: "saved".to_string(),
                    },
                ),
            ],
            vec![FlowEdge {
                id: "edge-1".to_string(),
                source_node_id: "wait".to_string(),
                target_node_id: "assert".to_string(),
                source_handle: Some("true".to_string()),
            }],
            now,
            now,
        )
        .unwrap();
        let snapshot = FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        };

        store.save(&snapshot).unwrap();
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(raw.contains("\"version\": 5"));

        assert_eq!(store.load().unwrap(), snapshot);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_a_load_flow_as_current_version() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let now = millis_now();
        let flow = Flow::new_with_execution_kind(
            "load-1",
            "Carga",
            FlowExecutionKind::Load,
            vec![
                FlowNode {
                    id: "start".to_string(),
                    kind: FlowNodeKind::Start,
                    position: FlowPosition { x: 0.0, y: 0.0 },
                },
                FlowNode {
                    id: "scenario".to_string(),
                    kind: FlowNodeKind::Load {
                        node: LoadNode {
                            kind: LoadNodeKind::Scenario,
                            label: "Cenário".to_string(),
                            config: r#"{"executor":"constantVus","vus":2,"durationMs":1000}"#
                                .to_string(),
                        },
                    },
                    position: FlowPosition { x: 200.0, y: 0.0 },
                },
            ],
            vec![FlowEdge {
                id: "start-scenario".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "scenario".to_string(),
                source_handle: None,
            }],
            now,
            now,
        )
        .unwrap();
        let snapshot = FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        };

        store.save(&snapshot).unwrap();
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(raw.contains("\"version\": 5"));
        assert!(raw.contains("\"execution_kind\": \"load\""));
        assert_eq!(store.load().unwrap(), snapshot);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn load_accepts_a_v2_standard_flow_without_execution_kind() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version":2,"flows":[{"id":"flow-1","name":"Legado","nodes":[{"id":"start","kind":"start","x":0.0,"y":0.0}],"edges":[],"created_at_ms":0,"updated_at_ms":0}]}"#,
        )
        .unwrap();

        let snapshot = FlowStore::new(root.clone()).load().unwrap();
        assert_eq!(
            snapshot.flows[0].execution_kind(),
            FlowExecutionKind::Standard
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn save_then_load_round_trips_note_log_display_sleep_and_set_variables_nodes() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let now = millis_now();
        let node = |id: &str, kind: FlowNodeKind| FlowNode {
            id: id.to_string(),
            kind,
            position: FlowPosition { x: 0.0, y: 0.0 },
        };
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "note-1",
                    FlowNodeKind::Note {
                        text: "lembrete".to_string(),
                        width: 220.0,
                        height: 140.5,
                    },
                ),
                node(
                    "log-1",
                    FlowNodeKind::Log {
                        message: "status {{nodes.a.response.status}}".to_string(),
                    },
                ),
                node(
                    "display-1",
                    FlowNodeKind::Display {
                        template: "{{token}}".to_string(),
                    },
                ),
                node("sleep-1", FlowNodeKind::Sleep { duration_ms: 1500 }),
                node("break-1", FlowNodeKind::Break),
                node(
                    "inline-1",
                    FlowNodeKind::InlineRequest {
                        request: Box::new(
                            alcy_domain::SavedRequest::new(
                                "inline-1",
                                "Avulsa",
                                alcy_domain::Request::new(
                                    alcy_domain::Endpoint::new("{{host}}/users").unwrap(),
                                    alcy_domain::RequestDocument::new(
                                        alcy_domain::ProtocolId::Rest,
                                        "{\"a\":1}",
                                    ),
                                    "",
                                    vec![
                                        alcy_domain::HeaderEntry::new("X-Id", "{{id}}", true)
                                            .unwrap(),
                                    ],
                                    alcy_domain::Authentication::Bearer {
                                        token: "{{token}}".to_string(),
                                    },
                                )
                                .with_method(alcy_domain::HttpMethod::Put),
                            )
                            .unwrap(),
                        ),
                    },
                ),
                node("continue-1", FlowNodeKind::Continue),
                node(
                    "while-1",
                    FlowNodeKind::While {
                        condition: alcy_domain::Condition {
                            left: "{{i}}".to_string(),
                            operator: alcy_domain::ComparisonOperator::LessThan,
                            right: "3".to_string(),
                        },
                        max_iterations: 50,
                    },
                ),
                node(
                    "vars-1",
                    FlowNodeKind::SetVariables {
                        assignments: vec![
                            VariableAssignment {
                                name: "page".to_string(),
                                operation: VariableOperation::Set {
                                    value: "1".to_string(),
                                },
                            },
                            VariableAssignment {
                                name: "count".to_string(),
                                operation: VariableOperation::Increment { by: 2.5 },
                            },
                        ],
                    },
                ),
            ],
            vec![
                FlowEdge {
                    id: "edge-1".to_string(),
                    source_node_id: "start".to_string(),
                    target_node_id: "vars-1".to_string(),
                    source_handle: None,
                },
                FlowEdge {
                    id: "edge-2".to_string(),
                    source_node_id: "vars-1".to_string(),
                    target_node_id: "sleep-1".to_string(),
                    source_handle: None,
                },
            ],
            now,
            now,
        )
        .unwrap();
        let snapshot = FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        };

        store.save(&snapshot).unwrap();
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, snapshot);
        assert!(raw.contains("\"kind\": \"setVariables\""));
        assert!(raw.contains("\"operation\": \"increment\""));
        assert!(raw.contains("\"duration_ms\": 1500"));
        assert!(raw.contains("\"max_iterations\": 50"));
        assert!(raw.contains("\"kind\": \"inlineRequest\""));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_an_if_node_with_handled_edges() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let now = millis_now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                FlowNode {
                    id: "start".to_string(),
                    kind: FlowNodeKind::Start,
                    position: FlowPosition { x: 0.0, y: 0.0 },
                },
                FlowNode {
                    id: "if-1".to_string(),
                    kind: FlowNodeKind::If {
                        condition: alcy_domain::Condition {
                            left: "{{nodes.a.response.status}}".to_string(),
                            operator: alcy_domain::ComparisonOperator::Equals,
                            right: "200".to_string(),
                        },
                    },
                    position: FlowPosition { x: 120.0, y: 0.0 },
                },
                FlowNode {
                    id: "block-a".to_string(),
                    kind: FlowNodeKind::Block {
                        label: "A".to_string(),
                    },
                    position: FlowPosition { x: 240.0, y: 0.0 },
                },
            ],
            vec![
                FlowEdge {
                    id: "edge-1".to_string(),
                    source_node_id: "start".to_string(),
                    target_node_id: "if-1".to_string(),
                    source_handle: None,
                },
                FlowEdge {
                    id: "edge-2".to_string(),
                    source_node_id: "if-1".to_string(),
                    target_node_id: "block-a".to_string(),
                    source_handle: Some("true".to_string()),
                },
            ],
            now,
            now,
        )
        .unwrap();
        let snapshot = FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        };

        store.save(&snapshot).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, snapshot);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_resolves_a_missing_source_handle_as_none_for_a_file_saved_before_if_existed() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{
                "version": 1,
                "flows": [{
                    "id": "flow-1",
                    "name": "My flow",
                    "nodes": [
                        {"id": "start", "kind": "start", "x": 0.0, "y": 0.0},
                        {"id": "block-1", "kind": "block", "label": "Block", "x": 100.0, "y": 0.0}
                    ],
                    "edges": [
                        {"id": "edge-1", "source_node_id": "start", "target_node_id": "block-1"}
                    ],
                    "created_at_ms": 0,
                    "updated_at_ms": 0
                }]
            }"#,
        )
        .unwrap();
        let store = FlowStore::new(root.clone());

        let snapshot = store.load().unwrap();

        assert_eq!(snapshot.flows[0].edges()[0].source_handle, None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_migrates_a_legacy_edge_leaving_a_request_node_to_the_success_handle() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{
                "version": 1,
                "flows": [{
                    "id": "flow-1",
                    "name": "My flow",
                    "nodes": [
                        {"id": "start", "kind": "start", "x": 0.0, "y": 0.0},
                        {"id": "req-1", "kind": "request", "request_id": "request-1", "x": 100.0, "y": 0.0},
                        {"id": "block-1", "kind": "block", "label": "Block", "x": 200.0, "y": 0.0}
                    ],
                    "edges": [
                        {"id": "edge-1", "source_node_id": "start", "target_node_id": "req-1"},
                        {"id": "edge-2", "source_node_id": "req-1", "target_node_id": "block-1"}
                    ],
                    "created_at_ms": 0,
                    "updated_at_ms": 0
                }]
            }"#,
        )
        .unwrap();
        let store = FlowStore::new(root.clone());

        let snapshot = store.load().unwrap();

        let edges = snapshot.flows[0].edges();
        assert_eq!(edges[0].source_handle, None);
        assert_eq!(edges[1].source_handle.as_deref(), Some("success"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_the_snapshot() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let snapshot = sample_snapshot();

        store.save(&snapshot).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, snapshot);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn round_trips_ordered_folders_and_empty_folders_without_changing_graphs() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let mut snapshot = sample_snapshot();
        snapshot.folders = vec![
            FlowFolder {
                id: "empty".into(),
                name: "Empty".into(),
                flow_ids: vec![],
            },
            FlowFolder {
                id: "folder".into(),
                name: "Checkout".into(),
                flow_ids: vec![snapshot.flows[0].id.clone()],
            },
        ];
        store.save(&snapshot).unwrap();
        assert_eq!(store.load().unwrap(), snapshot);

        // Removing a folder preserves its graphs.
        snapshot.folders.clear();
        store.save(&snapshot).unwrap();
        assert_eq!(store.load().unwrap(), snapshot);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn round_trips_forms_and_independent_panel_positions_in_v5() {
        use alcy_domain::{
            FlowForm, FlowFormField, FlowFormFieldKind, FlowFormSection, FlowPanel,
            FlowPresentation,
        };
        let root = temp_root();
        let form = FlowForm {
            title: "Input".into(),
            sections: vec![FlowFormSection {
                id: "main".into(),
                title: "Details".into(),
                collapsed: true,
                fields: vec![FlowFormField {
                    id: "quantity".into(),
                    label: "Quantity".into(),
                    kind: FlowFormFieldKind::Number,
                    min: Some(1.0),
                    step: Some(1.0),
                    required: true,
                    initial_value: "2".into(),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let now = millis_now();
        let mut flow = Flow::new(
            "form-flow",
            "Operator flow",
            vec![
                FlowNode {
                    id: "start".into(),
                    kind: FlowNodeKind::StartForm { form: form.clone() },
                    position: FlowPosition { x: 0.0, y: 0.0 },
                },
                FlowNode {
                    id: "human".into(),
                    kind: FlowNodeKind::HumanAction { form },
                    position: FlowPosition { x: 300.0, y: 0.0 },
                },
            ],
            vec![FlowEdge {
                id: "edge".into(),
                source_node_id: "start".into(),
                target_node_id: "human".into(),
                source_handle: None,
            }],
            now,
            now,
        )
        .unwrap();
        flow.set_presentation(FlowPresentation {
            panels: vec![FlowPanel {
                node_id: "human".into(),
                title: "Review".into(),
                x: 40.0,
                y: 80.0,
                width: 500.0,
                height: 450.0,
            }],
        })
        .unwrap();
        let expected = FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        };
        let store = FlowStore::new(root.clone());
        store.save(&expected).unwrap();
        assert_eq!(store.load().unwrap(), expected);
        let serialized = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(serialized.contains("\"version\": 5"));
        assert!(serialized.contains("humanAction"));
        assert!(serialized.contains("initialValue"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reads_all_older_versions_without_folders_and_saves_as_v5() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let store = FlowStore::new(root.clone());
        let snapshot = sample_snapshot();
        for version in 1..=4 {
            let legacy = serde_json::json!({
                "version": version,
                "flows": snapshot.flows.iter().map(persisted_from_flow).collect::<Vec<_>>(),
            });
            fs::write(root.join(MANIFEST_FILE_NAME), legacy.to_string()).unwrap();
            let loaded = store.load().unwrap();
            assert_eq!(loaded, snapshot);
            store.save(&loaded).unwrap();
            let saved: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap())
                    .unwrap();
            assert_eq!(saved["version"], 5);
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_invalid_folders_without_overwriting_the_previous_snapshot() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());
        let snapshot = sample_snapshot();
        store.save(&snapshot).unwrap();
        let folder = FlowFolder {
            id: "folder".into(),
            name: "Checkout".into(),
            flow_ids: vec![snapshot.flows[0].id.clone()],
        };
        let cases = vec![
            vec![FlowFolder {
                name: " ".into(),
                ..folder.clone()
            }],
            vec![FlowFolder {
                id: "".into(),
                ..folder.clone()
            }],
            vec![FlowFolder {
                flow_ids: vec!["missing".into()],
                ..folder.clone()
            }],
            vec![FlowFolder {
                flow_ids: vec![snapshot.flows[0].id.clone(); 2],
                ..folder.clone()
            }],
            vec![folder.clone(), folder.clone()],
            vec![
                folder.clone(),
                FlowFolder {
                    id: "other".into(),
                    ..folder
                },
            ],
        ];
        for folders in cases {
            let invalid = FlowsSnapshot {
                flows: snapshot.flows.clone(),
                folders,
            };
            assert!(store.save(&invalid).is_err());
            assert_eq!(store.load().unwrap(), snapshot);
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_corrupted_folder_memberships_on_load() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), r#"{"version":4,"flows":[],"folders":[{"id":"folder","name":"Checkout","flow_ids":["missing"]}]}"#).unwrap();
        let error = FlowStore::new(root.clone()).load().unwrap_err();
        assert!(matches!(error, StorageError::Corrupted(_)));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn save_does_not_leave_a_temporary_file_behind() {
        let root = temp_root();
        let store = FlowStore::new(root.clone());

        store.save(&sample_snapshot()).unwrap();

        assert!(!root.join(MANIFEST_FILE_NAME).with_extension("tmp").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), "not json").unwrap();
        let store = FlowStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 99, "flows": []}"#,
        )
        .unwrap();
        let store = FlowStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_data_that_violates_domain_invariants() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "flows": [{"id": "flow-1", "name": "", "nodes": [], "edges": [], "created_at_ms": 0, "updated_at_ms": 0}]}"#,
        )
        .unwrap();
        let store = FlowStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }
}
