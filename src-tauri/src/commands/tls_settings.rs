use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_http_proxy::ProxyError;
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{StorageError, TlsSettings, TlsSettingsStore};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TlsSettingsDto {
    /// Verifica o certificado do servidor nas chamadas do usuário.
    pub verify_certificates: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TlsSettingsCommandError {
    Client { message: String },
    Storage { message: String },
}

fn to_dto(settings: &TlsSettings) -> TlsSettingsDto {
    TlsSettingsDto {
        verify_certificates: settings.verify_certificates,
    }
}

fn storage_error(error: StorageError) -> TlsSettingsCommandError {
    TlsSettingsCommandError::Storage {
        message: error.to_string(),
    }
}

fn client_error(error: ProxyError) -> TlsSettingsCommandError {
    TlsSettingsCommandError::Client {
        message: error.to_string(),
    }
}

/// Só os executores das chamadas do usuário (requisições, flows, runner,
/// carga e introspecção) obedecem à preferência. Importação por URL, GitLab
/// e updater sempre verificam o certificado (ADR 0058).
fn apply(
    settings: &TlsSettings,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
) -> Result<(), ProxyError> {
    let accept_invalid = !settings.verify_certificates;
    graphql.set_accept_invalid_certificates(accept_invalid)?;
    rest.set_accept_invalid_certificates(accept_invalid)
}

/// Aplica a preferência salva na abertura do app. Se não puder ser lida, os
/// executores seguem verificando os certificados.
pub fn apply_saved_tls_settings(
    store: &TlsSettingsStore,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
) {
    let settings = match store.load() {
        Ok(settings) => settings,
        Err(error) => {
            log::warn!(target: "alcy::tls", "preferência de TLS ilegível; verificação de certificado mantida: {error}");
            return;
        }
    };
    match apply(&settings, graphql, rest) {
        Ok(()) if !settings.verify_certificates => {
            log::warn!(target: "alcy::tls", "verificação de certificado desativada nas chamadas do usuário");
        }
        Ok(()) => {}
        Err(error) => {
            log::warn!(target: "alcy::tls", "não foi possível aplicar a preferência de TLS: {error}");
        }
    }
}

fn save_settings(
    store: &TlsSettingsStore,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    input: &TlsSettingsDto,
) -> Result<TlsSettingsDto, TlsSettingsCommandError> {
    let settings = TlsSettings {
        verify_certificates: input.verify_certificates,
    };
    // Aplica antes de persistir: um valor que não pôde ser usado não
    // substitui o anterior.
    apply(&settings, graphql, rest).map_err(client_error)?;
    store.save(&settings).map_err(storage_error)?;
    if !settings.verify_certificates {
        log::warn!(target: "alcy::tls", "verificação de certificado desativada nas chamadas do usuário");
    }
    Ok(to_dto(&settings))
}

#[tauri::command]
pub fn get_tls_settings(
    store: State<'_, TlsSettingsStore>,
) -> Result<TlsSettingsDto, TlsSettingsCommandError> {
    crate::logging::logged_with("alcy::tls", "ler preferência de TLS", || {
        store
            .load()
            .map(|settings| to_dto(&settings))
            .map_err(storage_error)
    })
}

#[tauri::command]
pub fn save_tls_settings(
    input: TlsSettingsDto,
    store: State<'_, TlsSettingsStore>,
    graphql: State<'_, ReqwestGraphqlExecutor>,
    rest: State<'_, ReqwestRestExecutor>,
) -> Result<TlsSettingsDto, TlsSettingsCommandError> {
    crate::logging::logged_with("alcy::tls", "salvar preferência de TLS", || {
        save_settings(&store, &graphql, &rest, &input)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_store() -> (TlsSettingsStore, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!("alcy-tls-command-test-{nanos}.json"));
        (TlsSettingsStore::new(path.clone()), path)
    }

    #[test]
    fn dto_serializes_as_camel_case() {
        assert_eq!(
            serde_json::to_value(TlsSettingsDto {
                verify_certificates: false
            })
            .unwrap(),
            serde_json::json!({ "verifyCertificates": false })
        );
    }

    #[test]
    fn saving_persists_and_returns_the_preference() {
        let (store, path) = temp_store();
        let (graphql, rest) = (ReqwestGraphqlExecutor::new(), ReqwestRestExecutor::new());

        for verify_certificates in [false, true] {
            let input = TlsSettingsDto {
                verify_certificates,
            };
            assert_eq!(save_settings(&store, &graphql, &rest, &input), Ok(input));
            assert_eq!(
                store.load().unwrap().verify_certificates,
                verify_certificates
            );
        }
        let _ = std::fs::remove_file(path);
    }
}
