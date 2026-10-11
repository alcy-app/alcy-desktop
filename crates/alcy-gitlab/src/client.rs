use std::sync::Arc;
use std::time::Duration;

use alcy_app::{CredentialStore, RemoteError};
use alcy_domain::GitlabAccount;
use alcy_http_proxy::{ProxyError, ProxyPlan, SharedHttpClient};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::oauth::{OAuthError, TokenSet, unix_now};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PAGE_SIZE: &str = "30";
const MAX_ERROR_MESSAGE_CHARS: usize = 300;
pub(crate) const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// Chave do chaveiro para os tokens de uma conta.
pub fn credential_key(account_id: &str) -> String {
    format!("gitlab:{account_id}")
}

/// Identificador estável de uma conta (mesmo usuário na mesma instância).
pub fn account_id(base_url: &str, username: &str) -> String {
    let host = base_url
        .split_once("://")
        .map_or(base_url, |(_, rest)| rest);
    format!("{username}@{host}")
}

pub fn save_tokens(
    credentials: &dyn CredentialStore,
    account_id: &str,
    tokens: &TokenSet,
) -> Result<(), RemoteError> {
    let json = serde_json::to_string(tokens)
        .map_err(|error| RemoteError::Credentials(error.to_string()))?;
    credentials
        .save(&credential_key(account_id), &json)
        .map_err(|error| RemoteError::Credentials(error.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GitlabUser {
    pub username: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GitlabProject {
    pub id: u64,
    pub path_with_namespace: String,
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GitlabBranch {
    pub name: String,
    #[serde(rename = "default")]
    pub is_default: bool,
    pub can_push: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_page: Option<u32>,
}

/// Cliente HTTP do GitLab. Compartilha proxy e certificados com o resto do
/// app (`SharedHttpClient`) e serializa a renovação de tokens.
pub struct GitlabClient {
    http: SharedHttpClient,
    refresh_lock: Mutex<()>,
}

impl GitlabClient {
    pub fn new() -> Self {
        Self {
            http: SharedHttpClient::new(REQUEST_TIMEOUT),
            refresh_lock: Mutex::new(()),
        }
    }

    /// Passa a usar `plan` (proxy) nas próximas requisições.
    pub fn reconfigure_proxy(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.http.reconfigure(plan)
    }

    pub fn set_custom_ca_certificates(&self, certificates: &[String]) -> Result<(), ProxyError> {
        self.http.set_custom_ca_certificates(certificates)
    }

    pub(crate) async fn http(&self) -> Client {
        self.http.get().await
    }

    /// Sessão autenticada de uma conta, com tokens lidos do chaveiro.
    pub fn session<'a>(
        &'a self,
        account: &'a GitlabAccount,
        credentials: &'a dyn CredentialStore,
    ) -> GitlabSession<'a> {
        GitlabSession {
            client: self,
            account,
            credentials,
            tokens: Arc::new(Mutex::new(None)),
        }
    }

    /// Usuário dono de um access token recém-obtido (antes de a conta existir).
    pub async fn fetch_user(
        &self,
        base_url: &str,
        access_token: &str,
    ) -> Result<GitlabUser, RemoteError> {
        let response = self
            .http()
            .await
            .get(format!("{base_url}/api/v4/user"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(network_error)?;
        parse_json(check(response).await?).await
    }
}

impl Default for GitlabClient {
    fn default() -> Self {
        Self::new()
    }
}

pub struct GitlabSession<'a> {
    client: &'a GitlabClient,
    account: &'a GitlabAccount,
    credentials: &'a dyn CredentialStore,
    /// Compartilhado pelos repositórios criados a partir desta sessão para
    /// que requisições paralelas da mesma operação leiam o chaveiro uma vez.
    tokens: Arc<Mutex<Option<TokenSet>>>,
}

impl<'a> GitlabSession<'a> {
    pub(crate) fn api_url(&self, path: &str) -> String {
        format!("{}/api/v4{path}", self.account.base_url)
    }

    pub async fn current_user(&self) -> Result<GitlabUser, RemoteError> {
        let url = self.api_url("/user");
        let response = self
            .send(|client, token| client.get(&url).bearer_auth(token))
            .await?;
        parse_json(check(response).await?).await
    }

    pub async fn list_projects(
        &self,
        search: &str,
        page: u32,
    ) -> Result<Page<GitlabProject>, RemoteError> {
        let url = self.api_url("/projects");
        let page = page.max(1).to_string();
        let response = self
            .send(|client, token| {
                let mut request = client.get(&url).bearer_auth(token).query(&[
                    ("membership", "true"),
                    ("min_access_level", "30"),
                    ("simple", "true"),
                    ("order_by", "last_activity_at"),
                    ("per_page", PAGE_SIZE),
                    ("page", page.as_str()),
                ]);
                if !search.trim().is_empty() {
                    request = request.query(&[("search", search.trim())]);
                }
                request
            })
            .await?;
        parse_page(check(response).await?).await
    }

    pub async fn list_branches(
        &self,
        project_id: u64,
        search: &str,
        page: u32,
    ) -> Result<Page<GitlabBranch>, RemoteError> {
        let url = self.api_url(&format!("/projects/{project_id}/repository/branches"));
        let page = page.max(1).to_string();
        let response = self
            .send(|client, token| {
                let mut request = client
                    .get(&url)
                    .bearer_auth(token)
                    .query(&[("per_page", PAGE_SIZE), ("page", page.as_str())]);
                if !search.trim().is_empty() {
                    request = request.query(&[("search", search.trim())]);
                }
                request
            })
            .await?;
        parse_page(check(response).await?).await
    }

    /// Consulta novamente a branch antes do vínculo, pois a permissão pode
    /// ter mudado desde que a lista foi exibida.
    pub async fn branch(&self, project_id: u64, branch: &str) -> Result<GitlabBranch, RemoteError> {
        let encoded = utf8_percent_encode(branch, PATH_SEGMENT);
        let url = self.api_url(&format!(
            "/projects/{project_id}/repository/branches/{encoded}"
        ));
        let response = self
            .send(|client, token| client.get(&url).bearer_auth(token))
            .await?;
        parse_json(check(response).await?).await
    }

    /// Envia a requisição montada por `build` com o access token da conta.
    /// Renova o token antes (se estiver perto de expirar) ou uma vez após um
    /// 401; um segundo 401 significa sessão expirada.
    pub(crate) async fn send<F>(&self, build: F) -> Result<Response, RemoteError>
    where
        F: Fn(&Client, &str) -> RequestBuilder + Send + Sync,
    {
        let mut tokens = self.load_tokens().await?;
        if tokens.is_expiring(unix_now()) {
            tokens = self.refresh(&tokens.access_token).await?;
        }

        let response = build(&self.client.http().await, &tokens.access_token)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }

        let tokens = self.refresh(&tokens.access_token).await?;
        build(&self.client.http().await, &tokens.access_token)
            .send()
            .await
            .map_err(network_error)
    }

    /// Access token válido da conta (renovado antes se estiver perto de
    /// expirar), para clientes HTTP fora desta sessão — ex.: o updater, que
    /// usa o próprio cliente. Nunca deve ser registrado em log.
    pub async fn access_token(&self) -> Result<String, RemoteError> {
        let tokens = self.load_tokens().await?;
        if tokens.is_expiring(unix_now()) {
            return Ok(self.refresh(&tokens.access_token).await?.access_token);
        }
        Ok(tokens.access_token)
    }

    async fn load_tokens(&self) -> Result<TokenSet, RemoteError> {
        let mut cached = self.tokens.lock().await;
        if let Some(tokens) = cached.as_ref() {
            return Ok(tokens.clone());
        }
        let tokens = self.load_tokens_from_store()?;
        *cached = Some(tokens.clone());
        Ok(tokens)
    }

    fn load_tokens_from_store(&self) -> Result<TokenSet, RemoteError> {
        let stored = self
            .credentials
            .load(&credential_key(&self.account.id))
            .map_err(|error| RemoteError::Credentials(error.to_string()))?
            .ok_or(RemoteError::Unauthorized)?;
        serde_json::from_str(&stored).map_err(|_| RemoteError::Unauthorized)
    }

    /// Renova os tokens. `stale_access` é o token que falhou: se outro
    /// chamador já renovou enquanto esperávamos o lock, usa o novo.
    async fn refresh(&self, stale_access: &str) -> Result<TokenSet, RemoteError> {
        let _guard = self.client.refresh_lock.lock().await;

        // Outra sessão pode ter renovado enquanto esperávamos o lock global;
        // confira a fonte autoritativa e atualize o cache desta operação.
        let current = self.load_tokens_from_store()?;
        if current.access_token != stale_access {
            *self.tokens.lock().await = Some(current.clone());
            return Ok(current);
        }
        let refresh_token = current.refresh_token.ok_or(RemoteError::Unauthorized)?;

        let renewed = self
            .client
            .refresh_tokens(
                &self.account.base_url,
                &self.account.client_id,
                &refresh_token,
            )
            .await
            .map_err(|error| match error {
                OAuthError::Network(message) => RemoteError::Network(message),
                _ => RemoteError::Unauthorized,
            })?;
        save_tokens(self.credentials, &self.account.id, &renewed)?;
        *self.tokens.lock().await = Some(renewed.clone());
        Ok(renewed)
    }

    pub fn repository(&self, project_id: u64, branch: &str) -> crate::GitlabRepository<'a> {
        crate::GitlabRepository::new(
            GitlabSession {
                client: self.client,
                account: self.account,
                credentials: self.credentials,
                tokens: Arc::clone(&self.tokens),
            },
            project_id,
            branch,
        )
    }
}

pub(crate) fn network_error(error: reqwest::Error) -> RemoteError {
    // A URL pode carregar identificadores; a mensagem não precisa dela.
    RemoteError::Network(error.without_url().to_string())
}

/// Corpo de erro do GitLab (`message` como texto ou objeto, ou `error`).
pub(crate) async fn error_message(response: Response) -> String {
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let message = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .map(|message| match message {
                    serde_json::Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
        })
        .unwrap_or_else(|| format!("HTTP {status}"));
    message.chars().take(MAX_ERROR_MESSAGE_CHARS).collect()
}

/// Converte respostas de erro em `RemoteError`.
pub(crate) async fn check(response: Response) -> Result<Response, RemoteError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let message = error_message(response).await;
    Err(match status.as_u16() {
        401 => RemoteError::Unauthorized,
        403 => RemoteError::Rejected(format!("sem permissão: {message}")),
        404 => RemoteError::NotFound(message),
        409 => RemoteError::Conflict,
        _ => RemoteError::Rejected(message),
    })
}

pub(crate) async fn parse_json<T: serde::de::DeserializeOwned>(
    response: Response,
) -> Result<T, RemoteError> {
    let body = response.bytes().await.map_err(network_error)?;
    serde_json::from_slice(&body)
        .map_err(|error| RemoteError::Rejected(format!("resposta inesperada: {error}")))
}

async fn parse_page<T: serde::de::DeserializeOwned>(
    response: Response,
) -> Result<Page<T>, RemoteError> {
    let next_page = response
        .headers()
        .get("x-next-page")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok());
    Ok(Page {
        items: parse_json(response).await?,
        next_page,
    })
}
