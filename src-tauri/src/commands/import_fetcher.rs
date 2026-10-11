//! Cliente HTTP mínimo para a aba "URL" da modal de importar coleção — só
//! busca o corpo como texto, sem headers/autenticação/método (isso é
//! responsabilidade de `alcy-rest`, para executar requisições de fato, não
//! de importação de documento). Fica em `src-tauri` porque não tem nenhuma
//! regra de negócio própria e não deveria acoplar a importação a nenhuma
//! capability de protocolo específica.

use std::time::Duration;

use alcy_http_proxy::{ProxyError, ProxyPlan, SharedHttpClient};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// Folga generosa sobre o maior documento OpenAPI real testado até agora
/// (~11.7 MB, API REST do GitHub Enterprise Server).
const MAX_IMPORT_BYTES: u64 = 25 * 1024 * 1024;

pub struct ImportFetcher {
    client: SharedHttpClient,
}

impl ImportFetcher {
    pub fn new() -> Self {
        Self {
            client: SharedHttpClient::new(DEFAULT_TIMEOUT),
        }
    }

    /// Passa a usar `plan` (proxy) nas próximas buscas.
    pub fn reconfigure_proxy(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.client.reconfigure(plan)
    }

    pub fn set_custom_ca_certificates(&self, certificates: &[String]) -> Result<(), ProxyError> {
        self.client.set_custom_ca_certificates(certificates)
    }

    /// Busca `url` e devolve o corpo como texto. `Err` cobre falha de rede,
    /// status não-2xx e corpo maior que `MAX_IMPORT_BYTES` — a checagem de
    /// tamanho é best-effort (só quando o servidor manda `Content-Length`).
    pub async fn fetch_text(&self, url: &str) -> Result<String, String> {
        self.fetch_text_with_limit(url, MAX_IMPORT_BYTES).await
    }

    async fn fetch_text_with_limit(&self, url: &str, max_bytes: u64) -> Result<String, String> {
        let response = self
            .client
            .get()
            .await
            .get(url)
            .send()
            .await
            .map_err(|error| format!("falha ao buscar URL: {error}"))?;

        if !response.status().is_success() {
            return Err(format!("resposta HTTP {}", response.status()));
        }

        if response.content_length().unwrap_or(0) > max_bytes {
            return Err(format!(
                "resposta excede o limite de {} MB",
                MAX_IMPORT_BYTES / (1024 * 1024)
            ));
        }

        response
            .text()
            .await
            .map_err(|error| format!("falha ao ler corpo da resposta: {error}"))
    }
}

impl Default for ImportFetcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_the_response_body_as_text() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/openapi.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"openapi\":\"3.0.3\"}"))
            .mount(&server)
            .await;
        let fetcher = ImportFetcher::new();

        let body = fetcher
            .fetch_text(&format!("{}/openapi.json", server.uri()))
            .await
            .unwrap();

        assert_eq!(body, "{\"openapi\":\"3.0.3\"}");
    }

    #[tokio::test]
    async fn fails_with_a_message_for_a_non_success_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/missing.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let fetcher = ImportFetcher::new();

        let error = fetcher
            .fetch_text(&format!("{}/missing.json", server.uri()))
            .await
            .unwrap_err();

        assert!(error.contains("404"));
    }

    #[tokio::test]
    async fn fails_when_content_length_exceeds_the_limit() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/big.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(100)))
            .mount(&server)
            .await;
        let fetcher = ImportFetcher::new();

        let error = fetcher
            .fetch_text_with_limit(&format!("{}/big.json", server.uri()), 10)
            .await
            .unwrap_err();

        assert!(error.contains("limite"));
    }
}
