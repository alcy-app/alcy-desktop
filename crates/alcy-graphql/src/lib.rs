//! Adapter GraphQL: executa `Request` via HTTP usando `reqwest`.

mod graphql_error;
mod schema;

use std::time::{Duration, Instant};

use alcy_app::RequestExecutor;
use alcy_domain::{
    ConnectionInfo, Cookie, DEFAULT_REQUEST_TIMEOUT_SECONDS, ExecutionError, RedirectPolicy,
    Request, Response, ResponseHeader, ResponseMetadata, ResponseSizeLimit,
};
use alcy_http_auth::{ConfiguredResponseLimit, body_text, map_auth_error, read_response_body};
use alcy_http_proxy::{ProxyError, ProxyPlan, RequestClient, SharedHttpClient};
use reqwest::header::{HeaderMap, SET_COOKIE};
use serde_json::Value;

pub use graphql_error::{GraphqlError, GraphqlErrorLocation, interpret_graphql_errors};
pub use schema::{
    GraphqlDirective, GraphqlEnumValue, GraphqlField, GraphqlInputValue, GraphqlNamedType,
    GraphqlSchema, GraphqlTypeKind, SchemaError, introspection_request, parse_schema,
};

/// Vale até a preferência salva ser aplicada na abertura do app.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECONDS as u64);

pub struct ReqwestGraphqlExecutor {
    client: SharedHttpClient,
    response_limit: ConfiguredResponseLimit,
}

impl ReqwestGraphqlExecutor {
    pub fn new() -> Self {
        Self::with_timeout(DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            client: SharedHttpClient::new(timeout),
            response_limit: ConfiguredResponseLimit::default(),
        }
    }

    /// Passa a usar `limit` para o corpo das próximas respostas.
    pub fn set_response_size_limit(&self, limit: ResponseSizeLimit) {
        self.response_limit.set(limit);
    }

    /// Passa a usar `plan` (proxy) nas próximas requisições.
    pub fn reconfigure_proxy(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.client.reconfigure(plan)
    }

    /// Passa a usar `timeout` nas próximas requisições (`None` desabilita).
    pub fn set_timeout(&self, timeout: Option<Duration>) -> Result<(), ProxyError> {
        self.client.set_timeout(timeout)
    }

    pub fn set_custom_ca_certificates(&self, certificates: &[String]) -> Result<(), ProxyError> {
        self.client.set_custom_ca_certificates(certificates)
    }

    /// Liga ou desliga a verificação de certificado TLS nas próximas
    /// requisições (`true` aceita qualquer certificado).
    pub fn set_accept_invalid_certificates(&self, accept: bool) -> Result<(), ProxyError> {
        self.client.set_accept_invalid_certificates(accept)
    }
}

impl Default for ReqwestGraphqlExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestExecutor for ReqwestGraphqlExecutor {
    async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
        let variables = parse_variables(&request.variables)?;
        let body = serde_json::json!({
            "query": request.document.body,
            "variables": variables,
        });

        let RequestClient {
            client,
            accepts_invalid_certificates,
        } = self.client.get_for_request(RedirectPolicy::Follow).await;
        let mut http_request = client.post(request.endpoint.url()).json(&body);

        for header in request.headers.iter().filter(|header| header.enabled) {
            http_request = http_request.header(header.name(), header.value());
        }

        let requested_url = request.endpoint.url().to_string();
        let started_at = Instant::now();
        let exchange =
            alcy_http_auth::send_authenticated(&client, http_request, &request.authentication)
                .await
                .map_err(map_auth_error)?;
        let waiting_ms = started_at.elapsed().as_millis() as u64;
        let http_response = exchange.response;
        let status_code = http_response.status().as_u16();
        let headers = extract_headers(http_response.headers());
        let metadata = build_response_metadata(
            &http_response,
            &requested_url,
            exchange.request_headers,
            waiting_ms,
            accepts_invalid_certificates,
        );
        let limit = self.response_limit.for_request(request);
        let body = body_text(read_response_body(http_response, limit).await?);
        let duration_ms = started_at.elapsed().as_millis() as u64;

        Ok(Response::new(
            status_code,
            duration_ms,
            body,
            headers,
            metadata,
        ))
    }
}

/// Header com valor não-UTF-8 vira string vazia em vez de propagar erro —
/// raro (o valor já veio da rede) e não impede exibir os demais headers.
fn extract_headers(headers: &HeaderMap) -> Vec<ResponseHeader> {
    headers
        .iter()
        .map(|(name, value)| ResponseHeader {
            name: name.as_str().to_string(),
            value: value.to_str().unwrap_or_default().to_string(),
        })
        .collect()
}

/// Monta os dados de transporte que não são nem corpo nem headers de
/// resposta: headers efetivamente enviados, cookies (`Set-Cookie`
/// parseados), conexão (IP remoto, versão HTTP, presença de certificado
/// TLS) e a URL final quando a execução foi redirecionada.
fn build_response_metadata(
    response: &reqwest::Response,
    requested_url: &str,
    request_headers: Vec<(String, String)>,
    waiting_ms: u64,
    accepts_invalid_certificates: bool,
) -> ResponseMetadata {
    // Compara `Url` com `Url`, não string com string: `reqwest::Url` normaliza
    // (ex.: acrescenta "/" a uma URL sem path), então comparar o texto bruto
    // da URL pedida com `response.url().as_str()` acusaria "redirecionamento"
    // mesmo sem nenhum ter ocorrido.
    let final_url = match reqwest::Url::parse(requested_url) {
        Ok(parsed) if &parsed == response.url() => None,
        _ => Some(response.url().to_string()),
    };

    let tls_certificate_present = response
        .extensions()
        .get::<reqwest::tls::TlsInfo>()
        .is_some();
    let connection = ConnectionInfo {
        remote_address: response.remote_addr().map(|addr| addr.to_string()),
        http_version: format_http_version(response.version()),
        tls_certificate_present,
        certificate_verification_disabled: tls_certificate_present && accepts_invalid_certificates,
    };

    let cookies = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|raw| cookie::Cookie::parse(raw.to_string()).ok())
        .map(to_domain_cookie)
        .collect();

    ResponseMetadata {
        request_headers: request_headers
            .into_iter()
            .map(|(name, value)| ResponseHeader { name, value })
            .collect(),
        cookies,
        connection,
        final_url,
        waiting_ms,
    }
}

fn format_http_version(version: reqwest::Version) -> String {
    match version {
        reqwest::Version::HTTP_09 => "HTTP/0.9",
        reqwest::Version::HTTP_10 => "HTTP/1.0",
        reqwest::Version::HTTP_11 => "HTTP/1.1",
        reqwest::Version::HTTP_2 => "HTTP/2",
        reqwest::Version::HTTP_3 => "HTTP/3",
        _ => "desconhecida",
    }
    .to_string()
}

fn to_domain_cookie(parsed: cookie::Cookie<'_>) -> Cookie {
    let expires = match parsed.expires() {
        Some(cookie::Expiration::DateTime(datetime)) => Some(datetime.to_string()),
        _ => None,
    };

    Cookie {
        name: parsed.name().to_string(),
        value: parsed.value().to_string(),
        domain: parsed.domain().map(|domain| domain.to_string()),
        path: parsed.path().map(|path| path.to_string()),
        expires,
        max_age_seconds: parsed.max_age().map(|duration| duration.whole_seconds()),
        secure: parsed.secure().unwrap_or(false),
        http_only: parsed.http_only().unwrap_or(false),
        same_site: parsed.same_site().map(|same_site| same_site.to_string()),
    }
}

fn parse_variables(raw: &str) -> Result<Value, ExecutionError> {
    if raw.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(raw).map_err(|error| ExecutionError::InvalidVariables(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{
        Authentication, Endpoint, HeaderEntry, NetworkCause, ProtocolId, RequestDocument,
    };
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_request(endpoint_url: &str, variables: &str) -> Request {
        Request::new(
            Endpoint::new(endpoint_url).unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            variables,
            vec![HeaderEntry::new("X-Test", "1", true).unwrap()],
            Authentication::None,
        )
    }

    #[tokio::test]
    async fn returns_a_response_on_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"data\":{\"ping\":true}}"))
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request(&server.uri(), "{}");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 200);
        assert_eq!(response.body, "{\"data\":{\"ping\":true}}");
    }

    #[tokio::test]
    async fn captures_response_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("{}")
                    .insert_header("X-Request-Id", "abc-123"),
            )
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request(&server.uri(), "{}");

        let response = executor.execute(&request).await.unwrap();

        assert!(
            response
                .headers
                .iter()
                .any(|header| header.name.eq_ignore_ascii_case("x-request-id")
                    && header.value == "abc-123")
        );
    }

    #[tokio::test]
    async fn returns_a_response_for_a_non_2xx_status() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal error"))
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request(&server.uri(), "{}");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 500);
        assert_eq!(response.body, "internal error");
    }

    #[tokio::test]
    async fn fails_with_invalid_variables_without_hitting_the_network() {
        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request("http://127.0.0.1:1/graphql", "not json");

        let error = executor.execute(&request).await.unwrap_err();

        assert!(matches!(error, ExecutionError::InvalidVariables(_)));
    }

    #[tokio::test]
    async fn fails_with_a_descriptive_message_for_an_unresolved_template_url() {
        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request("{{baseUrl}}/graphql", "{}");

        let error = executor.execute(&request).await.unwrap_err();

        match error {
            ExecutionError::Network(failure) => {
                assert_eq!(failure.cause, Some(NetworkCause::InvalidUrl));
                assert!(
                    failure.detail.contains("relative URL without a base"),
                    "mensagem pouco descritiva: {}",
                    failure.detail
                );
            }
            other => panic!("esperava ExecutionError::Network, obteve {other:?}"),
        }
    }

    #[tokio::test]
    async fn fails_with_timeout_when_the_server_is_too_slow() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::with_timeout(Duration::from_millis(50));
        let request = sample_request(&server.uri(), "{}");

        let error = executor.execute(&request).await.unwrap_err();

        assert_eq!(error, ExecutionError::Timeout);
    }

    #[tokio::test]
    async fn captures_the_effective_request_headers_including_the_injected_authorization() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"data\":{}}"))
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        let request = Request::new(
            Endpoint::new(server.uri()).unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::Bearer {
                token: "secret-token".to_string(),
            },
        );

        let response = executor.execute(&request).await.unwrap();

        assert!(response.request_headers.contains(&ResponseHeader {
            name: "authorization".to_string(),
            value: "Bearer secret-token".to_string(),
        }));
    }

    #[tokio::test]
    async fn parses_set_cookie_headers_into_structured_cookies() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("{}")
                    .insert_header(
                        "Set-Cookie",
                        "session=abc123; Path=/; HttpOnly; Secure; SameSite=Strict",
                    ),
            )
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request(&server.uri(), "{}");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.cookies.len(), 1);
        let cookie = &response.cookies[0];
        assert_eq!(cookie.name, "session");
        assert_eq!(cookie.value, "abc123");
        assert!(cookie.http_only);
        assert!(cookie.secure);
    }

    #[tokio::test]
    async fn plain_http_never_reports_disabled_certificate_verification() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        executor.set_accept_invalid_certificates(true).unwrap();
        let request = sample_request(&server.uri(), "{}");

        let response = executor.execute(&request).await.unwrap();

        assert!(!response.connection.certificate_verification_disabled);
    }

    #[tokio::test]
    async fn captures_connection_info_for_a_plain_http_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request(&server.uri(), "{}");

        let response = executor.execute(&request).await.unwrap();

        assert!(
            response
                .connection
                .remote_address
                .as_deref()
                .is_some_and(|address| address.starts_with("127.0.0.1:"))
        );
        assert_eq!(response.connection.http_version, "HTTP/1.1");
        assert!(!response.connection.tls_certificate_present);
        assert_eq!(response.final_url, None);
    }

    #[tokio::test]
    async fn waiting_ms_accounts_for_time_until_headers_arrive_and_is_at_most_the_total_duration() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(50)))
            .mount(&server)
            .await;

        let executor = ReqwestGraphqlExecutor::new();
        let request = sample_request(&server.uri(), "{}");

        let response = executor.execute(&request).await.unwrap();

        assert!(response.waiting_ms > 0, "esperava waiting_ms > 0");
        assert!(response.waiting_ms <= response.duration_ms);
    }
}
