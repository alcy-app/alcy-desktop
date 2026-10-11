use std::future::Future;
use std::time::Duration;

use alcy_app::{CredentialStore, RemoteError, VersionControlError};
use alcy_domain::{GitlabAccount, GitlabAccountError};
use alcy_gitlab::{
    GitlabBranch, GitlabClient, GitlabProject, OAuthError, PkceChallenge, account_id,
    authorization_url, credential_key, generate_state, save_tokens,
};
use alcy_platform::{CallbackError, CallbackServer, KeyringCredentialStore};
use alcy_storage::{GitlabAccountsStore, StorageError};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use super::execution_registry::ExecutionRegistry;
use super::remote_content_cache::VersionControlCaches;

/// Tempo que o usuário tem para autorizar o Alcy no navegador.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabAccountDto {
    pub id: String,
    pub base_url: String,
    pub client_id: String,
    pub username: String,
    pub name: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabProjectDto {
    pub id: u64,
    pub path_with_namespace: String,
    pub default_branch: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitlabBranchDto {
    pub name: String,
    pub is_default: bool,
    pub can_push: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageDto<T> {
    pub items: Vec<T>,
    pub next_page: Option<u32>,
}

/// Erro comum aos comandos de GitLab e de controle de versão. Nunca carrega
/// tokens, códigos ou URLs de autorização.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitlabCommandError {
    Invalid { message: String },
    Storage { message: String },
    Credentials { message: String },
    Unauthorized,
    Network { message: String },
    Rejected { message: String },
    NotFound { message: String },
    Conflict,
    TooLarge,
    Files { message: String },
    Conflicts { files: Vec<String> },
    NothingToCommit,
    EmptyMessage,
    IncompleteResolution { file: String },
    NotLinked,
    AccountMissing,
    BranchNotWritable,
    Denied { message: String },
    Login { message: String },
    Timeout,
    PortBusy { port: u16 },
    Browser { message: String },
    Cancelled,
}

impl From<StorageError> for GitlabCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

impl From<GitlabAccountError> for GitlabCommandError {
    fn from(error: GitlabAccountError) -> Self {
        Self::Invalid {
            message: error.to_string(),
        }
    }
}

impl From<RemoteError> for GitlabCommandError {
    fn from(error: RemoteError) -> Self {
        match error {
            RemoteError::Unauthorized => Self::Unauthorized,
            RemoteError::NotFound(message) => Self::NotFound { message },
            RemoteError::Conflict => Self::Conflict,
            RemoteError::Network(message) => Self::Network { message },
            RemoteError::Rejected(message) => Self::Rejected { message },
            RemoteError::TooLarge => Self::TooLarge,
            RemoteError::Credentials(message) => Self::Credentials { message },
        }
    }
}

impl From<VersionControlError> for GitlabCommandError {
    fn from(error: VersionControlError) -> Self {
        match error {
            VersionControlError::Remote(error) => error.into(),
            VersionControlError::Files(message) => Self::Files { message },
            VersionControlError::Conflicts(files) => Self::Conflicts { files },
            VersionControlError::NothingToCommit => Self::NothingToCommit,
            VersionControlError::EmptyMessage => Self::EmptyMessage,
            VersionControlError::NotTracked(_)
            | VersionControlError::NotInConflict(_)
            | VersionControlError::ManifestRemoval
            | VersionControlError::InvalidStructuredFile(_)
            | VersionControlError::PartialResolutionUnsupported(_) => Self::Invalid {
                message: error.to_string(),
            },
            VersionControlError::StaleSelection => Self::Conflict,
            VersionControlError::IncompleteResolution(file) => Self::IncompleteResolution { file },
        }
    }
}

impl From<CallbackError> for GitlabCommandError {
    fn from(error: CallbackError) -> Self {
        match error {
            CallbackError::PortBusy { port } => Self::PortBusy { port },
            CallbackError::Denied(message) => Self::Denied { message },
            CallbackError::Timeout => Self::Timeout,
            other => Self::Login {
                message: other.to_string(),
            },
        }
    }
}

impl From<OAuthError> for GitlabCommandError {
    fn from(error: OAuthError) -> Self {
        match error {
            OAuthError::Network(message) => Self::Network { message },
            other => Self::Login {
                message: other.to_string(),
            },
        }
    }
}

pub fn account_dto(account: &GitlabAccount) -> GitlabAccountDto {
    GitlabAccountDto {
        id: account.id.clone(),
        base_url: account.base_url.clone(),
        client_id: account.client_id.clone(),
        username: account.username.clone(),
        name: account.name.clone(),
    }
}

fn project_dto(project: GitlabProject) -> GitlabProjectDto {
    GitlabProjectDto {
        id: project.id,
        path_with_namespace: project.path_with_namespace,
        default_branch: project.default_branch,
    }
}

fn branch_dto(branch: GitlabBranch) -> GitlabBranchDto {
    GitlabBranchDto {
        name: branch.name,
        is_default: branch.is_default,
        can_push: branch.can_push,
    }
}

/// Executa `future` até o fim ou até `cancel_gitlab_operation` com o mesmo
/// `operation_id` (a operação em andamento é descartada).
pub async fn cancellable<T>(
    registry: &ExecutionRegistry,
    operation_id: &str,
    future: impl Future<Output = Result<T, GitlabCommandError>>,
) -> Result<T, GitlabCommandError> {
    let (sender, receiver) = oneshot::channel::<()>();
    registry.register(operation_id.to_string(), sender);
    let result = tokio::select! {
        result = future => result,
        _ = receiver => Err(GitlabCommandError::Cancelled),
    };
    registry.remove(operation_id);
    result
}

pub fn find_account(
    store: &GitlabAccountsStore,
    account_id: &str,
) -> Result<GitlabAccount, GitlabCommandError> {
    store
        .load()?
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or(GitlabCommandError::AccountMissing)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginGitlabLoginInput {
    pub operation_id: String,
    pub instance_url: String,
    pub client_id: String,
}

/// Fluxo completo do login: autoriza no navegador, troca o código, guarda o
/// token no chaveiro e registra a conta. `open_browser` recebe a URL de
/// autorização (separado para poder ser simulado nos testes).
async fn complete_login(
    server: CallbackServer,
    input: &BeginGitlabLoginInput,
    client: &GitlabClient,
    credentials: &dyn CredentialStore,
    accounts: &GitlabAccountsStore,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<GitlabAccount, GitlabCommandError> {
    // Valida a URL e o client_id antes de abrir qualquer coisa.
    let pending = GitlabAccount::new("pending", &input.instance_url, &input.client_id, "", "")?;

    let pkce = PkceChallenge::generate()?;
    let state = generate_state()?;
    let redirect_uri = server.redirect_uri();
    let url = authorization_url(
        &pending.base_url,
        &pending.client_id,
        &redirect_uri,
        &state,
        &pkce.challenge,
    )?;

    open_browser(&url).map_err(|message| GitlabCommandError::Browser { message })?;
    let code = server.wait_for_code(&state, LOGIN_TIMEOUT).await?;

    let tokens = client
        .exchange_code(
            &pending.base_url,
            &pending.client_id,
            &redirect_uri,
            &code,
            &pkce.verifier,
        )
        .await?;
    let user = client
        .fetch_user(&pending.base_url, &tokens.access_token)
        .await?;

    let account = GitlabAccount::new(
        account_id(&pending.base_url, &user.username),
        &pending.base_url,
        &pending.client_id,
        user.username,
        user.name,
    )?;

    save_tokens(credentials, &account.id, &tokens)?;
    if let Err(error) = accounts.upsert(account.clone()) {
        // Sem a conta registrada o token ficaria órfão no chaveiro.
        let _ = credentials.delete(&credential_key(&account.id));
        return Err(error.into());
    }
    Ok(account)
}

#[tauri::command]
pub fn list_gitlab_accounts(
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<Vec<GitlabAccountDto>, GitlabCommandError> {
    Ok(accounts.load()?.iter().map(account_dto).collect())
}

#[tauri::command]
pub async fn begin_gitlab_login(
    input: BeginGitlabLoginInput,
    app: tauri::AppHandle,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<GitlabAccountDto, GitlabCommandError> {
    let result: Result<GitlabAccountDto, GitlabCommandError> = async {
        let server = CallbackServer::bind().await?;
        let operation_id = input.operation_id.clone();

        let login = complete_login(server, &input, &client, &*credentials, &accounts, |url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|error| error.to_string())
        });
        let account = cancellable(&registry, &operation_id, login).await?;
        Ok(account_dto(&account))
    }
    .await;
    crate::logging::logged("alcy::gitlab", "login no GitLab", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelGitlabOperationInput {
    pub operation_id: String,
}

/// Cancela um login, envio ou atualização em andamento. Idempotente.
#[tauri::command]
pub fn cancel_gitlab_operation(
    input: CancelGitlabOperationInput,
    registry: State<'_, ExecutionRegistry>,
) {
    registry.cancel(&input.operation_id);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub account_id: String,
}

/// Remove a conta e o token do chaveiro.
#[tauri::command]
pub async fn logout_gitlab(
    input: AccountInput,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
    caches: State<'_, VersionControlCaches>,
) -> Result<(), GitlabCommandError> {
    let result: Result<(), GitlabCommandError> = async {
        credentials
            .delete(&credential_key(&input.account_id))
            .map_err(|error| GitlabCommandError::Credentials {
                message: error.to_string(),
            })?;
        accounts.remove(&input.account_id)?;
        caches.clear().await;
        Ok(())
    }
    .await;
    crate::logging::logged("alcy::gitlab", "logout do GitLab", result)
}

/// Confirma que a sessão da conta ainda funciona (renovando o token se
/// preciso) e atualiza o nome exibido.
#[tauri::command]
pub async fn test_gitlab_connection(
    input: AccountInput,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<GitlabAccountDto, GitlabCommandError> {
    let result: Result<GitlabAccountDto, GitlabCommandError> = async {
        let account = find_account(&accounts, &input.account_id)?;
        let user = client
            .session(&account, &*credentials)
            .current_user()
            .await?;

        let refreshed = GitlabAccount::new(
            account.id.clone(),
            &account.base_url,
            &account.client_id,
            user.username,
            user.name,
        )?;
        if refreshed != account {
            accounts.upsert(refreshed.clone())?;
        }
        Ok(account_dto(&refreshed))
    }
    .await;
    crate::logging::logged("alcy::gitlab", "testar conexão com o GitLab", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsInput {
    pub account_id: String,
    #[serde(default)]
    pub search: String,
    #[serde(default = "first_page")]
    pub page: u32,
}

fn first_page() -> u32 {
    1
}

#[tauri::command]
pub async fn list_gitlab_projects(
    input: ListProjectsInput,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<PageDto<GitlabProjectDto>, GitlabCommandError> {
    let result: Result<PageDto<GitlabProjectDto>, GitlabCommandError> = async {
        let account = find_account(&accounts, &input.account_id)?;
        let page = client
            .session(&account, &*credentials)
            .list_projects(&input.search, input.page)
            .await?;
        Ok(PageDto {
            items: page.items.into_iter().map(project_dto).collect(),
            next_page: page.next_page,
        })
    }
    .await;
    crate::logging::logged("alcy::gitlab", "listar projetos do GitLab", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBranchesInput {
    pub account_id: String,
    pub project_id: u64,
    #[serde(default)]
    pub search: String,
    #[serde(default = "first_page")]
    pub page: u32,
}

#[tauri::command]
pub async fn list_gitlab_branches(
    input: ListBranchesInput,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<PageDto<GitlabBranchDto>, GitlabCommandError> {
    let result: Result<PageDto<GitlabBranchDto>, GitlabCommandError> = async {
        let account = find_account(&accounts, &input.account_id)?;
        let page = client
            .session(&account, &*credentials)
            .list_branches(input.project_id, &input.search, input.page)
            .await?;
        Ok(PageDto {
            items: page.items.into_iter().map(branch_dto).collect(),
            next_page: page.next_page,
        })
    }
    .await;
    crate::logging::logged("alcy::gitlab", "listar branches do GitLab", result)
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

    fn temp_accounts() -> (GitlabAccountsStore, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!("alcy-gitlab-command-test-{nanos}.json"));
        (GitlabAccountsStore::new(path.clone()), path)
    }

    /// Simula o navegador: abre a URL de autorização e devolve o `code` para
    /// o receptor local com o `state` recebido (ou um `state` trocado).
    fn fake_browser(
        code: &'static str,
        tamper_state: bool,
    ) -> impl FnOnce(&str) -> Result<(), String> {
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
            let state = if tamper_state {
                "outro".to_string()
            } else {
                param("state")
            };
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

    fn input(server: &MockServer) -> BeginGitlabLoginInput {
        BeginGitlabLoginInput {
            operation_id: "login-1".into(),
            instance_url: server.uri(),
            client_id: "cid".into(),
        }
    }

    #[tokio::test]
    async fn login_stores_the_token_in_the_keyring_and_the_account_on_disk() {
        let gitlab = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .and(body_string_contains("code=codigo-1"))
            .and(body_string_contains("code_verifier="))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "tok-acesso-123", "refresh_token": "tok-refresh-456",
                "expires_in": 7200
            })))
            .expect(1)
            .mount(&gitlab)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v4/user"))
            .and(header("authorization", "Bearer tok-acesso-123"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"username": "ana", "name": "Ana"})),
            )
            .mount(&gitlab)
            .await;

        let (accounts, accounts_path) = temp_accounts();
        let credentials = MemoryCredentials::default();
        let server = CallbackServer::bind_in(&[0]).await.unwrap();

        let account = complete_login(
            server,
            &input(&gitlab),
            &GitlabClient::new(),
            &credentials,
            &accounts,
            fake_browser("codigo-1", false),
        )
        .await
        .unwrap();

        assert_eq!(account.username, "ana");
        assert_eq!(accounts.load().unwrap(), vec![account.clone()]);
        let stored = credentials
            .load(&credential_key(&account.id))
            .unwrap()
            .unwrap();
        assert!(stored.contains("tok-acesso-123") && stored.contains("tok-refresh-456"));

        // O arquivo de contas nunca recebe o token.
        let on_disk = std::fs::read_to_string(&accounts_path).unwrap();
        assert!(!on_disk.contains("tok-acesso-123") && !on_disk.contains("tok-refresh-456"));
        let _ = std::fs::remove_file(accounts_path);
    }

    #[tokio::test]
    async fn login_with_a_tampered_state_is_rejected_before_any_token_request() {
        let gitlab = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&gitlab)
            .await;

        let (accounts, accounts_path) = temp_accounts();
        let credentials = MemoryCredentials::default();
        let server = CallbackServer::bind_in(&[0]).await.unwrap();

        let result = complete_login(
            server,
            &input(&gitlab),
            &GitlabClient::new(),
            &credentials,
            &accounts,
            fake_browser("codigo", true),
        )
        .await;

        assert!(matches!(result, Err(GitlabCommandError::Login { .. })));
        assert!(accounts.load().unwrap().is_empty());
        assert!(credentials.0.lock().unwrap().is_empty());
        let _ = std::fs::remove_file(accounts_path);
    }

    #[tokio::test]
    async fn login_validates_input_and_reports_browser_failures() {
        let (accounts, accounts_path) = temp_accounts();
        let credentials = MemoryCredentials::default();
        let client = GitlabClient::new();

        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let invalid = BeginGitlabLoginInput {
            operation_id: "l".into(),
            instance_url: "gitlab.exemplo.com".into(), // sem esquema http(s)
            client_id: "cid".into(),
        };
        let result = complete_login(server, &invalid, &client, &credentials, &accounts, |_| {
            panic!("não deve abrir o navegador com dados inválidos")
        })
        .await;
        assert!(matches!(result, Err(GitlabCommandError::Invalid { .. })));

        let gitlab = MockServer::start().await;
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let result = complete_login(
            server,
            &input(&gitlab),
            &client,
            &credentials,
            &accounts,
            |_| Err("sem navegador".into()),
        )
        .await;
        assert_eq!(
            result,
            Err(GitlabCommandError::Browser {
                message: "sem navegador".into()
            })
        );
        let _ = std::fs::remove_file(accounts_path);
    }

    #[tokio::test]
    async fn cancelling_stops_the_wait_and_releases_the_registry() {
        let gitlab = MockServer::start().await;
        let (accounts, accounts_path) = temp_accounts();
        let credentials = MemoryCredentials::default();
        let registry = ExecutionRegistry::default();
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let client = GitlabClient::new();
        let login_input = input(&gitlab);

        let login = complete_login(
            server,
            &login_input,
            &client,
            &credentials,
            &accounts,
            |_| Ok(()),
        );
        let cancelling = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            registry.cancel("login-1");
        };
        let (result, ()) = tokio::join!(cancellable(&registry, "login-1", login), cancelling);

        assert_eq!(result, Err(GitlabCommandError::Cancelled));
        assert!(!registry.is_registered("login-1"));
        let _ = std::fs::remove_file(accounts_path);
    }

    #[test]
    fn errors_serialize_with_a_kind_and_never_leak_payloads() {
        assert_eq!(
            serde_json::to_value(GitlabCommandError::Unauthorized).unwrap(),
            serde_json::json!({"kind": "unauthorized"})
        );
        assert_eq!(
            serde_json::to_value(GitlabCommandError::PortBusy { port: 53682 }).unwrap(),
            serde_json::json!({"kind": "portBusy", "port": 53682})
        );
        assert_eq!(
            serde_json::to_value(GitlabCommandError::BranchNotWritable).unwrap(),
            serde_json::json!({"kind": "branchNotWritable"})
        );
        assert_eq!(
            serde_json::to_value(GitlabCommandError::Conflicts {
                files: vec!["a".into()]
            })
            .unwrap(),
            serde_json::json!({"kind": "conflicts", "files": ["a"]})
        );
        assert_eq!(
            GitlabCommandError::from(VersionControlError::Remote(RemoteError::Conflict)),
            GitlabCommandError::Conflict
        );
        assert_eq!(
            serde_json::to_value(GitlabCommandError::IncompleteResolution {
                file: "alcy-collections.json".into()
            })
            .unwrap(),
            serde_json::json!({"kind": "incompleteResolution", "file": "alcy-collections.json"})
        );
        assert_eq!(
            GitlabCommandError::from(VersionControlError::IncompleteResolution(
                "alcy-collections.json".into()
            )),
            GitlabCommandError::IncompleteResolution {
                file: "alcy-collections.json".into()
            }
        );
    }
}
