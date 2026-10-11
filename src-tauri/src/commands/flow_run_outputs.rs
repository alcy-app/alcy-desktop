use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use alcy_app::CapturedRequest;
use alcy_domain::{BodyEncoding, Response};
use serde::{Deserialize, Serialize};

use crate::commands::execute_graphql_request::{ResponseBodyEncodingOutput, ResponseHeaderOutput};
use crate::commands::response_body_cache::char_boundary_window;

/// Teto do corpo retido por node: o log de um run só precisa mostrar o começo
/// da saída, e isso mantém a memória (e o payload de IPC sob demanda) limitados
/// mesmo para respostas de vários MB — o tamanho real segue em `size_bytes`.
pub const MAX_STORED_BODY_BYTES: usize = 256 * 1024;

/// Saída de um node de requisição no último run do flow.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeOutput {
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub headers: Vec<ResponseHeaderOutput>,
    pub body: String,
    pub body_encoding: ResponseBodyEncodingOutput,
    /// `true` quando `body` é só o começo do corpo (ou vazio, para binário).
    pub truncated: bool,
    /// Presente quando a saída é a chamada recebida por um node
    /// `MockWaitRequest` (spec 0121): `headers`/`body` são os da chamada e
    /// `status_code`/`duration_ms` ficam zerados.
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
            // Truncar base64 no meio não produz nada legível.
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
    flow_execution_id: Option<String>,
    outputs: HashMap<String, FlowNodeOutput>,
}

/// Saídas do **último** run de flow, em memória e sem persistência: começar um
/// run novo descarta as anteriores, então o custo fica limitado a um run.
#[derive(Default)]
pub struct FlowRunOutputs {
    state: Mutex<State>,
}

impl FlowRunOutputs {
    pub fn begin(&self, flow_execution_id: &str) {
        let mut state = self.lock();
        state.flow_execution_id = Some(flow_execution_id.to_string());
        state.outputs.clear();
    }

    pub fn store(&self, flow_execution_id: &str, node_id: &str, response: &Response) {
        self.insert(
            flow_execution_id,
            node_id,
            FlowNodeOutput::from_response(response),
        );
    }

    pub fn store_request(&self, flow_execution_id: &str, node_id: &str, request: &CapturedRequest) {
        self.insert(
            flow_execution_id,
            node_id,
            FlowNodeOutput::from_captured_request(request),
        );
    }

    fn insert(&self, flow_execution_id: &str, node_id: &str, output: FlowNodeOutput) {
        let mut state = self.lock();
        if state.flow_execution_id.as_deref() != Some(flow_execution_id) {
            return;
        }
        state.outputs.insert(node_id.to_string(), output);
    }

    pub fn get(&self, flow_execution_id: &str, node_id: &str) -> Option<FlowNodeOutput> {
        let state = self.lock();
        if state.flow_execution_id.as_deref() != Some(flow_execution_id) {
            return None;
        }
        state.outputs.get(node_id).cloned()
    }

    /// Todas as saídas do run informado (vazio se ele não é mais o atual).
    pub fn all(&self, flow_execution_id: &str) -> Vec<(String, FlowNodeOutput)> {
        let state = self.lock();
        if state.flow_execution_id.as_deref() != Some(flow_execution_id) {
            return Vec::new();
        }
        state
            .outputs
            .iter()
            .map(|(node_id, output)| (node_id.clone(), output.clone()))
            .collect()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
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

/// Saída de um node do último run, buscada sob demanda (o evento de progresso
/// não a carrega). `None` quando o run não é o mais recente ou o node não
/// produziu resposta.
#[tauri::command]
pub fn get_flow_node_output(
    input: GetFlowNodeOutputInput,
    outputs: tauri::State<'_, FlowRunOutputs>,
) -> Option<FlowNodeOutput> {
    outputs.get(&input.flow_execution_id, &input.node_id)
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
    fn a_new_run_discards_the_previous_outputs() {
        let outputs = FlowRunOutputs::default();
        outputs.begin("run-1");
        outputs.store("run-1", "node-a", &response("x"));

        outputs.begin("run-2");

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
