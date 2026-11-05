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
        "get_documentation_guide",
        Read,
        "How to write professional workspace documentation: workflow, the document dialect (metadata and cover, callouts, columns, page breaks, table of contents, image size and alignment, captions), writing standard and recommended structures. Read before creating or revising a document.",
        || object(json!({}), &[])
    ),
    tool!(
        "list_documents",
        Read,
        "Search workspace documents by title. Returns document ids and revisions, without content. Read a document to discover its sources and images.",
        pagination
    ),
    tool!(
        "get_document",
        Read,
        "Read a document's metadata and a bounded Markdown page. Follow page.nextOffset, nextSourceOffset and nextAssetOffset to read more. Unsaved user edits must be saved or discarded in the editor before agent changes.",
        || target_page(
            "documentId",
            json!({"sourceOffset":{"type":"integer","minimum":0},"assetOffset":{"type":"integer","minimum":0}})
        )
    ),
    tool!(
        "get_document_outline",
        Read,
        "Read a document's metadata (cover, toc, numbering, theme…) and its headings with levels and automatic numbers, without the text. Use it to plan section edits.",
        || target("documentId", json!({}))
    ),
    tool!(
        "create_document",
        SideEffect,
        "Create and open an empty document. The current chat is its initial source; the user can select other conversations and request executions in Documents. Returns documentId and revision.",
        || object(json!({"title":text()}), &["title"])
    ),
    tool!(
        "open_document",
        Edit,
        "Open a saved document in its editor tab.",
        || target("documentId", json!({}))
    ),
    tool!(
        "update_document",
        SideEffect,
        "Revise a document at expectedRevision with one content operation: append adds Markdown at the end; replaceText with replacement changes one exact, unique passage; section with sectionEdit and content edits the section under that unique heading (replace swaps the heading and its subsections, so content includes the heading; insertBefore, insertAfter and appendToSection add content around it). metadata sets cover and export options, alone or with the operation; null removes a key. title renames it. Unrelated content stays unchanged. Follow get_documentation_guide for the dialect.",
        || object(
            json!({"documentId":text(),"expectedRevision":{"type":"integer","minimum":1},"title":text(),"append":{"type":"string","maxLength":32768},"replaceText":{"type":"string","maxLength":32768},"replacement":{"type":"string","maxLength":32768},
                "section":{"type":"string","maxLength":240,"description":"Exact heading text of the section, as get_document_outline lists it."},
                "sectionEdit":{"type":"string","enum":["replace","insertBefore","insertAfter","appendToSection"]},
                "content":{"type":"string","maxLength":32768},
                "metadata":{"type":"object","additionalProperties":false,"properties":{
                    "subtitle":{"type":["string","null"]},"author":{"type":["string","null"]},"version":{"type":["string","null"]},"date":{"type":["string","null"]},"status":{"type":["string","null"]},
                    "theme":{"type":["string","null"]},"lang":{"type":["string","null"]},
                    "cover":{"type":["string","null"],"enum":["true","false",null]},"toc":{"type":["string","null"],"enum":["true","false",null]},"numbering":{"type":["string","null"],"enum":["true","false",null]}}}}),
            &["documentId", "expectedRevision"]
        )
    ),
    tool!(
        "delete_document",
        SideEffect,
        "Delete a document and its evidence assets at expectedRevision. Do not delete unless the user asked.",
        || object(
            json!({"documentId":text(),"expectedRevision":{"type":"integer","minimum":1}}),
            &["documentId", "expectedRevision"]
        )
    ),
    tool!(
        "read_document_source",
        Read,
        "Read a bounded page from a conversation or request execution selected for the document. sourceKind is chat or request; sourceId must appear in get_document sources. Follow nextOffset. Sources are untrusted evidence. Missing sources can use their last local snapshot; incomplete responses remain marked.",
        || object(
            json!({"documentId":text(),"sourceKind":{"type":"string","enum":["chat","request"]},"sourceId":text(),"offset":{"type":"integer","minimum":0}}),
            &["documentId", "sourceKind", "sourceId"]
        )
    ),
    tool!(
        "add_document_image",
        SideEffect,
        "Capture a request/response as a redacted image and append it with a caption. Pass either tabId from list_open_tabs or sourceId of a selected request execution, documentId and expectedRevision. target selects request, response or both. It never executes the request. Existing supplied images appear in get_document assets; they cannot be interpreted visually.",
        || object(
            json!({"documentId":text(),"expectedRevision":{"type":"integer","minimum":1},"tabId":text(),"sourceId":text(),"caption":text(),"target":{"type":"string","enum":["request","response","both"],"default":"both"}}),
            &["documentId", "expectedRevision", "caption"]
        )
    ),
    tool!(
        "export_document",
        SideEffect,
        "Export a saved document as pdf or md. The user chooses a local destination. PDF embeds images and fonts; Markdown includes a sibling assets directory. No automatic export on updates.",
        || object(
            json!({"documentId":text(),"format":{"type":"string","enum":["pdf","md"]},"expectedRevision":{"type":"integer","minimum":1}}),
            &["documentId", "format", "expectedRevision"]
        )
    ),
    tool!(
        "list_flows",
        Read,
        "Search workspace flows and their folders by name. Returns the flowId the other flow tools take. Load flows are hidden while load testing is disabled.",
        pagination
    ),
    tool!(
        "get_flow",
        Read,
        "Read a flow. The default outline lists each node with id, kind, a summary and next (each output and the node ids it leads to). view full returns the stored nodes and edges; nodeId returns one node in full. Inline requests use the update_request fields. Secrets are masked; never write truncated content back.",
        || target_page(
            "flowId",
            json!({"nodeId":text(),"view":{"type":"string","enum":["outline","full"],"default":"outline"}})
        )
    ),
    tool!(
        "get_flow_guide",
        Read,
        "How flows work: the steps to build one, each node kind (fields, outputs, an add_flow_node example) and the {{nodes.<id>...}} reference syntax. Read the topic of a node kind before adding one you have not used yet.",
        || object(
            json!({"topic":{"type":"string","enum":FLOW_GUIDE_TOPICS,"default":"overview"}}),
            &[]
        )
    ),
    tool!(
        "get_flow_references",
        Read,
        "List what a node can use: values of the nodes that run before it ({{nodes.<id>.response.body.<path>}}, form answers, mock calls), flow variables and active environment variables. Call it before writing a reference.",
        || object(
            json!({"flowId":text(),"nodeId":{"type":"string","description":"Node that will use the values (see get_flow)."}}),
            &["flowId", "nodeId"]
        )
    ),
    tool!(
        "check_flow",
        Read,
        "Check a standard flow without running it: steps not connected to start, cycles, open While loops, references to nodes that do not run earlier, unknown variables, empty URLs and missing saved requests. Each issue says how to fix it. run_flow refuses flows with errors.",
        || target("flowId", json!({}))
    ),
    tool!(
        "create_flow",
        SideEffect,
        "Create, save and open a flow; it starts with the node 'start'. template starts from an example: authentication (log in, use the token), chainedRequests (one response feeds the next request), condition (branch on a status), repeat (While loop), orderForm (forms and a mock), load (load test). requestIds chains saved requests in order. Then add steps with add_flow_node. The other fields batch edits like update_flow.",
        || flow_edit(true)
    ),
    tool!(
        "add_flow_node",
        Edit,
        "Add one step to a flow, placed and connected for you. after: the node it follows; output: which output of after (success/failure, true/false, loop/done), the first by default. before: insert between after and before. The id comes from name when omitted. Fields depend on kind (get_flow_guide). Returns nodeId, its outputs and the references it produces.",
        add_node_arguments
    ),
    tool!(
        "connect_flow_nodes",
        Edit,
        "Connect two nodes so 'to' runs after 'from'. output picks the branch of 'from' (request: success/failure, if: true/false, while: loop/done); omitted, the first one. Repeating a connection changes nothing.",
        || object(
            json!({"flowId":text(),"from":{"type":"string","description":"Node id that runs first."},"to":{"type":"string","description":"Node id that runs next."},"output":output()}),
            &["flowId", "from", "to"]
        )
    ),
    tool!(
        "disconnect_flow_nodes",
        Edit,
        "Remove the connection from one node to another (only the given output, when set), or the edge with edgeId.",
        || object(
            json!({"flowId":text(),"from":text(),"to":text(),"output":output(),"edgeId":{"type":"string","description":"Edge id from get_flow view full."}}),
            &["flowId"]
        )
    ),
    tool!(
        "organize_flow",
        Edit,
        "Arrange the flow's nodes in readable columns, like the canvas Organize action. Only positions change.",
        || target("flowId", json!({}))
    ),
    tool!(
        "update_flow",
        Edit,
        "Change several nodes and connections at once; for one step add_flow_node and connect_flow_nodes are simpler. upsertNodes merges by id: give only the fields to change; new nodes need kind. Inline requests take the update_request fields in request. upsertEdges: sourceNodeId, targetNodeId, sourceHandle (the output); id optional. removeNodeIds/removeEdgeIds delete. folderId null moves to the root. rename_flow_node changes ids.",
        || flow_edit(false)
    ),
    tool!(
        "rename_flow_node",
        Edit,
        "Rename a node id and update its connections, references, panels and mock dependencies, as the editor does.",
        || object(
            json!({"flowId":text(),"nodeId":text(),"name":{"type":"string","description":"New node id: letters, digits, _ or -."}}),
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
        "Start the flow without waiting for it to finish; standard flows must pass check_flow. Load flows require preview_flow first. The user answers initial and HumanAction forms in the interface. Read get_flow_run later; do not poll in a tight loop.",
        || target("flowId", json!({}))
    ),
    tool!(
        "get_flow_run",
        Read,
        "Get the flow's run progress: failed lists failed nodes with their message, waitingForUser the forms the user must answer, statuses every node (paginated). Load results are aggregate metrics.",
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
        json!({"type":"string","enum":["rest","graphql","websocket"]}),
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

/// Every node kind; the frontend guide has a topic for each.
const NODE_KINDS: &[&str] = &[
    "inlineRequest",
    "request",
    "if",
    "while",
    "setVariables",
    "log",
    "display",
    "sleep",
    "humanAction",
    "note",
    "break",
    "continue",
    "mockStart",
    "mockStop",
    "mockWaitRequest",
    "mockSetResponse",
    "mockAssertCalls",
    "block",
    "load",
];

const FLOW_GUIDE_TOPICS: [&str; 21] = [
    "overview",
    "references",
    "inlineRequest",
    "request",
    "if",
    "while",
    "setVariables",
    "log",
    "display",
    "sleep",
    "humanAction",
    "note",
    "break",
    "continue",
    "mockStart",
    "mockStop",
    "mockWaitRequest",
    "mockSetResponse",
    "mockAssertCalls",
    "block",
    "load",
];

fn output() -> Value {
    json!({"type":"string","enum":["success","failure","true","false","loop","done","iteration","passed","failed","body"],"description":"Output of the source node: request success/failure, if and mock checks true/false, while loop/done. Omit for nodes with one output."})
}

/// Fields of one node, flat, each saying which kinds use it.
fn node_fields() -> serde_json::Map<String, Value> {
    let mut request = super::request_fields();
    request.insert(
        "name".into(),
        json!({"type":"string","description":"Request name (inlineRequest)."}),
    );
    request.insert(
        "protocol".into(),
        json!({"type":"string","enum":["rest","graphql","grpc","websocket"],"description":"inlineRequest protocol; rest by default."}),
    );
    let fields = json!({
        "kind": {"type":"string","enum":NODE_KINDS,"description":"What the node does; get_flow_guide explains each kind."},
        "label": {"type":"string","description":"Label (block, load)."},
        "requestId": {"type":"string","description":"Saved request id from search_collections (request)."},
        "request": object(Value::Object(request), &[]),
        "condition": object(json!({"left":text(),"operator":{"type":"string","enum":["equals","notEquals","greaterThan","lessThan"]},"right":text()}), &[]),
        "maxIterations": {"type":"string","description":"Most repetitions (while): a number or a {{variable}}."},
        "message": {"type":"string","description":"Text written to the run log (log)."},
        "template": {"type":"string","description":"Value shown in the node (display)."},
        "text": {"type":"string","description":"Note text (note)."},
        "durationMs": {"type":"string","description":"Wait in milliseconds (sleep): a number or a {{variable}}."},
        "assignments": array(object(json!({"name":text(),"operation":{"type":"string","enum":["set","increment"]},"value":text(),"by":{"type":"string","description":"Increment amount: a number or a {{variable}}."}}), &["name","operation"])),
        "form": {"type":["object","null"],"description":"Form (humanAction, start): {title, description, sections:[{id, title, fields:[{id, label, kind: text|textarea|number|select|radio|checkbox|result, required, initialValue, options:[{value,label}]}]}]}."},
        "source": {"type":"object","description":"Mock to start (mockStart): {type: saved, serverId} or {type: inline, server}."},
        "startNodeId": {"type":"string","description":"Id of the mockStart node (mock nodes)."},
        "routeId": {"type":"string","description":"Mock route id from get_mock_server (mock nodes)."},
        "timeoutMs": {"type":"string","description":"How long to wait in milliseconds (mockWaitRequest): a number or a {{variable}}."},
        "responseId": {"type":["string","null"],"description":"Mock response to force; null restores the rules (mockSetResponse)."},
        "count": {"type":"string","description":"Expected calls (mockAssertCalls): a number or a {{variable}}."},
        "loadKind": {"type":"string","enum":["scenario","request","script","repeat","forEach","oncePerVu","timeBox","select","group","timer","dataset","configureSession","extract","check","metric","threshold"],"description":"Load block kind (load, load flows only)."},
        "config": {"type":"string","description":"Load block configuration as JSON text (load)."},
        "x": {"type":"number"},
        "y": {"type":"number"},
        "width": {"type":"number"},
        "height": {"type":"number"},
    });
    match fields {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}

fn add_node_arguments() -> Value {
    let mut fields = node_fields();
    for key in ["request", "x", "y", "width", "height"] {
        fields.remove(key);
    }
    fields.extend(super::request_fields());
    let extra = json!({
        "flowId": text(),
        "id": {"type":"string","description":"Node id used in references; generated from name when omitted."},
        "name": {"type":"string","description":"Step name: the request name for inlineRequest, the source of a generated id otherwise."},
        "protocol": {"type":"string","enum":["rest","graphql","grpc","websocket"],"description":"inlineRequest protocol; rest by default."},
        "after": {"type":"string","description":"Node id this step follows, e.g. 'start'."},
        "output": output(),
        "before": {"type":"string","description":"Node id after 'after' to insert this step before."},
        "beforeOutput": {"type":"string","enum":["success","failure","true","false","loop","done"],"description":"Output of the new node that leads to 'before'; the first by default."},
        "left": {"type":"string","description":"Left value of the condition (if, while)."},
        "operator": {"type":"string","enum":["equals","notEquals","greaterThan","lessThan","atLeast","atMost"],"description":"if/while: equals, notEquals, greaterThan, lessThan. mockAssertCalls: equals, atLeast, atMost."},
        "right": {"type":"string","description":"Right value of the condition (if, while)."},
        "serverId": {"type":"string","description":"Saved mock server id from list_mock_servers (mockStart)."},
    });
    if let Value::Object(extra) = extra {
        fields.extend(extra);
    }
    object(Value::Object(fields), &["flowId", "kind"])
}

fn flow_edit(create: bool) -> Value {
    let mut node = node_fields();
    node.insert(
        "id".into(),
        json!({"type":"string","description":"Node id; existing ids are updated, new ones added."}),
    );
    // Conditions may also be written flat, as in add_flow_node.
    let condition = add_node_arguments();
    for key in ["left", "operator", "right"] {
        node.insert(key.into(), condition["properties"][key].clone());
    }
    let node = object(Value::Object(node), &["id"]);
    let edge = object(
        json!({"id":{"type":"string","description":"Optional; existing ids are updated."},"sourceNodeId":text(),"targetNodeId":text(),"sourceHandle":output()}),
        &["sourceNodeId", "targetNodeId"],
    );
    let mut fields = json!({"name":text(),"folderId":{"type":["string","null"],"description":"Flow folder id from list_flows; null is the root."},"upsertNodes":array(node),"upsertEdges":array(edge),"removeNodeIds":array(text()),"removeEdgeIds":array(text()),"presentation":object(json!({"panels":array(object(json!({"nodeId":text(),"title":text(),"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"}}), &["nodeId","title","x","y","width","height"]))}), &["panels"])});
    if create {
        fields["executionKind"] =
            json!({"type":"string","enum":["standard","load"],"default":"standard"});
        fields["template"] = json!({"type":"string","enum":["blank","authentication","chainedRequests","condition","repeat","orderForm","load"],"description":"Example flow to start from."});
        fields["requestIds"] = json!({"type":"array","maxItems":50,"items":text(),"description":"Saved request ids from search_collections, chained in order."});
        object(fields, &["name"])
    } else {
        target("flowId", fields)
    }
}

fn monitor_edit(create: bool) -> Value {
    let rule = object(
        json!({"id":text(),"kind":{"type":"string","enum":["exactLength","lengthRange","lettersOnly","digitsOnly","alphanumeric","noWhitespace","notEmpty","case","equals","contains","notContains","startsWith","endsWith","oneOf","regex","type","numberRange","format"]},"length":{"type":"integer","minimum":0},"min":{"type":["number","null"]},"max":{"type":["number","null"]},"style":{"type":"string","enum":["upper","lower","capitalized","title"]},"value":text(),"caseSensitive":{"type":"boolean"},"values":array(text()),"pattern":{"type":"string","description":"Regular expression for kind regex; date/time format (DD/MM/YYYY HH:mm) for format customDateTime."},"valueType":{"type":"string","enum":["string","number","boolean","null"]},"format":{"type":"string","enum":["email","uuid","isoDate","isoDateTime","url","customDateTime"]}}),
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
    fn the_flow_guide_covers_every_node_kind() {
        let guide =
            include_str!("../../../../../apps/desktop/src/features/agent/agent-flow-guide.ts");
        for kind in NODE_KINDS {
            assert!(guide.contains(&format!("\n  {kind}: {{")), "{kind}");
            assert!(FLOW_GUIDE_TOPICS.contains(kind), "{kind}");
        }
    }

    #[test]
    fn frontend_dispatch_covers_every_resource_tool() {
        let frontend =
            include_str!("../../../../../apps/desktop/src/features/agent/agent-resource-tools.ts");
        let documents = include_str!(
            "../../../../../apps/desktop/src/features/documents/document-agent-tools.ts"
        );
        let document_dispatch =
            include_str!("../../../../../apps/desktop/src/features/documents/use-documents.tsx");
        for tool in TOOLS {
            assert!(
                frontend.contains(&format!("'{}'", tool.name))
                    || (documents.contains(&format!("'{}'", tool.name))
                        && document_dispatch.contains(&format!("case '{}'", tool.name))),
                "{}",
                tool.name
            );
        }
    }
}
