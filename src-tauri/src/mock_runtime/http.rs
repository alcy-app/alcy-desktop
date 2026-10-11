//! HTTP/1 mínimo do mock server: leitura da requisição, escolha da resposta
//! pelas rotas e regras, e escrita da resposta.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use alcy_domain::{
    HttpMethod, MockCondition, MockConditionGroup, MockConditionOperator, MockConditionSource,
    MockMatchOperator, MockResponse, MockServer,
};

#[derive(Default)]
pub(super) struct HttpRequest {
    pub method: String,
    pub path: String,
    /// Na ordem em que chegaram — a captura para flows preserva a ordem.
    pub query: Vec<(String, String)>,
    /// Nomes em minúsculas.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    fn query(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Clone, Default)]
pub(super) struct HttpResponse {
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub delay_ms: u64,
}

impl HttpResponse {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn text(value: &str) -> Self {
        Self {
            headers: vec![("content-type".into(), "text/plain; charset=utf-8".into())],
            body: value.into(),
            delay_ms: 0,
        }
    }
}

/// Resposta escolhida para uma requisição, com a rota que a atendeu.
pub(super) struct Selection {
    pub status: u16,
    pub route_id: Option<String>,
    pub route_name: Option<String>,
    pub response_name: Option<String>,
    pub path_params: Vec<(String, String)>,
    pub response: HttpResponse,
}

impl Selection {
    pub fn unmatched(status: u16, response: HttpResponse) -> Self {
        Self {
            status,
            route_id: None,
            route_name: None,
            response_name: None,
            path_params: Vec::new(),
            response,
        }
    }
}

pub(super) fn read_request(stream: &mut TcpStream) -> Option<Option<HttpRequest>> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    while bytes.len() <= alcy_domain::MAX_MOCK_BODY_BYTES + 16 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(header_end) = find_headers_end(&bytes) {
                    let length = content_length(&bytes[..header_end]);
                    if bytes.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            Err(_) => return None,
        }
    }
    Some(parse_request(&bytes))
}

fn find_headers_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &[u8]) -> usize {
    std::str::from_utf8(headers)
        .ok()
        .and_then(|headers| {
            headers.lines().find_map(|line| {
                line.strip_prefix("Content-Length:")
                    .or_else(|| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse().ok())
            })
        })
        .unwrap_or(0)
}

pub(super) fn parse_request(bytes: &[u8]) -> Option<HttpRequest> {
    let end = find_headers_end(bytes)?;
    let text = std::str::from_utf8(&bytes[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?;
    let (path, query) = target
        .split_once('?')
        .map_or((target, ""), |(path, query)| (path, query));
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            match headers.iter_mut().find(|(key, _)| *key == name) {
                Some(existing) => existing.1 = value,
                None => headers.push((name, value)),
            }
        }
    }
    let query = query
        .split('&')
        .filter_map(|pair| {
            pair.split_once('=')
                .map(|(name, value)| (url_decode(name), url_decode(value)))
        })
        .collect();
    Some(HttpRequest {
        method,
        path: path.into(),
        query,
        headers,
        body: bytes[end + 4..].to_vec(),
    })
}

fn url_decode(value: &str) -> String {
    value
        .replace('+', " ")
        .split('%')
        .enumerate()
        .fold(String::new(), |mut out, (index, part)| {
            if index == 0 {
                out.push_str(part);
            } else if part.len() >= 2 {
                if let Ok(byte) = u8::from_str_radix(&part[..2], 16) {
                    out.push(byte as char);
                    out.push_str(&part[2..]);
                } else {
                    out.push('%');
                    out.push_str(part);
                }
            } else {
                out.push('%');
                out.push_str(part);
            }
            out
        })
}

/// Primeira rota habilitada que casa método e caminho. Uma resposta forçada
/// por um flow (`overrides`, spec 0121) vence as regras; senão vale a primeira
/// alternativa cuja regra passa, ou a resposta padrão.
pub(super) fn select_response(
    config: &MockServer,
    overrides: &HashMap<String, String>,
    request: &HttpRequest,
) -> Selection {
    for route in config
        .routes
        .iter()
        .filter(|route| route.enabled && method_to(route.method) == request.method)
    {
        if let Some(params) = match_path(&route.path, &request.path) {
            let forced = overrides.get(&route.id).and_then(|response_id| {
                std::iter::once(&route.default_response)
                    .chain(&route.alternatives)
                    .find(|response| response.id == *response_id)
            });
            let selected = forced.unwrap_or_else(|| {
                route
                    .alternatives
                    .iter()
                    .find(|candidate| {
                        candidate.enabled
                            && candidate.condition.as_ref().is_some_and(|condition| {
                                // Sem regras, a resposta condicional nunca substitui a padrão.
                                !condition.conditions.is_empty()
                                    && matches_condition(condition, &params, request)
                            })
                    })
                    .unwrap_or(&route.default_response)
            });
            return Selection {
                status: selected.status,
                route_id: Some(route.id.clone()),
                route_name: Some(route.name.clone()),
                response_name: Some(selected.name.clone()),
                path_params: params,
                response: http_response(selected),
            };
        }
    }
    Selection::unmatched(404, HttpResponse::text("rota não encontrada"))
}

fn http_response(selected: &MockResponse) -> HttpResponse {
    HttpResponse {
        headers: selected.headers.clone(),
        body: selected.body.clone(),
        delay_ms: selected.delay_ms,
    }
}

pub(super) fn match_path(pattern: &str, actual: &str) -> Option<Vec<(String, String)>> {
    let pattern: Vec<_> = pattern
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let actual: Vec<_> = actual
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if pattern.len() != actual.len() {
        return None;
    }
    let mut parameters = Vec::new();
    for (pattern, actual) in pattern.into_iter().zip(actual) {
        if let Some(name) = pattern.strip_prefix(':') {
            parameters.push((name.to_string(), actual.to_string()));
        } else if pattern != actual {
            return None;
        }
    }
    Some(parameters)
}

pub(super) fn matches_condition(
    group: &MockConditionGroup,
    params: &[(String, String)],
    request: &HttpRequest,
) -> bool {
    let test = |condition: &MockCondition| match condition {
        MockCondition::Group(child) => matches_condition(child, params, request),
        MockCondition::Match {
            source,
            key,
            operator,
            value,
        } => {
            let actual = match source {
                MockConditionSource::PathParameter => params
                    .iter()
                    .find(|(name, _)| name == key)
                    .map(|(_, value)| value.clone()),
                MockConditionSource::Query => request.query(key).map(str::to_string),
                MockConditionSource::Header => request.header(key).map(str::to_string),
                MockConditionSource::BodyText => String::from_utf8(request.body.clone()).ok(),
                MockConditionSource::JsonPointer => {
                    serde_json::from_slice::<serde_json::Value>(&request.body)
                        .ok()
                        .and_then(|value| value.pointer(&json_pointer(key)).map(json_text))
                }
            };
            match operator {
                MockMatchOperator::Exists => actual.is_some(),
                MockMatchOperator::NotExists => actual.is_none(),
                MockMatchOperator::Equals => actual.as_deref() == Some(value),
                MockMatchOperator::NotEquals => actual.is_some_and(|actual| actual != *value),
                MockMatchOperator::Contains => actual.is_some_and(|actual| actual.contains(value)),
            }
        }
    };
    match group.operator {
        MockConditionOperator::All => group.conditions.iter().all(test),
        MockConditionOperator::Any => group.conditions.iter().any(test),
    }
}

/// Aceita JSON Pointer (`/usuario/perfil`) ou caminho com pontos (`usuario.perfil`).
fn json_pointer(key: &str) -> String {
    if key.is_empty() || key.starts_with('/') {
        key.to_string()
    } else {
        format!("/{}", key.replace('.', "/"))
    }
}

/// Strings são comparadas sem as aspas do JSON; os demais valores pela forma serializada.
fn json_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

pub(super) fn write_response(
    stream: &mut TcpStream,
    status: u16,
    response: &HttpResponse,
    cors: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Mock Response",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.body.len()
    )?;
    for (name, value) in &response.headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    if cors {
        write!(
            stream,
            "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n"
        )?;
    }
    write!(stream, "\r\n{}", response.body)
}

pub(crate) fn method_to(value: HttpMethod) -> &'static str {
    match value {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Put => "PUT",
        HttpMethod::Patch => "PATCH",
        HttpMethod::Delete => "DELETE",
        HttpMethod::Head => "HEAD",
        HttpMethod::Options => "OPTIONS",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::MockRoute;

    #[test]
    fn matches_literal_and_parameterized_paths() {
        assert_eq!(
            match_path("/users/:id", "/users/42").unwrap(),
            vec![("id".to_string(), "42".to_string())]
        );
        assert!(match_path("/users/:id", "/users").is_none());
        assert!(match_path("/users", "/Users").is_none());
    }

    #[test]
    fn evaluates_nested_conditions() {
        let request = HttpRequest {
            method: "GET".to_string(),
            path: "/".to_string(),
            query: vec![("page".to_string(), "1".to_string())],
            headers: Vec::new(),
            body: Vec::new(),
        };
        let condition = MockConditionGroup {
            operator: MockConditionOperator::All,
            conditions: vec![MockCondition::Group(MockConditionGroup {
                operator: MockConditionOperator::Any,
                conditions: vec![MockCondition::Match {
                    source: MockConditionSource::Query,
                    key: "page".to_string(),
                    operator: MockMatchOperator::Equals,
                    value: "1".to_string(),
                }],
            })],
        };
        assert!(matches_condition(&condition, &[], &request));
    }

    fn json_request(body: &str) -> HttpRequest {
        HttpRequest {
            method: "POST".to_string(),
            path: "/".to_string(),
            query: Vec::new(),
            headers: Vec::new(),
            body: body.as_bytes().to_vec(),
        }
    }

    fn json_rule(key: &str, value: &str) -> MockConditionGroup {
        MockConditionGroup {
            operator: MockConditionOperator::All,
            conditions: vec![MockCondition::Match {
                source: MockConditionSource::JsonPointer,
                key: key.to_string(),
                operator: MockMatchOperator::Equals,
                value: value.to_string(),
            }],
        }
    }

    #[test]
    fn compares_json_fields_by_pointer_or_dotted_path_without_quotes() {
        let request = json_request(r#"{"user":{"role":"admin","age":30}}"#);
        assert!(matches_condition(
            &json_rule("/user/role", "admin"),
            &[],
            &request
        ));
        assert!(matches_condition(
            &json_rule("user.role", "admin"),
            &[],
            &request
        ));
        assert!(matches_condition(
            &json_rule("user.age", "30"),
            &[],
            &request
        ));
        assert!(!matches_condition(
            &json_rule("user.role", "\"admin\""),
            &[],
            &request
        ));
    }

    fn server_with_alternatives() -> MockServer {
        let response = |id: &str, condition: Option<MockConditionGroup>| MockResponse {
            id: id.to_string(),
            name: id.to_string(),
            enabled: true,
            status: 200,
            headers: Vec::new(),
            body: String::new(),
            delay_ms: 0,
            condition,
        };
        let mut server = MockServer::new("server".to_string(), "Server".to_string(), 3001);
        server.routes.push(MockRoute {
            id: "route".to_string(),
            name: "Route".to_string(),
            enabled: true,
            method: HttpMethod::Post,
            path: "/".to_string(),
            default_response: response("default", None),
            alternatives: vec![
                response(
                    "empty",
                    Some(MockConditionGroup {
                        operator: MockConditionOperator::All,
                        conditions: Vec::new(),
                    }),
                ),
                response("admin", Some(json_rule("role", "admin"))),
            ],
        });
        server
    }

    #[test]
    fn ignores_conditional_responses_without_rules() {
        let server = server_with_alternatives();
        let selected = |body: &str| {
            select_response(&server, &HashMap::new(), &json_request(body)).response_name
        };
        assert_eq!(selected(r#"{"role":"guest"}"#).as_deref(), Some("default"));
        assert_eq!(selected(r#"{"role":"admin"}"#).as_deref(), Some("admin"));
    }

    #[test]
    fn a_forced_response_wins_over_the_rules() {
        let server = server_with_alternatives();
        let overrides = HashMap::from([("route".to_string(), "empty".to_string())]);
        let selection = select_response(&server, &overrides, &json_request(r#"{"role":"admin"}"#));
        assert_eq!(selection.response_name.as_deref(), Some("empty"));
        assert_eq!(selection.route_id.as_deref(), Some("route"));
    }
}
