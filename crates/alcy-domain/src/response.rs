/// Um header HTTP recebido numa resposta.
///
/// Diferente de `HeaderEntry` (headers editáveis pelo usuário na
/// requisição), este é somente leitura e não é uma chave única: HTTP
/// permite repetir o mesmo nome (ex.: múltiplos `Set-Cookie`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHeader {
    pub name: String,
    pub value: String,
}

/// Como interpretar `Response.body`. `Text` é o caso comum (JSON, XML,
/// HTML, texto puro); `Base64` marca um corpo binário (ex.: imagem)
/// codificado em base64 para atravessar o mesmo contrato `String` usado
/// por todo o resto do pipeline (cache, janelamento, IPC) — ver ADR 0009.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyEncoding {
    Text,
    Base64,
}

/// Um cookie recebido via `Set-Cookie`. Campos de atributo (`domain`,
/// `path`, `expires`, `max_age_seconds`, `same_site`) são `Option` porque
/// nem todo `Set-Cookie` os declara.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub expires: Option<String>,
    pub max_age_seconds: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<String>,
}

/// Informação de conexão/transporte de uma execução. `remote_address` e
/// `tls_certificate_present` ficam `None`/`false` quando o dado não está
/// disponível (ex.: endpoint HTTP puro não tem certificado de peer).
/// `certificate_verification_disabled` só fica `true` numa conexão TLS feita
/// com a verificação de certificado desligada pelo usuário (ADR 0058).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConnectionInfo {
    pub remote_address: Option<String>,
    pub http_version: String,
    pub tls_certificate_present: bool,
    pub certificate_verification_disabled: bool,
}

/// Dados de transporte de uma execução, coletados à parte do corpo/headers
/// de resposta: headers efetivamente enviados (incluindo os que a
/// autenticação injeta), cookies recebidos, informação de conexão, URL
/// final (presente só quando a execução foi redirecionada) e o tempo até
/// os headers da resposta chegarem (TTFB, "waiting").
///
/// Agrupado numa struct à parte para não fazer `Response::new`/`new_binary`
/// crescerem em parâmetros posicionais a cada novo dado de transporte.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ResponseMetadata {
    pub request_headers: Vec<ResponseHeader>,
    pub cookies: Vec<Cookie>,
    pub connection: ConnectionInfo,
    pub final_url: Option<String>,
    pub waiting_ms: u64,
}

/// Resposta recebida de uma execução, em qualquer status HTTP.
///
/// Um status HTTP não-2xx ainda é uma `Response` — o usuário precisa ver o
/// corpo de um 404/500, como em qualquer cliente de API. Diferenciar
/// "erro HTTP" na interface é uma leitura de `status_code`, não um caminho
/// de erro separado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub body: String,
    pub encoding: BodyEncoding,
    pub headers: Vec<ResponseHeader>,
    pub request_headers: Vec<ResponseHeader>,
    pub cookies: Vec<Cookie>,
    pub connection: ConnectionInfo,
    pub final_url: Option<String>,
    pub waiting_ms: u64,
}

impl Response {
    pub fn new(
        status_code: u16,
        duration_ms: u64,
        body: impl Into<String>,
        headers: Vec<ResponseHeader>,
        metadata: ResponseMetadata,
    ) -> Self {
        let body = body.into();
        let size_bytes = body.len();
        Self {
            status_code,
            duration_ms,
            size_bytes,
            body,
            encoding: BodyEncoding::Text,
            headers,
            request_headers: metadata.request_headers,
            cookies: metadata.cookies,
            connection: metadata.connection,
            final_url: metadata.final_url,
            waiting_ms: metadata.waiting_ms,
        }
    }

    /// Corpo binário (ex.: imagem) já codificado em base64 por quem chama.
    /// Diferente de `new`, `size_bytes` é recebido explicitamente — o
    /// tamanho real do binário original, não `body.len()` (que mede o
    /// texto base64, ~33% maior por causa da própria codificação).
    pub fn new_binary(
        status_code: u16,
        duration_ms: u64,
        size_bytes: usize,
        base64_body: impl Into<String>,
        headers: Vec<ResponseHeader>,
        metadata: ResponseMetadata,
    ) -> Self {
        Self {
            status_code,
            duration_ms,
            size_bytes,
            body: base64_body.into(),
            encoding: BodyEncoding::Base64,
            headers,
            request_headers: metadata.request_headers,
            cookies: metadata.cookies,
            connection: metadata.connection,
            final_url: metadata.final_url,
            waiting_ms: metadata.waiting_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_size_in_bytes_from_the_body() {
        let response = Response::new(200, 42, "café", vec![], ResponseMetadata::default());

        assert_eq!(response.status_code, 200);
        assert_eq!(response.duration_ms, 42);
        assert_eq!(response.size_bytes, 5); // "café" tem 5 bytes em UTF-8
        assert_eq!(response.body, "café");
        assert_eq!(response.encoding, BodyEncoding::Text);
        assert_eq!(response.headers, vec![]);
    }

    #[test]
    fn new_binary_uses_the_given_size_instead_of_the_base64_bodys_length() {
        let response = Response::new_binary(
            200,
            10,
            3,
            "base64bytes",
            vec![],
            ResponseMetadata::default(),
        );

        assert_eq!(response.size_bytes, 3);
        assert_eq!(response.body, "base64bytes");
        assert_eq!(response.encoding, BodyEncoding::Base64);
    }

    #[test]
    fn keeps_the_response_headers_as_given() {
        let headers = vec![ResponseHeader {
            name: "Content-Type".to_string(),
            value: "application/json".to_string(),
        }];

        let response = Response::new(200, 1, "{}", headers.clone(), ResponseMetadata::default());

        assert_eq!(response.headers, headers);
    }

    #[test]
    fn carries_transport_metadata_from_the_metadata_struct() {
        let metadata = ResponseMetadata {
            request_headers: vec![ResponseHeader {
                name: "Authorization".to_string(),
                value: "Bearer token".to_string(),
            }],
            cookies: vec![Cookie {
                name: "session".to_string(),
                value: "abc".to_string(),
                secure: true,
                ..Default::default()
            }],
            connection: ConnectionInfo {
                remote_address: Some("127.0.0.1:8080".to_string()),
                http_version: "HTTP/1.1".to_string(),
                tls_certificate_present: false,
                certificate_verification_disabled: false,
            },
            final_url: Some("https://example.com/final".to_string()),
            waiting_ms: 12,
        };

        let response = Response::new(200, 42, "{}", vec![], metadata.clone());

        assert_eq!(response.request_headers, metadata.request_headers);
        assert_eq!(response.cookies, metadata.cookies);
        assert_eq!(response.connection, metadata.connection);
        assert_eq!(response.final_url, metadata.final_url);
        assert_eq!(response.waiting_ms, metadata.waiting_ms);
    }
}
