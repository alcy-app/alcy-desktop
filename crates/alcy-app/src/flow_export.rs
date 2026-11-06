//! Portable flow export uses the validated editor JSON contract.
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use alcy_domain::EnvironmentVariable;
use serde_json::{Value, json};

use crate::resolve_variables::placeholder_names;

pub struct FlowExportRequest {
    pub request: Value,
    pub variables: Vec<EnvironmentVariable>,
}

#[derive(Default)]
pub struct FlowExportContext {
    pub requests: HashMap<String, FlowExportRequest>,
    pub variables: Vec<EnvironmentVariable>,
}

pub struct PreparedFlowExport {
    pub document: Value,
    pub request_count: usize,
    pub variable_names: Vec<String>,
    pub empty_variable_names: Vec<String>,
    pub blockers: Vec<String>,
}

/// Inspect expanded requests even for as-is exports. Node outputs are never
/// resolved, scripts never run, and sensitive values are never copied.
pub fn prepare_flow_export(
    original: Value,
    context: &FlowExportContext,
    inline: bool,
) -> Result<PreparedFlowExport, String> {
    let mut flow = original.clone();
    let source_nodes = original["nodes"].as_array().ok_or("Missing flow nodes")?;
    let mut request_count = 0;
    let mut blockers = BTreeSet::new();
    let mut variables = BTreeMap::<String, String>::new();
    let mut external = BTreeSet::new();
    let mut empty = BTreeSet::new();
    let mut reserved = BTreeSet::new();
    let mut all_aliases = BTreeMap::<String, Vec<String>>::new();
    let local_variables = local_variables_by_node(&original);
    // Load setup state is copied into scenario VUs even though lifecycle
    // phases are separate graph entries. Their declared variables stay local.
    let mut load_definitions = BTreeSet::new();
    if original["executionKind"] == "load" {
        for node in source_nodes {
            extend_definitions(node, &json!({"sourceHandle":"body"}), &mut load_definitions);
        }
    }
    collect_names(&original, &mut reserved);
    reserved.extend(context.variables.iter().map(|v| v.name().to_owned()));
    for request in context.requests.values() {
        collect_names(&request.request, &mut reserved);
        reserved.extend(request.variables.iter().map(|v| v.name().to_owned()));
    }
    for node in source_nodes {
        if let Some(assignments) = node["assignments"].as_array() {
            reserved.extend(
                assignments
                    .iter()
                    .filter_map(|a| a["name"].as_str().map(|name| name.trim().to_owned())),
            );
        }
    }
    let mut expanded = Vec::new();
    for node in source_nodes {
        let mut node = node.clone();
        let id = node["id"].as_str().ok_or("Missing node ID")?.to_owned();
        let mut locals = local_variables.get(&id).cloned().unwrap_or_default();
        locals.extend(load_definitions.iter().cloned());
        let mut available = &context.variables;
        let mut linked = false;
        if node["kind"] == "request" {
            request_count += 1;
            let request_id = node["requestId"].as_str().unwrap_or_default();
            if let Some(saved) = context.requests.get(request_id) {
                available = &saved.variables;
                linked = true;
                node.as_object_mut()
                    .ok_or("Invalid node")?
                    .remove("requestId");
                node["kind"] = json!("inlineRequest");
                node["request"] = saved.request.clone();
                node["request"]
                    .as_object_mut()
                    .ok_or("Invalid request")?
                    .remove("docsRef");
            } else {
                blockers.insert(format!("Missing request: {request_id}"));
            }
        }
        let mut content = node.clone();
        if node["kind"] == "load" {
            match serde_json::from_str(node["config"].as_str().unwrap_or_default()) {
                Ok(config) => content["config"] = config,
                Err(_) => {
                    blockers.insert(format!("Invalid configuration in node {id}"));
                }
            }
        }
        if node["kind"] == "note" {
            expanded.push(node);
            continue;
        }
        for field in ["id", "name", "label", "x", "y", "kind"] {
            if let Some(object) = content.as_object_mut() {
                object.remove(field);
            }
        }
        let mut names = BTreeSet::new();
        if let Some(assignments) = content["assignments"].as_array() {
            let mut assigned = locals.clone();
            for assignment in assignments {
                let mut used = BTreeSet::new();
                collect_names(assignment, &mut used);
                if assignment["operation"] == "increment"
                    && let Some(name) = assignment["name"].as_str().map(str::trim)
                    && context.variables.iter().any(|v| v.name() == name)
                {
                    used.insert(name.to_owned());
                }
                names.extend(used.difference(&assigned).cloned());
                if let Some(name) = assignment["name"].as_str().map(str::trim) {
                    assigned.insert(name.to_owned());
                }
            }
        } else {
            collect_names(&content, &mut names);
        }
        let mut aliases = BTreeMap::new();
        for name in names {
            if locals.contains(&name) {
                continue;
            }
            external.insert(name.clone());
            let variable = available.iter().find(|v| v.name() == name);
            let value = variable
                .filter(|v| !v.sensitive)
                .map(|v| v.value())
                .unwrap_or_default();
            if variable.is_none_or(|v| v.sensitive) {
                empty.insert(name.clone());
            }
            if value.contains("{{") {
                blockers.insert(
                    "Variable values containing templates require manual conversion".into(),
                );
            }
            let export_name =
                if linked && context.variables.iter().find(|v| v.name() == name) != variable {
                    let alias = unique_name(&format!("export_{id}_{name}"), &mut reserved);
                    all_aliases
                        .entry(name.clone())
                        .or_default()
                        .push(alias.clone());
                    aliases.insert(name.clone(), alias.clone());
                    alias
                } else {
                    name
                };
            variables.insert(export_name, value.to_owned());
        }
        if has_external_script(&content) {
            blockers.insert("Scripts accessing variable scopes require manual conversion".into());
        }
        if node["kind"] == "mockStart" && node["source"]["type"] == "saved" {
            blockers.insert("Saved mock servers require manual conversion".into());
        }
        if node["kind"] == "load" && content["config"].get("assetId").is_some() {
            blockers.insert("External datasets require manual conversion".into());
        }
        if !aliases.is_empty() {
            rewrite_templates(&mut node, &aliases);
        }
        expanded.push(node);
    }
    if inline {
        if !blockers.is_empty() {
            return Err(blockers.into_iter().collect::<Vec<_>>().join("; "));
        }
        // A runtime assignment overrides collection scopes too, including when
        // it happens on just one conditional branch before a linked request.
        for node in &mut expanded {
            if let Some(assignments) = node.get_mut("assignments").and_then(Value::as_array_mut) {
                let mut updated = Vec::new();
                for assignment in assignments.iter() {
                    updated.push(assignment.clone());
                    if let Some(name) = assignment["name"].as_str().map(str::trim)
                        && let Some(aliases) = all_aliases.get(name)
                    {
                        updated.extend(aliases.iter().map(|alias| json!({"name":alias,"operation":"set","value":format!("{{{{{name}}}}}")})));
                    }
                }
                *assignments = updated;
            }
        }
        flow["nodes"] = json!(expanded);
        if !variables.is_empty() {
            add_variables(&mut flow, variables)?;
        }
    }
    Ok(PreparedFlowExport {
        document: json!({ "format": "alcy-flow", "version": 1, "flow": if inline { flow } else { original } }),
        request_count,
        variable_names: external.into_iter().collect(),
        empty_variable_names: empty.into_iter().collect(),
        blockers: blockers.into_iter().collect(),
    })
}

fn collect_names(value: &Value, names: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => names.extend(
            placeholder_names(text)
                .into_iter()
                .filter(|name| !name.is_empty() && !name.starts_with("nodes."))
                .map(str::to_owned),
        ),
        Value::Array(values) => {
            for value in values {
                collect_names(value, names);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if matches!(
                    key.as_str(),
                    "id" | "label" | "preRequestScript" | "postResponseScript" | "code"
                ) || (key == "body" && values.get("protocol").is_some_and(|p| p == "graphql"))
                    || (key == "name"
                        && (values.contains_key("protocol") || values.contains_key("operation")))
                {
                    continue;
                }
                collect_names(value, names);
            }
        }
        _ => {}
    }
}

fn has_external_script(value: &Value) -> bool {
    match value {
        Value::Object(values) => values.iter().any(|(key, value)| {
            if matches!(
                key.as_str(),
                "preRequestScript" | "postResponseScript" | "code"
            ) {
                // Dynamic scope access cannot be converted reliably without a JS parser.
                value.as_str().is_some_and(|s| {
                    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
                    [
                        "al.environment",
                        "al.collection",
                        "al.folder",
                        "al.variables",
                        "al[",
                    ]
                    .iter()
                    .any(|scope| compact.contains(scope))
                })
            } else {
                has_external_script(value)
            }
        }),
        Value::Array(values) => values.iter().any(has_external_script),
        _ => false,
    }
}

fn rewrite_templates(value: &mut Value, aliases: &BTreeMap<String, String>) {
    match value {
        Value::String(text) => {
            let mut output = String::new();
            let mut rest = text.as_str();
            while let Some(start) = rest.find("{{") {
                let Some(end) = rest[start + 2..].find("}}") else {
                    break;
                };
                let end = start + 2 + end;
                output.push_str(&rest[..start]);
                if let Some(alias) = aliases.get(rest[start + 2..end].trim()) {
                    output.push_str(&format!("{{{{{alias}}}}}"));
                } else {
                    output.push_str(&rest[start..end + 2]);
                }
                rest = &rest[end + 2..];
            }
            output.push_str(rest);
            *text = output;
        }
        Value::Array(values) => {
            for value in values {
                rewrite_templates(value, aliases);
            }
        }
        Value::Object(values) => {
            let graphql = values.get("protocol").is_some_and(|p| p == "graphql");
            let metadata_name = values.contains_key("protocol") || values.contains_key("operation");
            for (key, value) in values.iter_mut() {
                if matches!(
                    key.as_str(),
                    "id" | "label" | "preRequestScript" | "postResponseScript" | "code"
                ) || (key == "body" && graphql)
                    || (key == "name" && metadata_name)
                {
                    continue;
                }
                rewrite_templates(value, aliases);
            }
        }
        _ => {}
    }
}

/// Only definitions on every incoming path are definitely local. Use a
/// topological queue so long graphs cannot exhaust the native call stack.
/// Cyclic subgraphs conservatively retain their external dependencies.
fn local_variables_by_node(flow: &Value) -> HashMap<String, BTreeSet<String>> {
    let Some(nodes) = flow["nodes"].as_array() else {
        return HashMap::new();
    };
    let by_id: HashMap<&str, &Value> = nodes
        .iter()
        .filter_map(|node| node["id"].as_str().map(|id| (id, node)))
        .collect();
    let mut remaining: HashMap<&str, usize> = by_id.keys().map(|id| (*id, 0)).collect();
    let mut outgoing = HashMap::<&str, Vec<&Value>>::new();
    if let Some(edges) = flow["edges"].as_array() {
        for edge in edges {
            if let (Some(source), Some(target)) =
                (edge["sourceNodeId"].as_str(), edge["targetNodeId"].as_str())
            {
                *remaining.entry(target).or_default() += 1;
                outgoing.entry(source).or_default().push(edge);
            }
        }
    }
    let mut queue: VecDeque<&str> = remaining
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut incoming = HashMap::<String, BTreeSet<String>>::new();
    let mut result = HashMap::new();
    while let Some(id) = queue.pop_front() {
        let vars = incoming.remove(id).unwrap_or_default();
        result.insert(id.to_owned(), vars.clone());
        if let Some(node) = by_id.get(id) {
            for edge in outgoing.get(id).into_iter().flatten() {
                let Some(target) = edge["targetNodeId"].as_str() else {
                    continue;
                };
                let mut defined = vars.clone();
                extend_definitions(node, edge, &mut defined);
                incoming
                    .entry(target.to_owned())
                    .and_modify(|current| {
                        current.retain(|name| defined.contains(name));
                    })
                    .or_insert(defined);
                if let Some(count) = remaining.get_mut(target) {
                    *count -= 1;
                    if *count == 0 {
                        queue.push_back(target);
                    }
                }
            }
        }
    }
    result
}

fn extend_definitions(node: &Value, edge: &Value, vars: &mut BTreeSet<String>) {
    if let Some(assignments) = node["assignments"].as_array() {
        vars.extend(
            assignments
                .iter()
                .filter_map(|a| a["name"].as_str().map(|name| name.trim().to_owned())),
        );
    }
    if node["kind"] == "load"
        && let Ok(config) =
            serde_json::from_str::<Value>(node["config"].as_str().unwrap_or_default())
    {
        if node["loadKind"] == "configureSession"
            && let Some(values) = config["variables"].as_object()
        {
            vars.extend(values.keys().cloned());
        }
        if node["loadKind"] == "extract"
            && let Some(name) = config["name"].as_str()
        {
            vars.insert(name.to_owned());
        }
        if node["loadKind"] == "forEach"
            && edge["sourceHandle"] == "body"
            && let Some(name) = config["variable"].as_str()
        {
            vars.insert(name.to_owned());
        }
    }
}

fn unique_name(base: &str, reserved: &mut BTreeSet<String>) -> String {
    let mut name = base.to_owned();
    let mut suffix = 2;
    while !reserved.insert(name.clone()) {
        name = format!("{base}_{suffix}");
        suffix += 1;
    }
    name
}

fn add_variables(flow: &mut Value, variables: BTreeMap<String, String>) -> Result<(), String> {
    let nodes = flow["nodes"].as_array().ok_or("Missing nodes")?;
    let mut reserved = nodes
        .iter()
        .filter_map(|n| n["id"].as_str().map(str::to_owned))
        .collect();
    let load = flow["executionKind"] == "load";
    let sources: Vec<String> = nodes
        .iter()
        .filter(|n| {
            if load {
                n["kind"] == "load" && n["loadKind"] == "scenario"
            } else {
                n["kind"] == "start"
            }
        })
        .filter_map(|n| n["id"].as_str().map(str::to_owned))
        .collect();
    if sources.is_empty() {
        return Err("Missing flow entry point".into());
    }
    for source in sources {
        let id = unique_name("export_variables", &mut reserved);
        let mut edge_ids: BTreeSet<String> = flow["edges"]
            .as_array()
            .ok_or("Missing edges")?
            .iter()
            .filter_map(|e| e["id"].as_str().map(str::to_owned))
            .collect();
        let edge_id = unique_name("export_variables_edge", &mut edge_ids);
        for edge in flow["edges"].as_array_mut().ok_or("Missing edges")? {
            if edge["sourceNodeId"] == source && (!load || edge["sourceHandle"] == "iteration") {
                edge["sourceNodeId"] = json!(id);
                edge.as_object_mut()
                    .ok_or("Invalid edge")?
                    .remove("sourceHandle");
            }
        }
        let new_node = if load {
            json!({"id":id,"kind":"load","loadKind":"configureSession","label":"Exported variables","config":json!({"variables":variables}).to_string(),"x":220,"y":-160})
        } else {
            let assignments: Vec<Value> = variables
                .iter()
                .map(|(name, value)| json!({"name":name,"operation":"set","value":value}))
                .collect();
            json!({"id":id,"kind":"setVariables","assignments":assignments,"x":220,"y":-160})
        };
        flow["nodes"]
            .as_array_mut()
            .ok_or("Missing nodes")?
            .push(new_node);
        let mut edge = json!({"id":edge_id,"sourceNodeId":source,"targetNodeId":id});
        if load {
            edge["sourceHandle"] = json!("iteration");
        }
        flow["edges"]
            .as_array_mut()
            .ok_or("Missing edges")?
            .push(edge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variable(name: &str, value: &str) -> EnvironmentVariable {
        EnvironmentVariable::new(name, value, false).unwrap()
    }

    fn flow(nodes: Value, edges: Value) -> Value {
        let mut all = vec![json!({"id":"start","kind":"start","x":0,"y":0})];
        all.extend(nodes.as_array().unwrap().clone());
        json!({"id":"flow","name":"Example","executionKind":"standard","nodes":all,"edges":edges})
    }

    fn edge(from: &str, to: &str) -> Value {
        json!({"id":format!("{from}-{to}"),"sourceNodeId":from,"targetNodeId":to})
    }

    fn linked_context() -> FlowExportContext {
        FlowExportContext {
            requests: HashMap::from([(
                "saved".into(),
                FlowExportRequest {
                    request: json!({"id":"saved","name":"Get","endpoint":"{{ host }}/items/{{nodes.previous.response.body.id}}","authentication":{"type":"none"}}),
                    variables: vec![variable("host", "https://folder.test")],
                },
            )]),
            variables: vec![variable("host", "https://environment.test")],
        }
    }

    #[test]
    fn as_is_preserves_the_graph_and_reports_linked_request_variables() {
        let original = flow(
            json!([{"id":"call","kind":"request","requestId":"saved"}]),
            json!([edge("start", "call")]),
        );
        let result = prepare_flow_export(original.clone(), &linked_context(), false).unwrap();
        assert_eq!(result.document["flow"], original);
        assert_eq!(result.request_count, 1);
        assert_eq!(result.variable_names, ["host"]);
        assert_eq!(result.document["format"], "alcy-flow");
        assert_eq!(result.document["version"], 1);
    }

    #[test]
    fn embeds_requests_and_preserves_scope_precedence_and_node_references() {
        let original = flow(
            json!([{"id":"call","kind":"request","requestId":"saved"}]),
            json!([edge("start", "call")]),
        );
        let result = prepare_flow_export(original, &linked_context(), true).unwrap();
        let exported = &result.document["flow"];
        assert_eq!(exported["nodes"][1]["kind"], "inlineRequest");
        assert_eq!(
            exported["nodes"][1]["request"]["endpoint"],
            "{{export_call_host}}/items/{{nodes.previous.response.body.id}}"
        );
        assert_eq!(
            exported["nodes"][2]["assignments"][0]["value"],
            "https://folder.test"
        );
        assert_eq!(exported["edges"][0]["sourceNodeId"], "export_variables");
        assert_eq!(exported["edges"][1]["sourceNodeId"], "start");
    }

    #[test]
    fn local_and_sequential_assignments_do_not_require_external_variables() {
        let original = flow(
            json!([
                {"id":"vars","kind":"setVariables","assignments":[{"name":" host ","operation":"set","value":"local"},{"name":"url","operation":"set","value":"{{host}}/items"}]},
                {"id":"log","kind":"log","message":"{{url}}"}
            ]),
            json!([edge("start", "vars"), edge("vars", "log")]),
        );
        let result =
            prepare_flow_export(original.clone(), &FlowExportContext::default(), true).unwrap();
        assert!(result.variable_names.is_empty());
        assert_eq!(result.document["flow"], original);
    }

    #[test]
    fn branch_assignments_continue_to_override_embedded_collection_values() {
        let original = flow(
            json!([
                {"id":"vars","kind":"setVariables","assignments":[{"name":"host","operation":"set","value":"branch"}]},
                {"id":"call","kind":"request","requestId":"saved"}
            ]),
            json!([
                edge("start", "vars"),
                edge("start", "call"),
                edge("vars", "call")
            ]),
        );
        let result = prepare_flow_export(original, &linked_context(), true).unwrap();
        assert_eq!(
            result.document["flow"]["nodes"][1]["assignments"][1],
            json!({"name":"export_call_host","operation":"set","value":"{{host}}"})
        );
    }

    #[test]
    fn sensitive_and_missing_values_are_empty_without_copying_unused_environment() {
        let original = flow(
            json!([{"id":"log","kind":"log","message":"{{token}} {{missing}}"}]),
            json!([edge("start", "log")]),
        );
        let context = FlowExportContext {
            variables: vec![
                EnvironmentVariable::new("token", "fixture", true).unwrap(),
                variable("unused", "unrelated"),
            ],
            ..Default::default()
        };
        let result = prepare_flow_export(original, &context, true).unwrap();
        assert_eq!(result.empty_variable_names, ["missing", "token"]);
        assert_eq!(
            result.document["flow"]["nodes"][2]["assignments"],
            json!([
                {"name":"missing","operation":"set","value":""}, {"name":"token","operation":"set","value":""}
            ])
        );
        assert!(!result.document.to_string().contains("fixture"));
        assert!(!result.document.to_string().contains("unrelated"));
    }

    #[test]
    fn missing_requests_and_external_scripts_allow_only_as_is() {
        for node in [
            json!({"id":"call","kind":"request","requestId":"missing"}),
            json!({"id":"call","kind":"inlineRequest","request":{"preRequestScript":"al.environment.get('host')"}}),
        ] {
            let original = flow(json!([node]), json!([edge("start", "call")]));
            let preview =
                prepare_flow_export(original.clone(), &FlowExportContext::default(), false)
                    .unwrap();
            assert!(!preview.blockers.is_empty());
            assert!(prepare_flow_export(original, &FlowExportContext::default(), true).is_err());
        }
    }

    #[test]
    fn response_only_scripts_and_annotations_do_not_create_dependencies() {
        let original = flow(
            json!([
                {"id":"note","kind":"note","text":"{{example}}"},
                {"id":"call","kind":"inlineRequest","request":{"postResponseScript":"al.expect(al.response.status).toBe(200)"}}
            ]),
            json!([edge("start", "call")]),
        );
        let result = prepare_flow_export(original, &FlowExportContext::default(), false).unwrap();
        assert!(result.blockers.is_empty());
        assert!(result.variable_names.is_empty());
    }

    #[test]
    fn load_session_variables_are_internal_and_external_values_get_session_blocks() {
        let mut original = flow(
            json!([
                {"id":"scenario","kind":"load","loadKind":"scenario","config":"{}"},
                {"id":"session","kind":"load","loadKind":"configureSession","config":"{\"variables\":{\"host\":\"local\"}}"},
                {"id":"call","kind":"load","loadKind":"request","config":"{\"url\":\"{{host}}/{{path}}\"}"}
            ]),
            json!([
                {"id":"iteration","sourceNodeId":"scenario","targetNodeId":"session","sourceHandle":"iteration"},edge("session","call")
            ]),
        );
        original["executionKind"] = json!("load");
        let context = FlowExportContext {
            variables: vec![variable("path", "items")],
            ..Default::default()
        };
        let result = prepare_flow_export(original, &context, true).unwrap();
        assert_eq!(result.variable_names, ["path"]);
        let exported = &result.document["flow"];
        assert_eq!(exported["nodes"][4]["loadKind"], "configureSession");
        assert_eq!(exported["edges"][0]["sourceNodeId"], "export_variables");
        assert!(exported["edges"][0].get("sourceHandle").is_none());
        assert_eq!(exported["edges"][2]["sourceHandle"], "iteration");
    }

    #[test]
    fn same_names_in_different_request_scopes_and_alias_collisions_are_isolated() {
        let mut context = linked_context();
        context
            .variables
            .push(variable("export_first_host", "reserved"));
        context.requests.insert(
            "other".into(),
            FlowExportRequest {
                request: json!({"endpoint":"{{host}}/{{export_first_host}}"}),
                variables: vec![
                    variable("host", "https://other.test"),
                    variable("export_first_host", "reserved"),
                ],
            },
        );
        let original = flow(
            json!([
                {"id":"first","kind":"request","requestId":"saved"},
                {"id":"second","kind":"request","requestId":"other"}
            ]),
            json!([edge("start", "first"), edge("start", "second")]),
        );
        let result = prepare_flow_export(original, &context, true).unwrap();
        let nodes = &result.document["flow"]["nodes"];
        assert_eq!(
            nodes[1]["request"]["endpoint"],
            "{{export_first_host_2}}/items/{{nodes.previous.response.body.id}}"
        );
        assert_eq!(
            nodes[2]["request"]["endpoint"],
            "{{export_second_host}}/{{export_first_host}}"
        );
        let assignments = &nodes[3]["assignments"];
        assert_eq!(assignments[0]["value"], "reserved");
        assert_eq!(assignments[1]["value"], "https://folder.test");
        assert_eq!(assignments[2]["value"], "https://other.test");
    }

    #[test]
    fn long_graphs_are_analyzed_without_recursive_traversal() {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut previous = "start".to_owned();
        for index in 0..2000 {
            let id = format!("node_{index}");
            nodes.push(json!({"id":id,"kind":"log","message":"{{host}}"}));
            edges.push(edge(&previous, &id));
            previous = id;
        }
        let result =
            prepare_flow_export(flow(json!(nodes), json!(edges)), &linked_context(), true).unwrap();
        assert_eq!(result.variable_names, ["host"]);
        assert_eq!(
            result.document["flow"]["nodes"].as_array().unwrap().len(),
            2002
        );
    }

    #[test]
    fn incomplete_load_configurations_can_still_be_exported_as_is() {
        let mut original = flow(
            json!([{"id":"load","kind":"load","loadKind":"request","config":"{"}]),
            json!([]),
        );
        original["executionKind"] = json!("load");
        let result =
            prepare_flow_export(original.clone(), &FlowExportContext::default(), false).unwrap();
        assert_eq!(result.document["flow"], original);
        assert!(!result.blockers.is_empty());
    }

    #[test]
    fn scope_rewriting_preserves_graphql_query_literals_and_response_scripts() {
        let mut context = linked_context();
        let request = &mut context.requests.get_mut("saved").unwrap().request;
        request["protocol"] = json!("graphql");
        request["body"] = json!("query { item(name: \"{{host}}\") }");
        request["postResponseScript"] = json!("al.expect(al.response.text()).toBe('{{host}}')");
        let original = flow(
            json!([{"id":"call","kind":"request","requestId":"saved"}]),
            json!([edge("start", "call")]),
        );
        let result = prepare_flow_export(original, &context, true).unwrap();
        let exported = &result.document["flow"]["nodes"][1]["request"];
        assert_eq!(exported["body"], "query { item(name: \"{{host}}\") }");
        assert_eq!(
            exported["postResponseScript"],
            "al.expect(al.response.text()).toBe('{{host}}')"
        );
        assert!(
            exported["endpoint"]
                .as_str()
                .unwrap()
                .starts_with("{{export_call_host}}")
        );
    }

    #[test]
    fn variables_produced_by_load_setup_remain_local_across_scenario_entries() {
        let mut original = flow(
            json!([
                {"id":"setup","kind":"load","loadKind":"scenario","config":"{\"phase\":\"setup\"}"},
                {"id":"extract","kind":"load","loadKind":"extract","config":"{\"name\":\"token\"}"},
                {"id":"scenario","kind":"load","loadKind":"scenario","config":"{}"},
                {"id":"call","kind":"load","loadKind":"request","config":"{\"url\":\"https://example.test/{{token}}\"}"}
            ]),
            json!([
                {"id":"setup-body","sourceNodeId":"setup","targetNodeId":"extract","sourceHandle":"iteration"},
                {"id":"body","sourceNodeId":"scenario","targetNodeId":"call","sourceHandle":"iteration"}
            ]),
        );
        original["executionKind"] = json!("load");
        let result =
            prepare_flow_export(original.clone(), &FlowExportContext::default(), true).unwrap();
        assert!(result.variable_names.is_empty());
        assert_eq!(result.document["flow"], original);
    }
}
