//! OneDrive account and folder commands (ADR 0063). Version control itself
//! goes through `version_control.rs`, like GitLab.

use std::time::Duration;

use alcy_app::CredentialStore;
use alcy_domain::{OnedriveAccount, OnedriveAccountError};
use alcy_onedrive::{
    DriveFolder, OAuthError, OnedriveClient, PkceChallenge, account_id, authorization_url,
    credential_key, generate_state,
};
use alcy_platform::{CallbackServer, KeyringCredentialStore};
use alcy_storage::OnedriveAccountsStore;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use super::execution_registry::ExecutionRegistry;
use super::remote_command::{RemoteCommandError, cancellable};
use super::remote_content_cache::VersionControlCaches;

/// Time the user has to authorize Alcy in the browser.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Graph client and the known Microsoft accounts, managed together.
pub struct OnedriveProvider {
    pub client: OnedriveClient,
    pub accounts: OnedriveAccountsStore,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnedriveAccountDto {
    pub id: String,
    pub tenant: String,
    pub client_id: String,
    pub username: String,
    pub name: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveFolderDto {
    pub drive_id: String,
    pub id: String,
    pub name: String,
    pub path: String,
    pub child_count: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderPageDto {
    pub items: Vec<DriveFolderDto>,
    pub next_link: Option<String>,
}

impl From<OnedriveAccountError> for RemoteCommandError {
    fn from(error: OnedriveAccountError) -> Self {
        Self::Invalid {
            message: error.to_string(),
        }
    }
}

impl From<OAuthError> for RemoteCommandError {
    fn from(error: OAuthError) -> Self {
        match error {
            OAuthError::Network(message) => Self::Network { message },
            other => Self::Login {
                message: other.to_string(),
            },
        }
    }
}

fn account_dto(account: &OnedriveAccount) -> OnedriveAccountDto {
    OnedriveAccountDto {
        id: account.id.clone(),
        tenant: account.tenant.clone(),
        client_id: account.client_id.clone(),
        username: account.username.clone(),
        name: account.name.clone(),
    }
}

pub fn folder_dto(folder: DriveFolder) -> DriveFolderDto {
    DriveFolderDto {
        drive_id: folder.drive_id,
        id: folder.id,
        name: folder.name,
        path: folder.path,
        child_count: folder.child_count,
    }
}

pub fn find_onedrive_account(
    store: &OnedriveAccountsStore,
    account_id: &str,
) -> Result<OnedriveAccount, RemoteCommandError> {
    store
        .load()?
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or(RemoteCommandError::AccountMissing)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginOnedriveLoginInput {
    pub operation_id: String,
    pub client_id: String,
    #[serde(default)]
    pub tenant: String,
}

/// Full login flow: authorize in the browser, exchange the code, keep the
/// refresh token in the keyring and register the account. `open_browser`
/// receives the authorization URL (separate so tests can simulate it).
async fn complete_login(
    server: CallbackServer,
    input: &BeginOnedriveLoginInput,
    client: &OnedriveClient,
    credentials: &dyn CredentialStore,
    accounts: &OnedriveAccountsStore,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<OnedriveAccount, RemoteCommandError> {
    // Validate tenant and client_id before opening anything.
    let pending = OnedriveAccount::new("pending", &input.tenant, &input.client_id, "", "")?;

    let pkce = PkceChallenge::generate()?;
    let state = generate_state()?;
    let redirect_uri = server.redirect_uri();
    let url = authorization_url(
        client.login_base(),
        &pending.tenant,
        &pending.client_id,
        &redirect_uri,
        &state,
        &pkce.challenge,
    )?;

    open_browser(&url).map_err(|message| RemoteCommandError::Browser { message })?;
    let code = server.wait_for_code(&state, LOGIN_TIMEOUT).await?;

    let tokens = client
        .exchange_code(
            &pending.tenant,
            &pending.client_id,
            &redirect_uri,
            &code,
            &pkce.verifier,
        )
        .await?;
    let user = client.fetch_user(&tokens.access_token).await?;

    let account = OnedriveAccount::new(
        account_id(&user),
        &pending.tenant,
        &pending.client_id,
        user.user_principal_name.trim(),
        user.display_name
            .unwrap_or_else(|| user.user_principal_name.clone()),
    )?;

    client
        .store_login(credentials, &account.id, &tokens)
        .await?;
    if let Err(error) = accounts.upsert(account.clone()) {
        // Without the registered account the token would be orphaned.
        let _ = credentials.delete(&credential_key(&account.id));
        client.forget(&account.id).await;
        return Err(error.into());
    }
    Ok(account)
}

#[tauri::command]
pub fn list_onedrive_accounts(
    onedrive: State<'_, OnedriveProvider>,
) -> Result<Vec<OnedriveAccountDto>, RemoteCommandError> {
    Ok(onedrive.accounts.load()?.iter().map(account_dto).collect())
}

#[tauri::command]
pub async fn begin_onedrive_login(
    input: BeginOnedriveLoginInput,
    app: tauri::AppHandle,
    registry: State<'_, ExecutionRegistry>,
    onedrive: State<'_, OnedriveProvider>,
    credentials: State<'_, KeyringCredentialStore>,
) -> Result<OnedriveAccountDto, RemoteCommandError> {
    let result: Result<OnedriveAccountDto, RemoteCommandError> = async {
        let server = CallbackServer::bind().await?;
        let operation_id = input.operation_id.clone();

        let login = complete_login(
            server,
            &input,
            &onedrive.client,
            &*credentials,
            &onedrive.accounts,
            |url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|error| error.to_string())
            },
        );
        let account = cancellable(&registry, &operation_id, login).await?;
        Ok(account_dto(&account))
    }
    .await;
    crate::logging::logged("alcy::onedrive", "login na Microsoft", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub account_id: String,
}

/// Removes the account and its token from the keyring and memory.
#[tauri::command]
pub async fn logout_onedrive(
    input: AccountInput,
    onedrive: State<'_, OnedriveProvider>,
    credentials: State<'_, KeyringCredentialStore>,
    caches: State<'_, VersionControlCaches>,
) -> Result<(), RemoteCommandError> {
    let result: Result<(), RemoteCommandError> = async {
        credentials
            .delete(&credential_key(&input.account_id))
            .map_err(|error| RemoteCommandError::Credentials {
                message: error.to_string(),
            })?;
        onedrive.client.forget(&input.account_id).await;
        onedrive.accounts.remove(&input.account_id)?;
        caches.clear().await;
        Ok(())
    }
    .await;
    crate::logging::logged("alcy::onedrive", "logout da Microsoft", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderOperationInput {
    pub operation_id: String,
    pub account_id: String,
}

/// Root of the user's own OneDrive, where folder browsing starts.
#[tauri::command]
pub async fn get_onedrive_root(
    input: FolderOperationInput,
    registry: State<'_, ExecutionRegistry>,
    onedrive: State<'_, OnedriveProvider>,
    credentials: State<'_, KeyringCredentialStore>,
) -> Result<DriveFolderDto, RemoteCommandError> {
    let result: Result<DriveFolderDto, RemoteCommandError> = async {
        let account = find_onedrive_account(&onedrive.accounts, &input.account_id)?;
        let session = onedrive.client.session(&account, &*credentials);
        let folder = cancellable(&registry, &input.operation_id, async {
            Ok(session.root_folder().await?)
        })
        .await?;
        Ok(folder_dto(folder))
    }
    .await;
    crate::logging::logged("alcy::onedrive", "abrir raiz do OneDrive", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFoldersInput {
    pub operation_id: String,
    pub account_id: String,
    pub drive_id: String,
    pub folder_id: String,
    #[serde(default)]
    pub next_link: Option<String>,
}

#[tauri::command]
pub async fn list_onedrive_folders(
    input: ListFoldersInput,
    registry: State<'_, ExecutionRegistry>,
    onedrive: State<'_, OnedriveProvider>,
    credentials: State<'_, KeyringCredentialStore>,
) -> Result<FolderPageDto, RemoteCommandError> {
    let result: Result<FolderPageDto, RemoteCommandError> = async {
        let account = find_onedrive_account(&onedrive.accounts, &input.account_id)?;
        let session = onedrive.client.session(&account, &*credentials);
        let page = cancellable(&registry, &input.operation_id, async {
            Ok(session
                .list_folders(
                    &input.drive_id,
                    &input.folder_id,
                    input.next_link.as_deref(),
                )
                .await?)
        })
        .await?;
        Ok(FolderPageDto {
            items: page.items.into_iter().map(folder_dto).collect(),
            next_link: page.next_link,
        })
    }
    .await;
    crate::logging::logged("alcy::onedrive", "listar pastas do OneDrive", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveShareLinkInput {
    pub operation_id: String,
    pub account_id: String,
    pub link: String,
}

/// Folder behind a sharing link (folders shared by other people,
/// SharePoint and Teams).
#[tauri::command]
pub async fn resolve_onedrive_share_link(
    input: ResolveShareLinkInput,
    registry: State<'_, ExecutionRegistry>,
    onedrive: State<'_, OnedriveProvider>,
    credentials: State<'_, KeyringCredentialStore>,
) -> Result<DriveFolderDto, RemoteCommandError> {
    let result: Result<DriveFolderDto, RemoteCommandError> = async {
        let account = find_onedrive_account(&onedrive.accounts, &input.account_id)?;
        let session = onedrive.client.session(&account, &*credentials);
        let folder = cancellable(&registry, &input.operation_id, async {
            Ok(session.resolve_share_link(&input.link).await?)
        })
        .await?;
        Ok(folder_dto(folder))
    }
    .await;
    crate::logging::logged("alcy::onedrive", "abrir link de compartilhamento", result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use alcy_app::CredentialError;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use url::Url;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Default)]
    struct MemoryCredentials(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentials {
        fn load(&self, key: &str) -> Result<Option<String>, CredentialError> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn save(&self, key: &str, secret: &str) -> Result<(), CredentialError> {
            self.0.lock().unwrap().insert(key.into(), secret.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), CredentialError> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn temp_accounts() -> (OnedriveAccountsStore, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!("alcy-onedrive-command-test-{nanos}.json"));
        (OnedriveAccountsStore::new(path.clone()), path)
    }

    /// Simulates the browser: sends the `code` to the local listener with
    /// the received `state`.
    fn fake_browser(code: &'static str) -> impl FnOnce(&str) -> Result<(), String> {
        move |authorization_url: &str| {
            let url = Url::parse(authorization_url).map_err(|error| error.to_string())?;
            let param = |name: &str| {
                url.query_pairs()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default()
            };
            let redirect = Url::parse(&param("redirect_uri")).map_err(|error| error.to_string())?;
            let port = redirect.port().unwrap_or_default();
            let state = param("state");
            tokio::spawn(async move {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                let request =
                    format!("GET /callback?code={code}&state={state} HTTP/1.1\r\nHost: x\r\n\r\n");
                stream.write_all(request.as_bytes()).await.unwrap();
                let mut sink = String::new();
                let _ = stream.read_to_string(&mut sink).await;
            });
            Ok(())
        }
    }

    #[tokio::test]
    async fn login_keeps_only_the_refresh_token_in_the_keyring() {
        let microsoft = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/organizations/oauth2/v2.0/token"))
            .and(body_string_contains("code=code-1"))
            .and(body_string_contains("code_verifier="))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "tok-access-123", "refresh_token": "tok-refresh-456",
                "expires_in": 3600
            })))
            .expect(1)
            .mount(&microsoft)
            .await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("authorization", "Bearer tok-access-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "displayName": "Ana", "userPrincipalName": "Ana@Contoso.com"
            })))
            .mount(&microsoft)
            .await;

        let (accounts, accounts_path) = temp_accounts();
        let credentials = MemoryCredentials::default();
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let client = OnedriveClient::with_endpoints(&microsoft.uri(), &microsoft.uri());
        let input = BeginOnedriveLoginInput {
            operation_id: "login-1".into(),
            client_id: "cid".into(),
            tenant: "organizations".into(),
        };

        let account = complete_login(
            server,
            &input,
            &client,
            &credentials,
            &accounts,
            fake_browser("code-1"),
        )
        .await
        .unwrap();

        assert_eq!(account.id, "ana@contoso.com");
        assert_eq!(account.name, "Ana");
        assert_eq!(account.tenant, "organizations");
        assert_eq!(accounts.load().unwrap(), vec![account.clone()]);
        assert_eq!(
            credentials.load(&credential_key(&account.id)).unwrap(),
            Some("tok-refresh-456".into())
        );

        let on_disk = std::fs::read_to_string(&accounts_path).unwrap();
        assert!(!on_disk.contains("tok-access-123") && !on_disk.contains("tok-refresh-456"));
        let _ = std::fs::remove_file(accounts_path);
    }

    #[tokio::test]
    async fn login_validates_input_before_opening_the_browser() {
        let (accounts, accounts_path) = temp_accounts();
        let credentials = MemoryCredentials::default();
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let input = BeginOnedriveLoginInput {
            operation_id: "l".into(),
            client_id: " ".into(),
            tenant: String::new(),
        };

        let result = complete_login(
            server,
            &input,
            &OnedriveClient::new(),
            &credentials,
            &accounts,
            |_| panic!("the browser must not open"),
        )
        .await;

        assert!(matches!(result, Err(RemoteCommandError::Invalid { .. })));
        let _ = std::fs::remove_file(accounts_path);
    }

    #[test]
    fn folders_serialize_camel_case() {
        let dto = folder_dto(DriveFolder {
            drive_id: "b!d".into(),
            id: "F".into(),
            name: "Alcy".into(),
            path: "/Equipe/Alcy".into(),
            child_count: Some(2),
        });
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            serde_json::json!({
                "driveId": "b!d", "id": "F", "name": "Alcy",
                "path": "/Equipe/Alcy", "childCount": 2
            })
        );
    }
}
