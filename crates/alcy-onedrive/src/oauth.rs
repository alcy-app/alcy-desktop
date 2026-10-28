use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use crate::client::OnedriveClient;

/// Renews the access token when it has less than 60 s left.
const EXPIRY_MARGIN_SECS: u64 = 60;
/// `offline_access` returns a refresh token; `Files.ReadWrite.All` reaches
/// folders shared by other people and SharePoint libraries;
/// `Team.ReadBasic.All` lists the teams behind the team catalog.
pub(crate) const SCOPES: &str = "offline_access User.Read Files.ReadWrite.All Team.ReadBasic.All";
const MAX_ERROR_DESCRIPTION_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OAuthError {
    #[error("falha ao gerar valores aleatórios: {0}")]
    Random(String),
    #[error("tenant ou endereço de login inválido")]
    InvalidUrl,
    #[error("falha de rede: {0}")]
    Network(String),
    /// The identity platform refused the request (expired code, revoked
    /// refresh token, consent required).
    #[error("{description}")]
    Rejected { error: String, description: String },
    #[error("resposta inesperada da Microsoft: {0}")]
    InvalidResponse(String),
}

/// Tokens returned by a login or renewal. The access token only lives in
/// memory; the refresh token goes to the system keyring. `Debug` never shows
/// the values.
#[derive(Clone, PartialEq, Eq)]
pub struct LoginTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Seconds since the Unix epoch when the access token expires.
    pub expires_at: u64,
}

impl fmt::Debug for LoginTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoginTokens")
            .field("access_token", &"<redigido>")
            .field("refresh_token", &"<redigido>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

pub(crate) fn is_expiring(expires_at: u64, now: u64) -> bool {
    now + EXPIRY_MARGIN_SECS >= expires_at
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// PKCE verifier and the challenge (S256) derived from it.
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

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Random 256-bit value in base64url (43 characters).
fn random_token() -> Result<String, OAuthError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| OAuthError::Random(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Random value for the login `state` parameter.
pub fn generate_state() -> Result<String, OAuthError> {
    random_token()
}

/// Browser URL that asks the user to authorize Alcy in the tenant.
pub fn authorization_url(
    login_base: &str,
    tenant: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> Result<String, OAuthError> {
    let mut url = Url::parse(&format!("{login_base}/{tenant}/oauth2/v2.0/authorize"))
        .map_err(|_| OAuthError::InvalidUrl)?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("response_mode", "query")
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", SCOPES)
        .append_pair("prompt", "select_account");
    Ok(url.into())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
    error_description: Option<String>,
}

impl OnedriveClient {
    /// Exchanges the authorization code for tokens.
    pub async fn exchange_code(
        &self,
        tenant: &str,
        client_id: &str,
        redirect_uri: &str,
        code: &str,
        verifier: &str,
    ) -> Result<LoginTokens, OAuthError> {
        let tokens = self
            .token_request(
                tenant,
                &[
                    ("client_id", client_id),
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    ("redirect_uri", redirect_uri),
                    ("code_verifier", verifier),
                    ("scope", SCOPES),
                ],
            )
            .await?;
        let refresh_token = tokens.refresh_token.ok_or_else(|| {
            OAuthError::InvalidResponse("a Microsoft não devolveu o refresh token".into())
        })?;
        Ok(LoginTokens {
            access_token: tokens.access_token,
            refresh_token,
            expires_at: tokens.expires_at,
        })
    }

    /// Renews the tokens. Microsoft rotates refresh tokens; when none comes
    /// back, the current one stays valid.
    pub(crate) async fn refresh_tokens(
        &self,
        tenant: &str,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<LoginTokens, OAuthError> {
        let tokens = self
            .token_request(
                tenant,
                &[
                    ("client_id", client_id),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                    ("scope", SCOPES),
                ],
            )
            .await?;
        Ok(LoginTokens {
            access_token: tokens.access_token,
            refresh_token: tokens
                .refresh_token
                .unwrap_or_else(|| refresh_token.to_string()),
            expires_at: tokens.expires_at,
        })
    }

    async fn token_request(
        &self,
        tenant: &str,
        form: &[(&str, &str)],
    ) -> Result<PartialTokens, OAuthError> {
        let url = Url::parse(&format!("{}/{tenant}/oauth2/v2.0/token", self.login_base()))
            .map_err(|_| OAuthError::InvalidUrl)?;
        let response = self
            .http()
            .await
            .post(url)
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
                        .unwrap_or_else(|| parsed.error.clone())
                        .chars()
                        .take(MAX_ERROR_DESCRIPTION_CHARS)
                        .collect(),
                    error: parsed.error,
                },
                Err(_) => OAuthError::InvalidResponse(format!("HTTP {status}")),
            });
        }

        let parsed: TokenResponse = serde_json::from_slice(&body)
            .map_err(|error| OAuthError::InvalidResponse(error.to_string()))?;
        Ok(PartialTokens {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            // Without `expires_in`, assume the platform's shortest lifetime.
            expires_at: unix_now() + parsed.expires_in.unwrap_or(EXPIRY_MARGIN_SECS * 5),
        })
    }
}

struct PartialTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client(server: &MockServer) -> OnedriveClient {
        OnedriveClient::with_endpoints(&server.uri(), &server.uri())
    }

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
            "https://login.microsoftonline.com",
            "organizations",
            "cid",
            "http://127.0.0.1:53682/callback",
            "st",
            "chal",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.path(), "/organizations/oauth2/v2.0/authorize");
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
            ("scope", SCOPES),
        ] {
            assert!(
                pairs.contains(&(key.to_string(), value.to_string())),
                "missing {key}={value}"
            );
        }
    }

    #[test]
    fn token_debug_never_shows_secrets() {
        let tokens = LoginTokens {
            access_token: "secret-a".into(),
            refresh_token: "secret-r".into(),
            expires_at: 10,
        };
        assert!(!format!("{tokens:?}").contains("secret"));
    }

    #[test]
    fn expiry_uses_a_safety_margin() {
        assert!(!is_expiring(1_000, 900));
        assert!(is_expiring(1_000, 940));
    }

    #[tokio::test]
    async fn exchanges_the_code_for_tokens() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/common/oauth2/v2.0/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .and(body_string_contains("code=abc"))
            .and(body_string_contains("code_verifier=ver"))
            .and(body_string_contains("offline_access"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "acc", "refresh_token": "ref",
                "expires_in": 3600, "token_type": "Bearer"
            })))
            .mount(&server)
            .await;

        let before = unix_now();
        let tokens = client(&server)
            .exchange_code("common", "cid", "http://127.0.0.1:1/callback", "abc", "ver")
            .await
            .unwrap();

        assert_eq!(tokens.access_token, "acc");
        assert_eq!(tokens.refresh_token, "ref");
        assert!(tokens.expires_at >= before + 3600);
    }

    #[tokio::test]
    async fn login_without_a_refresh_token_is_refused() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/common/oauth2/v2.0/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "access_token": "acc" })),
            )
            .mount(&server)
            .await;

        let error = client(&server)
            .exchange_code("common", "cid", "http://127.0.0.1:1/callback", "c", "v")
            .await
            .unwrap_err();
        assert!(matches!(error, OAuthError::InvalidResponse(_)));
    }

    #[tokio::test]
    async fn surfaces_oauth_rejections_without_leaking_the_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/common/oauth2/v2.0/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_grant", "error_description": "AADSTS70008: expired"
            })))
            .mount(&server)
            .await;

        let error = client(&server)
            .refresh_tokens("common", "cid", "old-refresh")
            .await
            .unwrap_err();

        assert_eq!(
            error,
            OAuthError::Rejected {
                error: "invalid_grant".into(),
                description: "AADSTS70008: expired".into()
            }
        );
        assert!(!error.to_string().contains("old-refresh"));
    }

    #[tokio::test]
    async fn refresh_keeps_the_old_refresh_token_when_none_is_returned() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/common/oauth2/v2.0/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "new", "expires_in": 60
            })))
            .mount(&server)
            .await;

        let tokens = client(&server)
            .refresh_tokens("common", "cid", "old-refresh")
            .await
            .unwrap();

        assert_eq!(tokens.access_token, "new");
        assert_eq!(tokens.refresh_token, "old-refresh");
    }
}
