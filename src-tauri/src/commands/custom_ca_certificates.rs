use std::fs;
use std::path::Path;

use alcy_agent::AgentHttpClient;
use alcy_gitlab::GitlabClient;
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_http_proxy::ProxyError;
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{CustomCaCertificate, CustomCaCertificateStore, StorageError};
use serde::Serialize;
use tauri::State;

use super::import_fetcher::ImportFetcher;
use super::onedrive::OnedriveProvider;
use super::remote_command::RemoteHttpClients;

const MAX_PEM_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomCaCertificateDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CustomCaCertificateCommandError {
    File { message: String },
    Invalid { message: String },
    Storage { message: String },
}

fn to_dto(item: &CustomCaCertificate) -> CustomCaCertificateDto {
    CustomCaCertificateDto {
        id: item.id.clone(),
        name: item.name.clone(),
    }
}
fn storage_error(error: StorageError) -> CustomCaCertificateCommandError {
    CustomCaCertificateCommandError::Storage {
        message: error.to_string(),
    }
}
fn invalid(error: ProxyError) -> CustomCaCertificateCommandError {
    CustomCaCertificateCommandError::Invalid {
        message: error.to_string(),
    }
}

fn apply(
    certificates: &[CustomCaCertificate],
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    import_fetcher: &ImportFetcher,
    remotes: RemoteHttpClients<'_>,
) -> Result<(), ProxyError> {
    let pem_bundles: Vec<String> = certificates.iter().map(|item| item.pem.clone()).collect();
    graphql.set_custom_ca_certificates(&pem_bundles)?;
    rest.set_custom_ca_certificates(&pem_bundles)?;
    import_fetcher.set_custom_ca_certificates(&pem_bundles)?;
    remotes.set_custom_ca_certificates(&pem_bundles)
}

pub fn apply_saved_custom_ca_certificates(
    store: &CustomCaCertificateStore,
    graphql: &ReqwestGraphqlExecutor,
    rest: &ReqwestRestExecutor,
    import_fetcher: &ImportFetcher,
    remotes: RemoteHttpClients<'_>,
) {
    match store.load().and_then(|certificates| {
        apply(&certificates, graphql, rest, import_fetcher, remotes)
            .map_err(|error| StorageError::Corrupted(error.to_string()))
    }) {
        Ok(()) => log::info!(target: "alcy::tls", "CAs personalizadas aplicadas"),
        Err(_) => {
            log::warn!(target: "alcy::tls", "CAs personalizadas não puderam ser aplicadas; usando só raízes do sistema")
        }
    }
}

fn read_pem(path: &str) -> Result<(String, String), CustomCaCertificateCommandError> {
    let metadata = fs::metadata(path).map_err(|error| CustomCaCertificateCommandError::File {
        message: error.to_string(),
    })?;
    if !metadata.is_file() {
        return Err(CustomCaCertificateCommandError::File {
            message: "o caminho escolhido não é um arquivo".into(),
        });
    }
    if metadata.len() > MAX_PEM_BYTES {
        return Err(CustomCaCertificateCommandError::File {
            message: "o arquivo excede o limite de 1 MB".into(),
        });
    }
    let pem = fs::read_to_string(path).map_err(|error| CustomCaCertificateCommandError::File {
        message: error.to_string(),
    })?;
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| CustomCaCertificateCommandError::File {
            message: "não foi possível identificar o nome do arquivo".into(),
        })?
        .to_string();
    Ok((name, pem))
}

fn certificate_id(pem: &str, existing: &[CustomCaCertificate]) -> String {
    let hash = pem
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    let base = format!("ca-{hash:016x}");
    if !existing.iter().any(|item| item.id == base) {
        return base;
    }
    let mut suffix = 2_u32;
    loop {
        let candidate = format!("{base}-{suffix}");
        if !existing.iter().any(|item| item.id == candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

#[tauri::command]
pub fn list_custom_ca_certificates(
    store: State<'_, CustomCaCertificateStore>,
) -> Result<Vec<CustomCaCertificateDto>, CustomCaCertificateCommandError> {
    crate::logging::logged_with("alcy::tls", "listar CAs personalizadas", || {
        Ok(store
            .load()
            .map_err(storage_error)?
            .iter()
            .map(to_dto)
            .collect())
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_custom_ca_certificate(
    path: String,
    store: State<'_, CustomCaCertificateStore>,
    graphql: State<'_, ReqwestGraphqlExecutor>,
    rest: State<'_, ReqwestRestExecutor>,
    import_fetcher: State<'_, ImportFetcher>,
    gitlab: State<'_, GitlabClient>,
    onedrive: State<'_, OnedriveProvider>,
    agent: State<'_, AgentHttpClient>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<Vec<CustomCaCertificateDto>, CustomCaCertificateCommandError> {
    let result = crate::logging::logged_with("alcy::tls", "adicionar CA personalizada", || {
        let (name, pem) = read_pem(&path)?;
        let mut certificates = store.load().map_err(storage_error)?;
        if certificates.iter().any(|item| item.pem == pem) {
            return Err(CustomCaCertificateCommandError::Invalid {
                message: "esta CA já foi adicionada".into(),
            });
        }
        certificates.push(CustomCaCertificate {
            id: certificate_id(&pem, &certificates),
            name,
            pem,
        });
        apply(
            &certificates,
            &graphql,
            &rest,
            &import_fetcher,
            RemoteHttpClients {
                gitlab: &gitlab,
                onedrive: &onedrive.client,
                agent: &agent,
            },
        )
        .map_err(invalid)?;
        store.save(&certificates).map_err(storage_error)?;
        Ok(certificates.iter().map(to_dto).collect())
    });
    crate::commands::usage_events::record_setting(
        &usage,
        "network",
        Some("customCaAdded"),
        &result,
    );
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn remove_custom_ca_certificate(
    id: String,
    store: State<'_, CustomCaCertificateStore>,
    graphql: State<'_, ReqwestGraphqlExecutor>,
    rest: State<'_, ReqwestRestExecutor>,
    import_fetcher: State<'_, ImportFetcher>,
    gitlab: State<'_, GitlabClient>,
    onedrive: State<'_, OnedriveProvider>,
    agent: State<'_, AgentHttpClient>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<Vec<CustomCaCertificateDto>, CustomCaCertificateCommandError> {
    let result = crate::logging::logged_with("alcy::tls", "remover CA personalizada", || {
        let mut certificates = store.load().map_err(storage_error)?;
        let before = certificates.len();
        certificates.retain(|item| item.id != id);
        if certificates.len() == before {
            return Err(CustomCaCertificateCommandError::Invalid {
                message: "CA não encontrada".into(),
            });
        }
        apply(
            &certificates,
            &graphql,
            &rest,
            &import_fetcher,
            RemoteHttpClients {
                gitlab: &gitlab,
                onedrive: &onedrive.client,
                agent: &agent,
            },
        )
        .map_err(invalid)?;
        store.save(&certificates).map_err(storage_error)?;
        Ok(certificates.iter().map(to_dto).collect())
    });
    crate::commands::usage_events::record_setting(
        &usage,
        "network",
        Some("customCaRemoved"),
        &result,
    );
    result
}
