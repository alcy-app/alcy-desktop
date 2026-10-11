use std::sync::Mutex;

use alcy_domain::{ProxySettings, ProxySettingsError};
use alcy_gitlab::GitlabClient;
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_http_proxy::{ProxyError, ProxyPlan};
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{ProxySettingsStore, StorageError};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::import_fetcher::ImportFetcher;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProxyModeDto {
    Disabled,
    System,
    Pac,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettingsDto {
    pub mode: ProxyModeDto,
    #[serde(default)]
    pub pac_url: Option<String>,
}

/// Configuração salva + situação da aplicação dela nos clientes HTTP.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatusDto {
    #[serde(flatten)]
    pub settings: ProxySettingsDto,
    /// Preenchido quando a configuração salva não pôde ser aplicada (ex.:
    /// script PAC inacessível na abertura do app); as requisições seguem
    /// diretas até uma nova tentativa.
    pub error: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProxyCommandError {
    Invalid { message: String },
    Pac { message: String },
    Storage { message: String },
}

/// Último erro ao aplicar a configuração salva e o plano em uso (estado
/// gerenciado). O plano é lido por clientes HTTP que não passam pelos
/// executores reconfiguráveis (ex.: o updater).
#[derive(Default)]
pub struct ProxyApplyState {
    error: Mutex<Option<String>>,
    plan: Mutex<Option<ProxyPlan>>,
}

impl ProxyApplyState {
    fn set_plan(&self, plan: ProxyPlan) {
        match self.plan.lock() {
            Ok(mut guard) => *guard = Some(plan),
            Err(poisoned) => *poisoned.into_inner() = Some(plan),
        }
    }

    /// Plano aplicado por último; `None` enquanto nenhum foi aplicado (as
    /// requisições saem diretas).
    pub fn plan(&self) -> Option<ProxyPlan> {
        match self.plan.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn set(&self, error: Option<String>) {
        match self.error.lock() {
            Ok(mut guard) => *guard = error,
            Err(poisoned) => *poisoned.into_inner() = error,
        }
    }

    fn get(&self) -> Option<String> {
        match self.error.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

fn to_dto(settings: &ProxySettings) -> ProxySettingsDto {
    match settings {
        ProxySettings::Disabled => ProxySettingsDto {
            mode: ProxyModeDto::Disabled,
            pac_url: None,
        },
        ProxySettings::System => ProxySettingsDto {
            mode: ProxyModeDto::System,
            pac_url: None,
        },
        ProxySettings::Pac { url } => ProxySettingsDto {
            mode: ProxyModeDto::Pac,
            pac_url: Some(url.clone()),
        },
    }
}

fn from_dto(dto: &ProxySettingsDto) -> Result<ProxySettings, ProxySettingsError> {
    match dto.mode {
        ProxyModeDto::Disabled => Ok(ProxySettings::Disabled),
        ProxyModeDto::System => Ok(ProxySettings::System),
        ProxyModeDto::Pac => ProxySettings::pac(dto.pac_url.as_deref().unwrap_or_default()),
    }
}

fn invalid(error: ProxySettingsError) -> ProxyCommandError {
    ProxyCommandError::Invalid {
        message: error.to_string(),
    }
}

fn pac_error(error: ProxyError) -> ProxyCommandError {
    ProxyCommandError::Pac {
        message: error.to_string(),
    }
}

fn storage_error(error: StorageError) -> ProxyCommandError {
    ProxyCommandError::Storage {
        message: error.to_string(),
    }
}

fn apply_plan(
    plan: &ProxyPlan,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    import_fetcher: &ImportFetcher,
    gitlab: &GitlabClient,
) -> Result<(), ProxyError> {
    graphql.reconfigure_proxy(plan)?;
    rest.reconfigure_proxy(plan)?;
    import_fetcher.reconfigure_proxy(plan)?;
    gitlab.reconfigure_proxy(plan)
}

/// Aplica a configuração salva na abertura do app. Falhas não impedem o
/// app de abrir: ficam registradas em `state` e as requisições seguem
/// diretas.
pub async fn apply_saved_settings(
    store: &ProxySettingsStore,
    state: &ProxyApplyState,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    import_fetcher: &ImportFetcher,
    gitlab: &GitlabClient,
) {
    let outcome = match store.load() {
        Ok(settings) => match ProxyPlan::resolve(&settings).await {
            Ok(plan) => apply_plan(&plan, graphql, rest, import_fetcher, gitlab)
                .map(|()| state.set_plan(plan)),
            Err(error) => Err(error),
        },
        Err(error) => Err(ProxyError::ClientBuild(error.to_string())),
    };
    // Só o resultado: a mensagem do erro pode conter o endereço do proxy/PAC.
    match &outcome {
        Ok(()) => log::info!(target: "alcy::proxy", "configuração de proxy salva aplicada"),
        Err(_) => log::warn!(
            target: "alcy::proxy",
            "configuração de proxy salva não pôde ser aplicada; requisições saem diretas"
        ),
    }
    state.set(outcome.err().map(|error| error.to_string()));
}

async fn save_settings(
    store: &ProxySettingsStore,
    state: &ProxyApplyState,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    import_fetcher: &ImportFetcher,
    gitlab: &GitlabClient,
    input: &ProxySettingsDto,
) -> Result<ProxyStatusDto, ProxyCommandError> {
    let settings = from_dto(input).map_err(invalid)?;
    // Resolve e aplica antes de persistir: uma configuração que não funciona
    // (ex.: PAC inacessível) não substitui a anterior.
    let plan = ProxyPlan::resolve(&settings).await.map_err(pac_error)?;
    apply_plan(&plan, graphql, rest, import_fetcher, gitlab).map_err(pac_error)?;
    store.save(&settings).map_err(storage_error)?;
    state.set(None);
    state.set_plan(plan);

    Ok(ProxyStatusDto {
        settings: to_dto(&settings),
        error: None,
    })
}

#[tauri::command]
pub fn get_proxy_settings(
    store: State<'_, ProxySettingsStore>,
    state: State<'_, ProxyApplyState>,
) -> Result<ProxyStatusDto, ProxyCommandError> {
    crate::logging::logged_with("alcy::proxy", "ler proxy", || {
        let settings = store.load().map_err(storage_error)?;
        Ok(ProxyStatusDto {
            settings: to_dto(&settings),
            error: state.get(),
        })
    })
}

#[tauri::command]
pub async fn save_proxy_settings(
    input: ProxySettingsDto,
    store: State<'_, ProxySettingsStore>,
    state: State<'_, ProxyApplyState>,
    graphql: State<'_, ReqwestGraphqlExecutor>,
    rest: State<'_, ReqwestRestExecutor>,
    import_fetcher: State<'_, ImportFetcher>,
    gitlab: State<'_, GitlabClient>,
) -> Result<ProxyStatusDto, ProxyCommandError> {
    let result: Result<ProxyStatusDto, ProxyCommandError> = async {
        save_settings(
            &store,
            &state,
            &graphql,
            &rest,
            &import_fetcher,
            &gitlab,
            &input,
        )
        .await
    }
    .await;
    crate::logging::logged("alcy::proxy", "salvar proxy", result)
}

/// Valida a configuração sem aplicá-la nem salvá-la (baixa e avalia o PAC).
#[tauri::command]
pub async fn test_proxy_settings(input: ProxySettingsDto) -> Result<(), ProxyCommandError> {
    let result: Result<(), ProxyCommandError> = async {
        let settings = from_dto(&input).map_err(invalid)?;
        ProxyPlan::resolve(&settings)
            .await
            .map(|_| ())
            .map_err(pac_error)
    }
    .await;
    crate::logging::logged("alcy::proxy", "testar proxy", result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn temp_store() -> (ProxySettingsStore, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!("alcy-proxy-command-test-{nanos}.json"));
        (ProxySettingsStore::new(path.clone()), path)
    }

    fn dto(mode: ProxyModeDto, pac_url: Option<&str>) -> ProxySettingsDto {
        ProxySettingsDto {
            mode,
            pac_url: pac_url.map(str::to_string),
        }
    }

    #[test]
    fn dto_serializes_as_camel_case_with_the_error_flattened() {
        let status = ProxyStatusDto {
            settings: dto(ProxyModeDto::Pac, Some("https://corp/p.pac")),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"mode": "pac", "pacUrl": "https://corp/p.pac", "error": null})
        );
    }

    #[tokio::test]
    async fn saves_and_reports_invalid_pac_urls_without_persisting() {
        let (store, path) = temp_store();
        let state = ProxyApplyState::default();
        let (graphql, rest, fetcher, gitlab) = (
            ReqwestGraphqlExecutor::new(),
            ReqwestRestExecutor::new(),
            ImportFetcher::new(),
            GitlabClient::new(),
        );

        let saved = save_settings(
            &store,
            &state,
            &graphql,
            &rest,
            &fetcher,
            &gitlab,
            &dto(ProxyModeDto::System, None),
        )
        .await
        .unwrap();
        assert_eq!(saved.settings.mode, ProxyModeDto::System);
        assert_eq!(store.load().unwrap(), ProxySettings::System);
        assert!(matches!(state.plan(), Some(ProxyPlan::System)));

        let invalid_url = save_settings(
            &store,
            &state,
            &graphql,
            &rest,
            &fetcher,
            &gitlab,
            &dto(ProxyModeDto::Pac, Some("ftp://x")),
        )
        .await;
        assert!(matches!(
            invalid_url,
            Err(ProxyCommandError::Invalid { .. })
        ));
        assert_eq!(store.load().unwrap(), ProxySettings::System);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn unreachable_pac_keeps_the_previous_settings() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/p.pac"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let (store, path) = temp_store();
        let state = ProxyApplyState::default();
        let (graphql, rest, fetcher, gitlab) = (
            ReqwestGraphqlExecutor::new(),
            ReqwestRestExecutor::new(),
            ImportFetcher::new(),
            GitlabClient::new(),
        );
        let pac_url = format!("{}/p.pac", server.uri());

        let result = save_settings(
            &store,
            &state,
            &graphql,
            &rest,
            &fetcher,
            &gitlab,
            &dto(ProxyModeDto::Pac, Some(&pac_url)),
        )
        .await;
        assert!(matches!(result, Err(ProxyCommandError::Pac { .. })));
        assert_eq!(store.load().unwrap(), ProxySettings::Disabled);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn startup_records_the_error_when_the_saved_pac_is_unreachable() {
        let (store, path) = temp_store();
        store
            .save(&ProxySettings::pac("http://127.0.0.1:1/p.pac").unwrap())
            .unwrap();
        let state = ProxyApplyState::default();

        apply_saved_settings(
            &store,
            &state,
            &ReqwestGraphqlExecutor::new(),
            &ReqwestRestExecutor::new(),
            &ImportFetcher::new(),
            &GitlabClient::new(),
        )
        .await;

        assert!(state.get().is_some());
        let _ = std::fs::remove_file(path);
    }
}
