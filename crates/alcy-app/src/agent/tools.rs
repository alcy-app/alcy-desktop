//! The tools the agent can use on the workbench. The catalog is plain data,
//! independent of provider and turn, so any agent front end (the built-in
//! loop today, a local MCP server later) publishes the same set with the
//! same approval rules.

use serde_json::{Value, json};

use super::chat_model::ToolDefinition;
mod arguments;
mod resources;

/// How much the user has to be involved before a tool runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolClass {
    /// Reads workbench state; runs on its own.
    Read,
    /// Changes an open tab without saving; runs on its own and can be
    /// reverted from the chat.
    Edit,
    /// Leaves the tab: sends a request, writes collections or environments.
    /// Waits for the user to approve it.
    SideEffect,
}

struct ToolSpec {
    name: &'static str,
    class: ToolClass,
    description: &'static str,
    schema: fn() -> Value,
}

const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "list_open_tabs",
        class: ToolClass::Read,
        description: "List the request tabs open in the workbench, with their id, name, protocol, method, URL, whether they have unsaved changes and which one is active.",
        schema: || {
            object(
                json!({"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &[],
            )
        },
    },
    ToolSpec {
        name: "get_request",
        class: ToolClass::Read,
        description: "Read a request: from an open tab (tabId) or a saved request (requestId). Without either, reads the active tab. Secret values (auth, sensitive variables) are masked.",
        schema: request_target,
    },
    ToolSpec {
        name: "get_response",
        class: ToolClass::Read,
        description: "Read the last response shown in a tab (status, time, size, headers and the start of the body). Without tabId, uses the active tab.",
        schema: || {
            object(
                json!({"tabId":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &[],
            )
        },
    },
    ToolSpec {
        name: "search_collections",
        class: ToolClass::Read,
        description: "Search saved requests, folders and collections by name, URL or method. An empty query lists the collections. Returns ids usable by open_request and save_request.",
        schema: search_arguments,
    },
    ToolSpec {
        name: "list_environments",
        class: ToolClass::Read,
        description: "List environments, the active one and their variable names. Values of sensitive variables are never returned. Use {{name}} in requests to reference a variable.",
        schema: || {
            object(
                json!({"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &[],
            )
        },
    },
    ToolSpec {
        name: "highlight_in_editor",
        class: ToolClass::Read,
        description: "Show the user where some text is: opens the request field or the response body in the editor and highlights every occurrence. Use it when the user cannot find a value or when you point to one. Without field, the first request field containing the text is used.",
        schema: highlight_arguments,
    },
    ToolSpec {
        name: "open_request",
        class: ToolClass::Edit,
        description: "Open a saved request in a tab and make it active. Returns the tab id.",
        schema: open_request_arguments,
    },
    ToolSpec {
        name: "select_tab",
        class: ToolClass::Edit,
        description: "Make an open tab the active one.",
        schema: select_tab_arguments,
    },
    ToolSpec {
        name: "close_tab",
        class: ToolClass::Edit,
        description: "Close an open tab. Closing a tab with unsaved changes discards them, so the user approves it first.",
        schema: select_tab_arguments,
    },
    ToolSpec {
        name: "new_request_tab",
        class: ToolClass::Edit,
        description: "Open a new unsaved request tab (REST, GraphQL or gRPC) with the given fields and make it active. Returns the tab id.",
        schema: new_request_arguments,
    },
    ToolSpec {
        name: "update_request",
        class: ToolClass::Edit,
        description: "Change fields of the request in an open tab (the active one without tabId), including its pre-request and post-response scripts. Only the given fields change; headers replace the whole list. The tab stays unsaved and the user can revert the change.",
        schema: update_request_arguments,
    },
    ToolSpec {
        name: "send_request",
        class: ToolClass::SideEffect,
        description: "Send the request of a tab (the active one without tabId). HTTP returns a response summary; gRPC starts asynchronously, with progress and messages available through get_response. The user approves it first.",
        schema: tab_target,
    },
    ToolSpec {
        name: "cancel_request",
        class: ToolClass::SideEffect,
        description: "Cancel an HTTP, GraphQL, gRPC or WebSocket request in progress in a tab.",
        schema: tab_target,
    },
    ToolSpec {
        name: "send_grpc_message",
        class: ToolClass::SideEffect,
        description: "Send the tab's current grpc.message on an accepting client-streaming or bidirectional call. Edit grpc.message with update_request first.",
        schema: tab_target,
    },
    ToolSpec {
        name: "close_grpc_send",
        class: ToolClass::SideEffect,
        description: "Finish the request side of an accepting gRPC stream, allowing the server to complete its response. Read get_response later.",
        schema: tab_target,
    },
    ToolSpec {
        name: "send_websocket_message",
        class: ToolClass::SideEffect,
        description: "Send the tab's current websocket.message on its open WebSocket connection (send_request connects). Edit websocket.message with update_request first.",
        schema: tab_target,
    },
    ToolSpec {
        name: "close_websocket",
        class: ToolClass::SideEffect,
        description: "Close the tab's open WebSocket connection normally (code 1000). Read get_response afterwards for the received messages.",
        schema: tab_target,
    },
    ToolSpec {
        name: "save_request",
        class: ToolClass::SideEffect,
        description: "Save a tab to its collection. An unsaved draft needs parentId (a collection or folder id from search_collections) and may take a name. The user approves it first.",
        schema: save_request_arguments,
    },
    ToolSpec {
        name: "import_from_text",
        class: ToolClass::SideEffect,
        description: "Import text using Alcy's native format detection: Alcy, Postman, Insomnia or Bruno collections, OpenAPI JSON/YAML, HAR, or curl/wget/grpcurl commands (including multiple commands). Pass the original content without Markdown fences; call separately for independent documents. Saves collections, folders, requests, environments and documentation without executing requests or scripts. Silent by default; set openFirstRequest to true only when the user needs to see the first imported request. Returns counts, saved ids and warnings. Follows the chat approval mode.",
        schema: || {
            object(
                json!({
                    "content": { "type": "string", "minLength": 1 },
                    "openFirstRequest": { "type": "boolean", "default": false },
                }),
                &["content"],
            )
        },
    },
    ToolSpec {
        name: "create_collection",
        class: ToolClass::SideEffect,
        description: "Create an empty collection. Returns its id. The user approves it first.",
        schema: name_argument,
    },
    ToolSpec {
        name: "create_folder",
        class: ToolClass::SideEffect,
        description: "Create a folder inside a collection or folder. Returns its id. The user approves it first.",
        schema: create_folder_arguments,
    },
    ToolSpec {
        name: "set_environment_variable",
        class: ToolClass::SideEffect,
        description: "Create or update a variable in any environment, active or not, without switching the active environment. \
Pass environmentId from list_environments (its name also works); without it the active environment is used. The user approves it first.",
        schema: set_variable_arguments,
    },
    ToolSpec {
        name: "set_active_environment",
        class: ToolClass::SideEffect,
        description: "Choose the active environment; null clears it. The user approves it first.",
        schema: set_active_environment_arguments,
    },
];

/// Optional features the interface can turn off for a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentFeatures {
    /// Workspace documents: their tools and the documentation guidance.
    pub documents: bool,
}

impl Default for AgentFeatures {
    fn default() -> Self {
        Self { documents: true }
    }
}

/// The tools behind workspace documents (spec 0144), hidden when documents are off.
pub const DOCUMENT_TOOLS: [&str; 11] = [
    "get_documentation_guide",
    "list_documents",
    "get_document",
    "get_document_outline",
    "create_document",
    "update_document",
    "delete_document",
    "open_document",
    "read_document_source",
    "add_document_image",
    "export_document",
];

pub fn is_document_tool(name: &str) -> bool {
    DOCUMENT_TOOLS.contains(&name)
}

/// The catalog without the tools of the features that are off.
pub fn agent_tool_catalog_for(features: AgentFeatures) -> Vec<ToolDefinition> {
    let mut tools = agent_tool_catalog();
    if !features.documents {
        tools.retain(|tool| !is_document_tool(&tool.name));
    }
    tools
}

/// Definitions sent to the model, in a stable order.
pub fn agent_tool_catalog() -> Vec<ToolDefinition> {
    TOOLS
        .iter()
        .chain(resources::TOOLS)
        .map(|tool| ToolDefinition {
            name: tool.name.into(),
            description: tool.description.into(),
            input_schema: schema_of(tool),
        })
        .collect()
}

/// Where each kind of id comes from, so no model has to guess it.
const ID_SOURCES: &[(&str, &str)] = &[
    (
        "documentId",
        "Document id from list_documents or create_document.",
    ),
    (
        "sourceId",
        "Selected conversation or request execution id from get_document sources.",
    ),
    ("flowId", "Flow id from list_flows."),
    ("nodeId", "Node id from get_flow."),
    ("folderId", "Folder id from list_flows (flow folders)."),
    ("monitorId", "Value monitor id from list_value_monitors."),
    ("runnerId", "Runner id from open_runner or list_runners."),
    (
        "scopeId",
        "Collection or folder id from search_collections.",
    ),
    ("serverId", "Mock server id from list_mock_servers."),
    ("routeId", "Mock route id from get_mock_server."),
    ("responseId", "Mock response id from get_mock_server."),
    (
        "itemId",
        "Request, folder or collection id from search_collections.",
    ),
    (
        "parentId",
        "Collection or folder id from search_collections.",
    ),
    ("requestId", "Saved request id from search_collections."),
    ("environmentId", "Environment id from list_environments."),
    (
        "tabId",
        "Open tab id from list_open_tabs; the active tab when omitted.",
    ),
    ("edgeId", "Edge id from get_flow view full."),
    ("startNodeId", "Id of the mockStart node."),
];

/// The schema with a description for every top-level id that lacks one.
fn schema_of(tool: &ToolSpec) -> Value {
    let mut schema = (tool.schema)();
    if let Some(properties) = schema["properties"].as_object_mut() {
        for (key, property) in properties.iter_mut() {
            if property.get("description").is_none()
                && let Some((_, description)) = ID_SOURCES.iter().find(|(id, _)| id == key)
                && let Some(property) = property.as_object_mut()
            {
                property.insert("description".into(), Value::String((*description).into()));
            }
        }
    }
    schema
}

/// `None` for a name outside the catalog.
pub fn agent_tool_class(name: &str) -> Option<ToolClass> {
    TOOLS
        .iter()
        .chain(resources::TOOLS)
        .find(|tool| tool.name == name)
        .map(|tool| tool.class)
}

/// The arguments fitted to the tool's schema (see `arguments`), or a message
/// for the model saying what is wrong. `None` for a name outside the catalog.
pub fn normalize_tool_arguments(name: &str, input: &Value) -> Option<Result<Value, String>> {
    TOOLS
        .iter()
        .chain(resources::TOOLS)
        .find(|tool| tool.name == name)
        .map(|tool| arguments::normalize_arguments(&schema_of(tool), input))
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn tab_target() -> Value {
    object(
        json!({ "tabId": { "type": "string", "description": "Open tab id from list_open_tabs." } }),
        &[],
    )
}

fn request_target() -> Value {
    object(
        json!({
            "tabId": { "type": "string", "description": "Open tab id from list_open_tabs." },
            "requestId": { "type": "string", "description": "Saved request id from search_collections." },
        }),
        &[],
    )
}

fn search_arguments() -> Value {
    object(
        json!({
            "query": { "type": "string" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
        }),
        &["query"],
    )
}

fn open_request_arguments() -> Value {
    object(json!({ "requestId": { "type": "string" } }), &["requestId"])
}

fn select_tab_arguments() -> Value {
    object(json!({ "tabId": { "type": "string" } }), &["tabId"])
}

fn name_argument() -> Value {
    object(json!({ "name": { "type": "string" } }), &["name"])
}

fn create_folder_arguments() -> Value {
    object(
        json!({
            "parentId": { "type": "string", "description": "Collection or folder id." },
            "name": { "type": "string" },
        }),
        &["parentId", "name"],
    )
}

fn highlight_arguments() -> Value {
    object(
        json!({
            "tabId": { "type": "string" },
            "target": { "type": "string", "enum": ["request", "response"] },
            "field": {
                "type": "string",
                "enum": ["body", "query", "variables", "preRequestScript", "postResponseScript"],
                "description": "Request field to search (target request only).",
            },
            "text": { "type": "string", "description": "Exact text to highlight, as it appears in the editor." },
        }),
        &["target", "text"],
    )
}

fn save_request_arguments() -> Value {
    object(
        json!({
            "tabId": { "type": "string" },
            "parentId": { "type": "string", "description": "Collection or folder id; needed for an unsaved draft." },
            "name": { "type": "string" },
        }),
        &[],
    )
}

fn set_variable_arguments() -> Value {
    object(
        json!({
            "environmentId": { "type": "string" },
            "name": { "type": "string" },
            "value": { "type": "string" },
            "sensitive": { "type": "boolean" },
        }),
        &["name", "value"],
    )
}

fn set_active_environment_arguments() -> Value {
    object(
        json!({ "environmentId": { "type": ["string", "null"] } }),
        &["environmentId"],
    )
}

/// The script API, as the editor's autocompletion documents it.
const SCRIPT_DESCRIPTION: &str = "JavaScript run before the request (pre-request) or after the response (post-response); replaces the whole script, empty removes it. \
API: `al.request` (url, method, body, headers.get/set/remove, json(), setJson()); `al.response` in post-response only (status, time, headers.get, text(), json()); \
variables with get/set/has/unset in `al.environment`, `al.collection`, `al.folder`, `al.variables` and `al.runtime`; \
tests with `al.test('name', () => { al.expect(value).toBe(expected) })` (toEqual, toBeTruthy, toContain, toMatch, toBeGreaterThan, toHaveProperty, .not); \
`al.console.log`; `require('lodash' | 'crypto-js' | 'moment' | 'uuid')`.";

/// Request fields shared by `new_request_tab` and `update_request`.
fn request_fields() -> serde_json::Map<String, Value> {
    let fields = json!({
        "method": {
            "type": "string",
            "enum": ["get", "post", "put", "patch", "delete", "head", "options"],
            "description": "HTTP method (REST only).",
        },
        "url": { "type": "string", "description": "Endpoint URL; may use {{variables}}. Query parameters go in the URL." },
        "headers": {
            "type": "array",
            "description": "Replaces every header of the request.",
            "items": object(
                json!({
                    "name": { "type": "string" },
                    "value": { "type": "string" },
                    "enabled": { "type": "boolean" },
                }),
                &["name", "value"],
            ),
        },
        "body": {
            "type": "object",
            "description": "REST body. type none clears it; raw takes content and language; urlencoded/formData take fields. File attachments must already have been selected by the user in the editor.",
            "properties": {
                "type": { "type": "string", "enum": ["none", "raw", "urlencoded", "formData", "binary"] },
                "filePath": { "type": "string" },
                "content": { "type": "string" },
                "language": { "type": "string", "enum": ["json", "text", "xml", "html", "javascript"] },
                "fields": {
                    "type": "array",
                    "items": object(
                        json!({ "name": { "type": "string" }, "value": { "type": "string" }, "kind": { "type": "string", "enum": ["text", "file"] }, "enabled": { "type": "boolean" }, "filePath": { "type": "string" } }),
                        &["name"],
                    ),
                },
            },
            "required": ["type"],
        },
        "query": { "type": "string", "description": "GraphQL document (GraphQL only)." },
        "variables": { "type": "string", "description": "GraphQL variables as a JSON string (GraphQL only)." },
        "preRequestScript": { "type": "string", "description": SCRIPT_DESCRIPTION },
        "postResponseScript": { "type": "string", "description": SCRIPT_DESCRIPTION },
        "routeParams": { "type": "array", "items": object(json!({"name":{"type":"string"},"value":{"type":"string"}}), &["name","value"]) },
        "grpc": object(json!({
            "service":{"type":"string"},"method":{"type":"string"},"message":{"type":"string","description":"Request message as JSON."},
            "deadlineMs":{"type":["integer","null"],"minimum":1},
            "schemaSource":{"type":"object","description":"Reuse the schema source already selected in the editor; defaults to server reflection."}
        }), &[]),
        "websocket": object(json!({
            "message":{"type":"string","description":"Message the composer sends; base64 when messageFormat is binary."},
            "messageFormat":{"type":"string","enum":["text","json","binary"]},
            "subprotocols":{"type":"array","items":{"type":"string"},"description":"Offered in Sec-WebSocket-Protocol, in order of preference."},
            "waitMs":{"type":["integer","null"],"minimum":1,"description":"Runs and flows: longest wait for replies; the request timeout when null."},
            "expectedMessages":{"type":["integer","null"],"minimum":0,"description":"Runs and flows: close after this many replies (1 when null, 0 waits for waitMs)."}
        }), &[]),
        "authentication": {
            "type": "object",
            "description": "inherit uses the collection's; bearer takes token; basic takes username and password; customHeader takes name and value. Prefer {{variables}} over literal secrets.",
            "properties": {
                "type": { "type": "string", "enum": ["inherit", "none", "bearer", "basic", "digest", "customHeader", "oauth2ClientCredentials"] },
                "token": { "type": "string" },
                "username": { "type": "string" },
                "password": { "type": "string" },
                "name": { "type": "string" },
                "value": { "type": "string" },
                "clientId": { "type": "string" },
                "clientSecret": { "type": "string" },
                "tokenUrl": { "type": "string" },
                "scope": { "type": "string" },
            },
            "required": ["type"],
        },
    });
    match fields {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}

fn new_request_arguments() -> Value {
    let mut properties = request_fields();
    properties.insert(
        "protocol".into(),
        json!({ "type": "string", "enum": ["rest", "graphql", "grpc", "websocket"] }),
    );
    properties.insert("name".into(), json!({ "type": "string" }));
    object(Value::Object(properties), &["protocol"])
}

fn update_request_arguments() -> Value {
    let mut properties = request_fields();
    properties.insert("tabId".into(), json!({ "type": "string" }));
    object(Value::Object(properties), &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_has_an_object_schema_and_a_unique_name() {
        let catalog = agent_tool_catalog();
        assert_eq!(catalog.len(), TOOLS.len() + resources::TOOLS.len());
        for (index, tool) in catalog.iter().enumerate() {
            assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
            assert!(
                catalog[index + 1..]
                    .iter()
                    .all(|other| other.name != tool.name),
                "{} is repeated",
                tool.name
            );
        }
    }

    #[test]
    fn every_id_says_where_it_comes_from_and_descriptions_stay_short() {
        for tool in agent_tool_catalog() {
            assert!(
                tool.description.len() <= 600,
                "{} has a {}-byte description",
                tool.name,
                tool.description.len()
            );
            let properties = tool.input_schema["properties"].as_object().unwrap();
            for (key, property) in properties {
                if key.ends_with("Id") {
                    assert!(
                        property["description"].is_string(),
                        "{}.{key} needs a description",
                        tool.name
                    );
                }
            }
        }
    }

    #[test]
    fn arguments_are_normalized_with_the_catalog_schema() {
        let input = json!({ "flow_id": "f", "kind": "INLINE_REQUEST", "method": "POST" });
        let normalized = normalize_tool_arguments("add_flow_node", &input)
            .unwrap()
            .unwrap();
        assert_eq!(
            normalized,
            json!({ "flowId": "f", "kind": "inlineRequest", "method": "post" })
        );
        assert!(
            normalize_tool_arguments("add_flow_node", &json!({ "kind": "log" }))
                .unwrap()
                .unwrap_err()
                .contains("Flow id from list_flows")
        );
        assert!(normalize_tool_arguments("rm_rf", &json!({})).is_none());
    }

    #[test]
    fn side_effects_are_classified() {
        assert_eq!(agent_tool_class("get_request"), Some(ToolClass::Read));
        assert_eq!(agent_tool_class("update_request"), Some(ToolClass::Edit));
        assert_eq!(
            agent_tool_class("send_request"),
            Some(ToolClass::SideEffect)
        );
        assert_eq!(
            agent_tool_class("highlight_in_editor"),
            Some(ToolClass::Read)
        );
        assert_eq!(agent_tool_class("close_tab"), Some(ToolClass::Edit));
        for name in [
            "add_flow_node",
            "connect_flow_nodes",
            "disconnect_flow_nodes",
            "organize_flow",
            "update_flow",
            "rename_flow_node",
        ] {
            assert_eq!(agent_tool_class(name), Some(ToolClass::Edit), "{name}");
        }
        for name in ["check_flow", "get_flow_guide", "get_flow_references"] {
            assert_eq!(agent_tool_class(name), Some(ToolClass::Read), "{name}");
        }
        assert_eq!(
            agent_tool_class("create_request"),
            Some(ToolClass::SideEffect)
        );
        assert_eq!(agent_tool_class("rm_rf"), None);
        for name in [
            "run_flow",
            "create_flow",
            "run_runner",
            "create_value_monitor",
            "delete_flow",
            "start_mock_server",
            "cancel_request",
            "send_grpc_message",
            "close_grpc_send",
            "send_websocket_message",
            "close_websocket",
            "import_from_text",
            "create_document",
            "update_document",
            "delete_document",
            "add_document_image",
            "export_document",
        ] {
            assert_eq!(
                agent_tool_class(name),
                Some(ToolClass::SideEffect),
                "{name}"
            );
        }
    }

    #[test]
    fn document_tools_match_the_frontend_list_and_drop_out_when_documents_are_off() {
        let frontend =
            include_str!("../../../../apps/desktop/src/features/documents/document-agent-tools.ts");
        for name in DOCUMENT_TOOLS {
            assert!(frontend.contains(&format!("'{name}'")), "{name}");
            assert!(
                agent_tool_catalog().iter().any(|tool| tool.name == name),
                "{name}"
            );
        }
        let without = agent_tool_catalog_for(AgentFeatures { documents: false });
        assert!(without.iter().all(|tool| !is_document_tool(&tool.name)));
        assert_eq!(
            without.len(),
            agent_tool_catalog().len() - DOCUMENT_TOOLS.len()
        );
        assert_eq!(
            agent_tool_catalog_for(AgentFeatures::default()).len(),
            agent_tool_catalog().len()
        );
    }

    #[test]
    fn every_tool_has_a_frontend_card_in_both_languages() {
        let english = include_str!("../../../../apps/desktop/src/shared/i18n/locales/en.ts");
        let portuguese = include_str!("../../../../apps/desktop/src/shared/i18n/locales/pt-BR.ts");
        for tool in agent_tool_catalog() {
            let key = format!("'agent.tool.{}'", tool.name);
            assert!(english.contains(&key), "{}", tool.name);
            assert!(portuguese.contains(&key), "{}", tool.name);
        }
    }
}
