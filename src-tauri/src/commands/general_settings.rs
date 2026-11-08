use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use alcy_domain::{
    DEFAULT_HISTORY_RETENTION_DAYS, DEFAULT_RESPONSE_SIZE_LIMIT_MB, GeneralSettings,
    HistoryRetention, RequestTimeout, ResponseSizeLimit,
};
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_http_proxy::ProxyError;
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{GeneralSettingsStore, StorageError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsDto {
    /// `null` desabilita o timeout das chamadas.
    pub request_timeout_seconds: Option<u32>,
    /// `null` desabilita o limite de tamanho do corpo de resposta.
    #[serde(default = "default_response_size_limit_mb")]
    pub response_size_limit_mb: Option<u32>,
    /// Dias de retenção do histórico; `0` desativa o histórico.
    #[serde(default = "default_history_retention_days")]
    pub history_retention_days: u32,
    /// Guarda corpo e headers das respostas no histórico; desligado por padrão.
    #[serde(default)]
    pub save_history_responses: bool,
}

fn default_response_size_limit_mb() -> Option<u32> {
    Some(DEFAULT_RESPONSE_SIZE_LIMIT_MB)
}

fn default_history_retention_days() -> u32 {
    DEFAULT_HISTORY_RETENTION_DAYS
}

/// Como o histórico é gravado: por quantos dias e se as respostas (corpo e
/// headers) são guardadas.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HistoryPreferences {
    pub retention: HistoryRetention,
    pub save_responses: bool,
}

/// Preferências de histórico em vigor, consultadas por quem grava ou lista o
/// histórico (requisições, flows e runner). Começam no padrão e são trocadas
/// pelas preferências salvas, como o timeout dos executores.
pub struct HistoryPreferencesState {
    retention_days: AtomicU32,
    save_responses: AtomicBool,
}

impl Default for HistoryPreferencesState {
    fn default() -> Self {
        Self {
            retention_days: AtomicU32::new(DEFAULT_HISTORY_RETENTION_DAYS),
            save_responses: AtomicBool::new(false),
        }
    }
}

impl HistoryPreferencesState {
    pub fn get(&self) -> HistoryPreferences {
        HistoryPreferences {
            retention: HistoryRetention::days(self.retention_days.load(Ordering::Relaxed))
                .unwrap_or_default(),
            save_responses: self.save_responses.load(Ordering::Relaxed),
        }
    }

    fn set(&self, settings: &GeneralSettings) {
        self.retention_days
            .store(settings.history_retention.as_days(), Ordering::Relaxed);
        self.save_responses
            .store(settings.save_history_responses, Ordering::Relaxed);
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GeneralSettingsCommandError {
    Invalid { message: String },
    Client { message: String },
    Storage { message: String },
}

fn to_dto(settings: &GeneralSettings) -> GeneralSettingsDto {
    GeneralSettingsDto {
        request_timeout_seconds: match settings.request_timeout {
            RequestTimeout::Disabled => None,
            RequestTimeout::Seconds(seconds) => Some(seconds),
        },
        response_size_limit_mb: match settings.response_size_limit {
            ResponseSizeLimit::Disabled => None,
            ResponseSizeLimit::Megabytes(megabytes) => Some(megabytes),
        },
        history_retention_days: settings.history_retention.as_days(),
        save_history_responses: settings.save_history_responses,
    }
}

fn from_dto(dto: &GeneralSettingsDto) -> Result<GeneralSettings, GeneralSettingsCommandError> {
    let request_timeout = match dto.request_timeout_seconds {
        None => RequestTimeout::Disabled,
        Some(seconds) => RequestTimeout::seconds(seconds).map_err(|error| {
            GeneralSettingsCommandError::Invalid {
                message: error.to_string(),
            }
        })?,
    };
    let response_size_limit = match dto.response_size_limit_mb {
        None => ResponseSizeLimit::Disabled,
        Some(megabytes) => ResponseSizeLimit::megabytes(megabytes).map_err(|error| {
            GeneralSettingsCommandError::Invalid {
                message: error.to_string(),
            }
        })?,
    };
    let history_retention =
        HistoryRetention::days(dto.history_retention_days).map_err(|error| {
            GeneralSettingsCommandError::Invalid {
                message: error.to_string(),
            }
        })?;
    Ok(GeneralSettings {
        request_timeout,
        response_size_limit,
        history_retention,
        save_history_responses: dto.save_history_responses,
    })
}

fn storage_error(error: StorageError) -> GeneralSettingsCommandError {
    GeneralSettingsCommandError::Storage {
        message: error.to_string(),
    }
}

fn client_error(error: ProxyError) -> GeneralSettingsCommandError {
    GeneralSettingsCommandError::Client {
        message: error.to_string(),
    }
}

/// O timeout vale para as chamadas do usuário: requisições, flows e
/// introspecção de schema, que passam pelos executores REST e GraphQL. O
/// limite de resposta vale para as mesmas chamadas, menos a introspecção.
fn apply(
    settings: &GeneralSettings,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    history: &HistoryPreferencesState,
) -> Result<(), ProxyError> {
    let timeout = settings.request_timeout.duration();
    graphql.set_timeout(timeout)?;
    rest.set_timeout(timeout)?;
    graphql.set_response_size_limit(settings.response_size_limit);
    rest.set_response_size_limit(settings.response_size_limit);
    history.set(settings);
    Ok(())
}

/// Arquivos que versões anteriores deixam no diretório de dados do app. Se
/// algum já existe na abertura, o app foi usado antes desta versão.
const PREVIOUS_INSTALL_MARKERS: &[&str] = &[
    "general-settings.json",
    "recent-workspaces.json",
    "proxy-settings.json",
    "update-settings.json",
    "security-settings.json",
    "tls-settings.json",
    "schema-cache",
    "version-control-cache",
];

/// Diz se o app já foi aberto antes neste computador. Precisa rodar no
/// início da abertura, antes de qualquer store gravar no diretório.
pub fn is_previous_install(app_data_dir: &Path) -> bool {
    PREVIOUS_INSTALL_MARKERS
        .iter()
        .any(|name| app_data_dir.join(name).exists())
}

/// Aplica as preferências salvas na abertura do app. Se não puderem ser
/// lidas, os executores seguem com o padrão, e o erro aparece ao abrir a aba
/// "Geral".
///
/// Na primeira abertura desta versão, grava as preferências iniciais: quem já
/// usava o app continua com as respostas guardadas no histórico, e uma
/// instalação nova começa sem elas.
pub fn apply_saved_general_settings(
    store: &GeneralSettingsStore,
    previous_install: bool,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    history: &HistoryPreferencesState,
) {
    if let Err(error) = store.ensure_first_run_defaults(previous_install) {
        log::warn!(target: "alcy::settings", "não foi possível gravar as preferências iniciais: {error}");
    }
    if let Ok(settings) = store.load() {
        if let Err(error) = apply(&settings, graphql, rest, history) {
            log::warn!(target: "alcy::settings", "não foi possível aplicar o timeout salvo: {error}");
        }
    }
}

fn save_settings(
    store: &GeneralSettingsStore,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    history: &HistoryPreferencesState,
    input: &GeneralSettingsDto,
) -> Result<GeneralSettingsDto, GeneralSettingsCommandError> {
    let settings = from_dto(input)?;
    // Aplica antes de persistir: um valor que não pôde ser usado não
    // substitui o anterior.
    apply(&settings, graphql, rest, history).map_err(client_error)?;
    store.save(&settings).map_err(storage_error)?;
    Ok(to_dto(&settings))
}

#[tauri::command]
pub fn get_general_settings(
    store: State<'_, GeneralSettingsStore>,
) -> Result<GeneralSettingsDto, GeneralSettingsCommandError> {
    crate::logging::logged_with("alcy::settings", "ler configurações gerais", || {
        store
            .load()
            .map(|settings| to_dto(&settings))
            .map_err(storage_error)
    })
}

#[tauri::command]
pub fn save_general_settings(
    input: GeneralSettingsDto,
    store: State<'_, GeneralSettingsStore>,
    graphql: State<'_, ReqwestGraphqlExecutor>,
    rest: State<'_, ReqwestRestExecutor>,
    history: State<'_, HistoryPreferencesState>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<GeneralSettingsDto, GeneralSettingsCommandError> {
    let result =
        crate::logging::logged_with("alcy::settings", "salvar configurações gerais", || {
            save_settings(&store, &graphql, &rest, &history, &input)
        });
    crate::commands::usage_events::record_setting(&usage, "general", None, &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_store() -> (GeneralSettingsStore, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!("alcy-general-command-test-{nanos}.json"));
        (GeneralSettingsStore::new(path.clone()), path)
    }

    fn dto(request_timeout_seconds: Option<u32>) -> GeneralSettingsDto {
        GeneralSettingsDto {
            request_timeout_seconds,
            response_size_limit_mb: Some(DEFAULT_RESPONSE_SIZE_LIMIT_MB),
            history_retention_days: DEFAULT_HISTORY_RETENTION_DAYS,
            save_history_responses: false,
        }
    }

    #[test]
    fn dto_serializes_as_camel_case_with_null_for_disabled() {
        assert_eq!(
            serde_json::to_value(dto(None)).unwrap(),
            serde_json::json!({
                "requestTimeoutSeconds": null,
                "responseSizeLimitMb": 50,
                "historyRetentionDays": 7,
                "saveHistoryResponses": false
            })
        );
        assert_eq!(
            serde_json::to_value(GeneralSettingsDto {
                request_timeout_seconds: Some(60),
                response_size_limit_mb: None,
                history_retention_days: 0,
                save_history_responses: true,
            })
            .unwrap(),
            serde_json::json!({
                "requestTimeoutSeconds": 60,
                "responseSizeLimitMb": null,
                "historyRetentionDays": 0,
                "saveHistoryResponses": true
            })
        );
    }

    #[test]
    fn a_dto_without_the_response_limit_gets_the_default() {
        let parsed: GeneralSettingsDto =
            serde_json::from_value(serde_json::json!({"requestTimeoutSeconds": 30})).unwrap();
        assert_eq!(
            parsed.response_size_limit_mb,
            Some(DEFAULT_RESPONSE_SIZE_LIMIT_MB)
        );
        assert_eq!(
            parsed.history_retention_days,
            DEFAULT_HISTORY_RETENTION_DAYS
        );
    }

    #[test]
    fn saving_the_history_retention_applies_it_and_rejects_more_than_seven_days() {
        let (store, path) = temp_store();
        let (graphql, rest) = (ReqwestGraphqlExecutor::new(), ReqwestRestExecutor::new());
        let history = HistoryPreferencesState::default();
        let disabled = GeneralSettingsDto {
            history_retention_days: 0,
            ..dto(Some(60))
        };

        save_settings(&store, &graphql, &rest, &history, &disabled).unwrap();
        assert!(history.get().retention.is_disabled());

        let too_long = GeneralSettingsDto {
            history_retention_days: 8,
            ..dto(Some(60))
        };
        assert!(matches!(
            save_settings(&store, &graphql, &rest, &history, &too_long),
            Err(GeneralSettingsCommandError::Invalid { .. })
        ));
        assert!(history.get().retention.is_disabled());
        assert_eq!(to_dto(&store.load().unwrap()), disabled);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn saves_a_disabled_response_limit_and_rejects_an_out_of_range_one() {
        let (store, path) = temp_store();
        let (graphql, rest) = (ReqwestGraphqlExecutor::new(), ReqwestRestExecutor::new());
        let history = HistoryPreferencesState::default();
        let disabled = GeneralSettingsDto {
            request_timeout_seconds: Some(60),
            response_size_limit_mb: None,
            history_retention_days: DEFAULT_HISTORY_RETENTION_DAYS,
            save_history_responses: false,
        };

        assert_eq!(
            save_settings(&store, &graphql, &rest, &history, &disabled).unwrap(),
            disabled
        );
        let out_of_range = GeneralSettingsDto {
            response_size_limit_mb: Some(0),
            ..disabled.clone()
        };
        assert!(matches!(
            save_settings(&store, &graphql, &rest, &history, &out_of_range),
            Err(GeneralSettingsCommandError::Invalid { .. })
        ));
        assert_eq!(to_dto(&store.load().unwrap()), disabled);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn saves_valid_timeouts_including_disabled() {
        let (store, path) = temp_store();
        let (graphql, rest) = (ReqwestGraphqlExecutor::new(), ReqwestRestExecutor::new());
        let history = HistoryPreferencesState::default();

        for value in [Some(15), None] {
            let saved = save_settings(&store, &graphql, &rest, &history, &dto(value)).unwrap();
            assert_eq!(saved, dto(value));
            assert_eq!(to_dto(&store.load().unwrap()), dto(value));
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_an_out_of_range_timeout_without_persisting() {
        let (store, path) = temp_store();
        let (graphql, rest) = (ReqwestGraphqlExecutor::new(), ReqwestRestExecutor::new());
        let history = HistoryPreferencesState::default();

        let result = save_settings(&store, &graphql, &rest, &history, &dto(Some(0)));

        assert!(matches!(
            result,
            Err(GeneralSettingsCommandError::Invalid { .. })
        ));
        assert_eq!(store.load().unwrap(), GeneralSettings::default());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn detects_a_previous_install_by_the_files_it_left() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("alcy-previous-install-test-{nanos}"));

        assert!(!is_previous_install(&dir));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".window-state.json"), "{}").unwrap();
        assert!(!is_previous_install(&dir));

        std::fs::write(dir.join("recent-workspaces.json"), "{}").unwrap();
        assert!(is_previous_install(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn startup_keeps_saving_responses_for_a_previous_install_only() {
        let (graphql, rest) = (ReqwestGraphqlExecutor::new(), ReqwestRestExecutor::new());
        for previous_install in [true, false] {
            let (store, path) = temp_store();
            let history = HistoryPreferencesState::default();

            apply_saved_general_settings(&store, previous_install, &graphql, &rest, &history);

            assert_eq!(history.get().save_responses, previous_install);
            assert_eq!(history.get().retention, HistoryRetention::default());
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn get_defaults_to_sixty_seconds() {
        let (store, _path) = temp_store();
        assert_eq!(to_dto(&store.load().unwrap()), dto(Some(60)));
    }
}
