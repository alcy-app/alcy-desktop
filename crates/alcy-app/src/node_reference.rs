use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use alcy_domain::Response;
use thiserror::Error;

use crate::json_path::{JsonPathError, evaluate_json_path};
use crate::mock_control::CapturedRequest;

/// Completed flow responses. References require real direct/transitive ancestry independently of timing. Mock nodes also record captured requests and server URLs.
#[derive(Debug, Default, Clone)]
pub struct NodeRunHistory {
    forms: HashMap<String, Arc<serde_json::Value>>,
    responses: HashMap<String, Arc<Response>>,
    requests: HashMap<String, Arc<CapturedRequest>>,
    server_urls: HashMap<String, String>,
}

impl NodeRunHistory {
    pub fn record_form(&mut self, node_id: String, values: crate::FormAnswers) {
        self.forms
            .insert(node_id, Arc::new(serde_json::Value::Object(values)));
    }
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, node_id: String, response: Response) {
        self.responses.insert(node_id, Arc::new(response));
    }

    pub fn get(&self, node_id: &str) -> Option<&Response> {
        self.responses.get(node_id).map(AsRef::as_ref)
    }

    pub fn record_request(&mut self, node_id: String, request: CapturedRequest) {
        self.requests.insert(node_id, Arc::new(request));
    }

    pub fn record_server_url(&mut self, node_id: String, url: String) {
        self.server_urls.insert(node_id, url);
    }

    pub(crate) fn request_body(&self, node_id: &str) -> Option<&str> {
        self.requests
            .get(node_id)
            .map(|request| request.body.as_str())
    }

    pub(crate) fn form_value(&self, node_id: &str) -> Option<&serde_json::Value> {
        self.forms.get(node_id).map(AsRef::as_ref)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NodeReferenceError {
    #[error(
        "referência de node malformada: '{0}' (esperado 'nodes.<id>.response.<campo>', 'nodes.<id>.request.<campo>' ou 'nodes.<id>.server.url')"
    )]
    MalformedReference(String),
    #[error(
        "resposta do node '{0}' não está disponível (ainda não executou, falhou, foi pulado, ou não é um node de requisição alcançável a partir deste)"
    )]
    ResponseUnavailable(String),
    #[error(
        "campo de resposta desconhecido em '{1}' para o node '{0}' (esperado status, body, headers, grpcStatus, messages ou closeCode)"
    )]
    UnknownField(String, String),
    #[error("'response.status' não aceita caminho adicional ('{1}')")]
    StatusHasNoPath(String, String),
    #[error("corpo da resposta do node '{0}' não é um JSON válido: {1}")]
    InvalidJsonBody(String, String),
    #[error("falha ao extrair caminho na resposta do node '{0}': {1}")]
    JsonPathFailed(String, JsonPathError),
    #[error("header '{1}' não encontrado na resposta do node '{0}'")]
    HeaderNotFound(String, String),
    #[error(
        "chamada do node '{0}' não está disponível (ainda não executou, não recebeu chamada, ou não é um node 'Aguardar chamada' alcançável a partir deste)"
    )]
    RequestUnavailable(String),
    #[error(
        "campo de chamada desconhecido em '{1}' para o node '{0}' (esperado method, path, body, headers, query ou params)"
    )]
    UnknownRequestField(String, String),
    #[error("'{1}' não encontrado na chamada recebida pelo node '{0}'")]
    RequestValueNotFound(String, String),
    #[error(
        "URL do mock do node '{0}' não está disponível (ainda não executou, falhou, ou não é um node 'Ligar mock' alcançável a partir deste)"
    )]
    ServerUnavailable(String),
}

/// The reserved nodes. prefix distinguishes node references from environment variables.
pub fn is_node_reference(name: &str) -> bool {
    name.starts_with("nodes.")
}

/// The received WebSocket messages as a JSON array, from the body the
/// executor writes: the message itself when there is one (parsed when it is
/// JSON), a JSON array when there are several (spec 0140).
fn websocket_messages(body: &str, received: u32) -> serde_json::Value {
    let parsed = |text: &str| {
        serde_json::from_str::<serde_json::Value>(text)
            .unwrap_or_else(|_| serde_json::Value::String(text.to_string()))
    };
    match received {
        0 => serde_json::json!([]),
        1 => serde_json::json!([parsed(body)]),
        _ => match serde_json::from_str::<serde_json::Value>(body) {
            Ok(array @ serde_json::Value::Array(_)) => array,
            _ => serde_json::json!([parsed(body)]),
        },
    }
}

/// Resolve ancestor response fields (status/body/headers/grpcStatus/messages/closeCode), captured request fields, or server.url. Require actual ancestry.
pub fn resolve_node_reference(
    name: &str,
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<String, NodeReferenceError> {
    let after_prefix = &name["nodes.".len()..];
    let (node_id, rest1) = after_prefix
        .split_once('.')
        .ok_or_else(|| NodeReferenceError::MalformedReference(name.to_string()))?;
    if let Some(path) = rest1.strip_prefix("form.") {
        if !ancestors.contains(node_id) {
            return Err(NodeReferenceError::ResponseUnavailable(node_id.into()));
        }
        let values = history
            .forms
            .get(node_id)
            .ok_or_else(|| NodeReferenceError::ResponseUnavailable(node_id.into()))?;
        let value = evaluate_json_path(values, path)
            .map_err(|e| NodeReferenceError::JsonPathFailed(node_id.into(), e))?;
        return Ok(stringify_extracted(value));
    }
    if let Some(rest2) = rest1.strip_prefix("request.") {
        return resolve_request_reference(name, node_id, rest2, history, ancestors);
    }
    if rest1 == "server.url" {
        if !ancestors.contains(node_id) {
            return Err(NodeReferenceError::ServerUnavailable(node_id.to_string()));
        }
        return history
            .server_urls
            .get(node_id)
            .cloned()
            .ok_or_else(|| NodeReferenceError::ServerUnavailable(node_id.to_string()));
    }
    let rest2 = rest1
        .strip_prefix("response.")
        .ok_or_else(|| NodeReferenceError::MalformedReference(name.to_string()))?;
    let (field, path_rest) = match rest2.split_once('.') {
        Some((field, tail)) => (field, Some(tail)),
        None => (rest2, None),
    };

    if !ancestors.contains(node_id) {
        return Err(NodeReferenceError::ResponseUnavailable(node_id.to_string()));
    }
    let response = history
        .get(node_id)
        .ok_or_else(|| NodeReferenceError::ResponseUnavailable(node_id.to_string()))?;

    match field {
        "status" => {
            if let Some(tail) = path_rest {
                return Err(NodeReferenceError::StatusHasNoPath(
                    node_id.to_string(),
                    tail.to_string(),
                ));
            }
            Ok(response.status_code.to_string())
        }
        "closeCode" => {
            let websocket = response.websocket.as_ref().ok_or_else(|| {
                NodeReferenceError::UnknownField(node_id.to_string(), field.to_string())
            })?;
            if let Some(tail) = path_rest {
                return Err(NodeReferenceError::StatusHasNoPath(
                    node_id.to_string(),
                    tail.to_string(),
                ));
            }
            Ok(websocket
                .close_code
                .map(|code| code.to_string())
                .unwrap_or_default())
        }
        "messages" if response.websocket.is_some() => {
            let received = response
                .websocket
                .as_ref()
                .map(|websocket| websocket.received)
                .unwrap_or_default();
            let value = websocket_messages(&response.body, received);
            let extracted = evaluate_json_path(&value, path_rest.unwrap_or(""))
                .map_err(|error| NodeReferenceError::JsonPathFailed(node_id.to_string(), error))?;
            Ok(stringify_extracted(extracted))
        }
        "grpcStatus" | "messages" => {
            let grpc = response.grpc.as_ref().ok_or_else(|| {
                NodeReferenceError::UnknownField(node_id.to_string(), field.to_string())
            })?;
            let value = if field == "grpcStatus" {
                serde_json::json!({"code": grpc.code, "codeName": grpc.code_name, "message": grpc.message})
            } else {
                let body: serde_json::Value = if response.body.is_empty() {
                    serde_json::json!([])
                } else {
                    serde_json::from_str(&response.body).map_err(|error| {
                        NodeReferenceError::InvalidJsonBody(node_id.to_string(), error.to_string())
                    })?
                };
                match body {
                    serde_json::Value::Array(_) => body,
                    message => serde_json::json!([message]),
                }
            };
            let extracted = evaluate_json_path(&value, path_rest.unwrap_or(""))
                .map_err(|error| NodeReferenceError::JsonPathFailed(node_id.to_string(), error))?;
            Ok(stringify_extracted(extracted))
        }
        "body" => {
            let path = path_rest.unwrap_or("");
            if path.is_empty() {
                return Ok(response.body.clone());
            }
            let parsed: serde_json::Value =
                serde_json::from_str(&response.body).map_err(|error| {
                    NodeReferenceError::InvalidJsonBody(node_id.to_string(), error.to_string())
                })?;
            let extracted = evaluate_json_path(&parsed, path)
                .map_err(|error| NodeReferenceError::JsonPathFailed(node_id.to_string(), error))?;
            Ok(stringify_extracted(extracted))
        }
        "headers" => {
            let header_name = path_rest
                .filter(|segment| !segment.is_empty())
                .ok_or_else(|| NodeReferenceError::MalformedReference(name.to_string()))?;
            response
                .headers
                .iter()
                .find(|header| header.name.eq_ignore_ascii_case(header_name))
                .map(|header| header.value.clone())
                .ok_or_else(|| {
                    NodeReferenceError::HeaderNotFound(node_id.to_string(), header_name.to_string())
                })
        }
        other => Err(NodeReferenceError::UnknownField(
            node_id.to_string(),
            other.to_string(),
        )),
    }
}

fn resolve_request_reference(
    name: &str,
    node_id: &str,
    rest: &str,
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<String, NodeReferenceError> {
    let (field, path_rest) = match rest.split_once('.') {
        Some((field, tail)) => (field, Some(tail)),
        None => (rest, None),
    };
    if !ancestors.contains(node_id) {
        return Err(NodeReferenceError::RequestUnavailable(node_id.to_string()));
    }
    let request = history
        .requests
        .get(node_id)
        .ok_or_else(|| NodeReferenceError::RequestUnavailable(node_id.to_string()))?;

    let pairs = match field {
        "method" | "path" => {
            if path_rest.is_some() {
                return Err(NodeReferenceError::MalformedReference(name.to_string()));
            }
            let value = if field == "method" {
                &request.method
            } else {
                &request.path
            };
            return Ok(value.clone());
        }
        "body" => {
            let path = path_rest.unwrap_or("");
            if path.is_empty() {
                return Ok(request.body.clone());
            }
            let parsed: serde_json::Value =
                serde_json::from_str(&request.body).map_err(|error| {
                    NodeReferenceError::InvalidJsonBody(node_id.to_string(), error.to_string())
                })?;
            let extracted = evaluate_json_path(&parsed, path)
                .map_err(|error| NodeReferenceError::JsonPathFailed(node_id.to_string(), error))?;
            return Ok(stringify_extracted(extracted));
        }
        "headers" => &request.headers,
        "query" => &request.query,
        "params" => &request.path_params,
        other => {
            return Err(NodeReferenceError::UnknownRequestField(
                node_id.to_string(),
                other.to_string(),
            ));
        }
    };
    let key = path_rest
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| NodeReferenceError::MalformedReference(name.to_string()))?;
    let found = if field == "headers" {
        pairs
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
    } else {
        pairs.iter().find(|(name, _)| name == key)
    };
    found.map(|(_, value)| value.clone()).ok_or_else(|| {
        NodeReferenceError::RequestValueNotFound(node_id.to_string(), format!("{field}.{key}"))
    })
}

/// Extracted strings insert raw contents; other types insert compact JSON.
fn stringify_extracted(value: serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Response, ResponseHeader, ResponseMetadata};

    fn response_with_body(status_code: u16, body: &str) -> Response {
        Response::new(status_code, 12, body, vec![], ResponseMetadata::default())
    }

    fn history_with(node_id: &str, response: Response) -> NodeRunHistory {
        let mut history = NodeRunHistory::new();
        history.record(node_id.to_string(), response);
        history
    }

    fn ancestors_of(node_id: &str) -> HashSet<String> {
        HashSet::from([node_id.to_string()])
    }

    fn websocket_response(body: &str, received: u32) -> Response {
        let mut response = response_with_body(101, body);
        response.websocket = Some(Box::new(alcy_domain::WebSocketOutcome {
            close_code: Some(4001),
            close_reason: "bye".to_string(),
            closed_by: alcy_domain::WebSocketClosedBy::Server,
            subprotocol: None,
            sent: 1,
            received,
        }));
        response
    }

    #[test]
    fn resolves_websocket_messages_and_close_code() {
        let ancestors = ancestors_of("ws");
        let single_text = history_with("ws", websocket_response("pong", 1));
        assert_eq!(
            resolve_node_reference("nodes.ws.response.messages.0", &single_text, &ancestors)
                .unwrap(),
            "pong"
        );
        assert_eq!(
            resolve_node_reference("nodes.ws.response.closeCode", &single_text, &ancestors)
                .unwrap(),
            "4001"
        );

        let several = history_with("ws", websocket_response("[\n{\"id\":7},\n\"plain\"\n]", 2));
        assert_eq!(
            resolve_node_reference("nodes.ws.response.messages.0.id", &several, &ancestors)
                .unwrap(),
            "7"
        );
        assert_eq!(
            resolve_node_reference("nodes.ws.response.messages.1", &several, &ancestors).unwrap(),
            "plain"
        );

        let http = history_with("ws", response_with_body(200, "{}"));
        assert!(matches!(
            resolve_node_reference("nodes.ws.response.closeCode", &http, &ancestors),
            Err(NodeReferenceError::UnknownField(_, _))
        ));
    }

    #[test]
    fn detects_node_reference_names() {
        assert!(is_node_reference("nodes.req-a.response.status"));
        assert!(!is_node_reference("baseUrl"));
    }

    #[test]
    fn resolves_status() {
        let history = history_with("req-a", response_with_body(201, "{}"));

        let resolved = resolve_node_reference(
            "nodes.req-a.response.status",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap();

        assert_eq!(resolved, "201");
    }

    #[test]
    fn rejects_a_path_after_status() {
        let history = history_with("req-a", response_with_body(200, "{}"));

        let error = resolve_node_reference(
            "nodes.req-a.response.status.extra",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap_err();

        assert_eq!(
            error,
            NodeReferenceError::StatusHasNoPath("req-a".to_string(), "extra".to_string())
        );
    }

    #[test]
    fn resolves_the_raw_body_with_no_path() {
        let history = history_with("req-a", response_with_body(200, "{\"token\":\"abc\"}"));

        let resolved = resolve_node_reference(
            "nodes.req-a.response.body",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap();

        assert_eq!(resolved, "{\"token\":\"abc\"}");
    }

    #[test]
    fn resolves_a_json_path_inside_the_body() {
        let history = history_with(
            "req-a",
            response_with_body(200, "{\"data\":{\"token\":\"abc123\"}}"),
        );

        let resolved = resolve_node_reference(
            "nodes.req-a.response.body.data.token",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap();

        assert_eq!(resolved, "abc123");
    }

    #[test]
    fn fails_on_an_invalid_json_body() {
        let history = history_with("req-a", response_with_body(200, "not json"));

        let error = resolve_node_reference(
            "nodes.req-a.response.body.token",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap_err();

        assert!(
            matches!(error, NodeReferenceError::InvalidJsonBody(node_id, _) if node_id == "req-a")
        );
    }

    #[test]
    fn resolves_a_header_case_insensitively() {
        let response = Response::new(
            200,
            1,
            "{}",
            vec![ResponseHeader {
                name: "X-Auth-Token".to_string(),
                value: "secret".to_string(),
            }],
            ResponseMetadata::default(),
        );
        let history = history_with("req-a", response);

        let resolved = resolve_node_reference(
            "nodes.req-a.response.headers.x-auth-token",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap();

        assert_eq!(resolved, "secret");
    }

    #[test]
    fn fails_on_a_missing_header() {
        let history = history_with("req-a", response_with_body(200, "{}"));

        let error = resolve_node_reference(
            "nodes.req-a.response.headers.Missing",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap_err();

        assert_eq!(
            error,
            NodeReferenceError::HeaderNotFound("req-a".to_string(), "Missing".to_string())
        );
    }

    #[test]
    fn fails_on_an_unknown_field() {
        let history = history_with("req-a", response_with_body(200, "{}"));

        let error = resolve_node_reference(
            "nodes.req-a.response.duration",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap_err();

        assert_eq!(
            error,
            NodeReferenceError::UnknownField("req-a".to_string(), "duration".to_string())
        );
    }

    #[test]
    fn fails_when_the_referenced_node_has_no_response_yet() {
        let history = NodeRunHistory::new();

        let error = resolve_node_reference(
            "nodes.req-a.response.status",
            &history,
            &ancestors_of("req-a"),
        )
        .unwrap_err();

        assert_eq!(
            error,
            NodeReferenceError::ResponseUnavailable("req-a".to_string())
        );
    }

    #[test]
    fn fails_on_a_malformed_reference_missing_the_response_segment() {
        let history = NodeRunHistory::new();

        let error = resolve_node_reference("nodes.req-a.status", &history, &ancestors_of("req-a"))
            .unwrap_err();

        assert_eq!(
            error,
            NodeReferenceError::MalformedReference("nodes.req-a.status".to_string())
        );
    }

    #[test]
    fn fails_when_the_referenced_node_is_not_a_real_predecessor_even_though_its_response_is_recorded()
     {
        // An available response without a real ancestor edge must fail regardless of timing.
        let history = history_with("req-a", response_with_body(200, "{\"token\":\"abc\"}"));
        let ancestors = HashSet::new();

        let error = resolve_node_reference("nodes.req-a.response.status", &history, &ancestors)
            .unwrap_err();

        assert_eq!(
            error,
            NodeReferenceError::ResponseUnavailable("req-a".to_string())
        );
    }

    fn captured(body: &str) -> CapturedRequest {
        CapturedRequest {
            seq: 1,
            route_id: "route-1".to_string(),
            method: "POST".to_string(),
            path: "/users/42".to_string(),
            query: vec![("page".to_string(), "2".to_string())],
            headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            path_params: vec![("id".to_string(), "42".to_string())],
            body: body.to_string(),
        }
    }

    #[test]
    fn resolves_fields_of_a_captured_request() {
        let mut history = NodeRunHistory::new();
        history.record_request("wait-1".to_string(), captured(r#"{"name":"Ana"}"#));
        let ancestors = ancestors_of("wait-1");
        let resolve = |name: &str| resolve_node_reference(name, &history, &ancestors);

        assert_eq!(resolve("nodes.wait-1.request.method").unwrap(), "POST");
        assert_eq!(resolve("nodes.wait-1.request.path").unwrap(), "/users/42");
        assert_eq!(resolve("nodes.wait-1.request.body.name").unwrap(), "Ana");
        assert_eq!(
            resolve("nodes.wait-1.request.headers.content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resolve("nodes.wait-1.request.query.page").unwrap(), "2");
        assert_eq!(resolve("nodes.wait-1.request.params.id").unwrap(), "42");
        assert_eq!(
            resolve("nodes.wait-1.request.query.missing").unwrap_err(),
            NodeReferenceError::RequestValueNotFound(
                "wait-1".to_string(),
                "query.missing".to_string()
            )
        );
    }

    #[test]
    fn resolves_the_url_of_a_started_mock_only_for_descendants() {
        let mut history = NodeRunHistory::new();
        history.record_server_url("mock-1".to_string(), "http://127.0.0.1:3001".to_string());

        assert_eq!(
            resolve_node_reference("nodes.mock-1.server.url", &history, &ancestors_of("mock-1"))
                .unwrap(),
            "http://127.0.0.1:3001"
        );
        assert_eq!(
            resolve_node_reference("nodes.mock-1.server.url", &history, &HashSet::new())
                .unwrap_err(),
            NodeReferenceError::ServerUnavailable("mock-1".to_string())
        );
    }
}
