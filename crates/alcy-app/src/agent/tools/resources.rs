use super::{ToolClass, ToolSpec, object};
use serde_json::{Value, json};

macro_rules! tool {
    ($name:literal, $class:ident, $description:literal, $schema:expr) => {
        ToolSpec {
            name: $name,
            class: ToolClass::$class,
            description: $description,
            schema: $schema,
        }
    };
}

pub(super) const TOOLS: &[ToolSpec] = &[
    tool!(
        "list_flows",
        Read,
        "Search workspace flows and their folders. Load flows are unavailable while load testing is disabled. Results are paginated.",
        pagination
    ),
    tool!(
        "get_flow",
        Read,
        "Read a flow's metadata and paginated nodes/edges, or a single node with nodeId. Secrets are masked. Never write truncated content back.",
        || target_page("flowId", json!({"nodeId":{"type":"string"}}))
    ),
    tool!(
        "create_flow",
        SideEffect,
        "Create and persist a standard or load flow. A standard flow starts with Start; a load flow has a starter scenario/request. Optional graph edits use the same format as update_flow. Returns flowId.",
        || flow_edit(true)
    ),
    tool!(
        "update_flow",
        SideEffect,
        "Persist partial flow edits: upsertNodes/upsertEdges merge by id; removeNodeIds/removeEdgeIds delete explicitly. Omitted properties, positions and secrets stay unchanged. New nodes need kind. Inline requests use the saved-request DTO (endpoint, restBody, body for GraphQL, headers, authentication). Load config is serialized JSON. Use rename_flow_node to rename ids and references. folderId null moves to root.",
        || flow_edit(false)
    ),
    tool!(
        "rename_flow_node",
        SideEffect,
        "Rename a node id and update its connections, panel references, mock dependencies and request templates using the editor's existing rename action. Linked request edits remain explicit-save drafts.",
        || object(
            json!({"flowId":text(),"nodeId":text(),"name":text()}),
            &["flowId", "nodeId", "name"]
        )
    ),
    tool!(
        "duplicate_flow",
        SideEffect,
        "Duplicate a flow, retaining its graph and inline configuration. Returns a new flowId.",
        || target(
            "flowId",
            json!({"name":text(),"folderId":{"type":["string","null"]}})
        )
    ),
    tool!(
        "delete_flow",
        SideEffect,
        "Delete a flow. Cancel a running flow first. Does not delete linked collection requests.",
        || target("flowId", json!({}))
    ),
    tool!(
        "manage_flow_folder",
        SideEffect,
        "Create, rename or delete a flow folder. Deleting a folder leaves its flows at the root. create/rename need name; rename/delete need folderId.",
        || object(
            json!({"action":{"type":"string","enum":["create","rename","delete"]},"folderId":text(),"name":text()}),
            &["action"]
        )
    ),
    tool!(
        "open_flow",
        Edit,
        "Open an existing flow in the canvas.",
        || target("flowId", json!({}))
    ),
    tool!(
        "preview_flow",
        SideEffect,
        "Save the current flow graph and prepare its native execution preview. For load flows returns destinations, scenarios, peak VUs and arrival rate. Call before run_flow for a load flow; edits invalidate the preview.",
        || target("flowId", json!({}))
    ),
    tool!(
        "run_flow",
        SideEffect,
        "Start the current flow without waiting for completion. Load flows require preview_flow first; approval displays the preview. Request drafts and initial forms open the UI for the user. HumanAction forms are always answered by the user. Query get_flow_run later; do not poll in a tight loop.",
        || target("flowId", json!({}))
    ),
    tool!(
        "get_flow_run",
        Read,
        "Get flow execution id, progress and paginated node states. Waiting forms must be completed by the user. Load results are aggregate metrics.",
        || target_page("flowId", json!({}))
    ),
    tool!(
        "cancel_flow",
        SideEffect,
        "Cancel the flow's current execution.",
        || target("flowId", json!({}))
    ),
    tool!(
        "get_flow_output",
        Read,
        "Inspect a standard flow node's last output through the bounded native inspector. pointer is a JSON pointer; use nextCursor for another page, or text true for text windows.",
        || target(
            "flowId",
            json!({"nodeId":text(),"pointer":text(),"cursor":text(),"text":{"type":"boolean"}})
        )
    ),
    tool!(
        "list_value_monitors",
        Read,
        "Search value monitors (response field validation rules, not scheduled network monitors). Returns paginated summaries.",
        pagination
    ),
    tool!(
        "get_value_monitor",
        Read,
        "Read a value monitor with paginated fields and rules.",
        || target_page("monitorId", json!({}))
    ),
    tool!(
        "create_value_monitor",
        SideEffect,
        "Create a value monitor with field suffixes and validation rules. Returns monitorId. Native validation rejects invalid rules without publishing them.",
        || monitor_edit(true)
    ),
    tool!(
        "update_value_monitor",
        SideEffect,
        "Update a monitor name or enabled flag; addFields/removeFields and upsertRules/removeRuleIds edit individual entries. Omitted properties stay unchanged; supplied fields/rules replace their whole lists. Omit a new rule's id to generate one. Read all pages before replacing a list.",
        || monitor_edit(false)
    ),
    tool!(
        "delete_value_monitor",
        SideEffect,
        "Delete a value monitor.",
        || target("monitorId", json!({}))
    ),
    tool!(
        "evaluate_value_monitors",
        Read,
        "Evaluate up to 100 primitive response candidates locally against current monitors (or one monitorId). path contains string keys/numeric indices; literal is the primitive JSON string, e.g. \"Ana\", 12 or true.",
        || object(
            json!({"monitorId":text(),"values":{"type":"array","maxItems":100,"items":object(json!({"path":{"type":"array","items":{"type":["string","integer"]}},"literal":text()}), &["path","literal"])}}),
            &["values"]
        )
    ),
    tool!(
        "list_runners",
        Read,
        "List open collection runner tabs with runnerId, scopeId and read-only status.",
        pagination
    ),
    tool!(
        "open_runner",
        Edit,
        "Open or reuse the runner of a collection/folder from search_collections. Returns runnerId. Runner configurations are session-only, not saved presets.",
        || target("scopeId", json!({}))
    ),
    tool!(
        "get_runner",
        Read,
        "Read runner settings, selected request ids in execution order (paginated), selected data file and run status.",
        || target_page("runnerId", json!({}))
    ),
    tool!(
        "configure_runner",
        Edit,
        "Change runner options or selected requestIds in execution order. Omitted fields stay unchanged. Reversible until a subsequent edit or run. A data file determines iterations when selected.",
        || target(
            "runnerId",
            json!({"requestIds":{"type":"array","items":text()},"options":runner_options()})
        )
    ),
    tool!(
        "pick_runner_data_file",
        Edit,
        "Open the native file selector so the user can choose a runner dataset. The user chooses the path; the agent never reads a whole file.",
        || target("runnerId", json!({}))
    ),
    tool!(
        "clear_runner_data_file",
        Edit,
        "Remove the runner's selected dataset from its configuration.",
        || target("runnerId", json!({}))
    ),
    tool!(
        "run_runner",
        SideEffect,
        "Start a runner with its current configuration. Returns runId immediately after preparation. Query get_runner_run later; do not poll in a tight loop.",
        || target("runnerId", json!({}))
    ),
    tool!(
        "get_runner_run",
        Read,
        "Get runner progress, verdict, errors and paginated finished steps. iteration/position identify a step for get_runner_output.",
        || target_page("runnerId", json!({}))
    ),
    tool!(
        "cancel_runner",
        SideEffect,
        "Cancel a runner's current execution.",
        || target("runnerId", json!({}))
    ),
    tool!(
        "get_runner_output",
        Read,
        "Read a bounded response preview of a completed runner step. iteration and position are zero-based values from get_runner_run.",
        || target(
            "runnerId",
            json!({"iteration":{"type":"integer","minimum":0},"position":{"type":"integer","minimum":0}})
        )
    ),
    tool!(
        "list_mock_servers",
        Read,
        "Search local mock servers, ports and running status. Results are paginated.",
        pagination
    ),
    tool!(
        "get_mock_server",
        Read,
        "Read current mock editor draft if open, otherwise saved configuration. Routes are paginated; secrets are masked.",
        || target_page("serverId", json!({"routeId":text(),"responseId":text()}))
    ),
    tool!(
        "create_mock_server",
        SideEffect,
        "Create and save a loopback-only mock server. Routes and responses need unique ids. Returns serverId.",
        || object(json!({"name":text(),"server":mock_patch()}), &["name"])
    ),
    tool!(
        "update_mock_server",
        Edit,
        "Edit the mock's open draft, without saving. patch merges settings; routes replace the full route list and alternatives replace the full alternatives list. Read all pages first. Omitted fields and masked secrets stay unchanged.",
        || target("serverId", json!({"patch":mock_patch()}))
    ),
    tool!(
        "save_mock_server",
        SideEffect,
        "Validate and save the mock editor's current draft. Must save before starting a modified mock.",
        || target("serverId", json!({}))
    ),
    tool!(
        "delete_mock_server",
        SideEffect,
        "Delete a mock server and close its editor.",
        || target("serverId", json!({}))
    ),
    tool!(
        "open_mock_server",
        Edit,
        "Open the mock server's editor.",
        || target("serverId", json!({}))
    ),
    tool!(
        "start_mock_server",
        SideEffect,
        "Start a saved mock on loopback using the native runtime. Does not save drafts.",
        || target("serverId", json!({}))
    ),
    tool!(
        "stop_mock_server",
        SideEffect,
        "Stop the local mock server.",
        || target("serverId", json!({}))
    ),
    tool!(
        "list_mock_calls",
        Read,
        "Read a page of mock call summaries, without full request bodies.",
        || target_page("serverId", json!({}))
    ),
    tool!(
        "clear_mock_calls",
        SideEffect,
        "Clear a mock's in-memory call log.",
        || target("serverId", json!({}))
    ),
    tool!(
        "get_collection",
        Read,
        "Read collection/folder settings, authentication, scoped variables and paginated child summaries.",
        || target_page("itemId", json!({}))
    ),
    tool!(
        "update_collection_item",
        SideEffect,
        "Rename a request/collection/folder, move a request/folder to parentId, or update collection/folder authentication. Request content edits use update_request and save_request.",
        || target(
            "itemId",
            json!({"name":text(),"parentId":text(),"authentication":super::request_fields()["authentication"].clone()})
        )
    ),
    tool!(
        "duplicate_collection_item",
        SideEffect,
        "Duplicate a collection, folder subtree or request with regenerated ids and save it, without opening a tab. Optional name overrides the copy name. For a request, the request fields (as in update_request) change the copy and parentId saves it in another collection or folder: start a new request from a similar saved one instead of from scratch. Returns itemId.",
        duplicate_arguments
    ),
    tool!(
        "create_request",
        SideEffect,
        "Create a request and save it in a collection or folder (parentId from search_collections) without opening a tab, for when the user does not need to see it. Returns requestId; open_request shows it later. Use new_request_tab when the user wants to see or edit the request.",
        create_request_arguments
    ),
    tool!(
        "delete_collection_item",
        SideEffect,
        "Delete a request, folder subtree or collection and close affected request tabs. Approval includes discarding their drafts.",
        || target("itemId", json!({}))
    ),
    tool!(
        "set_scope_variable",
        SideEffect,
        "Create or update a collection/folder variable. Prefer {{environmentVariable}} references for credentials.",
        || target("itemId", json!({"name":text(),"value":{"type":"string"}}))
    ),
    tool!(
        "delete_scope_variable",
        SideEffect,
        "Delete a collection/folder variable by name.",
        || target("itemId", json!({"name":text()}))
    ),
    tool!(
        "create_environment",
        SideEffect,
        "Create an empty environment without changing the active environment. Returns environmentId.",
        || object(json!({"name":text()}), &["name"])
    ),
    tool!(
        "update_environment",
        SideEffect,
        "Rename an environment. Use set_environment_variable to upsert variables.",
        || target("environmentId", json!({"name":text()}))
    ),
    tool!(
        "delete_environment",
        SideEffect,
        "Delete an environment and clear the active selection if it was active.",
        || target("environmentId", json!({}))
    ),
    tool!(
        "delete_environment_variable",
        SideEffect,
        "Delete a variable by name in an environment.",
        || target("environmentId", json!({"name":text()}))
    ),
];

fn text() -> Value {
    json!({"type":"string"})
}
fn pagination() -> Value {
    object(
        json!({"query":text(),"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}),
        &[],
    )
}
fn duplicate_arguments() -> Value {
    let mut fields = super::request_fields();
    fields.insert("itemId".into(), text());
    fields.insert("name".into(), text());
    fields.insert(
        "parentId".into(),
        json!({"type":"string","description":"Collection or folder for a request copy; the original's by default."}),
    );
    object(Value::Object(fields), &["itemId"])
}

fn create_request_arguments() -> Value {
    let mut fields = super::request_fields();
    fields.insert(
        "parentId".into(),
        json!({"type":"string","description":"Collection or folder id from search_collections."}),
    );
    fields.insert("name".into(), text());
    fields.insert(
        "protocol".into(),
        json!({"type":"string","enum":["rest","graphql"]}),
    );
    object(Value::Object(fields), &["parentId", "name", "protocol"])
}

fn target(key: &str, extra: Value) -> Value {
    let mut fields = extra.as_object().cloned().unwrap_or_default();
    fields.insert(key.into(), text());
    object(Value::Object(fields), &[key])
}
fn target_page(key: &str, extra: Value) -> Value {
    let mut fields = pagination()["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    fields.extend(extra.as_object().cloned().unwrap_or_default());
    target(key, Value::Object(fields))
}
fn array(items: Value) -> Value {
    json!({"type":"array","maxItems":100,"items":items})
}

fn flow_edit(create: bool) -> Value {
    let condition = object(
        json!({"left":text(),"operator":{"type":"string","enum":["equals","notEquals","greaterThan","lessThan"]},"right":text()}),
        &["left", "operator", "right"],
    );
    let node = object(
        json!({
            "id":text(),"kind":{"type":"string","enum":["start","humanAction","block","request","inlineRequest","if","note","log","display","sleep","setVariables","while","break","continue","load","mockStart","mockStop","mockWaitRequest","mockSetResponse","mockAssertCalls"]},
            "x":{"type":"number"},"y":{"type":"number"},"label":text(),"requestId":text(),"condition":condition,"text":text(),"width":{"type":"number"},"height":{"type":"number"},"message":text(),"template":text(),"durationMs":{"type":"integer","minimum":0},"maxIterations":{"type":"integer","minimum":1},
            "assignments":array(object(json!({"name":text(),"operation":{"type":"string","enum":["set","increment"]},"value":text(),"by":{"type":"number"}}), &["name","operation"])),
            "loadKind":{"type":"string","enum":["scenario","request","script","repeat","forEach","oncePerVu","timeBox","select","group","timer","dataset","configureSession","extract","check","metric","threshold"]},"config":{"type":"string","description":"Serialized JSON configuration for a load block."},
            "request":{"type":"object","description":"SavedRequest DTO: id,name,protocol,endpoint,method,body,restBody,variables,headers,authentication,preRequestScript,postResponseScript,routeParams,grpc. New nodes fill defaults for omitted fields."},
            "form":{"type":["object","null"],"description":"FlowForm: title,description,sections[{id,title,collapsed,fields[{id,label,description,kind,required,initialValue,min,max,step,options:[{value,label}],source:{reference,columns:[{path,label}],view}|null,multiple}]}]. kind: text,textarea,number,select,radio,checkbox,result."},
            "source":{"type":"object","description":"Mock source: {type:saved,serverId} or {type:inline,server:MockServerDto}."},"startNodeId":text(),"routeId":text(),"timeoutMs":{"type":"integer","minimum":1},"responseId":{"type":["string","null"]},"operator":{"type":"string","enum":["equals","atLeast","atMost"]},"count":{"type":"integer","minimum":0}
        }),
        &["id"],
    );
    let mut fields = json!({"name":text(),"folderId":{"type":["string","null"]},"upsertNodes":array(node),"upsertEdges":array(object(json!({"id":text(),"sourceNodeId":text(),"targetNodeId":text(),"sourceHandle":{"type":["string","null"],"enum":["true","false","success","failure","loop","done","iteration","passed","failed","body",null]}}), &["id"])),"removeNodeIds":array(text()),"removeEdgeIds":array(text()),"presentation":object(json!({"panels":array(object(json!({"nodeId":text(),"title":text(),"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"}}), &["nodeId","title","x","y","width","height"]))}), &["panels"])});
    if create {
        fields["executionKind"] = json!({"type":"string","enum":["standard","load"]});
        object(fields, &["name"])
    } else {
        target("flowId", fields)
    }
}

fn monitor_edit(create: bool) -> Value {
    let rule = object(
        json!({"id":text(),"kind":{"type":"string","enum":["exactLength","lengthRange","lettersOnly","digitsOnly","alphanumeric","noWhitespace","notEmpty","case","equals","contains","notContains","startsWith","endsWith","oneOf","regex","type","numberRange","format"]},"length":{"type":"integer","minimum":0},"min":{"type":["number","null"]},"max":{"type":["number","null"]},"style":{"type":"string","enum":["upper","lower","capitalized","title"]},"value":text(),"caseSensitive":{"type":"boolean"},"values":array(text()),"pattern":text(),"valueType":{"type":"string","enum":["string","number","boolean","null"]},"format":{"type":"string","enum":["email","uuid","isoDate","isoDateTime","url"]}}),
        &["kind"],
    );
    let fields = json!({"name":text(),"enabled":{"type":"boolean"},"fields":array(text()),"rules":array(rule.clone()),"addFields":array(text()),"removeFields":array(text()),"upsertRules":array(rule),"removeRuleIds":array(text())});
    if create {
        object(fields, &["name"])
    } else {
        target("monitorId", fields)
    }
}

fn runner_options() -> Value {
    let mut fields = json!({"iterations":{"type":"integer","minimum":1,"maximum":1000},"delayMs":{"type":"integer","minimum":0,"maximum":600000}});
    for key in [
        "stopOnError",
        "httpErrorsFail",
        "keepVariableValues",
        "shareCookies",
        "persistResponses",
        "saveToHistory",
        "disableLogs",
    ] {
        fields[key] = json!({"type":"boolean"});
    }
    object(fields, &[])
}

fn mock_patch() -> Value {
    let response = object(
        json!({"id":text(),"name":text(),"enabled":{"type":"boolean"},"status":{"type":"integer","minimum":100,"maximum":599},"headers":array(object(json!({"name":text(),"value":text()}), &["name","value"])),"body":text(),"delayMs":{"type":"integer","minimum":0},"condition":{"type":["object","null"],"description":"Recursive MockConditionGroup: {operator:all|any,conditions:[{kind:group,group}|{kind:match,source:pathParameter|query|header|bodyText|jsonPointer,key,operator:equals|notEquals|contains|exists|notExists,value}]}"}}),
        &[
            "id",
            "name",
            "enabled",
            "status",
            "headers",
            "body",
            "delayMs",
            "condition",
        ],
    );
    object(
        json!({"name":text(),"port":{"type":"integer","minimum":1,"maximum":65535},"corsEnabled":{"type":"boolean"},"routes":array(object(json!({"id":text(),"name":text(),"enabled":{"type":"boolean"},"method":text(),"path":text(),"defaultResponse":response,"alternatives":array(response.clone())}), &["id","name","enabled","method","path","defaultResponse","alternatives"]))}),
        &[],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_dispatch_covers_every_resource_tool() {
        let frontend =
            include_str!("../../../../../apps/desktop/src/features/agent/agent-resource-tools.ts");
        for tool in TOOLS {
            assert!(
                frontend.contains(&format!("'{}'", tool.name)),
                "{}",
                tool.name
            );
        }
    }
}
