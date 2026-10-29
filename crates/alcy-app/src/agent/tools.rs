//! The tools the agent can use on the workbench. The catalog is plain data,
//! independent of provider and turn, so any agent front end (the built-in
//! loop today, a local MCP server later) publishes the same set with the
//! same approval rules.

use serde_json::{Value, json};

use super::chat_model::ToolDefinition;

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
        schema: no_arguments,
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
        schema: tab_target,
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
        schema: no_arguments,
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
        name: "new_request_tab",
        class: ToolClass::Edit,
        description: "Open a new unsaved request tab (REST or GraphQL) with the given fields and make it active. Returns the tab id.",
        schema: new_request_arguments,
    },
    ToolSpec {
        name: "update_request",
        class: ToolClass::Edit,
        description: "Change fields of the request in an open tab (the active one without tabId). Only the given fields change; headers replace the whole list. The tab stays unsaved and the user can revert the change.",
        schema: update_request_arguments,
    },
    ToolSpec {
        name: "send_request",
        class: ToolClass::SideEffect,
        description: "Send the request of a tab (the active one without tabId) and return the response summary. The user approves it first.",
        schema: tab_target,
    },
    ToolSpec {
        name: "save_request",
        class: ToolClass::SideEffect,
        description: "Save a tab to its collection. An unsaved draft needs parentId (a collection or folder id from search_collections) and may take a name. The user approves it first.",
        schema: save_request_arguments,
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
        description: "Create or update a variable in an environment (the active one without environmentId). The user approves it first.",
        schema: set_variable_arguments,
    },
    ToolSpec {
        name: "set_active_environment",
        class: ToolClass::SideEffect,
        description: "Choose the active environment; null clears it. The user approves it first.",
        schema: set_active_environment_arguments,
    },
];

/// Definitions sent to the model, in a stable order.
pub fn agent_tool_catalog() -> Vec<ToolDefinition> {
    TOOLS
        .iter()
        .map(|tool| ToolDefinition {
            name: tool.name.into(),
            description: tool.description.into(),
            input_schema: (tool.schema)(),
        })
        .collect()
}

/// `None` for a name outside the catalog.
pub fn agent_tool_class(name: &str) -> Option<ToolClass> {
    TOOLS
        .iter()
        .find(|tool| tool.name == name)
        .map(|tool| tool.class)
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn no_arguments() -> Value {
    object(json!({}), &[])
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
            "description": "REST body. type none clears it; raw takes content and language; urlencoded takes fields.",
            "properties": {
                "type": { "type": "string", "enum": ["none", "raw", "urlencoded"] },
                "content": { "type": "string" },
                "language": { "type": "string", "enum": ["json", "text", "xml", "html", "javascript"] },
                "fields": {
                    "type": "array",
                    "items": object(
                        json!({ "name": { "type": "string" }, "value": { "type": "string" } }),
                        &["name", "value"],
                    ),
                },
            },
            "required": ["type"],
        },
        "query": { "type": "string", "description": "GraphQL document (GraphQL only)." },
        "variables": { "type": "string", "description": "GraphQL variables as a JSON string (GraphQL only)." },
        "authentication": {
            "type": "object",
            "description": "inherit uses the collection's; bearer takes token; basic takes username and password; customHeader takes name and value. Prefer {{variables}} over literal secrets.",
            "properties": {
                "type": { "type": "string", "enum": ["inherit", "none", "bearer", "basic", "customHeader"] },
                "token": { "type": "string" },
                "username": { "type": "string" },
                "password": { "type": "string" },
                "name": { "type": "string" },
                "value": { "type": "string" },
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
        json!({ "type": "string", "enum": ["rest", "graphql"] }),
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
        assert_eq!(catalog.len(), TOOLS.len());
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
    fn side_effects_are_classified() {
        assert_eq!(agent_tool_class("get_request"), Some(ToolClass::Read));
        assert_eq!(agent_tool_class("update_request"), Some(ToolClass::Edit));
        assert_eq!(
            agent_tool_class("send_request"),
            Some(ToolClass::SideEffect)
        );
        assert_eq!(agent_tool_class("rm_rf"), None);
    }
}
