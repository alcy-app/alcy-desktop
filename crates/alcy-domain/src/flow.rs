use std::collections::{HashMap, HashSet};
use std::time::SystemTime;

use thiserror::Error;

use crate::{MockServer, SavedRequest};

/// Standard retains existing flow behavior; Load enables load-testing controllers and nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowExecutionKind {
    Standard,
    Load,
}

/// Closed load block kinds. The load capability validates canonical JSON; the domain preserves graph structure without HTTP, metric or import details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadNodeKind {
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

impl LoadNodeKind {
    pub fn requires_body(self) -> bool {
        matches!(
            self,
            Self::Scenario
                | Self::Repeat
                | Self::ForEach
                | Self::OncePerVu
                | Self::TimeBox
                | Self::Select
                | Self::Group
        )
    }

    pub fn allows_handle(self, handle: Option<&str>) -> bool {
        match self {
            Self::Scenario => matches!(handle, Some("iteration") | Some("done")),
            Self::Threshold => matches!(handle, Some("passed") | Some("failed")),
            Self::Request => matches!(handle, Some("success") | Some("failure")),
            kind if kind.requires_body() => matches!(handle, Some("body") | Some("done")),
            _ => handle.is_none(),
        }
    }
}

/// Canonical load configuration from importer or inspector. Saving/importing never executes it; semantic validation belongs to the load engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadNode {
    pub kind: LoadNodeKind,
    pub label: String,
    pub config: String,
}

/// Free canvas coordinates whose units belong to presentation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlowPosition {
    pub x: f64,
    pub y: f64,
}

/// Small comparison operator set for resolvable node references and environment variables (spec 0047).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparisonOperator {
    Equals,
    NotEquals,
    GreaterThan,
    LessThan,
}

/// If operands are templates. The application compares numerically when possible and textually otherwise; the domain only holds configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct Condition {
    pub left: String,
    pub operator: ComparisonOperator,
    pub right: String,
}

/// SetVariables assignment operation (spec 0083).
#[derive(Debug, Clone, PartialEq)]
pub enum VariableOperation {
    /// Set the variable to a template resolved at execution time.
    Set { value: String },
    /// Add to the current value, treating an absent variable as zero; supports counters without an expression language.
    /// `by` is a number or a `{{...}}` template resolved when the node runs.
    Increment { by: String },
}

/// Run-local assignment. Execution validates the name so incomplete configurations remain editable.
#[derive(Debug, Clone, PartialEq)]
pub struct VariableAssignment {
    pub name: String,
    pub operation: VariableOperation,
}

/// Saved mock resolved at execution time, or a complete inline server, started by MockStart (spec 0120).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockServerSource {
    Saved { server_id: String },
    Inline { server: Box<MockServer> },
}

/// Comparison between observed and expected route call counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockCallCountOperator {
    Equals,
    AtLeast,
    AtMost,
}

/// Closed node-kind enum: executable kinds require deliberate versioned contract changes.
#[derive(Debug, Clone, PartialEq)]
pub enum FlowNodeKind {
    /// Unique initial node, which the UI cannot delete.
    Start,
    /// Start with an operator form, validated before running any effects.
    StartForm { form: crate::FlowForm },
    /// Pause this dependency branch until the operator submits the form.
    HumanAction { form: crate::FlowForm },
    /// Legacy generic block without executable behavior.
    Block { label: String },
    /// Saved request resolved by request_id at execution time. Outputs are success for status below 400, failure for transport errors or status at least 400 (spec 0043).
    Request { request_id: String },
    /// Evaluate the condition and follow only its true/false output, skipping the other branch (spec 0047).
    If { condition: Condition },
    /// Unconnected, non-executable annotation with explicit dimensions. Flow::new rejects attached edges (spec 0083).
    Note {
        text: String,
        width: f64,
        height: f64,
    },
    /// Write the resolved message template to the run log.
    Log { message: String },
    /// Resolve the template and display its value in this node.
    Display { template: String },
    /// Wait asynchronously without blocking independent branches.
    /// Numeric block settings (`duration_ms` here, `max_iterations`, `timeout_ms`, `count`) hold a number or a
    /// `{{...}}` template; execution resolves and validates them when the node runs, so they stay editable while incomplete.
    Sleep { duration_ms: String },
    /// Run-local variables available as {{name}} and discarded at run completion.
    SetVariables {
        assignments: Vec<VariableAssignment>,
    },
    /// Repeat the loop body while its condition holds, up to max_iterations, then take done (spec 0084, ADR 0033).
    While {
        condition: Condition,
        max_iterations: String,
    },
    /// Exit the innermost While, skip unstarted body nodes and take done. Has no outputs (spec 0085).
    Break,
    /// End this innermost While iteration, skip unstarted body nodes and reevaluate its condition. Has no outputs.
    Continue,
    /// Complete request stored in the flow, sharing the request editor and success/failure outputs. Its ID does not reference a collection (spec 0086).
    InlineRequest { request: Box<SavedRequest> },
    /// Load-engine block, accepted only in load flows.
    Load { node: LoadNode },
    /// Start a mock for this run. Dependent nodes reference start_node_id for saved and inline sources. Execution stops servers it started (spec 0120).
    MockStart { source: MockServerSource },
    /// Stop the mock started by start_node_id.
    MockStop { start_node_id: String },
    /// Wait for a route call: true when received, false when timeout_ms expires.
    MockWaitRequest {
        start_node_id: String,
        route_id: String,
        timeout_ms: String,
    },
    /// Force the route response until run completion; None restores normal rules.
    MockSetResponse {
        start_node_id: String,
        route_id: String,
        response_id: Option<String>,
    },
    /// Compare calls received since this run started the mock against count, taking true or false.
    MockAssertCalls {
        start_node_id: String,
        route_id: String,
        operator: MockCallCountOperator,
        count: String,
    },
}

impl FlowNodeKind {
    pub fn is_mock(&self) -> bool {
        matches!(
            self,
            Self::MockStart { .. }
                | Self::MockStop { .. }
                | Self::MockWaitRequest { .. }
                | Self::MockSetResponse { .. }
                | Self::MockAssertCalls { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlowNode {
    pub id: String,
    pub kind: FlowNodeKind,
    pub position: FlowPosition,
}

/// Optional source output: true/false for If/mock checks, success/failure for requests, loop/done for While. Other nodes have one unnamed output. Flow::new validates compatibility.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowEdge {
    pub id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub source_handle: Option<String>,
}

/// Named graph with freely positioned nodes. Execution results belong to the application and separate history records.
#[derive(Debug, Clone, PartialEq)]
pub struct Flow {
    pub id: String,
    name: String,
    execution_kind: FlowExecutionKind,
    nodes: Vec<FlowNode>,
    edges: Vec<FlowEdge>,
    pub presentation: crate::FlowPresentation,
    pub created_at: SystemTime,
    pub updated_at: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FlowError {
    #[error("invalid panel layout")]
    InvalidPresentation,
    #[error("interactive node '{0}' is not supported in a load flow")]
    InteractiveNodeInLoadFlow(String),
    #[error("nome do flow não pode ser vazio")]
    EmptyName,
    #[error("node '{0}' duplicado")]
    DuplicateNodeId(String),
    #[error("edge referencia node inexistente '{0}'")]
    EdgeReferencesUnknownNode(String),
    #[error(
        "edge '{0}' tem um handle de origem incompatível com o node de onde sai (nodes `If`, `MockWaitRequest` e `MockAssertCalls` exigem \"true\" ou \"false\"; nodes `Request` exigem \"success\" ou \"failure\"; nodes `While` exigem \"loop\" ou \"done\"; qualquer outro tipo de node exige nenhum handle)"
    )]
    InvalidEdgeHandle(String),
    #[error("edge '{0}' se conecta a uma anotação, que não tem entradas nem saídas")]
    NoteCannotConnect(String),
    #[error("edge '{0}' sai de um Break/Continue, que não tem saídas")]
    LoopControlHasNoOutput(String),
    #[error("node de carga '{0}' só é permitido em um flow de carga")]
    LoadNodeInStandardFlow(String),
    #[error("node de mock server '{0}' não é permitido em um flow de carga")]
    MockNodeInLoadFlow(String),
}

impl Flow {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        nodes: Vec<FlowNode>,
        edges: Vec<FlowEdge>,
        created_at: SystemTime,
        updated_at: SystemTime,
    ) -> Result<Self, FlowError> {
        Self::new_with_execution_kind(
            id,
            name,
            FlowExecutionKind::Standard,
            nodes,
            edges,
            created_at,
            updated_at,
        )
    }

    pub fn new_with_execution_kind(
        id: impl Into<String>,
        name: impl Into<String>,
        execution_kind: FlowExecutionKind,
        nodes: Vec<FlowNode>,
        edges: Vec<FlowEdge>,
        created_at: SystemTime,
        updated_at: SystemTime,
    ) -> Result<Self, FlowError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(FlowError::EmptyName);
        }

        let mut seen_node_ids = HashSet::new();
        for node in &nodes {
            if !seen_node_ids.insert(node.id.as_str()) {
                return Err(FlowError::DuplicateNodeId(node.id.clone()));
            }
        }

        if execution_kind == FlowExecutionKind::Standard
            && let Some(node) = nodes
                .iter()
                .find(|node| matches!(node.kind, FlowNodeKind::Load { .. }))
        {
            return Err(FlowError::LoadNodeInStandardFlow(node.id.clone()));
        }
        if execution_kind == FlowExecutionKind::Load
            && let Some(node) = nodes.iter().find(|node| node.kind.is_mock())
        {
            return Err(FlowError::MockNodeInLoadFlow(node.id.clone()));
        }
        if execution_kind == FlowExecutionKind::Load
            && let Some(node) = nodes.iter().find(|node| {
                matches!(
                    node.kind,
                    FlowNodeKind::StartForm { .. } | FlowNodeKind::HumanAction { .. }
                )
            })
        {
            return Err(FlowError::InteractiveNodeInLoadFlow(node.id.clone()));
        }

        let kind_by_id: HashMap<&str, &FlowNodeKind> = nodes
            .iter()
            .map(|node| (node.id.as_str(), &node.kind))
            .collect();

        for edge in &edges {
            if !seen_node_ids.contains(edge.source_node_id.as_str()) {
                return Err(FlowError::EdgeReferencesUnknownNode(
                    edge.source_node_id.clone(),
                ));
            }
            if !seen_node_ids.contains(edge.target_node_id.as_str()) {
                return Err(FlowError::EdgeReferencesUnknownNode(
                    edge.target_node_id.clone(),
                ));
            }

            let is_note =
                |node_id: &str| matches!(kind_by_id.get(node_id), Some(FlowNodeKind::Note { .. }));
            if is_note(&edge.source_node_id) || is_note(&edge.target_node_id) {
                return Err(FlowError::NoteCannotConnect(edge.id.clone()));
            }
            if matches!(
                kind_by_id.get(edge.source_node_id.as_str()),
                Some(FlowNodeKind::Break | FlowNodeKind::Continue)
            ) {
                return Err(FlowError::LoopControlHasNoOutput(edge.id.clone()));
            }

            let source_kind = kind_by_id.get(edge.source_node_id.as_str());
            let handle_is_valid = match source_kind {
                Some(
                    FlowNodeKind::If { .. }
                    | FlowNodeKind::MockWaitRequest { .. }
                    | FlowNodeKind::MockAssertCalls { .. },
                ) => {
                    matches!(edge.source_handle.as_deref(), Some("true") | Some("false"))
                }
                Some(FlowNodeKind::Request { .. } | FlowNodeKind::InlineRequest { .. }) => {
                    matches!(
                        edge.source_handle.as_deref(),
                        Some("success") | Some("failure")
                    )
                }
                Some(FlowNodeKind::While { .. }) => {
                    matches!(edge.source_handle.as_deref(), Some("loop") | Some("done"))
                }
                Some(FlowNodeKind::Load { node }) => {
                    node.kind.allows_handle(edge.source_handle.as_deref())
                }
                _ => edge.source_handle.is_none(),
            };
            if !handle_is_valid {
                return Err(FlowError::InvalidEdgeHandle(edge.id.clone()));
            }
        }

        Ok(Self {
            id: id.into(),
            name,
            execution_kind,
            nodes,
            edges,
            presentation: crate::FlowPresentation::default(),
            created_at,
            updated_at,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn execution_kind(&self) -> FlowExecutionKind {
        self.execution_kind
    }

    pub fn nodes(&self) -> &[FlowNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[FlowEdge] {
        &self.edges
    }

    pub fn set_presentation(
        &mut self,
        mut presentation: crate::FlowPresentation,
    ) -> Result<(), FlowError> {
        let mut ids = HashSet::new();
        for panel in &presentation.panels {
            if !ids.insert(&panel.node_id)
                || panel.title.len() > 1024
                || [panel.x, panel.y, panel.width, panel.height]
                    .into_iter()
                    .any(|n| !n.is_finite())
                || !(0.0..=100_000.0).contains(&panel.x)
                || !(0.0..=100_000.0).contains(&panel.y)
                || !(280.0..=4096.0).contains(&panel.width)
                || !(180.0..=4096.0).contains(&panel.height)
            {
                return Err(FlowError::InvalidPresentation);
            }
        }
        // Removing a node or disabling its form also removes its panel.
        presentation.panels.retain(|panel| {
            self.nodes.iter().any(|node| {
                node.id == panel.node_id
                    && matches!(
                        node.kind,
                        FlowNodeKind::Display { .. }
                            | FlowNodeKind::StartForm { .. }
                            | FlowNodeKind::HumanAction { .. }
                    )
            })
        });
        self.presentation = presentation;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_node() -> FlowNode {
        FlowNode {
            id: "start".to_string(),
            kind: FlowNodeKind::Start,
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    fn block_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::Block {
                label: "Block".to_string(),
            },
            position: FlowPosition { x: 100.0, y: 0.0 },
        }
    }

    #[test]
    fn accepts_a_valid_flow() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), block_node("block-1")],
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

        assert_eq!(flow.name(), "My flow");
        assert_eq!(flow.nodes().len(), 2);
        assert_eq!(flow.edges().len(), 1);
    }

    #[test]
    fn rejects_an_empty_name() {
        let now = SystemTime::now();
        assert_eq!(
            Flow::new("flow-1", "", vec![start_node()], vec![], now, now),
            Err(FlowError::EmptyName)
        );
        assert_eq!(
            Flow::new("flow-1", "   ", vec![start_node()], vec![], now, now),
            Err(FlowError::EmptyName)
        );
    }

    #[test]
    fn rejects_duplicate_node_ids() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), start_node()],
            vec![],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::DuplicateNodeId("start".to_string()));
    }

    #[test]
    fn rejects_an_edge_referencing_an_unknown_node() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node()],
            vec![FlowEdge {
                id: "edge-1".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "missing".to_string(),
                source_handle: None,
            }],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(
            error,
            FlowError::EdgeReferencesUnknownNode("missing".to_string())
        );
    }

    fn if_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::If {
                condition: Condition {
                    left: "{{nodes.a.response.status}}".to_string(),
                    operator: ComparisonOperator::Equals,
                    right: "200".to_string(),
                },
            },
            position: FlowPosition { x: 200.0, y: 0.0 },
        }
    }

    #[test]
    fn accepts_true_and_false_edges_leaving_an_if_node() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                if_node("if-1"),
                block_node("a"),
                block_node("b"),
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
                    target_node_id: "a".to_string(),
                    source_handle: Some("true".to_string()),
                },
                FlowEdge {
                    id: "edge-3".to_string(),
                    source_node_id: "if-1".to_string(),
                    target_node_id: "b".to_string(),
                    source_handle: Some("false".to_string()),
                },
            ],
            now,
            now,
        )
        .unwrap();

        assert_eq!(flow.edges().len(), 3);
    }

    #[test]
    fn rejects_an_edge_leaving_an_if_node_without_a_true_or_false_handle() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), if_node("if-1"), block_node("a")],
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
                    target_node_id: "a".to_string(),
                    source_handle: None,
                },
            ],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-2".to_string()));
    }

    fn request_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::Request {
                request_id: "request-1".to_string(),
            },
            position: FlowPosition { x: 200.0, y: 0.0 },
        }
    }

    fn edge_with_handle(id: &str, source: &str, target: &str, handle: Option<&str>) -> FlowEdge {
        FlowEdge {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: handle.map(str::to_string),
        }
    }

    #[test]
    fn accepts_success_and_failure_edges_leaving_a_request_node() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                request_node("req-1"),
                block_node("a"),
                block_node("b"),
            ],
            vec![
                edge_with_handle("edge-1", "start", "req-1", None),
                edge_with_handle("edge-2", "req-1", "a", Some("success")),
                edge_with_handle("edge-3", "req-1", "b", Some("failure")),
            ],
            now,
            now,
        )
        .unwrap();

        assert_eq!(flow.edges().len(), 3);
    }

    #[test]
    fn rejects_an_edge_leaving_a_request_node_without_a_success_or_failure_handle() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), request_node("req-1"), block_node("a")],
            vec![edge_with_handle("edge-1", "req-1", "a", None)],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_an_if_handle_on_an_edge_leaving_a_request_node() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), request_node("req-1"), block_node("a")],
            vec![edge_with_handle("edge-1", "req-1", "a", Some("true"))],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_a_handle_on_an_edge_leaving_a_non_if_node() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), block_node("a")],
            vec![FlowEdge {
                id: "edge-1".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "a".to_string(),
                source_handle: Some("true".to_string()),
            }],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_an_edge_touching_a_note() {
        let now = SystemTime::now();
        let note = FlowNode {
            id: "note-1".to_string(),
            kind: FlowNodeKind::Note {
                text: "lembrete".to_string(),
                width: 200.0,
                height: 120.0,
            },
            position: FlowPosition { x: 0.0, y: 200.0 },
        };

        let into_note = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), note.clone()],
            vec![edge_with_handle("edge-1", "start", "note-1", None)],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(
            into_note,
            FlowError::NoteCannotConnect("edge-1".to_string())
        );

        let out_of_note = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), note, block_node("a")],
            vec![edge_with_handle("edge-2", "note-1", "a", None)],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(
            out_of_note,
            FlowError::NoteCannotConnect("edge-2".to_string())
        );
    }

    #[test]
    fn accepts_loop_and_done_edges_leaving_a_while_node_and_rejects_others() {
        let now = SystemTime::now();
        let while_node = FlowNode {
            id: "while-1".to_string(),
            kind: FlowNodeKind::While {
                condition: Condition {
                    left: "{{i}}".to_string(),
                    operator: ComparisonOperator::LessThan,
                    right: "3".to_string(),
                },
                max_iterations: "100".to_string(),
            },
            position: FlowPosition { x: 0.0, y: 0.0 },
        };

        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                while_node.clone(),
                block_node("a"),
                block_node("b"),
            ],
            vec![
                edge_with_handle("edge-1", "start", "while-1", None),
                edge_with_handle("edge-2", "while-1", "a", Some("loop")),
                edge_with_handle("edge-3", "while-1", "b", Some("done")),
            ],
            now,
            now,
        )
        .unwrap();
        assert_eq!(flow.edges().len(), 3);

        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), while_node, block_node("a")],
            vec![edge_with_handle("edge-1", "while-1", "a", Some("true"))],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_an_edge_leaving_a_break_or_continue_node() {
        let now = SystemTime::now();
        for kind in [FlowNodeKind::Break, FlowNodeKind::Continue] {
            let control = FlowNode {
                id: "control".to_string(),
                kind,
                position: FlowPosition { x: 0.0, y: 0.0 },
            };
            let error = Flow::new(
                "flow-1",
                "My flow",
                vec![start_node(), control, block_node("a")],
                vec![
                    edge_with_handle("edge-1", "start", "control", None),
                    edge_with_handle("edge-2", "control", "a", None),
                ],
                now,
                now,
            )
            .unwrap_err();
            assert_eq!(
                error,
                FlowError::LoopControlHasNoOutput("edge-2".to_string())
            );
        }
    }

    fn mock_wait_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::MockWaitRequest {
                start_node_id: "mock-1".to_string(),
                route_id: "route-1".to_string(),
                timeout_ms: "1000".to_string(),
            },
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn accepts_true_and_false_edges_leaving_mock_branch_nodes_and_rejects_others() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                mock_wait_node("wait-1"),
                block_node("a"),
                block_node("b"),
            ],
            vec![
                edge_with_handle("edge-1", "start", "wait-1", None),
                edge_with_handle("edge-2", "wait-1", "a", Some("true")),
                edge_with_handle("edge-3", "wait-1", "b", Some("false")),
            ],
            now,
            now,
        )
        .unwrap();
        assert_eq!(flow.edges().len(), 3);

        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), mock_wait_node("wait-1"), block_node("a")],
            vec![edge_with_handle("edge-1", "wait-1", "a", None)],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_mock_nodes_in_a_load_flow() {
        let now = SystemTime::now();
        let error = Flow::new_with_execution_kind(
            "flow-1",
            "My flow",
            FlowExecutionKind::Load,
            vec![start_node(), mock_wait_node("wait-1")],
            vec![],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(error, FlowError::MockNodeInLoadFlow("wait-1".to_string()));
    }
}
