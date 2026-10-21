use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use alcy_app::CapturedRequest;
use alcy_domain::{BodyEncoding, Response};
use alcy_storage::FlowBodyCapture;
use serde::{Deserialize, Serialize};

use crate::commands::execute_graphql_request::{ResponseBodyEncodingOutput, ResponseHeaderOutput};
use crate::commands::response_body_cache::char_boundary_window;

/// Bound the legacy per-node preview while preserving the true response size in size_bytes. Larger bodies are available through the separate archive inspector.
pub const MAX_STORED_BODY_BYTES: usize = 256 * 1024;

/// Legacy request-output preview for the latest flow run.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeOutput {
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub headers: Vec<ResponseHeaderOutput>,
    pub body: String,
    pub body_encoding: ResponseBodyEncodingOutput,
    /// True when body contains only a prefix, or is omitted for binary data.
    pub truncated: bool,
    /// Captured Wait for call requests use their incoming headers and body; status and duration are zero (spec 0121).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestLineOutput>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLineOutput {
    pub method: String,
    pub path: String,
}

impl FlowNodeOutput {
    pub(crate) fn from_response(response: &Response) -> Self {
        let (body, truncated) = match response.encoding {
            // Partial base64 cannot be decoded into a useful preview.
            BodyEncoding::Base64 => (String::new(), response.size_bytes > 0),
            BodyEncoding::Text => {
                let (window, next) = char_boundary_window(&response.body, 0, MAX_STORED_BODY_BYTES);
                (window.to_string(), next.is_some())
            }
        };
        Self {
            status_code: response.status_code,
            duration_ms: response.duration_ms,
            size_bytes: response.size_bytes,
            headers: response
                .headers
                .iter()
                .cloned()
                .map(ResponseHeaderOutput::from)
                .collect(),
            body,
            body_encoding: response.encoding.into(),
            truncated,
            request: None,
        }
    }

    pub(crate) fn from_captured_request(request: &CapturedRequest) -> Self {
        let (window, next) = char_boundary_window(&request.body, 0, MAX_STORED_BODY_BYTES);
        Self {
            status_code: 0,
            duration_ms: 0,
            size_bytes: request.body.len(),
            headers: request
                .headers
                .iter()
                .map(|(name, value)| ResponseHeaderOutput {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
            body: window.to_string(),
            body_encoding: ResponseBodyEncodingOutput::Text,
            truncated: next.is_some(),
            request: Some(RequestLineOutput {
                method: request.method.clone(),
                path: request.path.clone(),
            }),
        }
    }
}

#[derive(Default)]
struct State {
    outputs: HashMap<String, FlowNodeOutput>,
    revisions: HashMap<String, u64>,
    archive: Option<FlowBodyCapture>,
}

/// The latest run's in-memory previews and body capture. Starting another run releases previous session-only data; archived history remains available separately.
#[derive(Default)]
pub struct FlowRunOutputs {
    state: Mutex<HashMap<String, State>>,
}

impl FlowRunOutputs {
    pub fn begin(&self, flow_execution_id: &str) {
        self.lock()
            .insert(flow_execution_id.into(), State::default());
    }

    pub fn release(&self, execution_id: &str) {
        self.lock().remove(execution_id);
    }

    pub fn attach_archive(&self, execution_id: &str, archive: FlowBodyCapture) {
        if let Some(state) = self.lock().get_mut(execution_id) {
            state.archive = Some(archive);
        }
    }

    pub fn archive(&self, execution_id: &str) -> Option<FlowBodyCapture> {
        self.lock()
            .get(execution_id)
            .and_then(|state| state.archive.clone())
    }

    pub fn store(
        &self,
        flow_execution_id: &str,
        node_id: &str,
        response: &Response,
    ) -> FlowNodeOutput {
        let preview = FlowNodeOutput::from_response(response);
        self.insert(flow_execution_id, node_id, preview.clone());
        preview
    }

    pub fn store_request(
        &self,
        flow_execution_id: &str,
        node_id: &str,
        request: &CapturedRequest,
    ) -> FlowNodeOutput {
        let preview = FlowNodeOutput::from_captured_request(request);
        self.insert(flow_execution_id, node_id, preview.clone());
        preview
    }

    fn insert(&self, flow_execution_id: &str, node_id: &str, output: FlowNodeOutput) {
        let mut states = self.lock();
        let Some(state) = states.get_mut(flow_execution_id) else {
            return;
        };
        if let Some(revision) = state
            .archive
            .as_ref()
            .and_then(|archive| archive.metadata(node_id))
            .map(|metadata| metadata.revision)
        {
            state.revisions.insert(node_id.into(), revision);
        }
        state.outputs.insert(node_id.to_string(), output);
    }

    pub fn snapshot(
        &self,
        execution_id: &str,
        node_id: &str,
    ) -> (Option<FlowNodeOutput>, Option<u64>) {
        let states = self.lock();
        let Some(state) = states.get(execution_id) else {
            return (None, None);
        };
        (
            state.outputs.get(node_id).cloned(),
            state.revisions.get(node_id).copied(),
        )
    }

    pub fn get(&self, flow_execution_id: &str, node_id: &str) -> Option<FlowNodeOutput> {
        self.lock()
            .get(flow_execution_id)
            .and_then(|state| state.outputs.get(node_id).cloned())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, State>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFlowNodeOutputInput {
    pub flow_execution_id: String,
    pub node_id: String,
}

/// Fetch a node preview separately from progress events; return None for a different run or a node without a response.
#[tauri::command]
pub fn get_flow_node_output(
    input: GetFlowNodeOutputInput,
    outputs: tauri::State<'_, FlowRunOutputs>,
) -> Option<FlowNodeOutput> {
    outputs.get(&input.flow_execution_id, &input.node_id)
}

/// Release session data only after its execution has ended.
#[tauri::command]
pub fn release_flow_run(
    flow_execution_id: String,
    outputs: tauri::State<'_, FlowRunOutputs>,
    registry: tauri::State<'_, super::flow_execution_registry::FlowExecutionRegistry>,
) -> Result<(), String> {
    if registry.is_running(&flow_execution_id) {
        return Err("runActive".into());
    }
    outputs.release(&flow_execution_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{ResponseHeader, ResponseMetadata};

    fn response(body: &str) -> Response {
        Response::new(
            200,
            5,
            body,
            vec![ResponseHeader {
                name: "content-type".to_string(),
                value: "application/json".to_string(),
            }],
            ResponseMetadata::default(),
        )
    }

    #[test]
    fn stores_and_returns_the_output_of_the_current_run() {
        let outputs = FlowRunOutputs::default();
        outputs.begin("run-1");
        outputs.store("run-1", "node-a", &response("{\"ok\":true}"));

        let output = outputs.get("run-1", "node-a").unwrap();

        assert_eq!(output.status_code, 200);
        assert_eq!(output.body, "{\"ok\":true}");
        assert!(!output.truncated);
        assert_eq!(output.headers[0].name, "content-type");
    }

    #[test]
    fn parallel_runs_keep_separate_outputs_until_released() {
        let outputs = FlowRunOutputs::default();
        outputs.begin("run-1");
        outputs.store("run-1", "node-a", &response("x"));

        outputs.begin("run-2");

        assert_eq!(outputs.get("run-1", "node-a").unwrap().body, "x");
        outputs.release("run-1");
        assert_eq!(outputs.get("run-1", "node-a"), None);
        assert_eq!(outputs.get("run-2", "node-a"), None);
    }

    #[test]
    fn ignores_stores_from_a_run_that_is_no_longer_current() {
        let outputs = FlowRunOutputs::default();
        outputs.begin("run-2");

        outputs.store("run-1", "node-a", &response("late"));

        assert_eq!(outputs.get("run-2", "node-a"), None);
    }

    #[test]
    fn truncates_a_large_body_but_keeps_the_real_size() {
        let outputs = FlowRunOutputs::default();
        outputs.begin("run-1");
        let big = "a".repeat(MAX_STORED_BODY_BYTES + 10);
        outputs.store("run-1", "node-a", &response(&big));

        let output = outputs.get("run-1", "node-a").unwrap();

        assert_eq!(output.body.len(), MAX_STORED_BODY_BYTES);
        assert!(output.truncated);
        assert_eq!(output.size_bytes, big.len());
    }
}
