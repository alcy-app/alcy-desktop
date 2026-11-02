//! Transport data of a received response, shared by the executors that send
//! through the shared HTTP client (REST, GraphQL and the WebSocket
//! handshake), so they report cookies and connection details the same way.

use alcy_domain::{ConnectionInfo, Cookie, ResponseHeader, ResponseMetadata};
use reqwest::header::SET_COOKIE;

/// Monta os dados de transporte que não são nem corpo nem headers de
/// resposta: headers efetivamente enviados, cookies (`Set-Cookie`
/// parseados), conexão (IP remoto, versão HTTP, presença de certificado
/// TLS) e a URL final quando a execução foi redirecionada.
pub fn build_response_metadata(
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
