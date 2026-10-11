use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use crate::client::GitlabClient;

/// Renova o token quando faltam menos de 60 s para expirar.
const EXPIRY_MARGIN_SECS: u64 = 60;
const SCOPES: &str = "api";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OAuthError {
    #[error("falha ao gerar valores aleatórios: {0}")]
    Random(String),
    #[error("URL da instância inválida")]
    InvalidUrl,
    #[error("falha de rede: {0}")]
    Network(String),
    /// O GitLab recusou o pedido (ex.: código expirado, refresh inválido).
    #[error("{description}")]
    Rejected { error: String, description: String },
    #[error("resposta inesperada do GitLab: {0}")]
    InvalidResponse(String),
}

/// Par de tokens de uma conta. Vive só no chaveiro do sistema; o `Debug`
/// nunca mostra os valores.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Segundos desde a época Unix em que o access token expira.
    pub expires_at: Option<u64>,
}

impl fmt::Debug for TokenSet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TokenSet")
            .field("access_token", &"<redigido>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redigido>"),
            )
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl TokenSet {
    pub fn is_expiring(&self, now: u64) -> bool {
        self.expires_at
            .is_some_and(|expires_at| now + EXPIRY_MARGIN_SECS >= expires_at)
    }
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Verificador PKCE e o desafio (S256) derivado dele.
pub struct PkceChallenge {
    pub verifier: String,
    pub challenge: String,
}

impl fmt::Debug for PkceChallenge {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PkceChallenge")
            .field("verifier", &"<redigido>")
            .finish()
    }
}

impl PkceChallenge {
    pub fn generate() -> Result<Self, OAuthError> {
        let verifier = random_token()?;
        let challenge = challenge_for(&verifier);
        Ok(Self {
            verifier,
            challenge,
        })
    }
}

pub(crate) fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Valor aleatório de 256 bits em base64url (43 caracteres).
fn random_token() -> Result<String, OAuthError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| OAuthError::Random(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Valor aleatório para o parâmetro `state` do login.
pub fn generate_state() -> Result<String, OAuthError> {
    random_token()
}

/// URL do navegador para autorizar o Alcy na instância.
pub fn authorization_url(
    base_url: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> Result<String, OAuthError> {
    let mut url =
        Url::parse(&format!("{base_url}/oauth/authorize")).map_err(|_| OAuthError::InvalidUrl)?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", SCOPES);
    Ok(url.into())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    created_at: Option<u64>,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
    error_description: Option<String>,
}

impl GitlabClient {
    /// Troca o código de autorização pelo par de tokens.
    pub async fn exchange_code(
        &self,
        base_url: &str,
        client_id: &str,
        redirect_uri: &str,
        code: &str,
        verifier: &str,
    ) -> Result<TokenSet, OAuthError> {
        self.token_request(
            base_url,
            &[
                ("client_id", client_id),
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("code_verifier", verifier),
            ],
        )
        .await
    }

    /// Renova o par de tokens (o refresh token é rotativo).
    pub async fn refresh_tokens(
        &self,
        base_url: &str,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<TokenSet, OAuthError> {
        let mut tokens = self
            .token_request(
                base_url,
                &[
                    ("client_id", client_id),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                ],
            )
            .await?;
        // Se o servidor não devolver um refresh novo, o atual continua valendo.
        if tokens.refresh_token.is_none() {
            tokens.refresh_token = Some(refresh_token.to_string());
        }
        Ok(tokens)
    }

    async fn token_request(
        &self,
        base_url: &str,
        form: &[(&str, &str)],
    ) -> Result<TokenSet, OAuthError> {
        let response = self
            .http()
            .await
            .post(format!("{base_url}/oauth/token"))
            .form(form)
            .send()
            .await
            .map_err(|error| OAuthError::Network(error.without_url().to_string()))?;

        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| OAuthError::Network(error.without_url().to_string()))?;

        if !status.is_success() {
            return Err(match serde_json::from_slice::<ErrorResponse>(&body) {
                Ok(parsed) => OAuthError::Rejected {
                    description: parsed
                        .error_description
                        .unwrap_or_else(|| parsed.error.clone()),
                    error: parsed.error,
                },
                Err(_) => OAuthError::InvalidResponse(format!("HTTP {status}")),
            });
        }

        let parsed: TokenResponse = serde_json::from_slice(&body)
            .map_err(|error| OAuthError::InvalidResponse(error.to_string()))?;
        let expires_at = parsed.expires_in.map(|expires_in| {
            parsed
                .created_at
                .filter(|created_at| *created_at > 0)
                .unwrap_or_else(unix_now)
                + expires_in
        });
        Ok(TokenSet {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            expires_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn challenge_matches_the_rfc_7636_example() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_values_are_random_url_safe_and_long_enough() {
        let first = PkceChallenge::generate().unwrap();
        let second = PkceChallenge::generate().unwrap();
        assert_ne!(first.verifier, second.verifier);
        assert_eq!(first.verifier.len(), 43);
        assert_eq!(first.challenge, challenge_for(&first.verifier));
        assert_ne!(generate_state().unwrap(), generate_state().unwrap());
        assert!(!format!("{first:?}").contains(&first.verifier));
    }

    #[test]
    fn builds_the_authorization_url() {
        let url = authorization_url(
            "https://git.corp.local/gitlab",
            "cid",
            "http://127.0.0.1:53682/callback",
            "st",
            "chal",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.path(), "/gitlab/oauth/authorize");
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        for (key, value) in [
            ("client_id", "cid"),
            ("redirect_uri", "http://127.0.0.1:53682/callback"),
            ("response_type", "code"),
            ("state", "st"),
            ("code_challenge", "chal"),
            ("code_challenge_method", "S256"),
            ("scope", "api"),
        ] {
            assert!(
                pairs.contains(&(key.to_string(), value.to_string())),
                "faltou {key}={value}"
            );
        }
    }

    #[test]
    fn token_debug_never_shows_secrets() {
        let tokens = TokenSet {
            access_token: "segredo-a".into(),
            refresh_token: Some("segredo-r".into()),
            expires_at: Some(10),
        };
        let shown = format!("{tokens:?}");
        assert!(!shown.contains("segredo"));
    }

    #[test]
    fn expiry_uses_a_safety_margin() {
        let tokens = TokenSet {
            access_token: "a".into(),
            refresh_token: None,
            expires_at: Some(1_000),
        };
        assert!(!tokens.is_expiring(900));
        assert!(tokens.is_expiring(940));
        let no_expiry = TokenSet {
            expires_at: None,
            ..tokens
        };
        assert!(!no_expiry.is_expiring(u64::MAX / 2));
    }

    #[tokio::test]
    async fn exchanges_the_code_for_tokens() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .and(body_string_contains("code=abc"))
            .and(body_string_contains("code_verifier=ver"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "acc", "refresh_token": "ref",
                "expires_in": 7200, "created_at": 1000, "token_type": "Bearer"
            })))
            .mount(&server)
            .await;

        let tokens = GitlabClient::new()
            .exchange_code(
                &server.uri(),
                "cid",
                "http://127.0.0.1:1/callback",
                "abc",
                "ver",
            )
            .await
            .unwrap();

        assert_eq!(tokens.access_token, "acc");
        assert_eq!(tokens.refresh_token.as_deref(), Some("ref"));
        assert_eq!(tokens.expires_at, Some(8200));
    }

    #[tokio::test]
    async fn surfaces_oauth_rejections_without_leaking_the_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_grant", "error_description": "Código expirado"
            })))
            .mount(&server)
            .await;

        let error = GitlabClient::new()
            .refresh_tokens(&server.uri(), "cid", "ref-antigo")
            .await
            .unwrap_err();

        assert_eq!(
            error,
            OAuthError::Rejected {
                error: "invalid_grant".into(),
                description: "Código expirado".into()
            }
        );
        assert!(!error.to_string().contains("ref-antigo"));
    }

    #[tokio::test]
    async fn refresh_keeps_the_old_refresh_token_when_none_is_returned() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "novo", "expires_in": 60
            })))
            .mount(&server)
            .await;

        let tokens = GitlabClient::new()
            .refresh_tokens(&server.uri(), "cid", "ref-antigo")
            .await
            .unwrap();

        assert_eq!(tokens.access_token, "novo");
        assert_eq!(tokens.refresh_token.as_deref(), Some("ref-antigo"));
    }
}
