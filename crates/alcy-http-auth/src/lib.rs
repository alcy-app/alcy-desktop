//! Aplica um `Authentication` (domínio, agnóstico de protocolo) a uma
//! requisição `reqwest`. Compartilhado por `alcy-rest` e `alcy-graphql`
//! (que não podem depender um do outro — capabilities de protocolo ficam
//! paralelas, ver `ARCHITECTURE.md`) porque `Digest` e
//! `OAuth2ClientCredentials` exigem fluxos de rede multi-etapa (desafio
//! HTTP / busca de token) idênticos nos dois adapters.

mod execution_failure;
mod response_body;

pub use execution_failure::{map_auth_error, map_reqwest_error};
pub use response_body::{ConfiguredResponseLimit, body_text, read_response_body};

use alcy_domain::Authentication;
use reqwest::header::{AUTHORIZATION, HeaderValue, WWW_AUTHENTICATE};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthHttpError {
    #[error("falha de rede: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("servidor de token OAuth2 respondeu com status {0}")]
    TokenStatus(StatusCode),
    #[error("resposta inválida do servidor de token OAuth2: {0}")]
    TokenResponse(String),
    #[error("o corpo da requisição não pode ser reenviado para a autenticação digest")]
    DigestBodyNotReplayable,
    #[error("cabeçalho WWW-Authenticate ausente na resposta 401")]
    DigestChallengeMissing,
    #[error("desafio digest inválido: {0}")]
    DigestChallengeInvalid(String),
}

/// Resultado de `send_authenticated`: a resposta e os headers efetivamente
/// enviados no request que a produziu — incluindo os que a própria
/// autenticação injeta (`Authorization` resolvido de Bearer/Basic/Digest/
/// OAuth2), que não existem em `request` antes de `send_authenticated`
/// rodar.
#[derive(Debug)]
pub struct AuthenticatedExchange {
    pub request_headers: Vec<(String, String)>,
    pub response: Response,
}

/// Envia `request` aplicando `authentication`. Substitui a chamada direta
/// a `.send()` porque `Digest` (desafio/resposta) e
/// `OAuth2ClientCredentials` (busca de token) podem exigir mais de um
/// round-trip antes da resposta final, e porque quem chama precisa dos
/// headers do request que foi de fato executado (ver `AuthenticatedExchange`).
pub async fn send_authenticated(
    client: &Client,
    request: RequestBuilder,
    authentication: &Authentication,
) -> Result<AuthenticatedExchange, AuthHttpError> {
    match authentication {
        Authentication::None | Authentication::Inherit => {
            execute_and_capture(client, request).await
        }
        Authentication::CustomHeader { name, value } => {
            let request = if name.trim().is_empty() {
                request
            } else {
                let request = if name.eq_ignore_ascii_case(AUTHORIZATION.as_str()) {
                    remove_authorization(client, request)?
                } else {
                    request
                };
                request.header(name.as_str(), value.as_str())
            };
            execute_and_capture(client, request).await
        }
        Authentication::Bearer { token } => {
            let request = remove_authorization(client, request)?;
            execute_and_capture(client, request.bearer_auth(token)).await
        }
        Authentication::Basic { username, password } => {
            let request = remove_authorization(client, request)?;
            execute_and_capture(client, request.basic_auth(username, Some(password))).await
        }
        Authentication::Digest { username, password } => {
            let request = remove_authorization(client, request)?;
            send_with_digest(client, request, username, password).await
        }
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => {
            let request = remove_authorization(client, request)?;
            send_with_oauth2_client_credentials(
                client,
                request,
                client_id,
                client_secret,
                token_url,
                scope,
            )
            .await
        }
    }
}

/// Remove um `Authorization` definido manualmente antes de aplicar a autenticação escolhida.
/// `RequestBuilder::header` anexa valores; sem esta etapa, o request poderia sair com dois
/// headers conflitantes e o valor da aba Authorization não teria precedência.
fn remove_authorization(
    client: &Client,
    request: RequestBuilder,
) -> Result<RequestBuilder, AuthHttpError> {
    let mut built = request.build()?;
    built.headers_mut().remove(AUTHORIZATION);
    Ok(RequestBuilder::from_parts(client.clone(), built))
}

/// Constrói `request`, captura os headers do request construído (o que foi
/// de fato enviado) e o executa.
async fn execute_and_capture(
    client: &Client,
    request: RequestBuilder,
) -> Result<AuthenticatedExchange, AuthHttpError> {
    let built = request.build()?;
    let request_headers = extract_request_headers(&built);
    let response = client.execute(built).await?;
    Ok(AuthenticatedExchange {
        request_headers,
        response,
    })
}

fn extract_request_headers(request: &reqwest::Request) -> Vec<(String, String)> {
    request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

/// Envia a requisição sem `Authorization`; se o servidor responder `401`
/// com `WWW-Authenticate`, calcula a resposta do desafio Digest (RFC 7616,
/// via `digest_auth`) e reenvia a mesma requisição com o header calculado.
/// Se a primeira resposta não for `401`, é retornada como está (alguns
/// endpoints não exigem desafio para todo método/rota).
async fn send_with_digest(
    client: &Client,
    request: RequestBuilder,
    username: &str,
    password: &str,
) -> Result<AuthenticatedExchange, AuthHttpError> {
    let built = request.build()?;
    let probe = built
        .try_clone()
        .ok_or(AuthHttpError::DigestBodyNotReplayable)?;
    let probe_headers = extract_request_headers(&probe);
    let probe_response = client.execute(probe).await?;

    if probe_response.status() != StatusCode::UNAUTHORIZED {
        return Ok(AuthenticatedExchange {
            request_headers: probe_headers,
            response: probe_response,
        });
    }

    let www_authenticate = probe_response
        .headers()
        .get(WWW_AUTHENTICATE)
        .and_then(|value| value.to_str().ok())
        .ok_or(AuthHttpError::DigestChallengeMissing)?
        .to_string();

    let mut prompt = digest_auth::parse(&www_authenticate)
        .map_err(|error| AuthHttpError::DigestChallengeInvalid(error.to_string()))?;

    let method = digest_auth::HttpMethod::from(built.method().as_str());
    let context = digest_auth::AuthContext::new_with_method(
        username,
        password,
        built.url().path(),
        Option::<&[u8]>::None,
        method,
    );
    let answer = prompt
        .respond(&context)
        .map_err(|error| AuthHttpError::DigestChallengeInvalid(error.to_string()))?;

    let mut retry = built;
    retry.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&answer.to_header_string())
            .map_err(|error| AuthHttpError::DigestChallengeInvalid(error.to_string()))?,
    );

    let request_headers = extract_request_headers(&retry);
    let response = client.execute(retry).await?;
    Ok(AuthenticatedExchange {
        request_headers,
        response,
    })
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// Busca um token via `grant_type=client_credentials` (autenticado com
/// `client_id`/`client_secret` como Basic Auth no token URL, conforme
/// RFC 6749 §2.3.1) e envia a requisição original com o token como
/// Bearer. Sem cache: um token novo é buscado a cada execução.
async fn send_with_oauth2_client_credentials(
    client: &Client,
    request: RequestBuilder,
    client_id: &str,
    client_secret: &str,
    token_url: &str,
    scope: &str,
) -> Result<AuthenticatedExchange, AuthHttpError> {
    let mut form = vec![("grant_type", "client_credentials")];
    if !scope.trim().is_empty() {
        form.push(("scope", scope));
    }

    let token_response = client
        .post(token_url)
        .basic_auth(client_id, Some(client_secret))
        .form(&form)
        .send()
        .await?;

    if !token_response.status().is_success() {
        return Err(AuthHttpError::TokenStatus(token_response.status()));
    }

    let token_body: TokenResponse = token_response
        .json()
        .await
        .map_err(|error| AuthHttpError::TokenResponse(error.to_string()))?;

    execute_and_capture(client, request.bearer_auth(token_body.access_token)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{basic_auth, body_string, header, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn sends_without_authorization_when_authentication_is_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client.get(server.uri());

        let exchange = send_authenticated(&client, request, &Authentication::None)
            .await
            .unwrap();

        assert_eq!(exchange.response.status(), 200);
        assert!(
            !exchange
                .request_headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        );
    }

    #[tokio::test]
    async fn captures_the_authorization_header_injected_by_bearer_auth() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("Authorization", "Bearer secret-token"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client.get(server.uri());
        let authentication = Authentication::Bearer {
            token: "secret-token".to_string(),
        };

        let exchange = send_authenticated(&client, request, &authentication)
            .await
            .unwrap();

        assert_eq!(exchange.response.status(), 200);
        assert!(exchange.request_headers.contains(&(
            "authorization".to_string(),
            "Bearer secret-token".to_string()
        )));
    }

    #[tokio::test]
    async fn bearer_authentication_replaces_a_manual_authorization_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("Authorization", "Bearer configured-token"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client
            .get(server.uri())
            .header("Authorization", "Bearer manual-token");
        let authentication = Authentication::Bearer {
            token: "configured-token".to_string(),
        };

        let exchange = send_authenticated(&client, request, &authentication)
            .await
            .unwrap();
        let authorization_headers = exchange
            .request_headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .collect::<Vec<_>>();

        assert_eq!(exchange.response.status(), 200);
        assert_eq!(authorization_headers.len(), 1);
        assert_eq!(authorization_headers[0].1, "Bearer configured-token");
    }

    #[tokio::test]
    async fn custom_authorization_replaces_a_manual_authorization_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("Authorization", "Custom configured-token"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client
            .get(server.uri())
            .header("Authorization", "Bearer manual-token");
        let authentication = Authentication::CustomHeader {
            name: "Authorization".to_string(),
            value: "Custom configured-token".to_string(),
        };

        let exchange = send_authenticated(&client, request, &authentication)
            .await
            .unwrap();
        let authorization_headers = exchange
            .request_headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .collect::<Vec<_>>();

        assert_eq!(exchange.response.status(), 200);
        assert_eq!(authorization_headers.len(), 1);
        assert_eq!(authorization_headers[0].1, "Custom configured-token");
    }

    #[tokio::test]
    async fn sends_the_custom_header_and_captures_it() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("X-Api-Key", "k-123"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client.get(server.uri());
        let authentication = Authentication::CustomHeader {
            name: "X-Api-Key".to_string(),
            value: "k-123".to_string(),
        };

        let exchange = send_authenticated(&client, request, &authentication)
            .await
            .unwrap();

        assert_eq!(exchange.response.status(), 200);
        assert!(
            exchange
                .request_headers
                .contains(&("x-api-key".to_string(), "k-123".to_string()))
        );
    }

    #[tokio::test]
    async fn captures_the_authorization_header_injected_by_basic_auth() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(basic_auth("user", "pass"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client.get(server.uri());
        let authentication = Authentication::Basic {
            username: "user".to_string(),
            password: "pass".to_string(),
        };

        let exchange = send_authenticated(&client, request, &authentication)
            .await
            .unwrap();

        assert_eq!(exchange.response.status(), 200);
        assert!(
            exchange
                .request_headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        );
    }

    #[tokio::test]
    async fn resolves_a_digest_challenge_and_retries() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .respond_with(ResponseTemplate::new(401).insert_header(
                "WWW-Authenticate",
                r#"Digest realm="test", qop="auth", nonce="abc123", algorithm=MD5"#,
            ))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .and(header_exists("Authorization"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client.get(format!("{}/protected", server.uri()));
        let authentication = Authentication::Digest {
            username: "user".to_string(),
            password: "pass".to_string(),
        };

        let exchange = send_authenticated(&client, request, &authentication)
            .await
            .unwrap();

        assert_eq!(exchange.response.status(), 200);
        assert!(
            exchange
                .request_headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        );
    }

    #[tokio::test]
    async fn fetches_a_token_and_sends_it_as_bearer() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(basic_auth("client-id", "client-secret"))
            .and(body_string("grant_type=client_credentials&scope=read"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "issued-token",
                "token_type": "Bearer"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/resource"))
            .and(header("Authorization", "Bearer issued-token"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client.get(format!("{}/resource", server.uri()));
        let authentication = Authentication::OAuth2ClientCredentials {
            client_id: "client-id".to_string(),
            client_secret: "client-secret".to_string(),
            token_url: format!("{}/token", server.uri()),
            scope: "read".to_string(),
        };

        let exchange = send_authenticated(&client, request, &authentication)
            .await
            .unwrap();

        assert_eq!(exchange.response.status(), 200);
        assert!(exchange.request_headers.contains(&(
            "authorization".to_string(),
            "Bearer issued-token".to_string()
        )));
    }

    #[tokio::test]
    async fn fails_descriptively_when_the_token_endpoint_rejects_the_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let client = Client::new();
        let request = client.get(server.uri());
        let authentication = Authentication::OAuth2ClientCredentials {
            client_id: "client-id".to_string(),
            client_secret: "wrong-secret".to_string(),
            token_url: format!("{}/token", server.uri()),
            scope: String::new(),
        };

        let error = send_authenticated(&client, request, &authentication)
            .await
            .unwrap_err();

        match error {
            AuthHttpError::TokenStatus(status) => assert_eq!(status, StatusCode::UNAUTHORIZED),
            other => panic!("esperava AuthHttpError::TokenStatus, obteve {other:?}"),
        }
    }
}
