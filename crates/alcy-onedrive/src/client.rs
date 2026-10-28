use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use alcy_app::{CredentialStore, RemoteError};
use alcy_domain::OnedriveAccount;
use alcy_http_proxy::{ProxyError, ProxyPlan, SharedHttpClient};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::header::RETRY_AFTER;
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::oauth::{LoginTokens, OAuthError, is_expiring, unix_now};

const LOGIN_BASE: &str = "https://login.microsoftonline.com";
const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PAGE_SIZE: &str = "100";
const MAX_ERROR_MESSAGE_CHARS: usize = 300;
/// Longest `Retry-After` honored before giving up on a throttled request.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);
/// Content hashes kept for items whose metadata has no SHA-256.
const MAX_CACHED_HASHES: usize = 256;
pub(crate) const ITEM_SELECT: &str = "id,name,eTag,cTag,file,folder,parentReference,root";
/// A drive or item id as one URL path segment. `!` stays as is: SharePoint
/// drive ids start with `b!`.
pub(crate) const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'!');

/// Keyring entry holding an account's refresh token.
pub fn credential_key(account_id: &str) -> String {
    format!("onedrive:{account_id}")
}

/// Stable account identifier: the user principal name, unique across
/// tenants because it carries the domain.
pub fn account_id(user: &OnedriveUser) -> String {
    user.user_principal_name.trim().to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnedriveUser {
    pub display_name: Option<String>,
    pub user_principal_name: String,
}

/// A folder the workspace can be linked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFolder {
    pub drive_id: String,
    pub id: String,
    pub name: String,
    /// Path shown to the user (`/Equipe/Alcy`); only the ids address it.
    pub path: String,
    pub child_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderPage {
    pub items: Vec<DriveFolder>,
    /// Opaque Graph URL for the next page.
    pub next_link: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphItem {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub e_tag: Option<String>,
    pub c_tag: Option<String>,
    pub file: Option<FileFacet>,
    pub folder: Option<FolderFacet>,
    pub parent_reference: Option<ParentReference>,
    pub root: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FileFacet {
    pub hashes: Option<Hashes>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hashes {
    pub sha256_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderFacet {
    pub child_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParentReference {
    pub drive_id: Option<String>,
    pub path: Option<String>,
}

#[derive(Deserialize)]
struct ItemPage {
    value: Vec<GraphItem>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Deserialize)]
struct Drive {
    id: String,
}

#[derive(Clone, PartialEq, Eq)]
struct AccessToken {
    value: String,
    expires_at: u64,
}

impl fmt::Debug for AccessToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AccessToken")
            .field("value", &"<redigido>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// Microsoft Graph client. Shares proxy and certificates with the rest of the
/// app (`SharedHttpClient`), keeps access tokens in memory only and
/// serializes token renewal.
pub struct OnedriveClient {
    http: SharedHttpClient,
    login_base: String,
    graph_base: String,
    refresh_lock: Mutex<()>,
    access_tokens: Mutex<HashMap<String, AccessToken>>,
    /// `cTag` → SHA-256 for drives whose metadata only has `quickXorHash`.
    hashes: std::sync::Mutex<HashMap<String, String>>,
}

impl OnedriveClient {
    pub fn new() -> Self {
        Self::with_endpoints(LOGIN_BASE, GRAPH_BASE)
    }

    /// Client pointed at other endpoints (tests and national clouds).
    pub fn with_endpoints(login_base: &str, graph_base: &str) -> Self {
        Self {
            http: SharedHttpClient::new(REQUEST_TIMEOUT),
            login_base: login_base.trim_end_matches('/').to_string(),
            graph_base: graph_base.trim_end_matches('/').to_string(),
            refresh_lock: Mutex::new(()),
            access_tokens: Mutex::new(HashMap::new()),
            hashes: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Uses `plan` (proxy) for the next requests.
    pub fn reconfigure_proxy(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.http.reconfigure(plan)
    }

    pub fn set_custom_ca_certificates(&self, certificates: &[String]) -> Result<(), ProxyError> {
        self.http.set_custom_ca_certificates(certificates)
    }

    pub fn login_base(&self) -> &str {
        &self.login_base
    }

    pub(crate) fn graph_url(&self, path: &str) -> String {
        format!("{}{path}", self.graph_base)
    }

    pub(crate) async fn http(&self) -> Client {
        self.http.get().await
    }

    /// Authenticated session for an account; the refresh token is read from
    /// the keyring only when the access token in memory is missing or
    /// expiring.
    pub fn session<'a>(
        &'a self,
        account: &'a OnedriveAccount,
        credentials: &'a dyn CredentialStore,
    ) -> OnedriveSession<'a> {
        OnedriveSession {
            client: self,
            account,
            credentials,
        }
    }

    /// Owner of a freshly obtained access token (before the account exists).
    pub async fn fetch_user(&self, access_token: &str) -> Result<OnedriveUser, RemoteError> {
        let response = self
            .http()
            .await
            .get(self.graph_url("/me"))
            .query(&[("$select", "displayName,userPrincipalName")])
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(network_error)?;
        parse_json(check(response).await?).await
    }

    /// Keeps a new login: the refresh token goes to the keyring, the access
    /// token stays in memory.
    pub async fn store_login(
        &self,
        credentials: &dyn CredentialStore,
        account_id: &str,
        tokens: &LoginTokens,
    ) -> Result<(), RemoteError> {
        credentials
            .save(&credential_key(account_id), &tokens.refresh_token)
            .map_err(|error| RemoteError::Credentials(error.to_string()))?;
        self.access_tokens.lock().await.insert(
            account_id.to_string(),
            AccessToken {
                value: tokens.access_token.clone(),
                expires_at: tokens.expires_at,
            },
        );
        Ok(())
    }

    /// Drops the account's access token from memory (logout).
    pub async fn forget(&self, account_id: &str) {
        self.access_tokens.lock().await.remove(account_id);
    }

    pub(crate) fn cached_hash(&self, c_tag: &str) -> Option<String> {
        self.hashes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(c_tag)
            .cloned()
    }

    pub(crate) fn cache_hash(&self, c_tag: &str, sha256: &str) {
        let mut hashes = self
            .hashes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if hashes.len() >= MAX_CACHED_HASHES {
            hashes.clear();
        }
        hashes.insert(c_tag.to_string(), sha256.to_string());
    }
}

impl Default for OnedriveClient {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
pub struct OnedriveSession<'a> {
    pub(crate) client: &'a OnedriveClient,
    account: &'a OnedriveAccount,
    credentials: &'a dyn CredentialStore,
}

impl<'a> OnedriveSession<'a> {
    pub async fn current_user(&self) -> Result<OnedriveUser, RemoteError> {
        let url = self.client.graph_url("/me");
        let response = self
            .send(|client, token| {
                client
                    .get(&url)
                    .query(&[("$select", "displayName,userPrincipalName")])
                    .bearer_auth(token)
            })
            .await?;
        parse_json(check(response).await?).await
    }

    /// Root folder of the user's own OneDrive.
    pub async fn root_folder(&self) -> Result<DriveFolder, RemoteError> {
        let item: GraphItem = self
            .get_json(&self.client.graph_url("/me/drive/root"), ITEM_SELECT)
            .await?;
        let drive_id = match item
            .parent_reference
            .as_ref()
            .and_then(|parent| parent.drive_id.clone())
        {
            Some(drive_id) => drive_id,
            None => {
                let drive: Drive = self
                    .get_json(&self.client.graph_url("/me/drive"), "id")
                    .await?;
                drive.id
            }
        };
        Ok(DriveFolder {
            drive_id,
            id: item.id,
            name: item.name,
            path: "/".to_string(),
            child_count: item.folder.and_then(|folder| folder.child_count),
        })
    }

    /// Reads the folder again before linking: access may have changed since
    /// it was listed.
    pub async fn folder(
        &self,
        drive_id: &str,
        folder_id: &str,
    ) -> Result<DriveFolder, RemoteError> {
        let url = self.client.graph_url(&format!(
            "/drives/{}/items/{}",
            segment(drive_id),
            segment(folder_id)
        ));
        let item: GraphItem = self.get_json(&url, ITEM_SELECT).await?;
        to_folder(item, Some(drive_id))
            .ok_or_else(|| RemoteError::Rejected("o item escolhido não é uma pasta".into()))
    }

    /// Subfolders of `folder_id`, one page at a time.
    /// `next_link` must be the value returned by the previous page.
    pub async fn list_folders(
        &self,
        drive_id: &str,
        folder_id: &str,
        next_link: Option<&str>,
    ) -> Result<FolderPage, RemoteError> {
        let response = match next_link {
            Some(link) => {
                // The link carries the token-bearing request elsewhere only
                // if it points outside Graph; refuse that.
                if !link.starts_with(&format!("{}/", self.client.graph_base)) {
                    return Err(RemoteError::Rejected("link de paginação inesperado".into()));
                }
                self.send(|client, token| client.get(link).bearer_auth(token))
                    .await?
            }
            None => {
                let url = self.client.graph_url(&format!(
                    "/drives/{}/items/{}/children",
                    segment(drive_id),
                    segment(folder_id)
                ));
                self.send(|client, token| {
                    client
                        .get(&url)
                        .query(&[("$select", ITEM_SELECT), ("$top", PAGE_SIZE)])
                        .bearer_auth(token)
                })
                .await?
            }
        };
        let page: ItemPage = parse_json(check(response).await?).await?;
        Ok(FolderPage {
            items: page
                .value
                .into_iter()
                .filter_map(|item| to_folder(item, Some(drive_id)))
                .collect(),
            next_link: page.next_link,
        })
    }

    /// Folder behind a sharing link: the way to reach folders shared by
    /// other people, SharePoint libraries and Teams channels.
    pub async fn resolve_share_link(&self, link: &str) -> Result<DriveFolder, RemoteError> {
        let link = link.trim();
        if !link.starts_with("https://") {
            return Err(RemoteError::Rejected(
                "cole um link de compartilhamento https".into(),
            ));
        }
        let encoded = format!("u!{}", URL_SAFE_NO_PAD.encode(link));
        let url = self
            .client
            .graph_url(&format!("/shares/{encoded}/driveItem"));
        let response = self
            .send(|client, token| {
                client
                    .get(&url)
                    .query(&[("$select", ITEM_SELECT)])
                    // Grants lasting access, so the folder stays reachable
                    // by id after this request.
                    .header("Prefer", "redeemSharingLink")
                    .bearer_auth(token)
            })
            .await?;
        let item: GraphItem = parse_json(check(response).await?).await?;
        to_folder(item, None)
            .ok_or_else(|| RemoteError::Rejected("o link não aponta para uma pasta".into()))
    }

    pub fn repository(&self, drive_id: &str, folder_id: &str) -> crate::OnedriveRepository<'a> {
        crate::OnedriveRepository::new(*self, drive_id, folder_id)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        select: &str,
    ) -> Result<T, RemoteError> {
        let response = self
            .send(|client, token| {
                client
                    .get(url)
                    .query(&[("$select", select)])
                    .bearer_auth(token)
            })
            .await?;
        parse_json(check(response).await?).await
    }

    /// Sends the request built by `build` with the account's access token.
    /// Renews the token first when it is expiring, and once after a 401; a
    /// second 401 means the session expired.
    pub(crate) async fn send<F>(&self, build: F) -> Result<Response, RemoteError>
    where
        F: Fn(&Client, &str) -> RequestBuilder + Send + Sync,
    {
        let token = self.access_token().await?;
        let response = self.send_throttled(&build, &token).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        let token = self.refresh(Some(&token)).await?;
        self.send_throttled(&build, &token).await
    }

    /// Retries once when Graph throttles (429/503) and asks to wait at most
    /// `MAX_RETRY_AFTER`.
    async fn send_throttled<F>(&self, build: &F, token: &str) -> Result<Response, RemoteError>
    where
        F: Fn(&Client, &str) -> RequestBuilder + Send + Sync,
    {
        let response = build(&self.client.http().await, token)
            .send()
            .await
            .map_err(network_error)?;
        let throttled = matches!(
            response.status(),
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
        );
        let wait = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        match wait {
            Some(wait) if throttled && wait <= MAX_RETRY_AFTER => {
                tokio::time::sleep(wait).await;
                build(&self.client.http().await, token)
                    .send()
                    .await
                    .map_err(network_error)
            }
            _ => Ok(response),
        }
    }

    async fn access_token(&self) -> Result<String, RemoteError> {
        let cached = self
            .client
            .access_tokens
            .lock()
            .await
            .get(&self.account.id)
            .cloned();
        match cached {
            Some(token) if !is_expiring(token.expires_at, unix_now()) => Ok(token.value),
            _ => self.refresh(None).await,
        }
    }

    /// Renews the access token. `stale` is the token that failed: when
    /// another caller renewed it while this one waited for the lock, that
    /// new token is used instead.
    async fn refresh(&self, stale: Option<&str>) -> Result<String, RemoteError> {
        let _guard = self.client.refresh_lock.lock().await;

        let current = self
            .client
            .access_tokens
            .lock()
            .await
            .get(&self.account.id)
            .cloned();
        if let Some(current) = current {
            let renewed_meanwhile = stale.is_some_and(|stale| stale != current.value);
            if renewed_meanwhile && !is_expiring(current.expires_at, unix_now()) {
                return Ok(current.value);
            }
        }

        let refresh_token = self
            .credentials
            .load(&credential_key(&self.account.id))
            .map_err(|error| RemoteError::Credentials(error.to_string()))?
            .ok_or(RemoteError::Unauthorized)?;
        let renewed = self
            .client
            .refresh_tokens(
                &self.account.tenant,
                &self.account.client_id,
                &refresh_token,
            )
            .await
            .map_err(|error| match error {
                OAuthError::Network(message) => RemoteError::Network(message),
                _ => RemoteError::Unauthorized,
            })?;
        self.client
            .store_login(self.credentials, &self.account.id, &renewed)
            .await?;
        Ok(renewed.access_token)
    }
}

/// Item → folder; `None` when it is not a folder. Without a drive id in the
/// item, `fallback_drive` (the drive being listed) is used.
fn to_folder(item: GraphItem, fallback_drive: Option<&str>) -> Option<DriveFolder> {
    let folder = item.folder?;
    let parent = item.parent_reference;
    let drive_id = parent
        .as_ref()
        .and_then(|parent| parent.drive_id.clone())
        .or_else(|| fallback_drive.map(str::to_string))?;
    let path = if item.root.is_some() {
        "/".to_string()
    } else {
        match parent
            .and_then(|parent| parent.path)
            .and_then(|path| path.split_once("root:").map(|(_, rest)| rest.to_string()))
        {
            Some(parent_path) => format!("{}/{}", parent_path.trim_end_matches('/'), item.name),
            None => item.name.clone(),
        }
    };
    Some(DriveFolder {
        drive_id,
        id: item.id,
        name: item.name,
        path,
        child_count: folder.child_count,
    })
}

pub(crate) fn segment(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT).to_string()
}

pub(crate) fn network_error(error: reqwest::Error) -> RemoteError {
    // The URL may carry identifiers; the message does not need it.
    RemoteError::Network(error.without_url().to_string())
}

/// Graph error body (`{"error": {"code", "message"}}`).
pub(crate) async fn error_message(response: Response) -> String {
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let message = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            let error = value.get("error")?;
            error
                .get("message")
                .and_then(|message| message.as_str())
                .or_else(|| error.get("code").and_then(|code| code.as_str()))
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("HTTP {status}"));
    message.chars().take(MAX_ERROR_MESSAGE_CHARS).collect()
}

/// Turns error responses into `RemoteError`. 409 and 412 mean the item
/// changed since it was read (ADR 0063).
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
        409 | 412 => RemoteError::Conflict,
        413 => RemoteError::TooLarge,
        429 | 503 => RemoteError::Network(format!(
            "a Microsoft limitou as requisições; tente de novo em instantes ({message})"
        )),
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use alcy_app::CredentialError;
    use wiremock::matchers::{body_string_contains, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Default)]
    pub(crate) struct MemoryCredentials(pub std::sync::Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentials {
        fn load(&self, key: &str) -> Result<Option<String>, CredentialError> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn save(&self, key: &str, secret: &str) -> Result<(), CredentialError> {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), CredentialError> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    pub(crate) fn account() -> OnedriveAccount {
        OnedriveAccount::new("ana@contoso.com", "common", "cid", "ana@contoso.com", "Ana").unwrap()
    }

    /// Client with a valid access token `acc` and refresh token `ref`.
    pub(crate) async fn logged_in(server: &MockServer) -> (OnedriveClient, MemoryCredentials) {
        let client = OnedriveClient::with_endpoints(&server.uri(), &server.uri());
        let credentials = MemoryCredentials::default();
        client
            .store_login(
                &credentials,
                &account().id,
                &LoginTokens {
                    access_token: "acc".into(),
                    refresh_token: "ref".into(),
                    expires_at: unix_now() + 3600,
                },
            )
            .await
            .unwrap();
        (client, credentials)
    }

    #[test]
    fn account_ids_are_lowercase_principal_names() {
        let user = OnedriveUser {
            display_name: None,
            user_principal_name: " Ana@Contoso.com ".into(),
        };
        assert_eq!(account_id(&user), "ana@contoso.com");
        assert_eq!(credential_key("a@b"), "onedrive:a@b");
    }

    #[test]
    fn folder_paths_come_from_the_parent_reference() {
        let item: GraphItem = serde_json::from_value(serde_json::json!({
            "id": "F1", "name": "Alcy", "folder": { "childCount": 3 },
            "parentReference": { "driveId": "b!d", "path": "/drive/root:/Equipe" }
        }))
        .unwrap();
        let folder = to_folder(item, None).unwrap();
        assert_eq!(folder.path, "/Equipe/Alcy");
        assert_eq!(folder.drive_id, "b!d");
        assert_eq!(folder.child_count, Some(3));

        let top: GraphItem = serde_json::from_value(serde_json::json!({
            "id": "F2", "name": "Top", "folder": {},
            "parentReference": { "path": "/drives/b!d/root:" }
        }))
        .unwrap();
        assert_eq!(to_folder(top, Some("b!d")).unwrap().path, "/Top");

        let file: GraphItem = serde_json::from_value(serde_json::json!({
            "id": "X", "name": "a.json", "file": {}, "parentReference": { "driveId": "d" }
        }))
        .unwrap();
        assert!(to_folder(file, None).is_none());
    }

    #[tokio::test]
    async fn renews_once_after_a_401_and_rotates_the_refresh_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("authorization", "Bearer acc"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/common/oauth2/v2.0/token"))
            .and(body_string_contains("refresh_token=ref"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "acc2", "refresh_token": "ref2", "expires_in": 3600
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("authorization", "Bearer acc2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "displayName": "Ana", "userPrincipalName": "ana@contoso.com"
            })))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let user = client
            .session(&account, &credentials)
            .current_user()
            .await
            .unwrap();

        assert_eq!(user.user_principal_name, "ana@contoso.com");
        assert_eq!(
            credentials.load("onedrive:ana@contoso.com").unwrap(),
            Some("ref2".into())
        );
    }

    #[tokio::test]
    async fn missing_refresh_token_means_unauthorized() {
        let server = MockServer::start().await;
        let client = OnedriveClient::with_endpoints(&server.uri(), &server.uri());
        let credentials = MemoryCredentials::default();
        let account = account();

        let error = client
            .session(&account, &credentials)
            .current_user()
            .await
            .unwrap_err();
        assert_eq!(error, RemoteError::Unauthorized);
    }

    #[tokio::test]
    async fn retries_once_when_throttled() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "userPrincipalName": "ana@contoso.com"
            })))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        assert!(
            client
                .session(&account, &credentials)
                .current_user()
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn long_throttling_is_reported_without_waiting() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "120"))
            .expect(1)
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let error = client
            .session(&account, &credentials)
            .current_user()
            .await
            .unwrap_err();
        assert!(matches!(error, RemoteError::Network(_)));
    }

    #[tokio::test]
    async fn lists_only_folders_and_follows_graph_next_links() {
        let server = MockServer::start().await;
        let next = format!(
            "{}/drives/b!d/items/ROOT/children?$skiptoken=2",
            server.uri()
        );
        Mock::given(method("GET"))
            .and(path("/drives/b!d/items/ROOT/children"))
            .and(query_param("$top", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": [
                    { "id": "F1", "name": "Alcy", "folder": { "childCount": 0 },
                      "parentReference": { "driveId": "b!d", "path": "/drive/root:" } },
                    { "id": "X", "name": "notes.txt", "file": {} }
                ],
                "@odata.nextLink": next
            })))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let session = client.session(&account, &credentials);
        let page = session.list_folders("b!d", "ROOT", None).await.unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].path, "/Alcy");
        assert_eq!(page.next_link.as_deref(), Some(next.as_str()));

        let foreign = session
            .list_folders("b!d", "ROOT", Some("https://evil.example/steal"))
            .await
            .unwrap_err();
        assert!(matches!(foreign, RemoteError::Rejected(_)));
    }

    #[tokio::test]
    async fn resolves_folder_sharing_links() {
        let server = MockServer::start().await;
        let link = "https://contoso.sharepoint.com/:f:/s/team/abc";
        let encoded = format!("u!{}", URL_SAFE_NO_PAD.encode(link));
        Mock::given(method("GET"))
            .and(path(format!("/shares/{encoded}/driveItem")))
            .and(header("prefer", "redeemSharingLink"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "F9", "name": "Alcy", "folder": {},
                "parentReference": { "driveId": "b!team" }
            })))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let session = client.session(&account, &credentials);
        let folder = session.resolve_share_link(link).await.unwrap();

        assert_eq!(folder.drive_id, "b!team");
        assert_eq!(folder.id, "F9");
        assert_eq!(folder.path, "Alcy");
        assert!(matches!(
            session.resolve_share_link("ftp://x").await,
            Err(RemoteError::Rejected(_))
        ));
    }
}
