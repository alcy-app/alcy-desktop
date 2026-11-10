//! Exportação de uma coleção ou pasta como webclient (spec 0113, ADR 0046).
//! As regras (dados sensíveis, senha, recorte) ficam em `alcy-webclient`;
//! aqui só há conversão de DTOs e a gravação do arquivo.

use std::fs;
use std::path::{Path, PathBuf};

use alcy_domain::EnvironmentVariable;
use alcy_webclient::{
    ExportEnvironment, ExportOptions, ExportSelection, TransportMode, WebclientError,
    WebclientSummary,
};
use serde::{Deserialize, Serialize};

use crate::commands::collections::{CollectionDto, CollectionsCommandError, collection_from_dto};
use crate::commands::environments::EnvironmentVariableDto;

/// O que exportar. A coleção inteira vem do frontend (como no export no
/// formato Alcy), para que a pasta herde variáveis e autenticação dos
/// ancestrais.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebclientSelectionInput {
    pub collection: CollectionDto,
    #[serde(default)]
    pub folder_id: Option<String>,
    /// Ambiente escolhido no diálogo, com os valores que o app tem em memória.
    #[serde(default)]
    pub environment: Option<WebclientEnvironmentInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebclientEnvironmentInput {
    pub name: String,
    pub variables: Vec<EnvironmentVariableDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebclientExportInput {
    #[serde(flatten)]
    pub selection: WebclientSelectionInput,
    pub include_sensitive: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransportModeInput {
    Auto,
    Direct,
    Server,
}

impl From<TransportModeInput> for TransportMode {
    fn from(mode: TransportModeInput) -> Self {
        match mode {
            TransportModeInput::Auto => Self::Auto,
            TransportModeInput::Direct => Self::Direct,
            TransportModeInput::Server => Self::Server,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWebclientInput {
    #[serde(flatten)]
    pub selection: WebclientSelectionInput,
    pub path: String,
    pub title: String,
    pub transport: TransportModeInput,
    pub include_sensitive: bool,
    pub sensitive_confirmed: bool,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportWebclientError {
    Invalid { message: String },
    FolderNotFound,
    NoRequests,
    SensitiveNotConfirmed,
    PasswordTooShort { minimum: usize },
    Storage { message: String },
}

impl From<WebclientError> for ExportWebclientError {
    fn from(error: WebclientError) -> Self {
        match error {
            WebclientError::FolderNotFound(_) => Self::FolderNotFound,
            WebclientError::NoRequests => Self::NoRequests,
            WebclientError::SensitiveNotConfirmed => Self::SensitiveNotConfirmed,
            WebclientError::PasswordTooShort { minimum } => Self::PasswordTooShort { minimum },
            WebclientError::Crypto
            | WebclientError::InvalidRuntime
            | WebclientError::Serialization(_) => Self::Storage {
                message: error.to_string(),
            },
        }
    }
}

impl From<CollectionsCommandError> for ExportWebclientError {
    fn from(error: CollectionsCommandError) -> Self {
        match error {
            CollectionsCommandError::Invalid { message } => Self::Invalid { message },
            CollectionsCommandError::Storage { message } => Self::Storage { message },
        }
    }
}

async fn run_blocking<T, F>(work: F) -> Result<T, ExportWebclientError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ExportWebclientError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(ExportWebclientError::Storage {
                message: error.to_string(),
            })
        })
}

/// Prévia para o diálogo: credenciais, itens não suportados e hosts.
#[tauri::command]
pub async fn preview_webclient_export(
    input: PreviewWebclientExportInput,
) -> Result<WebclientSummary, ExportWebclientError> {
    let result = run_blocking(move || preview_inner(input)).await;
    crate::logging::logged("alcy::export", "prévia do webclient", result)
}

/// Gera o webclient e grava no arquivo escolhido.
#[tauri::command]
pub async fn export_webclient(
    input: ExportWebclientInput,
    usage: tauri::State<'_, alcy_app::UsageHub>,
) -> Result<(), ExportWebclientError> {
    let result = run_blocking(move || export_inner(input)).await;
    crate::commands::usage_events::record_export(&usage, "webclient", &result);
    crate::logging::logged("alcy::export", "exportar webclient", result)
}

fn environment_from_input(
    input: Option<WebclientEnvironmentInput>,
) -> Result<Option<ExportEnvironment>, ExportWebclientError> {
    input
        .map(|environment| {
            let variables = environment
                .variables
                .into_iter()
                .map(|variable| {
                    EnvironmentVariable::new(variable.name, variable.value, variable.sensitive)
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| ExportWebclientError::Invalid {
                    message: error.to_string(),
                })?;
            Ok(ExportEnvironment {
                name: environment.name,
                variables,
            })
        })
        .transpose()
}

fn preview_inner(
    input: PreviewWebclientExportInput,
) -> Result<WebclientSummary, ExportWebclientError> {
    let collection = collection_from_dto(input.selection.collection)?;
    let environment = environment_from_input(input.selection.environment)?;
    let selection = ExportSelection {
        collection: &collection,
        folder_id: input.selection.folder_id.as_deref(),
        environment: environment.as_ref(),
    };
    Ok(alcy_webclient::summarize(
        selection,
        input.include_sensitive,
    )?)
}

fn export_inner(input: ExportWebclientInput) -> Result<(), ExportWebclientError> {
    let path = PathBuf::from(&input.path);
    let has_html_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"));
    if !has_html_extension {
        return Err(ExportWebclientError::Invalid {
            message: "o arquivo deve ter a extensão .html".to_string(),
        });
    }

    let collection = collection_from_dto(input.selection.collection)?;
    let environment = environment_from_input(input.selection.environment)?;
    let selection = ExportSelection {
        collection: &collection,
        folder_id: input.selection.folder_id.as_deref(),
        environment: environment.as_ref(),
    };
    let options = ExportOptions {
        title: input.title,
        transport: input.transport.into(),
        include_sensitive: input.include_sensitive,
        sensitive_confirmed: input.sensitive_confirmed,
        password: input.password,
    };
    let html = alcy_webclient::build_webclient(selection, &options)?;
    write_atomic(&path, &html)
}

/// Grava num temporário ao lado e renomeia: um export interrompido não
/// deixa um HTML pela metade no lugar do anterior.
fn write_atomic(path: &Path, contents: &str) -> Result<(), ExportWebclientError> {
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);
    let result = fs::write(&tmp_path, contents).and_then(|()| fs::rename(&tmp_path, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result.map_err(|error| ExportWebclientError::Storage {
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::{
        FolderDto, SavedRequestAuthenticationDto, SavedRequestDto, SavedRequestHeaderDto,
    };
    use crate::commands::execute_rest_request::HttpMethodInput;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "alcy-webclient-export-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn collection() -> CollectionDto {
        let request = SavedRequestDto {
            id: "r1".into(),
            name: "List".into(),
            protocol: "rest".into(),
            endpoint: "{{baseUrl}}/items".into(),
            method: HttpMethodInput::Get,
            body: String::new(),
            rest_body: None,
            variables: String::new(),
            headers: vec![SavedRequestHeaderDto {
                name: "Authorization".into(),
                value: "Bearer typed-literal-token".into(),
                enabled: true,
            }],
            authentication: SavedRequestAuthenticationDto::Inherit,
            pre_request_script: "al.environment.set('x', 1)".into(),
            post_response_script: String::new(),
            route_params: vec![],
            docs_ref: None,
            grpc: None,
            websocket: None,
            examples: vec![],
        };
        CollectionDto {
            id: "c1".into(),
            name: "API".into(),
            folders: vec![FolderDto {
                id: "f1".into(),
                name: "Items".into(),
                folders: vec![],
                requests: vec![request],
                authentication: SavedRequestAuthenticationDto::Inherit,
                variables: vec![],
            }],
            requests: vec![],
            authentication: SavedRequestAuthenticationDto::Bearer {
                token: "{{token}}".into(),
            },
            variables: vec![],
            labels: vec![],
        }
    }

    fn selection() -> WebclientSelectionInput {
        WebclientSelectionInput {
            collection: collection(),
            folder_id: Some("f1".into()),
            environment: Some(WebclientEnvironmentInput {
                name: "Prod".into(),
                variables: vec![
                    EnvironmentVariableDto {
                        name: "baseUrl".into(),
                        value: "https://api.example.com".into(),
                        sensitive: false,
                    },
                    EnvironmentVariableDto {
                        name: "token".into(),
                        value: "env-secret-token".into(),
                        sensitive: true,
                    },
                ],
            }),
        }
    }

    fn export_input(path: &Path) -> ExportWebclientInput {
        ExportWebclientInput {
            selection: selection(),
            path: path.to_string_lossy().into_owned(),
            title: "Items".into(),
            transport: TransportModeInput::Auto,
            include_sensitive: false,
            sensitive_confirmed: false,
            password: None,
        }
    }

    #[test]
    fn writes_a_webclient_without_secrets_or_scripts() {
        let dir = temp_dir();
        let path = dir.join("items.html");

        export_inner(export_input(&path)).unwrap();

        let html = fs::read_to_string(&path).unwrap();
        assert!(html.contains("https://api.example.com"));
        for leaked in ["env-secret-token", "typed-literal-token", "al.environment"] {
            assert!(!html.contains(leaked), "vazou {leaked}");
        }
        assert!(!dir.join("items.html.tmp").exists());
    }

    #[test]
    fn requires_the_html_extension() {
        let dir = temp_dir();

        let result = export_inner(export_input(&dir.join("items.txt")));

        assert!(matches!(result, Err(ExportWebclientError::Invalid { .. })));
    }

    #[test]
    fn rejects_sensitive_data_without_confirmation() {
        let dir = temp_dir();
        let path = dir.join("items.html");
        let input = ExportWebclientInput {
            include_sensitive: true,
            ..export_input(&path)
        };

        assert_eq!(
            export_inner(input),
            Err(ExportWebclientError::SensitiveNotConfirmed)
        );
        assert!(!path.exists());
    }

    #[test]
    fn preview_lists_hosts_and_credentials() {
        let summary = preview_inner(PreviewWebclientExportInput {
            selection: selection(),
            include_sensitive: false,
        })
        .unwrap();

        assert_eq!(summary.hosts, vec!["api.example.com".to_string()]);
        assert_eq!(summary.request_count, 1);
        assert_eq!(summary.credentials.len(), 2);
    }

    #[test]
    fn unknown_folder_is_reported() {
        let mut selection = selection();
        selection.folder_id = Some("missing".into());

        assert_eq!(
            preview_inner(PreviewWebclientExportInput {
                selection,
                include_sensitive: false,
            }),
            Err(ExportWebclientError::FolderNotFound)
        );
    }
}
