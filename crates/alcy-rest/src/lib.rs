//! Adapter REST: executa `Request` via HTTP usando `reqwest`, com o verbo
//! dado por `Request.method`. Corpos none/raw vêm de `Request.document.body`
//! (sem envelope, ao contrário do adapter GraphQL); urlencoded, form-data e
//! binary são montados a partir de `Request.body_payload` (ADR 0024).

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alcy_app::{InstrumentedResponse, RequestExecutionTimings, RequestExecutor};
use alcy_domain::{
    Authentication, BodyPayload, ConnectionInfo, Cookie, DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ExecutionError, FormDataField, FormDataFieldValue, HttpMethod, RawBodyLanguage, Request,
    Response, ResponseHeader, ResponseMetadata, ResponseSizeLimit, UrlEncodedField,
};
use alcy_http_auth::{ConfiguredResponseLimit, body_text, map_auth_error, read_response_body};
use alcy_http_proxy::{ProxyError, ProxyPlan, RequestClient, SharedHttpClient};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::Method;
use reqwest::header::{
    ACCEPT, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, SET_COOKIE, USER_AGENT,
};

/// Identificação enviada quando o usuário não define `User-Agent`.
const DEFAULT_USER_AGENT: &str = concat!("Alcy/", env!("CARGO_PKG_VERSION"));

/// Vale até a preferência salva ser aplicada na abertura do app.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECONDS as u64);

pub struct ReqwestRestExecutor {
    client: SharedHttpClient,
    response_limit: ConfiguredResponseLimit,
}

impl ReqwestRestExecutor {
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

impl Default for ReqwestRestExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestExecutor for ReqwestRestExecutor {
    async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
        Ok(self.execute_instrumented(request).await?.response)
    }

    async fn execute_instrumented(
        &self,
        request: &Request,
    ) -> Result<InstrumentedResponse, ExecutionError> {
        self.execute_instrumented_inner(request).await
    }
}

impl ReqwestRestExecutor {
    async fn execute_instrumented_inner(
        &self,
        request: &Request,
    ) -> Result<InstrumentedResponse, ExecutionError> {
        let RequestClient {
            client,
            accepts_invalid_certificates,
        } = self.client.get_for_request(request.redirect_policy).await;
        let mut http_request =
            client.request(to_reqwest_method(request.method), request.endpoint.url());

        // Digest reenvia a requisição depois do desafio 401, e um corpo em
        // streaming não pode ser reenviado: nesse caso arquivos são lidos para
        // a memória. Nos demais, form-data e binary vão em streaming do disco.
        let must_replay = matches!(request.authentication, Authentication::Digest { .. });
        let is_multipart_body = matches!(request.body_payload, BodyPayload::FormData(_));
        // `Content-Type`/`Content-Length` que o corpo pede. Entram como headers
        // padrão (o do usuário prevalece) e, por estarem no request montado,
        // aparecem nos headers enviados. Sem corpo, métodos que esperam um
        // levam `Content-Length: 0` — vários servidores respondem 411 sem ele.
        let empty_body_length = expects_body(request.method).then_some(0);
        let mut body_content_type: Option<String> = None;
        let mut body_length: Option<u64> = empty_body_length;
        match &request.body_payload {
            BodyPayload::None | BodyPayload::Raw { .. } => {
                if !request.document.body.is_empty() {
                    if let BodyPayload::Raw { language } = request.body_payload {
                        body_content_type = Some(raw_content_type(language).to_string());
                    }
                    body_length = Some(request.document.body.len() as u64);
                    http_request = http_request.body(request.document.body.clone());
                }
            }
            BodyPayload::UrlEncoded(fields) => {
                let encoded = encode_url_encoded(fields);
                if !encoded.is_empty() {
                    body_content_type = Some(URL_ENCODED_CONTENT_TYPE.to_string());
                    body_length = Some(encoded.len() as u64);
                    http_request = http_request.body(encoded);
                }
            }
            BodyPayload::FormData(fields) if must_replay => {
                let (content_type, bytes) = encode_multipart(fields).await?;
                body_length = Some(bytes.len() as u64);
                http_request = http_request.header(CONTENT_TYPE, content_type).body(bytes);
            }
            BodyPayload::FormData(fields) => {
                // `multipart()` define `Content-Type` e, quando calculável,
                // `Content-Length`.
                body_length = None;
                http_request = http_request.multipart(build_multipart_form(fields).await?);
            }
            BodyPayload::Binary { file_path } if must_replay => {
                let bytes = read_body_file(file_path).await?;
                body_content_type = Some(binary_content_type(file_path));
                body_length = Some(bytes.len() as u64);
                http_request = http_request.body(bytes);
            }
            BodyPayload::Binary { file_path } => {
                let (length, body) = stream_body_file(file_path).await?;
                body_content_type = Some(binary_content_type(file_path));
                body_length = Some(length);
                http_request = http_request.body(body);
            }
        }

        for header in request.headers.iter().filter(|header| header.enabled) {
            // `multipart()` já define `Content-Type: multipart/form-data;
            // boundary=...` e o `Content-Length` do corpo gerado — repeti-los
            // aqui duplicaria os headers, e um `Content-Length` divergente faz
            // a requisição sair com dois tamanhos e `Transfer-Encoding: chunked`.
            if is_multipart_body
                && (header.name().eq_ignore_ascii_case("content-type")
                    || header.name().eq_ignore_ascii_case("content-length"))
            {
                continue;
            }
            http_request = http_request.header(header.name(), header.value());
        }

        // Headers padrão: o usuário sempre prevalece, então só entram quando
        // ele não definiu o mesmo nome.
        let mut defaults = vec![
            (USER_AGENT, DEFAULT_USER_AGENT.to_string()),
            (ACCEPT, "*/*".to_string()),
            // Evita que proxies/CDNs no caminho devolvam uma resposta em cache.
            (CACHE_CONTROL, "no-cache".to_string()),
        ];
        defaults.extend(body_content_type.map(|value| (CONTENT_TYPE, value)));
        defaults.extend(body_length.map(|length| (CONTENT_LENGTH, length.to_string())));
        for (name, value) in defaults {
            let defined_by_user = request
                .headers
                .iter()
                .any(|header| header.enabled && header.name().eq_ignore_ascii_case(name.as_str()));
            if !defined_by_user {
                http_request = http_request.header(name, value);
            }
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
        let receiving_started = Instant::now();

        let limit = self.response_limit.for_request(request);
        if is_image_content_type(&headers) {
            let raw = read_response_body(http_response, limit).await?;
            let duration_ms = started_at.elapsed().as_millis() as u64;
            let size_bytes = raw.len();
            let body = BASE64.encode(raw);
            let response = Response::new_binary(
                status_code,
                duration_ms,
                size_bytes,
                body,
                headers,
                metadata,
            );
            return Ok(instrumented_response(
                response,
                Duration::from_millis(waiting_ms),
                receiving_started.elapsed(),
            ));
        }

        let body = body_text(read_response_body(http_response, limit).await?);
        let duration_ms = started_at.elapsed().as_millis() as u64;

        Ok(instrumented_response(
            Response::new(status_code, duration_ms, body, headers, metadata),
            Duration::from_millis(waiting_ms),
            receiving_started.elapsed(),
        ))
    }
}

/// O client reqwest expõe o momento de recebimento dos headers e o fim da
/// leitura do corpo. DNS/conexão/TLS/envio não são publicados pela API do
/// client; preservamos essas fases como ausentes, nunca como zero inventado.
fn instrumented_response(
    response: Response,
    waiting: Duration,
    receiving: Duration,
) -> InstrumentedResponse {
    InstrumentedResponse {
        response,
        timings: RequestExecutionTimings {
            waiting: Some(waiting),
            receiving: Some(receiving),
            ..RequestExecutionTimings::default()
        },
    }
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

/// Decide se o corpo deve ser lido como bytes crus (e transportado em
/// base64, ver ADR 0009) em vez de texto — `.text()` decodificaria bytes
/// binários como UTF-8 lossy, corrompendo o payload. Qualquer subtipo de
/// imagem entra por aqui; o que a webview consegue de fato renderizar
/// fica a cargo do frontend.
fn is_image_content_type(headers: &[ResponseHeader]) -> bool {
    headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("content-type")
            && header
                .value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("image/")
    })
}

fn to_reqwest_method(method: HttpMethod) -> Method {
    match method {
        HttpMethod::Get => Method::GET,
        HttpMethod::Post => Method::POST,
        HttpMethod::Put => Method::PUT,
        HttpMethod::Patch => Method::PATCH,
        HttpMethod::Delete => Method::DELETE,
        HttpMethod::Head => Method::HEAD,
        HttpMethod::Options => Method::OPTIONS,
    }
}

/// Métodos cujo corpo tem semântica definida: sem corpo, ainda levam
/// `Content-Length: 0`.
fn expects_body(method: HttpMethod) -> bool {
    matches!(
        method,
        HttpMethod::Post | HttpMethod::Put | HttpMethod::Patch
    )
}

const URL_ENCODED_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";

/// Mesma tabela que o frontend usa para sincronizar a linha `Content-Type`
/// da grade de headers.
fn raw_content_type(language: RawBodyLanguage) -> &'static str {
    match language {
        RawBodyLanguage::Text => "text/plain",
        RawBodyLanguage::JavaScript => "application/javascript",
        RawBodyLanguage::Json => "application/json",
        RawBodyLanguage::Html => "text/html",
        RawBodyLanguage::Xml => "application/xml",
    }
}

fn binary_content_type(file_path: &str) -> String {
    mime_guess::from_path(file_path)
        .first_or_octet_stream()
        .to_string()
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

fn file_error(file_path: &str, error: std::io::Error) -> ExecutionError {
    ExecutionError::BodyFileUnreadable {
        path: file_path.to_string(),
        detail: error.to_string(),
    }
}

/// Lê um arquivo de corpo inteiro para a memória, de forma assíncrona — só
/// quando o corpo precisa poder ser reenviado (Digest). Os bytes nunca
/// cruzam a IPC: só o caminho chega até aqui (ADR 0024).
async fn read_body_file(file_path: &str) -> Result<Vec<u8>, ExecutionError> {
    tokio::fs::read(file_path)
        .await
        .map_err(|error| file_error(file_path, error))
}

/// Abre o arquivo para envio em streaming, junto com o tamanho — enviado
/// como `Content-Length` para não cair em `Transfer-Encoding: chunked`, que
/// vários servidores (ex.: URLs pré-assinadas de storage) recusam.
async fn stream_body_file(file_path: &str) -> Result<(u64, reqwest::Body), ExecutionError> {
    let file = tokio::fs::File::open(file_path)
        .await
        .map_err(|error| file_error(file_path, error))?;
    let length = file
        .metadata()
        .await
        .map_err(|error| file_error(file_path, error))?
        .len();
    Ok((length, reqwest::Body::from(file)))
}

fn encode_url_encoded(fields: &[UrlEncodedField]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for field in fields.iter().filter(|field| field.enabled) {
        serializer.append_pair(&field.name, &field.value);
    }
    serializer.finish()
}

/// Boundary único por corpo; basta não aparecer no conteúdo (probabilidade
/// desprezível com tempo + contador).
fn multipart_boundary() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("alcy-boundary-{nanos:x}-{count:x}")
}

/// Escapa um nome/arquivo dentro de `Content-Disposition`, como os browsers
/// (e o `reqwest`) fazem: aspas e quebras de linha viram percent-encoding.
fn quote_disposition(value: &str) -> String {
    value
        .replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

/// Monta um corpo multipart/form-data inteiro em memória (RFC 7578) — ao
/// contrário de `reqwest::multipart`, que sempre gera um stream, este corpo
/// pode ser clonado e reenviado no desafio Digest.
async fn encode_multipart(fields: &[FormDataField]) -> Result<(String, Vec<u8>), ExecutionError> {
    let boundary = multipart_boundary();
    let mut body = Vec::new();
    for field in fields.iter().filter(|field| field.enabled) {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        let name = quote_disposition(&field.name);
        match &field.value {
            FormDataFieldValue::Text(value) => {
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                );
                body.extend_from_slice(value.as_bytes());
            }
            FormDataFieldValue::File { file_path } => {
                let bytes = read_body_file(file_path).await?;
                let file_name = Path::new(file_path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let mime = mime_guess::from_path(file_path).first_or_octet_stream();
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{}\"\r\nContent-Type: {mime}\r\n\r\n",
                        quote_disposition(&file_name)
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&bytes);
            }
        }
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

async fn build_multipart_form(
    fields: &[FormDataField],
) -> Result<reqwest::multipart::Form, ExecutionError> {
    let mut form = reqwest::multipart::Form::new();
    for field in fields.iter().filter(|field| field.enabled) {
        form = match &field.value {
            FormDataFieldValue::Text(value) => form.text(field.name.clone(), value.clone()),
            FormDataFieldValue::File { file_path } => {
                let part = reqwest::multipart::Part::file(file_path)
                    .await
                    .map_err(|error| file_error(file_path, error))?;
                form.part(field.name.clone(), part)
            }
        };
    }
    Ok(form)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{
        Authentication, Endpoint, HeaderEntry, NetworkCause, ProtocolId, RequestDocument,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use wiremock::matchers::{body_string, body_string_contains, header_regex, method};
    use wiremock::{Match, Mock, MockServer, ResponseTemplate};

    fn sample_request(endpoint_url: &str, http_method: HttpMethod, body: &str) -> Request {
        Request::new(
            Endpoint::new(endpoint_url).unwrap(),
            RequestDocument::new(ProtocolId::Rest, body),
            "",
            vec![HeaderEntry::new("X-Test", "1", true).unwrap()],
            Authentication::None,
        )
        .with_method(http_method)
    }

    #[tokio::test]
    async fn sends_the_requests_method() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Delete, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 204);
    }

    #[tokio::test]
    async fn sends_the_body_as_is_without_wrapping_it() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string("{\"name\":\"acme\"}"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Post, "{\"name\":\"acme\"}");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    #[tokio::test]
    async fn sends_no_body_for_a_get_with_an_empty_document() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(body_string(""))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.body, "[]");
    }

    #[tokio::test]
    async fn captures_response_headers() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("{}")
                    .insert_header("X-Request-Id", "abc-123"),
            )
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

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
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 404);
        assert_eq!(response.body, "not found");
    }

    #[tokio::test]
    async fn fails_with_a_descriptive_message_for_an_unresolved_template_url() {
        let executor = ReqwestRestExecutor::new();
        let request = sample_request("{{baseUrl}}/users", HttpMethod::Get, "");

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
    async fn reads_an_image_response_as_base64_instead_of_lossy_text() {
        let raw_bytes: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00];
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(raw_bytes)
                    .insert_header("Content-Type", "image/png"),
            )
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.encoding, alcy_domain::BodyEncoding::Base64);
        assert_eq!(response.size_bytes, raw_bytes.len());
        assert_eq!(
            response.body,
            base64::engine::general_purpose::STANDARD.encode(raw_bytes)
        );
    }

    #[tokio::test]
    async fn keeps_reading_non_image_content_types_as_text() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("{}")
                    .insert_header("Content-Type", "application/json"),
            )
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.encoding, alcy_domain::BodyEncoding::Text);
        assert_eq!(response.body, "{}");
    }

    #[tokio::test]
    async fn fails_with_timeout_when_the_server_is_too_slow() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::with_timeout(Duration::from_millis(50));
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let error = executor.execute(&request).await.unwrap_err();

        assert_eq!(error, ExecutionError::Timeout);
    }

    #[tokio::test]
    async fn a_disabled_timeout_waits_for_slow_servers() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::with_timeout(Duration::from_millis(50));
        executor.set_timeout(None).unwrap();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 200);
    }

    #[tokio::test]
    async fn captures_the_effective_request_headers_including_the_injected_authorization() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = Request::new(
            Endpoint::new(server.uri()).unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::Bearer {
                token: "secret-token".to_string(),
            },
        )
        .with_method(HttpMethod::Get);

        let response = executor.execute(&request).await.unwrap();

        assert!(response.request_headers.contains(&ResponseHeader {
            name: "authorization".to_string(),
            value: "Bearer secret-token".to_string(),
        }));
    }

    #[tokio::test]
    async fn sends_default_user_agent_and_accept_unless_the_user_defines_them() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let build = |headers: Vec<HeaderEntry>| {
            Request::new(
                Endpoint::new(server.uri()).unwrap(),
                RequestDocument::new(ProtocolId::Rest, ""),
                "",
                headers,
                Authentication::None,
            )
            .with_method(HttpMethod::Get)
        };

        let response = executor.execute(&build(vec![])).await.unwrap();
        let find = |name: &str| {
            response
                .request_headers
                .iter()
                .filter(|header| header.name == name)
                .map(|header| header.value.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(find("user-agent"), vec![DEFAULT_USER_AGENT.to_string()]);
        assert_eq!(find("accept"), vec!["*/*".to_string()]);
        assert_eq!(find("cache-control"), vec!["no-cache".to_string()]);

        let custom = vec![
            HeaderEntry::new("user-agent", "meu-agente", true).unwrap(),
            HeaderEntry::new("Accept", "application/json", true).unwrap(),
        ];
        let response = executor.execute(&build(custom)).await.unwrap();
        let values = |name: &str| {
            response
                .request_headers
                .iter()
                .filter(|header| header.name == name)
                .map(|header| header.value.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(values("user-agent"), vec!["meu-agente".to_string()]);
        assert_eq!(values("accept"), vec!["application/json".to_string()]);
    }

    fn sent_header_values(response: &Response, name: &str) -> Vec<String> {
        response
            .request_headers
            .iter()
            .filter(|header| header.name == name)
            .map(|header| header.value.clone())
            .collect()
    }

    #[tokio::test]
    async fn sends_content_type_and_length_for_a_raw_body_without_a_user_content_type() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(SingleContentTypeHeader)
            .and(header_regex("content-type", "^application/json$"))
            .and(header_regex("content-length", "^15$"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Post, "{\"name\":\"acme\"}");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
        assert_eq!(
            sent_header_values(&response, "content-type"),
            vec!["application/json".to_string()]
        );
        assert_eq!(
            sent_header_values(&response, "content-length"),
            vec!["15".to_string()]
        );
    }

    #[tokio::test]
    async fn uses_the_raw_language_for_the_default_content_type() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header_regex("content-type", "^application/xml$"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Post, "<a/>").with_body_payload(
            BodyPayload::Raw {
                language: RawBodyLanguage::Xml,
            },
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    #[tokio::test]
    async fn keeps_the_user_content_type_for_a_raw_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(SingleContentTypeHeader)
            .and(header_regex("content-type", "^application/vnd.api\\+json$"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let mut request = sample_request(&server.uri(), HttpMethod::Post, "{}");
        request
            .headers
            .push(HeaderEntry::new("content-type", "application/vnd.api+json", true).unwrap());

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    #[tokio::test]
    async fn sends_content_length_zero_for_a_post_without_body_but_not_for_a_get() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header_regex("content-length", "^0$"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();

        let post = executor
            .execute(&sample_request(&server.uri(), HttpMethod::Post, ""))
            .await
            .unwrap();
        assert_eq!(post.status_code, 201);
        assert!(sent_header_values(&post, "content-type").is_empty());

        let get = executor
            .execute(&sample_request(&server.uri(), HttpMethod::Get, ""))
            .await
            .unwrap();
        assert!(sent_header_values(&get, "content-length").is_empty());
        assert!(sent_header_values(&get, "content-type").is_empty());
    }

    #[tokio::test]
    async fn parses_set_cookie_headers_into_structured_cookies() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).insert_header(
                "Set-Cookie",
                "session=abc123; Path=/; HttpOnly; Secure; SameSite=Strict",
            ))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.cookies.len(), 1);
        let cookie = &response.cookies[0];
        assert_eq!(cookie.name, "session");
        assert_eq!(cookie.value, "abc123");
        assert_eq!(cookie.path.as_deref(), Some("/"));
        assert!(cookie.http_only);
        assert!(cookie.secure);
    }

    #[tokio::test]
    async fn plain_http_never_reports_disabled_certificate_verification() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        executor.set_accept_invalid_certificates(true).unwrap();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert!(!response.connection.certificate_verification_disabled);
    }

    #[tokio::test]
    async fn captures_connection_info_for_a_plain_http_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

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
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(50)))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&server.uri(), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert!(response.waiting_ms > 0, "esperava waiting_ms > 0");
        assert!(response.waiting_ms <= response.duration_ms);
    }

    #[tokio::test]
    async fn exposes_the_final_url_when_the_request_is_redirected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", "/destination"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/destination"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&format!("{}/start", server.uri()), HttpMethod::Get, "");

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(
            response.final_url,
            Some(format!("{}/destination", server.uri()))
        );
    }

    #[tokio::test]
    async fn manual_redirect_policy_returns_the_original_3xx_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", "/destination"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/destination"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = sample_request(&format!("{}/start", server.uri()), HttpMethod::Get, "")
            .with_redirect_policy(alcy_domain::RedirectPolicy::Manual);

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 302);
        assert_eq!(response.final_url, None);
        assert!(
            response
                .headers
                .iter()
                .any(|header| header.name.eq_ignore_ascii_case("location")
                    && header.value == "/destination")
        );
    }

    #[tokio::test]
    async fn exposes_headers_and_body_read_timings_to_the_load_runner() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(20))
                    .set_body_string("payload"),
            )
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let exchange = executor
            .execute_instrumented(&sample_request(&server.uri(), HttpMethod::Get, ""))
            .await
            .unwrap();

        assert_eq!(exchange.response.body, "payload");
        assert!(exchange.timings.waiting.is_some());
        assert!(exchange.timings.receiving.is_some());
        assert_eq!(exchange.timings.dns, None);
        assert_eq!(exchange.timings.connecting, None);
        assert_eq!(exchange.timings.tls_handshaking, None);
        assert_eq!(exchange.timings.sending, None);
    }

    static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_file(contents: &[u8]) -> std::path::PathBuf {
        let count = TEMP_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("alcy-rest-body-test-{count}"));
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn request_with_body_payload(endpoint_url: &str, payload: BodyPayload) -> Request {
        Request::new(
            Endpoint::new(endpoint_url).unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Post)
        .with_body_payload(payload)
    }

    /// Verifica que exatamente um header `Content-Type` chegou ao servidor —
    /// usado para garantir que `multipart()` (que já define o próprio,
    /// com boundary) não duplica um `Content-Type` que o usuário também
    /// tenha definido manualmente.
    struct SingleContentTypeHeader;

    impl Match for SingleContentTypeHeader {
        fn matches(&self, request: &wiremock::Request) -> bool {
            request.headers.get_all("content-type").iter().count() == 1
        }
    }

    struct ExactBody(Vec<u8>);

    impl Match for ExactBody {
        fn matches(&self, request: &wiremock::Request) -> bool {
            request.body == self.0
        }
    }

    #[tokio::test]
    async fn sends_a_multipart_form_with_only_text_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header_regex(
                "content-type",
                "^multipart/form-data; boundary=",
            ))
            .and(body_string_contains("name=\"company\""))
            .and(body_string_contains("acme"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            &server.uri(),
            BodyPayload::FormData(vec![FormDataField {
                name: "company".to_string(),
                enabled: true,
                value: FormDataFieldValue::Text("acme".to_string()),
            }]),
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    #[tokio::test]
    async fn skips_disabled_form_data_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("kept"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            &server.uri(),
            BodyPayload::FormData(vec![
                FormDataField {
                    name: "skipped".to_string(),
                    enabled: false,
                    value: FormDataFieldValue::Text("should-not-be-sent".to_string()),
                },
                FormDataField {
                    name: "included".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::Text("kept".to_string()),
                },
            ]),
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    #[tokio::test]
    async fn sends_a_multipart_form_with_a_file_field() {
        let path = temp_file(b"file contents");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("name=\"attachment\""))
            .and(body_string_contains("file contents"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            &server.uri(),
            BodyPayload::FormData(vec![FormDataField {
                name: "attachment".to_string(),
                enabled: true,
                value: FormDataFieldValue::File {
                    file_path: path.to_string_lossy().to_string(),
                },
            }]),
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn sends_a_binary_body_as_the_exact_bytes_of_a_file() {
        let raw_bytes: &[u8] = &[0x00, 0x01, 0x02, 0xff, 0xfe];
        let path = temp_file(raw_bytes);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(ExactBody(raw_bytes.to_vec()))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            &server.uri(),
            BodyPayload::Binary {
                file_path: path.to_string_lossy().to_string(),
            },
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn sends_the_url_encoded_content_type_by_default() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header_regex(
                "content-type",
                "^application/x-www-form-urlencoded$",
            ))
            .and(header_regex("content-length", "^8$"))
            .and(body_string("name=acm"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            &server.uri(),
            BodyPayload::UrlEncoded(vec![UrlEncodedField {
                name: "name".to_string(),
                value: "acm".to_string(),
                enabled: true,
            }]),
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    #[tokio::test]
    async fn guesses_the_binary_content_type_from_the_file_extension() {
        let source = temp_file(b"png");
        let png = source.with_extension("png");
        std::fs::rename(&source, &png).unwrap();
        let unknown = temp_file(b"raw");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header_regex("content-type", "^image/png$"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(header_regex("content-type", "^application/octet-stream$"))
            .respond_with(ResponseTemplate::new(202))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let binary = |path: &std::path::Path| {
            request_with_body_payload(
                &server.uri(),
                BodyPayload::Binary {
                    file_path: path.to_string_lossy().to_string(),
                },
            )
        };

        let response = executor.execute(&binary(&png)).await.unwrap();
        assert_eq!(response.status_code, 201);
        let response = executor.execute(&binary(&unknown)).await.unwrap();
        assert_eq!(response.status_code, 202);

        std::fs::remove_file(&png).ok();
        std::fs::remove_file(&unknown).ok();
    }

    #[tokio::test]
    async fn a_missing_binary_file_fails_with_invalid_request_instead_of_touching_the_network() {
        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            "http://127.0.0.1:1",
            BodyPayload::Binary {
                file_path: "/no/such/file-alcy-test".to_string(),
            },
        );

        let error = executor.execute(&request).await.unwrap_err();

        assert!(matches!(error, ExecutionError::BodyFileUnreadable { .. }));
    }

    #[tokio::test]
    async fn a_missing_form_data_file_field_fails_with_invalid_request() {
        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            "http://127.0.0.1:1",
            BodyPayload::FormData(vec![FormDataField {
                name: "attachment".to_string(),
                enabled: true,
                value: FormDataFieldValue::File {
                    file_path: "/no/such/file-alcy-test".to_string(),
                },
            }]),
        );

        let error = executor.execute(&request).await.unwrap_err();

        assert!(matches!(error, ExecutionError::BodyFileUnreadable { .. }));
    }

    #[tokio::test]
    async fn does_not_duplicate_the_content_type_header_when_the_user_sets_one_for_form_data() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(SingleContentTypeHeader)
            .and(header_regex(
                "content-type",
                "^multipart/form-data; boundary=",
            ))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let mut request = request_with_body_payload(
            &server.uri(),
            BodyPayload::FormData(vec![FormDataField {
                name: "field".to_string(),
                enabled: true,
                value: FormDataFieldValue::Text("value".to_string()),
            }]),
        );
        request.headers = vec![HeaderEntry::new("Content-Type", "text/plain", true).unwrap()];

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    /// Exatamente um `Content-Length`, igual ao tamanho do corpo recebido.
    struct ContentLengthMatchesBody;

    impl Match for ContentLengthMatchesBody {
        fn matches(&self, request: &wiremock::Request) -> bool {
            let values: Vec<_> = request.headers.get_all("content-length").iter().collect();
            values.len() == 1
                && values[0].to_str().ok() == Some(request.body.len().to_string().as_str())
        }
    }

    #[tokio::test]
    async fn ignores_a_user_content_length_for_form_data() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(ContentLengthMatchesBody)
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let mut request = request_with_body_payload(
            &server.uri(),
            BodyPayload::FormData(vec![FormDataField {
                name: "field".to_string(),
                enabled: true,
                value: FormDataFieldValue::Text("value".to_string()),
            }]),
        );
        request.headers = vec![HeaderEntry::new("Content-Length", "999", true).unwrap()];

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
        assert_eq!(sent_header_values(&response, "content-length").len(), 1);
        assert!(!sent_header_values(&response, "content-length").contains(&"999".to_string()));
    }

    fn digest_request(endpoint_url: &str, payload: BodyPayload) -> Request {
        let mut request = request_with_body_payload(endpoint_url, payload);
        request.authentication = Authentication::Digest {
            username: "user".to_string(),
            password: "pass".to_string(),
        };
        request
    }

    async fn mount_digest_challenge(server: &MockServer) {
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).insert_header(
                "WWW-Authenticate",
                r#"Digest realm="test", qop="auth", nonce="abc123", algorithm=MD5"#,
            ))
            .up_to_n_times(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn resends_a_form_data_body_after_a_digest_challenge() {
        let path = temp_file(b"file contents");
        let server = MockServer::start().await;
        mount_digest_challenge(&server).await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::header_exists("Authorization"))
            .and(header_regex(
                "content-type",
                "^multipart/form-data; boundary=",
            ))
            .and(body_string_contains("name=\"title\""))
            .and(body_string_contains("photo"))
            .and(body_string_contains("filename=\""))
            .and(body_string_contains("file contents"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = digest_request(
            &server.uri(),
            BodyPayload::FormData(vec![
                FormDataField {
                    name: "title".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::Text("photo".to_string()),
                },
                FormDataField {
                    name: "file".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::File {
                        file_path: path.to_string_lossy().to_string(),
                    },
                },
            ]),
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn resends_a_binary_body_after_a_digest_challenge() {
        let raw_bytes: &[u8] = &[0x00, 0xff, 0x10];
        let path = temp_file(raw_bytes);
        let server = MockServer::start().await;
        mount_digest_challenge(&server).await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::header_exists("Authorization"))
            .and(ExactBody(raw_bytes.to_vec()))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = digest_request(
            &server.uri(),
            BodyPayload::Binary {
                file_path: path.to_string_lossy().to_string(),
            },
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn streams_a_binary_body_with_a_content_length_instead_of_chunked_encoding() {
        let raw_bytes = vec![7u8; 64 * 1024];
        let path = temp_file(&raw_bytes);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::header("content-length", "65536"))
            .and(ExactBody(raw_bytes.clone()))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let request = request_with_body_payload(
            &server.uri(),
            BodyPayload::Binary {
                file_path: path.to_string_lossy().to_string(),
            },
        );

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn encodes_the_enabled_urlencoded_fields_ignoring_the_document_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string("q=a+b&amp=%26"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let executor = ReqwestRestExecutor::new();
        let mut request = request_with_body_payload(
            &server.uri(),
            BodyPayload::UrlEncoded(vec![
                UrlEncodedField {
                    name: "q".to_string(),
                    value: "a b".to_string(),
                    enabled: true,
                },
                UrlEncodedField {
                    name: "off".to_string(),
                    value: "x".to_string(),
                    enabled: false,
                },
                UrlEncodedField {
                    name: "amp".to_string(),
                    value: "&".to_string(),
                    enabled: true,
                },
            ]),
        );
        request.document.body = "stale=text".to_string();

        let response = executor.execute(&request).await.unwrap();

        assert_eq!(response.status_code, 201);
    }

    #[test]
    fn quotes_names_inside_content_disposition() {
        assert_eq!(quote_disposition("a\"b\r\nc"), "a%22b%0D%0Ac");
    }
}
