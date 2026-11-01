//! Atualizações do app (ADR 0026).
//!
//! A origem das releases vem fixa no build (`ALCY_UPDATE_PROVIDER` e
//! `ALCY_UPDATE_URL`, lidas do `.env` pelos scripts), definida por quem
//! distribui o app: um projeto GitLab, um repositório do
//! GitHub, o serviço de releases (ADR 0051) ou a URL direta do manifesto.
//! Todas levam ao manifesto
//! `latest.json` do `tauri-plugin-updater`, que baixa o pacote e verifica a
//! assinatura contra a chave pública embutida no build. No GitLab o
//! manifesto é baixado com o token da conta, que só vai para a instância.

use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use alcy_app::{CredentialStore, RemoteError};
use alcy_domain::{
    GitlabAccount, UpdateSettings, UpdateSource, UpdateSourceError, project_path_in_instance,
};
use alcy_gitlab::{GitlabClient, GitlabRelease, UPDATE_MANIFEST_ASSET, is_instance_url};
use alcy_http_proxy::ProxyPlan;
use alcy_platform::KeyringCredentialStore;
use alcy_storage::{
    GitlabAccountsStore, RecentWorkspacesStore, StorageError, UpdateSettingsStore,
    backup_workspaces,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;
use url::Url;

use super::app_logs::AppLogLocation;
use super::execution_registry::ExecutionRegistry;
use super::proxy_settings::ProxyApplyState;

/// Origem das releases, embutida no build (ver `scripts/build-env.mjs`). Sem
/// `ALCY_UPDATE_PROVIDER` (ou com `none`), o app não se atualiza sozinho.
const UPDATE_PROVIDER: Option<&str> = option_env!("ALCY_UPDATE_PROVIDER");
const UPDATE_URL: Option<&str> = option_env!("ALCY_UPDATE_URL");

/// Só a conexão tem prazo: o download de um instalador em rede lenta pode
/// levar minutos e é cancelável pelo usuário.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Intervalo mínimo (em bytes) entre eventos de progresso enviados à UI.
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;
/// Deadline for listing releases to find the newest pre-release (a small
/// JSON document, unlike the installer download).
const LISTING_TIMEOUT: Duration = Duration::from_secs(30);
/// GitHub's public API, used only to list releases when previews are wanted.
const GITHUB_API: &str = "https://api.github.com";
/// Releases listed to find the newest published one with a manifest.
const GITHUB_RELEASES_WINDOW: &str = "20";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateCommandError {
    /// O build não tem projeto de origem configurado.
    NotConfigured,
    Invalid {
        message: String,
    },
    /// Nenhuma conta GitLab conectada para a instância do projeto.
    NoAccount {
        host: String,
    },
    Unauthorized,
    NotFound {
        message: String,
    },
    NoReleases,
    NoManifest {
        tag: String,
    },
    /// O manifesto ou o pacote apontam para fora da instância.
    OriginMismatch,
    /// O build não tem chave pública de atualização.
    MissingPublicKey,
    Signature {
        message: String,
    },
    Network {
        message: String,
    },
    Rejected {
        message: String,
    },
    Credentials {
        message: String,
    },
    Storage {
        message: String,
    },
    /// A versão anunciada deixou de estar disponível entre verificar e baixar.
    NotAvailable,
    NoPendingUpdate,
    /// O backup dos workspaces falhou; a atualização não foi instalada.
    Backup {
        message: String,
    },
    Updater {
        message: String,
    },
    Cancelled,
}

impl From<StorageError> for UpdateCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

impl From<UpdateSourceError> for UpdateCommandError {
    fn from(error: UpdateSourceError) -> Self {
        Self::Invalid {
            message: error.to_string(),
        }
    }
}

impl From<RemoteError> for UpdateCommandError {
    fn from(error: RemoteError) -> Self {
        match error {
            RemoteError::Unauthorized => Self::Unauthorized,
            RemoteError::NotFound(message) => Self::NotFound { message },
            RemoteError::Network(message) => Self::Network { message },
            RemoteError::Credentials(message) => Self::Credentials { message },
            RemoteError::Rejected(message) => Self::Rejected { message },
            RemoteError::Conflict | RemoteError::TooLarge => Self::Rejected {
                message: error.to_string(),
            },
        }
    }
}

impl From<tauri_plugin_updater::Error> for UpdateCommandError {
    fn from(error: tauri_plugin_updater::Error) -> Self {
        use tauri_plugin_updater::Error;
        match error {
            Error::Minisign(_)
            | Error::Base64(_)
            | Error::SignatureUtf8(_)
            | Error::MissingSignedVersion => Self::Signature {
                message: error.to_string(),
            },
            Error::Reqwest(_) | Error::Network(_) => Self::Network {
                message: error.to_string(),
            },
            other => Self::Updater {
                message: other.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateProviderDto {
    Gitlab,
    Github,
    Manifest,
    ReleaseServer,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSourceDto {
    pub provider: UpdateProviderDto,
    /// O que exibir: URL do projeto, `dono/repositorio`, URL do manifesto ou
    /// do serviço de releases.
    pub location: String,
    pub host: String,
    /// Só o GitLab exige uma conta conectada na instância.
    pub requires_account: bool,
    /// Conta usada para acessar a origem; `None` sem conta (ou sem exigência).
    pub account_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsDto {
    pub current_version: String,
    pub check_on_startup: bool,
    /// Preview (pre-release) versions are offered too.
    pub include_prereleases: bool,
    /// `None` = o build não tem origem de atualizações.
    pub source: Option<UpdateSourceDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDto {
    pub version: String,
    pub name: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub web_url: Option<String>,
    /// Esta instalação consegue se atualizar sozinha (ex.: no Linux, só o
    /// AppImage); senão a UI oferece o download pela página da release.
    pub installable: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckDto {
    pub current_version: String,
    /// `None` = a versão instalada é a mais recente.
    pub release: Option<ReleaseDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressDto {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreferenceInput {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOperationInput {
    pub operation_id: String,
}

struct DownloadedUpdate {
    update: Update,
    bytes: Vec<u8>,
}

/// Pacote baixado e verificado, aguardando o usuário reiniciar o app.
#[derive(Default)]
pub struct PendingUpdate {
    downloaded: Mutex<Option<DownloadedUpdate>>,
}

impl PendingUpdate {
    fn replace(&self, downloaded: Option<DownloadedUpdate>) {
        match self.downloaded.lock() {
            Ok(mut guard) => *guard = downloaded,
            Err(poisoned) => *poisoned.into_inner() = downloaded,
        }
    }

    fn take(&self) -> Option<DownloadedUpdate> {
        match self.downloaded.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        }
    }
}

/// Executa `future` até o fim ou até `cancel_update_operation` com o mesmo
/// `operation_id`.
async fn cancellable<T>(
    registry: &ExecutionRegistry,
    operation_id: &str,
    future: impl Future<Output = Result<T, UpdateCommandError>>,
) -> Result<T, UpdateCommandError> {
    let (sender, receiver) = oneshot::channel::<()>();
    registry.register(operation_id.to_string(), sender);
    let result = tokio::select! {
        result = future => result,
        _ = receiver => Err(UpdateCommandError::Cancelled),
    };
    registry.remove(operation_id);
    result
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn public_key(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .map(str::trim)
        .filter(|pubkey| !pubkey.is_empty())
        .map(str::to_string)
}

/// A instalação atual consegue ser substituída pelo updater?
fn installable() -> bool {
    if cfg!(target_os = "windows") {
        true
    } else if cfg!(target_os = "linux") {
        // O updater só substitui AppImages (pacotes .deb/.rpm são do gerenciador).
        std::env::var_os("APPIMAGE").is_some()
    } else {
        false
    }
}

fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

/// Origem configurada no build (`None` = atualizações desativadas).
fn configured_source(
    provider: Option<&str>,
    url: Option<&str>,
) -> Result<Option<UpdateSource>, UpdateCommandError> {
    let Some(provider) = provider
        .map(str::trim)
        .filter(|p| !p.is_empty() && *p != "none")
    else {
        return Ok(None);
    };
    let url = url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| UpdateCommandError::Invalid {
            message: format!("defina ALCY_UPDATE_URL para o provedor {provider}"),
        })?;
    let source = match provider {
        "gitlab" => UpdateSource::gitlab(url)?,
        "github" => UpdateSource::github(url)?,
        "manifest" => UpdateSource::manifest(url)?,
        "releaseServer" => UpdateSource::release_server(url)?,
        other => {
            return Err(UpdateCommandError::Invalid {
                message: format!(
                    "ALCY_UPDATE_PROVIDER inválido: {other} (use gitlab, github, manifest, releaseServer ou none)"
                ),
            });
        }
    };
    Ok(Some(source))
}

fn build_source() -> Result<Option<UpdateSource>, UpdateCommandError> {
    configured_source(UPDATE_PROVIDER, UPDATE_URL)
}

fn required_source() -> Result<UpdateSource, UpdateCommandError> {
    build_source()?.ok_or(UpdateCommandError::NotConfigured)
}

/// Conta conectada na instância do projeto (a de URL base mais específica
/// vence, o que cobre instâncias em subcaminho) e o caminho do projeto nela.
fn account_for<'a>(
    project_url: &str,
    accounts: &'a [GitlabAccount],
) -> Option<(&'a GitlabAccount, String)> {
    accounts
        .iter()
        .filter_map(|account| {
            project_path_in_instance(project_url, &account.base_url).map(|path| (account, path))
        })
        .max_by_key(|(account, _)| account.base_url.len())
}

fn github_repository_url(owner: &str, repo: &str) -> String {
    format!("https://github.com/{owner}/{repo}")
}

fn source_dto(source: &UpdateSource, accounts: &[GitlabAccount]) -> UpdateSourceDto {
    match source {
        UpdateSource::Gitlab { project_url } => UpdateSourceDto {
            provider: UpdateProviderDto::Gitlab,
            location: project_url.clone(),
            host: host_of(project_url),
            requires_account: true,
            account_id: account_for(project_url, accounts).map(|(account, _)| account.id.clone()),
        },
        UpdateSource::Github { owner, repo } => UpdateSourceDto {
            provider: UpdateProviderDto::Github,
            location: format!("{owner}/{repo}"),
            host: "github.com".into(),
            requires_account: false,
            account_id: None,
        },
        UpdateSource::Manifest { url } => UpdateSourceDto {
            provider: UpdateProviderDto::Manifest,
            location: url.clone(),
            host: host_of(url),
            requires_account: false,
            account_id: None,
        },
        UpdateSource::ReleaseServer { base_url } => UpdateSourceDto {
            provider: UpdateProviderDto::ReleaseServer,
            location: base_url.clone(),
            host: host_of(base_url),
            requires_account: false,
            account_id: None,
        },
    }
}

fn settings_dto(
    settings: &UpdateSettings,
    source: Option<&UpdateSource>,
    accounts: &[GitlabAccount],
    current_version: String,
) -> UpdateSettingsDto {
    UpdateSettingsDto {
        current_version,
        check_on_startup: settings.check_on_startup,
        include_prereleases: settings.include_prereleases,
        source: source.map(|source| source_dto(source, accounts)),
    }
}

/// Dados da release que o manifesto do updater não traz (GitLab).
#[derive(Default)]
struct ReleaseInfo {
    name: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    web_url: Option<String>,
}

/// Cabeçalho de autorização e a única origem para a qual ele pode ir.
struct SourceAuth {
    instance_url: String,
    token: String,
}

/// O que o updater precisa para consultar a origem.
struct ResolvedSource {
    manifest_url: Url,
    auth: Option<SourceAuth>,
    info: ReleaseInfo,
}

/// GitLab: a release publicada mais recente aponta para o manifesto (asset
/// link `latest.json`), baixado com o token da conta da instância.
async fn resolve_gitlab(
    project_url: &str,
    include_prereleases: bool,
    accounts: &[GitlabAccount],
    client: &GitlabClient,
    credentials: &dyn CredentialStore,
) -> Result<ResolvedSource, UpdateCommandError> {
    let (account, path) =
        account_for(project_url, accounts).ok_or_else(|| UpdateCommandError::NoAccount {
            host: host_of(project_url),
        })?;
    let session = client.session(account, credentials);
    let project = session.project_by_path(&path).await?;
    let release = session
        .latest_release(project.id, include_prereleases)
        .await?
        .ok_or(UpdateCommandError::NoReleases)?;

    let manifest_url = release
        .manifest_url()
        .ok_or_else(|| UpdateCommandError::NoManifest {
            tag: release.tag_name.clone(),
        })?;
    if !is_instance_url(&account.base_url, manifest_url) {
        return Err(UpdateCommandError::OriginMismatch);
    }
    let manifest_url = Url::parse(manifest_url).map_err(|_| UpdateCommandError::OriginMismatch)?;
    // Token renovado a cada consulta: o download pode acontecer bem depois.
    let token = session.access_token().await?;

    Ok(ResolvedSource {
        manifest_url,
        auth: Some(SourceAuth {
            instance_url: account.base_url.clone(),
            token,
        }),
        info: release_info(release),
    })
}

fn release_info(release: GitlabRelease) -> ReleaseInfo {
    ReleaseInfo {
        name: release.name,
        notes: release.description,
        published_at: release.released_at,
        web_url: release.web_url,
    }
}

fn invalid_url(error: url::ParseError) -> UpdateCommandError {
    UpdateCommandError::Invalid {
        message: error.to_string(),
    }
}

/// Resolves the source down to the updater manifest. Only GitLab queries an
/// API with credentials; the other sources are unauthenticated addresses.
/// With `include_prereleases`, GitHub and the release server list their
/// releases to find the newest one, preview or not; a direct manifest is a
/// single version and ignores it.
async fn resolve_source(
    source: &UpdateSource,
    include_prereleases: bool,
    accounts: &[GitlabAccount],
    client: &GitlabClient,
    credentials: &dyn CredentialStore,
    proxy: Option<&ProxyPlan>,
) -> Result<ResolvedSource, UpdateCommandError> {
    match source {
        UpdateSource::Gitlab { project_url } => {
            resolve_gitlab(
                project_url,
                include_prereleases,
                accounts,
                client,
                credentials,
            )
            .await
        }
        UpdateSource::Github { owner, repo } if include_prereleases => {
            resolve_github_newest(GITHUB_API, owner, repo, proxy).await
        }
        UpdateSource::Github { owner, repo } => {
            let repository = github_repository_url(owner, repo);
            Ok(ResolvedSource {
                manifest_url: Url::parse(&format!(
                    "{repository}/releases/latest/download/{UPDATE_MANIFEST_ASSET}"
                ))
                .map_err(invalid_url)?,
                auth: None,
                info: ReleaseInfo {
                    web_url: Some(format!("{repository}/releases/latest")),
                    ..ReleaseInfo::default()
                },
            })
        }
        UpdateSource::Manifest { url } => Ok(ResolvedSource {
            manifest_url: Url::parse(url).map_err(invalid_url)?,
            auth: None,
            info: ReleaseInfo::default(),
        }),
        UpdateSource::ReleaseServer { base_url } if include_prereleases => {
            resolve_release_server_newest(base_url, proxy).await
        }
        // O serviço entrega o manifesto da maior versão estável; notas e data
        // vêm dele. A página inicial do serviço lista os downloads.
        UpdateSource::ReleaseServer { base_url } => Ok(ResolvedSource {
            manifest_url: Url::parse(&format!(
                "{base_url}/v1/releases/latest/{UPDATE_MANIFEST_ASSET}"
            ))
            .map_err(invalid_url)?,
            auth: None,
            info: ReleaseInfo {
                web_url: Some(format!("{base_url}/")),
                ..ReleaseInfo::default()
            },
        }),
    }
}

/// `base` with `segments` appended as path segments (each one encoded).
fn url_with_segments(base: &str, segments: &[&str]) -> Result<Url, UpdateCommandError> {
    let mut url = Url::parse(base).map_err(invalid_url)?;
    url.path_segments_mut()
        .map_err(|()| UpdateCommandError::Invalid {
            message: format!("{base} cannot have a path"),
        })?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}

/// Fetches a release listing as JSON, through the same proxy as the updater.
async fn fetch_listing<T: serde::de::DeserializeOwned>(
    url: Url,
    proxy: Option<&ProxyPlan>,
) -> Result<T, UpdateCommandError> {
    let network = |error: reqwest::Error| UpdateCommandError::Network {
        message: error.to_string(),
    };
    let builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(LISTING_TIMEOUT)
        .user_agent(concat!("Alcy/", env!("CARGO_PKG_VERSION")));
    let builder = match updater_proxy(proxy, &url) {
        UpdaterProxy::Direct => builder.no_proxy(),
        UpdaterProxy::System => builder,
        UpdaterProxy::Via(proxy) => builder.proxy(reqwest::Proxy::all(proxy).map_err(network)?),
    };
    let response = builder
        .build()
        .map_err(network)?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(network)?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(UpdateCommandError::NotFound {
            message: status.to_string(),
        });
    }
    if !status.is_success() {
        return Err(UpdateCommandError::Rejected {
            message: format!("HTTP {status}"),
        });
    }
    let body = response.bytes().await.map_err(network)?;
    serde_json::from_slice(&body).map_err(|error| UpdateCommandError::Rejected {
        message: format!("unexpected release listing: {error}"),
    })
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

/// GitHub: `releases/latest` never points at a pre-release, so the newest
/// published release (preview or not) carrying the manifest comes from the
/// API listing, newest first.
async fn resolve_github_newest(
    api_base: &str,
    owner: &str,
    repo: &str,
    proxy: Option<&ProxyPlan>,
) -> Result<ResolvedSource, UpdateCommandError> {
    let mut listing = url_with_segments(api_base, &["repos", owner, repo, "releases"])?;
    listing
        .query_pairs_mut()
        .append_pair("per_page", GITHUB_RELEASES_WINDOW);
    let releases: Vec<GithubRelease> = fetch_listing(listing, proxy).await?;

    let mut published = releases
        .into_iter()
        .filter(|release| !release.draft)
        .peekable();
    let newest_tag = published
        .peek()
        .map(|release| release.tag_name.clone())
        .ok_or(UpdateCommandError::NoReleases)?;
    let release = published
        .find(|release| {
            release
                .assets
                .iter()
                .any(|asset| asset.name.eq_ignore_ascii_case(UPDATE_MANIFEST_ASSET))
        })
        .ok_or(UpdateCommandError::NoManifest { tag: newest_tag })?;

    // Built from the repository rather than taken from the response, so the
    // manifest always comes from the configured repository.
    let manifest_url = url_with_segments(
        &github_repository_url(owner, repo),
        &[
            "releases",
            "download",
            &release.tag_name,
            UPDATE_MANIFEST_ASSET,
        ],
    )?;
    Ok(ResolvedSource {
        manifest_url,
        auth: None,
        info: ReleaseInfo {
            name: release.name,
            notes: release.body,
            published_at: release.published_at,
            web_url: release.html_url,
        },
    })
}

#[derive(Deserialize)]
struct ServerRelease {
    version: String,
}

/// Release server: `latest` is the highest stable version, while the full
/// listing comes highest version first, pre-releases included.
async fn resolve_release_server_newest(
    base_url: &str,
    proxy: Option<&ProxyPlan>,
) -> Result<ResolvedSource, UpdateCommandError> {
    let releases: Vec<ServerRelease> =
        fetch_listing(url_with_segments(base_url, &["v1", "releases"])?, proxy).await?;
    let newest = releases
        .into_iter()
        .next()
        .ok_or(UpdateCommandError::NoReleases)?;
    Ok(ResolvedSource {
        manifest_url: url_with_segments(
            base_url,
            &[
                "v1",
                "releases",
                &newest.version,
                "files",
                UPDATE_MANIFEST_ASSET,
            ],
        )?,
        auth: None,
        info: ReleaseInfo {
            web_url: Some(format!("{base_url}/")),
            ..ReleaseInfo::default()
        },
    })
}

/// Proxy do updater (que usa um cliente HTTP próprio) conforme o plano
/// aplicado ao resto do app, resolvido para o manifesto.
enum UpdaterProxy {
    Direct,
    System,
    Via(Url),
}

fn updater_proxy(plan: Option<&ProxyPlan>, target: &Url) -> UpdaterProxy {
    match plan {
        None | Some(ProxyPlan::Disabled) => UpdaterProxy::Direct,
        Some(ProxyPlan::System) => UpdaterProxy::System,
        Some(ProxyPlan::Pac(script)) => match script.proxy_for(target) {
            Some(proxy) => UpdaterProxy::Via(proxy),
            None => UpdaterProxy::Direct,
        },
    }
}

/// Consulta o manifesto da origem. `None` = já atualizado.
async fn find_update(
    app: &AppHandle,
    source: &UpdateSource,
    include_prereleases: bool,
    accounts: &[GitlabAccount],
    client: &GitlabClient,
    credentials: &dyn CredentialStore,
    proxy: Option<&ProxyPlan>,
) -> Result<Option<(Update, ReleaseInfo)>, UpdateCommandError> {
    if public_key(app).is_none() {
        return Err(UpdateCommandError::MissingPublicKey);
    }
    let resolved = resolve_source(
        source,
        include_prereleases,
        accounts,
        client,
        credentials,
        proxy,
    )
    .await?;

    let mut builder = app
        .updater_builder()
        .endpoints(vec![resolved.manifest_url.clone()])?
        .configure_client(|builder| builder.connect_timeout(CONNECT_TIMEOUT));
    if let Some(auth) = &resolved.auth {
        builder = builder.header("Authorization", format!("Bearer {}", auth.token))?;
    }
    builder = match updater_proxy(proxy, &resolved.manifest_url) {
        UpdaterProxy::Direct => builder.no_proxy(),
        UpdaterProxy::System => builder,
        UpdaterProxy::Via(proxy) => builder.proxy(proxy),
    };

    let Some(update) = builder.build()?.check().await? else {
        return Ok(None);
    };
    // Com credenciais, o pacote é baixado com o mesmo cabeçalho de
    // autorização: só pode estar na instância.
    if let Some(auth) = &resolved.auth {
        if !is_instance_url(&auth.instance_url, update.download_url.as_str()) {
            return Err(UpdateCommandError::OriginMismatch);
        }
    }
    Ok(Some((update, resolved.info)))
}

fn non_blank(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.trim().is_empty())
}

fn release_dto(update: &Update, info: ReleaseInfo) -> ReleaseDto {
    let manifest_date = update
        .raw_json
        .get("pub_date")
        .and_then(|date| date.as_str())
        .map(str::to_string);
    ReleaseDto {
        version: update.version.clone(),
        name: non_blank(info.name),
        notes: non_blank(info.notes.or_else(|| update.body.clone())),
        published_at: info.published_at.or(manifest_date),
        web_url: info.web_url,
        installable: installable(),
    }
}

/// Envia o progresso em passos de `PROGRESS_STEP_BYTES` (e ao terminar),
/// sem um evento de IPC por chunk.
struct ProgressReporter<'a> {
    channel: &'a Channel<DownloadProgressDto>,
    downloaded: u64,
    reported: u64,
    total: Option<u64>,
}

impl ProgressReporter<'_> {
    fn chunk(&mut self, length: usize, total: Option<u64>) {
        self.downloaded += length as u64;
        self.total = total;
        if self.downloaded - self.reported >= PROGRESS_STEP_BYTES {
            self.send();
        }
    }

    fn send(&mut self) {
        self.reported = self.downloaded;
        let _ = self.channel.send(DownloadProgressDto {
            downloaded: self.downloaded,
            total: self.total,
        });
    }
}

/// A origem vem do build; uma configuração inválida aparece como "sem
/// origem" aqui e fica registrada no log. Os scripts de build já a recusam
/// antes de compilar (`scripts/with-env.mjs`).
fn view(
    app: &AppHandle,
    settings: &UpdateSettings,
    accounts: &GitlabAccountsStore,
) -> Result<UpdateSettingsDto, UpdateCommandError> {
    let source = build_source().unwrap_or_else(|error| {
        log::warn!(target: "alcy::updates", "origem de atualizações inválida no build: {error:?}");
        None
    });
    Ok(settings_dto(
        settings,
        source.as_ref(),
        &accounts.load()?,
        current_version(app),
    ))
}

#[tauri::command]
pub fn get_update_settings(
    app: AppHandle,
    store: State<'_, UpdateSettingsStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<UpdateSettingsDto, UpdateCommandError> {
    view(&app, &store.load()?, &accounts)
}

/// Saves one preference and keeps the others. An unreadable file is
/// replaced, so saving a preference also recovers from it.
fn save_preference(
    app: &AppHandle,
    store: &UpdateSettingsStore,
    accounts: &GitlabAccountsStore,
    change: impl FnOnce(&mut UpdateSettings),
) -> Result<UpdateSettingsDto, UpdateCommandError> {
    crate::logging::logged_with(
        "alcy::updates",
        "salvar preferência de atualização",
        || {
            let mut settings = store.load().unwrap_or_default();
            change(&mut settings);
            store.save(&settings)?;
            view(app, &settings, accounts)
        },
    )
}

/// Whether checks may offer preview versions; an unreadable file means
/// stable only (it is reported where the preferences are shown).
fn include_prereleases(store: &UpdateSettingsStore) -> bool {
    store
        .load()
        .map(|settings| settings.include_prereleases)
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_update_check_on_startup(
    input: UpdatePreferenceInput,
    app: AppHandle,
    store: State<'_, UpdateSettingsStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<UpdateSettingsDto, UpdateCommandError> {
    save_preference(&app, &store, &accounts, |settings| {
        settings.check_on_startup = input.enabled;
    })
}

#[tauri::command]
pub fn set_update_include_prereleases(
    input: UpdatePreferenceInput,
    app: AppHandle,
    store: State<'_, UpdateSettingsStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<UpdateSettingsDto, UpdateCommandError> {
    save_preference(&app, &store, &accounts, |settings| {
        settings.include_prereleases = input.enabled;
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn check_for_update(
    input: UpdateOperationInput,
    app: AppHandle,
    registry: State<'_, ExecutionRegistry>,
    settings: State<'_, UpdateSettingsStore>,
    accounts: State<'_, GitlabAccountsStore>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    proxy: State<'_, ProxyApplyState>,
) -> Result<UpdateCheckDto, UpdateCommandError> {
    let source = required_source()?;
    let accounts = accounts.load()?;
    let plan = proxy.plan();
    let check = find_update(
        &app,
        &source,
        include_prereleases(&settings),
        &accounts,
        &client,
        &*credentials,
        plan.as_ref(),
    );
    let found = crate::logging::logged(
        "alcy::updates",
        "verificar atualização",
        cancellable(&registry, &input.operation_id, check).await,
    )?;
    log::info!(
        target: "alcy::updates",
        "verificação de atualização: {}",
        if found.is_some() { "nova versão disponível" } else { "sem novidades" }
    );
    Ok(UpdateCheckDto {
        current_version: current_version(&app),
        release: found.map(|(update, info)| release_dto(&update, info)),
    })
}

/// Baixa e verifica (assinatura) o pacote da versão mais recente, que fica
/// guardado até `install_update_and_restart`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_update(
    input: UpdateOperationInput,
    on_progress: Channel<DownloadProgressDto>,
    app: AppHandle,
    registry: State<'_, ExecutionRegistry>,
    settings: State<'_, UpdateSettingsStore>,
    accounts: State<'_, GitlabAccountsStore>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    proxy: State<'_, ProxyApplyState>,
    pending: State<'_, PendingUpdate>,
) -> Result<ReleaseDto, UpdateCommandError> {
    let source = required_source()?;
    let accounts = accounts.load()?;
    let plan = proxy.plan();
    let include_prereleases = include_prereleases(&settings);
    pending.replace(None);

    let download = async {
        let (update, info) = find_update(
            &app,
            &source,
            include_prereleases,
            &accounts,
            &client,
            &*credentials,
            plan.as_ref(),
        )
        .await?
        .ok_or(UpdateCommandError::NotAvailable)?;

        let mut progress = ProgressReporter {
            channel: &on_progress,
            downloaded: 0,
            reported: 0,
            total: None,
        };
        let bytes = update
            .download(|length, total| progress.chunk(length, total), || {})
            .await?;
        progress.send();
        Ok((update, info, bytes))
    };
    let (update, info, bytes) = crate::logging::logged(
        "alcy::updates",
        "baixar atualização",
        cancellable(&registry, &input.operation_id, download).await,
    )?;
    log::info!(target: "alcy::updates", "atualização baixada ({} bytes)", bytes.len());

    let dto = release_dto(&update, info);
    pending.replace(Some(DownloadedUpdate { update, bytes }));
    Ok(dto)
}

#[tauri::command]
pub fn cancel_update_operation(
    input: UpdateOperationInput,
    registry: State<'_, ExecutionRegistry>,
) {
    registry.cancel(&input.operation_id);
}

/// Instala o pacote baixado e reinicia o app. No Windows o instalador fecha
/// o app e o reabre ao terminar; no Linux o AppImage é substituído e o app
/// reinicia em seguida.
#[tauri::command]
pub fn install_update_and_restart(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    recents: State<'_, RecentWorkspacesStore>,
    folders: State<'_, AppLogLocation>,
) -> Result<(), UpdateCommandError> {
    crate::logging::logged_with("alcy::updates", "instalar atualização", || {
        let downloaded = pending.take().ok_or(UpdateCommandError::NoPendingUpdate)?;
        // As edições pendentes já foram gravadas (`runBeforeExit` no frontend).
        if let Err(error) = backup_before_update(
            &folders.backups,
            &recents,
            &current_version(&app),
            &downloaded.update.version,
        ) {
            // Sem backup não instala, mas o pacote baixado continua disponível.
            pending.replace(Some(downloaded));
            return Err(error);
        }
        crate::window_state::save(&app);
        downloaded.update.install(&downloaded.bytes)?;
        app.restart()
    })
}

/// Copia os arquivos principais dos workspaces recentes antes de instalar
/// (spec 0120): uma versão nova pode gravá-los num formato que a anterior
/// não lê, e o backup permite voltar de versão sem perder dados.
fn backup_before_update(
    backups_root: &std::path::Path,
    recents: &RecentWorkspacesStore,
    from_version: &str,
    to_version: &str,
) -> Result<(), UpdateCommandError> {
    let backup_error = |error: StorageError| UpdateCommandError::Backup {
        message: error.to_string(),
    };
    let workspaces = recents.load().map_err(backup_error)?;
    let backup = backup_workspaces(
        backups_root,
        from_version,
        to_version,
        &workspaces,
        SystemTime::now(),
    )
    .map_err(backup_error)?;
    log::info!(
        target: "alcy::updates",
        "backup antes da atualização: {} workspace(s), {} arquivo(s) em {}",
        backup.workspaces,
        backup.files,
        backup.dir.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use alcy_app::CredentialError;
    use alcy_gitlab::{TokenSet, save_tokens};
    use wiremock::matchers::{method, path};
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

    fn account(base_url: &str, username: &str) -> GitlabAccount {
        GitlabAccount::new(
            format!("{username}@{}", host_of(base_url)),
            base_url,
            "cid",
            username,
            username,
        )
        .unwrap()
    }

    fn credentials_for(accounts: &[GitlabAccount]) -> MemoryCredentials {
        let credentials = MemoryCredentials::default();
        for account in accounts {
            save_tokens(
                &credentials,
                &account.id,
                &TokenSet {
                    access_token: "t".into(),
                    refresh_token: None,
                    expires_at: None,
                },
            )
            .unwrap();
        }
        credentials
    }

    fn project_url(account: &GitlabAccount) -> String {
        format!("{}/grupo/alcy", account.base_url)
    }

    async fn mount_project(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/grupo%2Falcy"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "name": "Alcy",
                "path_with_namespace": "grupo/alcy",
                "web_url": format!("{}/grupo/alcy", server.uri())
            })))
            .mount(server)
            .await;
    }

    async fn mount_releases(server: &MockServer, links: serde_json::Value) {
        mount_project(server).await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/42/releases"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "tag_name": "v0.2.0",
                    "name": "Alcy 0.2.0",
                    "released_at": "2026-09-01T12:00:00Z",
                    "assets": { "links": links }
                }])),
            )
            .mount(server)
            .await;
    }

    async fn resolve(server: &MockServer) -> Result<ResolvedSource, UpdateCommandError> {
        let accounts = [account(&server.uri(), "u")];
        resolve_source(
            &UpdateSource::Gitlab {
                project_url: project_url(&accounts[0]),
            },
            false,
            &accounts,
            &GitlabClient::new(),
            &credentials_for(&accounts),
            None,
        )
        .await
    }

    async fn resolve_public(source: UpdateSource) -> ResolvedSource {
        try_resolve_public(source, false).await.unwrap()
    }

    async fn try_resolve_public(
        source: UpdateSource,
        include_prereleases: bool,
    ) -> Result<ResolvedSource, UpdateCommandError> {
        resolve_source(
            &source,
            include_prereleases,
            &[],
            &GitlabClient::new(),
            &credentials_for(&[]),
            None,
        )
        .await
    }

    #[test]
    fn the_build_source_config_is_valid() {
        assert!(build_source().is_ok());
    }

    #[test]
    fn reads_every_provider_from_the_build_env() {
        assert_eq!(
            configured_source(Some("gitlab"), Some("https://gitlab.corp/grupo/alcy/")),
            Ok(Some(UpdateSource::Gitlab {
                project_url: "https://gitlab.corp/grupo/alcy".into()
            }))
        );
        assert_eq!(
            configured_source(Some("github"), Some("empresa/alcy")),
            Ok(Some(UpdateSource::Github {
                owner: "empresa".into(),
                repo: "alcy".into()
            }))
        );
        assert_eq!(
            configured_source(Some("manifest"), Some("https://cdn.corp/alcy/latest.json")),
            Ok(Some(UpdateSource::Manifest {
                url: "https://cdn.corp/alcy/latest.json".into()
            }))
        );
        assert_eq!(
            configured_source(
                Some(" releaseServer "),
                Some(" http://alcy-releases.interno:32761/ ")
            ),
            Ok(Some(UpdateSource::ReleaseServer {
                base_url: "http://alcy-releases.interno:32761".into()
            }))
        );
    }

    #[test]
    fn no_provider_disables_updates() {
        for provider in [None, Some(""), Some("  "), Some("none")] {
            assert_eq!(
                configured_source(provider, Some("http://srv")),
                Ok(None),
                "{provider:?}"
            );
        }
    }

    #[test]
    fn rejects_an_invalid_build_env() {
        for (provider, url) in [
            ("bitbucket", Some("http://srv")),
            ("gitlab", None),
            ("gitlab", Some("  ")),
            ("gitlab", Some("gitlab.corp")),
            ("github", Some("alcy")),
            ("releaseServer", None),
            ("releaseServer", Some("alcy-releases:32761")),
        ] {
            assert!(
                matches!(
                    configured_source(Some(provider), url),
                    Err(UpdateCommandError::Invalid { .. })
                ),
                "{provider} {url:?}"
            );
        }
    }

    #[test]
    fn errors_serialize_with_a_kind_tag() {
        assert_eq!(
            serde_json::to_value(UpdateCommandError::NoAccount {
                host: "gitlab.corp".into()
            })
            .unwrap(),
            serde_json::json!({"kind": "noAccount", "host": "gitlab.corp"})
        );
        assert_eq!(
            serde_json::to_value(UpdateCommandError::MissingPublicKey).unwrap(),
            serde_json::json!({"kind": "missingPublicKey"})
        );
    }

    #[test]
    fn settings_dto_shows_the_account_used_by_gitlab() {
        let settings = UpdateSettings::default();
        let source = UpdateSource::Gitlab {
            project_url: "https://gitlab.corp/grupo/alcy".into(),
        };
        let accounts = [
            account("https://gitlab.com", "outra"),
            account("https://gitlab.corp", "u"),
        ];

        let dto = settings_dto(&settings, Some(&source), &accounts, "0.1.0".into());
        assert_eq!(dto.current_version, "0.1.0");
        assert_eq!(
            dto.source,
            Some(UpdateSourceDto {
                provider: UpdateProviderDto::Gitlab,
                location: "https://gitlab.corp/grupo/alcy".into(),
                host: "gitlab.corp".into(),
                requires_account: true,
                account_id: Some("u@gitlab.corp".into()),
            })
        );

        let dto = settings_dto(&settings, Some(&source), &accounts[..1], "0.1.0".into());
        assert_eq!(dto.source.unwrap().account_id, None);

        let dto = settings_dto(&settings, None, &accounts, "0.1.0".into());
        assert_eq!(dto.source, None);
    }

    #[test]
    fn public_providers_need_no_account() {
        let github = UpdateSource::Github {
            owner: "empresa".into(),
            repo: "alcy".into(),
        };
        assert_eq!(
            source_dto(&github, &[]),
            UpdateSourceDto {
                provider: UpdateProviderDto::Github,
                location: "empresa/alcy".into(),
                host: "github.com".into(),
                requires_account: false,
                account_id: None,
            }
        );
        let manifest = UpdateSource::Manifest {
            url: "https://cdn.corp/alcy/latest.json".into(),
        };
        assert!(!source_dto(&manifest, &[]).requires_account);
        let server = UpdateSource::ReleaseServer {
            base_url: "http://alcy-releases.interno:32761".into(),
        };
        assert_eq!(
            source_dto(&server, &[]),
            UpdateSourceDto {
                provider: UpdateProviderDto::ReleaseServer,
                location: "http://alcy-releases.interno:32761".into(),
                host: "alcy-releases.interno".into(),
                requires_account: false,
                account_id: None,
            }
        );
    }

    #[tokio::test]
    async fn github_uses_the_public_latest_release_manifest() {
        let resolved = resolve_public(UpdateSource::Github {
            owner: "empresa".into(),
            repo: "alcy".into(),
        })
        .await;

        assert_eq!(
            resolved.manifest_url.as_str(),
            "https://github.com/empresa/alcy/releases/latest/download/latest.json"
        );
        assert!(resolved.auth.is_none());
        assert_eq!(
            resolved.info.web_url.as_deref(),
            Some("https://github.com/empresa/alcy/releases/latest")
        );
    }

    #[tokio::test]
    async fn a_direct_manifest_is_used_as_is_without_credentials() {
        let resolved = resolve_public(UpdateSource::Manifest {
            url: "https://cdn.corp/alcy/latest.json".into(),
        })
        .await;

        assert_eq!(
            resolved.manifest_url.as_str(),
            "https://cdn.corp/alcy/latest.json"
        );
        assert!(resolved.auth.is_none());
    }

    #[tokio::test]
    async fn the_release_server_serves_its_latest_manifest_without_credentials() {
        for (base_url, expected) in [
            (
                "http://alcy-releases.interno:32761",
                "http://alcy-releases.interno:32761/v1/releases/latest/latest.json",
            ),
            (
                "https://corp.com/releases",
                "https://corp.com/releases/v1/releases/latest/latest.json",
            ),
        ] {
            let resolved = resolve_public(UpdateSource::ReleaseServer {
                base_url: base_url.into(),
            })
            .await;

            assert_eq!(resolved.manifest_url.as_str(), expected);
            assert!(resolved.auth.is_none());
            assert_eq!(resolved.info.web_url, Some(format!("{base_url}/")));
        }
    }

    #[tokio::test]
    async fn a_direct_manifest_ignores_the_preview_preference() {
        let resolved = try_resolve_public(
            UpdateSource::Manifest {
                url: "https://cdn.corp/alcy/latest.json".into(),
            },
            true,
        )
        .await
        .unwrap();

        assert_eq!(
            resolved.manifest_url.as_str(),
            "https://cdn.corp/alcy/latest.json"
        );
    }

    async fn mount_github_releases(server: &MockServer, releases: serde_json::Value) {
        Mock::given(method("GET"))
            .and(path("/repos/empresa/alcy/releases"))
            .and(wiremock::matchers::header_exists("user-agent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(releases))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn github_previews_use_the_newest_published_release_with_a_manifest() {
        let server = MockServer::start().await;
        mount_github_releases(
            &server,
            serde_json::json!([
                { "tag_name": "v0.10.0-preview01", "draft": true,
                  "assets": [{ "name": "latest.json" }] },
                { "tag_name": "v0.9.1-preview02", "draft": false, "prerelease": true,
                  "name": "Alcy 0.9.1 preview 2", "body": "- Novidades",
                  "published_at": "2026-10-20T12:00:00Z",
                  "html_url": "https://github.com/empresa/alcy/releases/tag/v0.9.1-preview02",
                  "assets": [{ "name": "Alcy.exe" }, { "name": "latest.json" }] },
                { "tag_name": "v0.9.0", "draft": false, "prerelease": false,
                  "assets": [{ "name": "latest.json" }] }
            ]),
        )
        .await;

        let resolved = resolve_github_newest(&server.uri(), "empresa", "alcy", None)
            .await
            .unwrap();

        assert_eq!(
            resolved.manifest_url.as_str(),
            "https://github.com/empresa/alcy/releases/download/v0.9.1-preview02/latest.json"
        );
        assert!(resolved.auth.is_none());
        assert_eq!(resolved.info.name.as_deref(), Some("Alcy 0.9.1 preview 2"));
        assert_eq!(resolved.info.notes.as_deref(), Some("- Novidades"));
        assert_eq!(
            resolved.info.web_url.as_deref(),
            Some("https://github.com/empresa/alcy/releases/tag/v0.9.1-preview02")
        );
    }

    #[tokio::test]
    async fn github_previews_report_missing_releases_and_manifests() {
        let server = MockServer::start().await;
        mount_github_releases(
            &server,
            serde_json::json!([{ "tag_name": "v1.0.0", "assets": [{ "name": "Alcy.exe" }] }]),
        )
        .await;
        assert!(matches!(
            resolve_github_newest(&server.uri(), "empresa", "alcy", None).await,
            Err(UpdateCommandError::NoManifest { tag }) if tag == "v1.0.0"
        ));

        let empty = MockServer::start().await;
        mount_github_releases(&empty, serde_json::json!([])).await;
        assert!(matches!(
            resolve_github_newest(&empty.uri(), "empresa", "alcy", None).await,
            Err(UpdateCommandError::NoReleases)
        ));

        let missing = MockServer::start().await;
        assert!(matches!(
            resolve_github_newest(&missing.uri(), "empresa", "alcy", None).await,
            Err(UpdateCommandError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn release_server_previews_use_the_highest_listed_version() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/releases"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "version": "1.1.0-preview01", "manifestUrl": "/ignored" },
                { "version": "1.0.0" }
            ])))
            .mount(&server)
            .await;

        let resolved = try_resolve_public(
            UpdateSource::ReleaseServer {
                base_url: server.uri(),
            },
            true,
        )
        .await
        .unwrap();

        assert_eq!(
            resolved.manifest_url.as_str(),
            format!(
                "{}/v1/releases/1.1.0-preview01/files/latest.json",
                server.uri()
            )
        );
        assert_eq!(resolved.info.web_url, Some(format!("{}/", server.uri())));
    }

    #[tokio::test]
    async fn release_server_previews_without_releases_are_reported() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/releases"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let result = try_resolve_public(
            UpdateSource::ReleaseServer {
                base_url: server.uri(),
            },
            true,
        )
        .await;

        assert!(matches!(result, Err(UpdateCommandError::NoReleases)));
    }

    #[test]
    fn the_most_specific_account_wins() {
        let accounts = [
            account("https://corp.com", "raiz"),
            account("https://corp.com/gitlab", "sub"),
        ];

        let (chosen, path) = account_for("https://corp.com/gitlab/grupo/alcy", &accounts).unwrap();

        assert_eq!(chosen.id, accounts[1].id);
        assert_eq!(path, "grupo/alcy");
    }

    #[tokio::test]
    async fn a_release_requires_an_account_for_the_instance() {
        let accounts = [account("https://gitlab.com", "u")];
        let result = resolve_gitlab(
            "https://gitlab.corp/grupo/alcy",
            false,
            &accounts,
            &GitlabClient::new(),
            &credentials_for(&accounts),
        )
        .await;

        assert!(matches!(
            result,
            Err(UpdateCommandError::NoAccount { host }) if host == "gitlab.corp"
        ));
    }

    #[tokio::test]
    async fn a_missing_project_is_not_found() {
        let server = MockServer::start().await;

        let result = resolve(&server).await;

        assert!(matches!(result, Err(UpdateCommandError::NotFound { .. })));
    }

    #[tokio::test]
    async fn a_release_without_the_manifest_is_reported_by_tag() {
        let server = MockServer::start().await;
        mount_releases(
            &server,
            serde_json::json!([{ "name": "Alcy.exe", "url": format!("{}/a.exe", server.uri()) }]),
        )
        .await;

        let result = resolve(&server).await;

        assert!(matches!(
            result,
            Err(UpdateCommandError::NoManifest { tag }) if tag == "v0.2.0"
        ));
    }

    #[tokio::test]
    async fn a_manifest_outside_the_instance_is_rejected() {
        let server = MockServer::start().await;
        mount_releases(
            &server,
            serde_json::json!([{ "name": "latest.json", "url": "https://evil.example/latest.json" }]),
        )
        .await;

        let result = resolve(&server).await;

        assert!(matches!(result, Err(UpdateCommandError::OriginMismatch)));
    }

    #[tokio::test]
    async fn a_project_without_releases_is_reported() {
        let server = MockServer::start().await;
        mount_project(&server).await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/42/releases"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let result = resolve(&server).await;

        assert!(matches!(result, Err(UpdateCommandError::NoReleases)));
    }

    #[tokio::test]
    async fn resolves_the_manifest_of_the_latest_release() {
        let server = MockServer::start().await;
        let manifest = format!(
            "{}/api/v4/projects/42/packages/generic/alcy/0.2.0/latest.json",
            server.uri()
        );
        mount_releases(
            &server,
            serde_json::json!([{ "name": "latest.json", "url": manifest }]),
        )
        .await;

        let resolved = resolve(&server).await.unwrap();

        assert_eq!(resolved.manifest_url.as_str(), manifest);
        assert_eq!(resolved.info.name.as_deref(), Some("Alcy 0.2.0"));
        let auth = resolved.auth.unwrap();
        assert_eq!(auth.instance_url, server.uri());
        assert_eq!(auth.token, "t");
    }

    #[test]
    fn the_updater_follows_the_applied_proxy_plan() {
        let target = Url::parse("https://gitlab.corp/latest.json").unwrap();
        assert!(matches!(updater_proxy(None, &target), UpdaterProxy::Direct));
        assert!(matches!(
            updater_proxy(Some(&ProxyPlan::Disabled), &target),
            UpdaterProxy::Direct
        ));
        assert!(matches!(
            updater_proxy(Some(&ProxyPlan::System), &target),
            UpdaterProxy::System
        ));

        let script = alcy_http_proxy::PacScript::new(
            r#"function FindProxyForURL(url, host) {
                return host === "gitlab.corp" ? "PROXY proxy.corp:3128" : "DIRECT";
            }"#,
        )
        .unwrap();
        let plan = ProxyPlan::Pac(std::sync::Arc::new(script));
        assert!(matches!(
            updater_proxy(Some(&plan), &target),
            UpdaterProxy::Via(proxy) if proxy.as_str() == "http://proxy.corp:3128/"
        ));
        let other = Url::parse("https://outro.corp/x").unwrap();
        assert!(matches!(
            updater_proxy(Some(&plan), &other),
            UpdaterProxy::Direct
        ));
    }
}
