//! Static checks of a standard flow (spec 0139): the problems a run would
//! hit, found without sending anything, each with a fix that an agent or a
//! person can apply. Execution keeps its own validation; this only reads.

use std::collections::{HashMap, HashSet};

use alcy_domain::{
    Authentication, BodyPayload, Flow, FlowExecutionKind, FlowNode, FlowNodeKind,
    FormDataFieldValue, ProtocolId, Request, VariableOperation,
};

use crate::execute_flow::FlowRunError;
use crate::flow_graph::{LOOP_HANDLE, build_flow_graph};
use crate::resolve_variables::placeholder_names;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowIssueSeverity {
    /// The run fails or cannot start.
    Error,
    /// The run starts, but probably not as intended.
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowIssue {
    pub severity: FlowIssueSeverity,
    pub node_id: Option<String>,
    pub message: String,
    pub fix: String,
}

impl FlowIssue {
    fn error(node_id: Option<&str>, message: String, fix: impl Into<String>) -> Self {
        Self {
            severity: FlowIssueSeverity::Error,
            node_id: node_id.map(str::to_string),
            message,
            fix: fix.into(),
        }
    }

    fn warning(node_id: Option<&str>, message: String, fix: impl Into<String>) -> Self {
        Self {
            severity: FlowIssueSeverity::Warning,
            ..Self::error(node_id, message, fix)
        }
    }
}

const REFERENCE_FORMS: &str = "{{nodes.<id>.response.status}}, {{nodes.<id>.response.body.<path>}}, {{nodes.<id>.response.headers.<name>}}, {{nodes.<id>.form.<fieldId>}}, {{nodes.<id>.request.body.<path>}} or {{nodes.<id>.server.url}}";

/// Check a standard flow. `known_variables` are the names the run can read
/// besides its own Set variables (environment, collection); `None` skips the
/// unknown-variable warnings. Load flows are checked by their preview instead.
pub fn check_flow(flow: &Flow, known_variables: Option<&HashSet<String>>) -> Vec<FlowIssue> {
    if flow.execution_kind() == FlowExecutionKind::Load {
        return Vec::new();
    }
    let graph = match build_flow_graph(flow) {
        Ok(graph) => graph,
        Err(error) => return vec![graph_issue(error)],
    };
    let by_id: HashMap<&str, &FlowNode> = flow
        .nodes()
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let run_variables: HashSet<&str> = flow
        .nodes()
        .iter()
        .filter_map(|node| match &node.kind {
            FlowNodeKind::SetVariables { assignments } => Some(assignments),
            _ => None,
        })
        .flatten()
        .map(|assignment| assignment.name.trim())
        .collect();
    let unreachable: HashSet<&str> = graph.unreachable.iter().map(String::as_str).collect();
    let no_ancestors = HashSet::new();
    let mut issues = Vec::new();

    for node in flow.nodes() {
        let id = node.id.as_str();
        if unreachable.contains(id) {
            issues.push(FlowIssue::warning(
                Some(id),
                format!("Node '{id}' is not connected to Start, so it never runs."),
                format!("Connect a node that runs earlier to '{id}', or remove it."),
            ));
            continue;
        }
        let outputs: Vec<Option<&str>> = flow
            .edges()
            .iter()
            .filter(|edge| edge.source_node_id == id)
            .map(|edge| edge.source_handle.as_deref())
            .collect();
        issues.extend(output_issue(node, &outputs));
        if let FlowNodeKind::InlineRequest { request } = &node.kind
            && request.request.endpoint.url().trim().is_empty()
        {
            issues.push(FlowIssue::error(
                Some(id),
                format!("Request node '{id}' has no URL."),
                "Set request.url on this node.",
            ));
        }
        let ancestors = graph.ancestors.get(id).unwrap_or(&no_ancestors);
        if let Some(start_node_id) = mock_start(&node.kind) {
            issues.extend(mock_issue(id, start_node_id, &by_id, ancestors));
        }
        for template in templates(&node.kind) {
            for name in placeholder_names(template) {
                if let Some(reference) = name.strip_prefix("nodes.") {
                    issues.extend(reference_issue(id, name, reference, &by_id, ancestors));
                } else if let Some(known) = known_variables
                    && !name.is_empty()
                    && !known.contains(name)
                    && !run_variables.contains(name)
                {
                    issues.push(FlowIssue::warning(
                        Some(id),
                        format!("'{{{{{name}}}}}' in node '{id}' is not a variable of the active environment, the collection or a Set variables node."),
                        format!("Create '{name}' in the environment, add a Set variables node before '{id}', or fix the name."),
                    ));
                }
            }
        }
    }
    issues
}

fn graph_issue(error: FlowRunError) -> FlowIssue {
    match error {
        FlowRunError::MissingStartNode => FlowIssue::error(
            None,
            "The flow has no Start node.".into(),
            "Create the flow again; every flow starts at the node 'start'.",
        ),
        FlowRunError::CyclicGraph => FlowIssue::error(
            None,
            "The flow has a cycle: a connection goes back to a node that already ran.".into(),
            "Remove the connection that goes back. To repeat steps, put them after the 'loop' output of a While node.",
        ),
        FlowRunError::InvalidLoopBody { while_node_id } => FlowIssue::error(
            Some(&while_node_id),
            format!("The steps of While '{while_node_id}' connect to nodes outside the loop."),
            "Keep every node after the 'loop' output connected only to other loop steps; continue after the loop from the 'done' output.",
        ),
        FlowRunError::InvalidForm(message) => FlowIssue::error(
            None,
            format!("Invalid form: {message}"),
            "Fix the form fields.",
        ),
    }
}

fn output_issue(node: &FlowNode, outputs: &[Option<&str>]) -> Option<FlowIssue> {
    let id = node.id.as_str();
    match node.kind {
        FlowNodeKind::If { .. }
        | FlowNodeKind::MockWaitRequest { .. }
        | FlowNodeKind::MockAssertCalls { .. }
            if outputs.is_empty() =>
        {
            Some(FlowIssue::warning(
                Some(id),
                format!(
                    "Node '{id}' decides between 'true' and 'false' but neither output is connected."
                ),
                format!("Connect the next steps from '{id}' with output 'true' and/or 'false'."),
            ))
        }
        FlowNodeKind::While { .. } if !outputs.contains(&Some(LOOP_HANDLE)) => {
            Some(FlowIssue::warning(
                Some(id),
                format!("While '{id}' has no steps on its 'loop' output, so it repeats nothing."),
                format!("Connect the steps to repeat from '{id}' with output 'loop'."),
            ))
        }
        _ => None,
    }
}

fn mock_start(kind: &FlowNodeKind) -> Option<&str> {
    match kind {
        FlowNodeKind::MockStop { start_node_id }
        | FlowNodeKind::MockWaitRequest { start_node_id, .. }
        | FlowNodeKind::MockSetResponse { start_node_id, .. }
        | FlowNodeKind::MockAssertCalls { start_node_id, .. } => Some(start_node_id),
        _ => None,
    }
}

fn mock_issue(
    id: &str,
    start_node_id: &str,
    by_id: &HashMap<&str, &FlowNode>,
    ancestors: &HashSet<String>,
) -> Option<FlowIssue> {
    let is_mock_start = by_id
        .get(start_node_id)
        .is_some_and(|node| matches!(node.kind, FlowNodeKind::MockStart { .. }));
    if !is_mock_start {
        return Some(FlowIssue::error(
            Some(id),
            format!(
                "Mock node '{id}' uses startNodeId '{start_node_id}', which is not a mockStart node."
            ),
            "Set startNodeId to the id of the mockStart node that starts this mock.",
        ));
    }
    (!ancestors.contains(start_node_id)).then(|| {
        FlowIssue::error(
            Some(id),
            format!(
                "Mock node '{id}' runs without '{start_node_id}' having started the mock before it."
            ),
            format!("Connect '{start_node_id}' (directly or through other steps) to '{id}'."),
        )
    })
}

/// `reference` is the name after `nodes.`.
fn reference_issue(
    id: &str,
    name: &str,
    reference: &str,
    by_id: &HashMap<&str, &FlowNode>,
    ancestors: &HashSet<String>,
) -> Option<FlowIssue> {
    let malformed = || {
        FlowIssue::error(
            Some(id),
            format!("'{{{{{name}}}}}' in node '{id}' is not a valid reference."),
            format!("Use one of {REFERENCE_FORMS}."),
        )
    };
    let Some((target, path)) = reference.split_once('.') else {
        return Some(malformed());
    };
    let Some(node) = by_id.get(target) else {
        return Some(FlowIssue::error(
            Some(id),
            format!(
                "'{{{{{name}}}}}' in node '{id}' refers to node '{target}', which does not exist."
            ),
            "Use the id of an existing node (see get_flow).",
        ));
    };
    let (output, valid) = match &node.kind {
        FlowNodeKind::Request { .. } | FlowNodeKind::InlineRequest { .. } => (
            "response",
            path.strip_prefix("response.")
                .map(|rest| rest.split('.').next().unwrap_or_default())
                .is_some_and(|field| {
                    matches!(
                        field,
                        "status" | "body" | "headers" | "grpcStatus" | "messages"
                    )
                }),
        ),
        FlowNodeKind::StartForm { .. } | FlowNodeKind::HumanAction { .. } => {
            ("form", path.starts_with("form."))
        }
        FlowNodeKind::MockWaitRequest { .. } => ("request", path.starts_with("request.")),
        FlowNodeKind::MockStart { .. } => ("server", path == "server.url"),
        _ => {
            return Some(FlowIssue::error(
                Some(id),
                format!(
                    "'{{{{{name}}}}}' in node '{id}' refers to node '{target}', which produces no values."
                ),
                "Only request, form, mockStart and mockWaitRequest nodes produce values to reference.",
            ));
        }
    };
    if !valid {
        return Some(FlowIssue::error(
            Some(id),
            format!("'{{{{{name}}}}}' in node '{id}' does not match what '{target}' produces."),
            format!(
                "Node '{target}' exposes {{{{nodes.{target}.{output}...}}}}; forms: {REFERENCE_FORMS}."
            ),
        ));
    }
    (!ancestors.contains(target)).then(|| {
        FlowIssue::error(
            Some(id),
            format!("Node '{id}' uses '{target}', but '{target}' does not run before it."),
            format!("Connect '{target}' (directly or through other steps) before '{id}'."),
        )
    })
}

/// Text a node resolves with `{{…}}` at run time.
fn templates(kind: &FlowNodeKind) -> Vec<&str> {
    match kind {
        FlowNodeKind::If { condition } | FlowNodeKind::While { condition, .. } => {
            vec![condition.left.as_str(), condition.right.as_str()]
        }
        FlowNodeKind::Log { message } => vec![message.as_str()],
        FlowNodeKind::Display { template } => vec![template.as_str()],
        FlowNodeKind::SetVariables { assignments } => assignments
            .iter()
            .filter_map(|assignment| match &assignment.operation {
                VariableOperation::Set { value } => Some(value.as_str()),
                VariableOperation::Increment { .. } => None,
            })
            .collect(),
        FlowNodeKind::InlineRequest { request } => request_templates(&request.request),
        FlowNodeKind::StartForm { form } | FlowNodeKind::HumanAction { form } => form
            .sections
            .iter()
            .flat_map(|section| &section.fields)
            .filter_map(|field| field.source.as_ref())
            .map(|source| source.reference.as_str())
            .collect(),
        _ => Vec::new(),
    }
}

/// The request fields execution resolves, as in `resolve_request_variables`.
fn request_templates(request: &Request) -> Vec<&str> {
    let mut texts: Vec<&str> = vec![request.endpoint.url(), request.variables.as_str()];
    if request.document.protocol != ProtocolId::GraphQl {
        texts.push(request.document.body.as_str());
    }
    texts.extend(
        request
            .route_parameters
            .iter()
            .map(|parameter| parameter.value.as_str()),
    );
    texts.extend(request.headers.iter().map(|header| header.value()));
    match &request.body_payload {
        BodyPayload::UrlEncoded(fields) => {
            texts.extend(fields.iter().map(|field| field.value.as_str()));
        }
        BodyPayload::FormData(fields) => {
            texts.extend(fields.iter().filter_map(|field| match &field.value {
                FormDataFieldValue::Text(value) => Some(value.as_str()),
                FormDataFieldValue::File { .. } => None,
            }));
        }
        _ => {}
    }
    match &request.authentication {
        Authentication::Bearer { token } => texts.push(token.as_str()),
        Authentication::Basic { username, password }
        | Authentication::Digest { username, password } => {
            texts.extend([username.as_str(), password.as_str()])
        }
        Authentication::CustomHeader { value, .. } => texts.push(value.as_str()),
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => texts.extend([
            client_id.as_str(),
            client_secret.as_str(),
            token_url.as_str(),
            scope.as_str(),
        ]),
        Authentication::None | Authentication::Inherit => {}
    }
    texts
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use alcy_domain::{
        ComparisonOperator, Condition, Endpoint, FlowEdge, FlowPosition, RequestDocument,
        SavedRequest, VariableAssignment,
    };

    use super::*;

    fn node(id: &str, kind: FlowNodeKind) -> FlowNode {
        FlowNode {
            id: id.into(),
            kind,
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    fn request(id: &str, url: &str) -> FlowNode {
        let request = Request::new(
            Endpoint::saved(url),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        );
        node(
            id,
            FlowNodeKind::InlineRequest {
                request: Box::new(SavedRequest::new(id, "Request", request).unwrap()),
            },
        )
    }

    fn log(id: &str, message: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::Log {
                message: message.into(),
            },
        )
    }

    fn edge(source: &str, target: &str, handle: Option<&str>) -> FlowEdge {
        FlowEdge {
            id: format!("{source}-{target}"),
            source_node_id: source.into(),
            target_node_id: target.into(),
            source_handle: handle.map(str::to_string),
        }
    }

    fn flow(nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) -> Flow {
        let now = SystemTime::now();
        Flow::new("flow", "Flow", nodes, edges, now, now).unwrap()
    }

    fn messages(issues: &[FlowIssue]) -> Vec<&str> {
        issues.iter().map(|issue| issue.message.as_str()).collect()
    }

    #[test]
    fn a_connected_chain_with_valid_references_has_no_issues() {
        let flow = flow(
            vec![
                node("start", FlowNodeKind::Start),
                request("login", "{{baseUrl}}/login"),
                request(
                    "profile",
                    "{{baseUrl}}/me?t={{nodes.login.response.body.token}}",
                ),
                log("done", "{{nodes.profile.response.status}} {{counter}}"),
                node(
                    "set",
                    FlowNodeKind::SetVariables {
                        assignments: vec![VariableAssignment {
                            name: "counter".into(),
                            operation: VariableOperation::Increment { by: 1.0 },
                        }],
                    },
                ),
            ],
            vec![
                edge("start", "set", None),
                edge("set", "login", None),
                edge("login", "profile", Some("success")),
                edge("profile", "done", Some("success")),
            ],
        );
        let known = HashSet::from(["baseUrl".to_string()]);

        assert_eq!(check_flow(&flow, Some(&known)), vec![]);
    }

    #[test]
    fn references_must_name_an_existing_node_that_runs_before() {
        let flow = flow(
            vec![
                node("start", FlowNodeKind::Start),
                request("a", "https://a.test"),
                request("b", "https://b.test/{{nodes.c.response.body.id}}"),
                request("c", "https://c.test/{{nodes.ghost.response.body}}"),
            ],
            vec![
                edge("start", "a", None),
                edge("a", "b", Some("success")),
                edge("b", "c", Some("success")),
            ],
        );

        let issues = check_flow(&flow, None);

        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].node_id.as_deref(), Some("b"));
        assert!(issues[0].message.contains("does not run before it"));
        assert!(issues[1].message.contains("'ghost', which does not exist"));
        assert!(
            issues
                .iter()
                .all(|issue| issue.severity == FlowIssueSeverity::Error)
        );
    }

    #[test]
    fn malformed_references_show_the_valid_forms() {
        let flow = flow(
            vec![
                node("start", FlowNodeKind::Start),
                request("a", "https://a.test"),
                log("l1", "{{nodes.a.status}}"),
                log("l2", "{{nodes.a}}"),
            ],
            vec![
                edge("start", "a", None),
                edge("a", "l1", Some("success")),
                edge("l1", "l2", None),
            ],
        );

        let issues = check_flow(&flow, None);

        assert!(
            issues[0]
                .message
                .contains("does not match what 'a' produces")
        );
        assert!(issues[0].fix.contains("{{nodes.a.response...}}"));
        assert!(issues[1].message.contains("is not a valid reference"));
    }

    #[test]
    fn graph_problems_are_reported_with_a_fix() {
        let cyclic = flow(
            vec![
                node("start", FlowNodeKind::Start),
                log("a", ""),
                log("b", ""),
            ],
            vec![
                edge("start", "a", None),
                edge("a", "b", None),
                edge("b", "a", None),
            ],
        );
        let issues = check_flow(&cyclic, None);
        assert_eq!(messages(&issues).len(), 1);
        assert!(issues[0].fix.contains("While"));

        let island = flow(
            vec![node("start", FlowNodeKind::Start), log("island", "")],
            vec![],
        );
        let issues = check_flow(&island, None);
        assert_eq!(issues[0].severity, FlowIssueSeverity::Warning);
        assert_eq!(issues[0].node_id.as_deref(), Some("island"));
    }

    #[test]
    fn missing_urls_unused_branches_and_unknown_variables_are_reported() {
        let condition = Condition {
            left: "{{missing}}".into(),
            operator: ComparisonOperator::Equals,
            right: "1".into(),
        };
        let flow = flow(
            vec![
                node("start", FlowNodeKind::Start),
                request("empty", " "),
                node("check", FlowNodeKind::If { condition }),
            ],
            vec![
                edge("start", "empty", None),
                edge("empty", "check", Some("failure")),
            ],
        );

        let issues = check_flow(&flow, Some(&HashSet::new()));

        assert_eq!(issues.len(), 3);
        assert!(issues[0].message.contains("has no URL"));
        assert!(issues[1].message.contains("neither output is connected"));
        assert!(issues[2].message.contains("'{{missing}}'"));
        assert!(check_flow(&flow, None).len() == 2);
    }
}
