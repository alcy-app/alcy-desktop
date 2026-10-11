use std::path::PathBuf;

use alcy_domain::{Environment, EnvironmentVariable};
use alcy_storage::{EnvironmentStore, EnvironmentsSnapshot, LocalSecrets, StorageError};
use serde::{Deserialize, Serialize};

const DEFAULT_ENVIRONMENT_ID: &str = "development";
const DEFAULT_ENVIRONMENT_NAME: &str = "Development";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentVariableDto {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDto {
    pub id: String,
    pub name: String,
    pub variables: Vec<EnvironmentVariableDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInput {
    pub id: String,
    pub name: String,
    pub variables: Vec<EnvironmentVariableDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentsSnapshotDto {
    pub environments: Vec<EnvironmentDto>,
    pub active_environment_id: Option<String>,
    /// Variáveis sensíveis cujo valor cifrado não pôde ser lido nesta
    /// máquina (carregadas vazias), como "Ambiente › variável".
    pub unreadable_secrets: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEnvironmentsInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEnvironmentsInput {
    pub root_path: String,
    pub environments: Vec<EnvironmentInput>,
    pub active_environment_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EnvironmentsError {
    Invalid { message: String },
    Storage { message: String },
}

impl From<StorageError> for EnvironmentsError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

fn default_snapshot() -> EnvironmentsSnapshotDto {
    EnvironmentsSnapshotDto {
        environments: vec![EnvironmentDto {
            id: DEFAULT_ENVIRONMENT_ID.to_string(),
            name: DEFAULT_ENVIRONMENT_NAME.to_string(),
            variables: vec![],
        }],
        active_environment_id: Some(DEFAULT_ENVIRONMENT_ID.to_string()),
        unreadable_secrets: Vec::new(),
    }
}

pub(crate) fn environment_to_dto(environment: &Environment) -> EnvironmentDto {
    EnvironmentDto {
        id: environment.id.clone(),
        name: environment.name().to_string(),
        variables: environment
            .variables()
            .iter()
            .map(|variable| EnvironmentVariableDto {
                name: variable.name().to_string(),
                value: variable.value().to_string(),
                sensitive: variable.sensitive,
            })
            .collect(),
    }
}

fn snapshot_to_dto(
    snapshot: EnvironmentsSnapshot,
    unreadable_secrets: Vec<String>,
) -> EnvironmentsSnapshotDto {
    EnvironmentsSnapshotDto {
        environments: snapshot
            .environments
            .iter()
            .map(environment_to_dto)
            .collect(),
        active_environment_id: snapshot.active_environment_id,
        unreadable_secrets,
    }
}

/// Variáveis para montar a versão de uma requisição que vai para o
/// histórico: cada variável sensível vira o próprio placeholder `{{nome}}`
/// (a interpolação não é recursiva, então ele sai literal), e o segredo
/// nunca chega ao disco. `None` quando não há variável sensível — o
/// histórico pode usar a requisição executada, sem custo extra.
pub(crate) fn redact_sensitive_variables(
    variables: &[EnvironmentVariableDto],
) -> Option<Vec<EnvironmentVariableDto>> {
    if !variables.iter().any(|variable| variable.sensitive) {
        return None;
    }
    Some(
        variables
            .iter()
            .map(|variable| EnvironmentVariableDto {
                name: variable.name.clone(),
                value: if variable.sensitive {
                    format!("{{{{{}}}}}", variable.name)
                } else {
                    variable.value.clone()
                },
                sensitive: variable.sensitive,
            })
            .collect(),
    )
}

fn environment_from_input(input: EnvironmentInput) -> Result<Environment, EnvironmentsError> {
    let variables = input
        .variables
        .into_iter()
        .map(|variable| EnvironmentVariable::new(variable.name, variable.value, variable.sensitive))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| EnvironmentsError::Invalid {
            message: error.to_string(),
        })?;

    Environment::new(input.id, input.name, variables).map_err(|error| EnvironmentsError::Invalid {
        message: error.to_string(),
    })
}

fn build_snapshot(input: SaveEnvironmentsInput) -> Result<EnvironmentsSnapshot, EnvironmentsError> {
    let environments = input
        .environments
        .into_iter()
        .map(environment_from_input)
        .collect::<Result<Vec<_>, EnvironmentsError>>()?;

    Ok(EnvironmentsSnapshot {
        environments,
        active_environment_id: input.active_environment_id,
    })
}

/// Lista os ambientes persistidos no workspace em `input.root_path`. Se
/// nada existir ainda, sintetiza um ambiente "Development" padrão em
/// memória — só é gravado de verdade quando o usuário salvar alguma
/// mudança. A única escrita possível aqui é a migração de um arquivo antigo
/// com valores sensíveis em texto claro, regravado já cifrado. Ambientes
/// não são compartilhados entre workspaces — cada um tem seu próprio
/// arquivo, como coleções e histórico.
///
/// Roda fora da thread principal: o primeiro acesso à chave local passa
/// pelo chaveiro do sistema, que pode bloquear.
#[tauri::command]
pub async fn list_environments(
    input: ListEnvironmentsInput,
    secrets: tauri::State<'_, LocalSecrets>,
) -> Result<EnvironmentsSnapshotDto, EnvironmentsError> {
    let result: Result<EnvironmentsSnapshotDto, EnvironmentsError> = async {
        let secrets = LocalSecrets::clone(&secrets);
        run_blocking(move || list_environments_inner(PathBuf::from(input.root_path), secrets)).await
    }
    .await;
    crate::logging::logged("alcy::environments", "carregar ambientes", result)
}

fn list_environments_inner(
    root: PathBuf,
    secrets: LocalSecrets,
) -> Result<EnvironmentsSnapshotDto, EnvironmentsError> {
    let store = EnvironmentStore::new(root, secrets);
    let loaded = store.load()?;
    if loaded.needs_migration {
        store.save(&loaded.snapshot)?;
    }
    if loaded.snapshot.environments.is_empty() {
        return Ok(default_snapshot());
    }
    let unreadable = loaded
        .unreadable_secrets
        .into_iter()
        .map(|secret| format!("{} › {}", secret.environment_name, secret.variable_name))
        .collect();
    Ok(snapshot_to_dto(loaded.snapshot, unreadable))
}

#[tauri::command]
pub async fn save_environments(
    input: SaveEnvironmentsInput,
    secrets: tauri::State<'_, LocalSecrets>,
) -> Result<(), EnvironmentsError> {
    let result: Result<(), EnvironmentsError> = async {
        let secrets = LocalSecrets::clone(&secrets);
        run_blocking(move || {
            save_environments_inner(PathBuf::from(input.root_path.clone()), input, secrets)
        })
        .await
    }
    .await;
    crate::logging::logged("alcy::environments", "salvar ambientes", result)
}

fn save_environments_inner(
    root: PathBuf,
    input: SaveEnvironmentsInput,
    secrets: LocalSecrets,
) -> Result<(), EnvironmentsError> {
    let snapshot = build_snapshot(input)?;
    let store = EnvironmentStore::new(root, secrets);
    store.save(&snapshot)?;
    Ok(())
}

async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, EnvironmentsError> + Send + 'static,
) -> Result<T, EnvironmentsError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| EnvironmentsError::Storage {
            message: error.to_string(),
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_app::{CredentialError, CredentialStore};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-env-cmd-test-{nanos}-{count}"))
    }

    /// Sem chaveiro: a chave local vai para um arquivo reserva temporário.
    struct NoKeyring;

    impl CredentialStore for NoKeyring {
        fn load(&self, _key: &str) -> Result<Option<String>, CredentialError> {
            Err(CredentialError::Unavailable("sem chaveiro".into()))
        }

        fn save(&self, _key: &str, _secret: &str) -> Result<(), CredentialError> {
            Err(CredentialError::Unavailable("sem chaveiro".into()))
        }

        fn delete(&self, _key: &str) -> Result<(), CredentialError> {
            Ok(())
        }
    }

    fn secrets() -> LocalSecrets {
        LocalSecrets::new(Box::new(NoKeyring), temp_root().join("local-secret.key"))
    }

    #[test]
    fn lists_a_default_environment_when_nothing_is_persisted() {
        let root = temp_root();

        let snapshot = list_environments_inner(root, secrets()).unwrap();

        assert_eq!(snapshot.environments.len(), 1);
        assert_eq!(snapshot.environments[0].name, "Development");
        assert_eq!(
            snapshot.active_environment_id,
            Some("development".to_string())
        );
    }

    #[test]
    fn save_then_list_round_trips_environments() {
        let root = temp_root();
        let input = SaveEnvironmentsInput {
            root_path: root.to_string_lossy().to_string(),
            environments: vec![EnvironmentInput {
                id: "env-1".to_string(),
                name: "Staging".to_string(),
                variables: vec![EnvironmentVariableDto {
                    name: "baseUrl".to_string(),
                    value: "https://staging.example.com".to_string(),
                    sensitive: false,
                }],
            }],
            active_environment_id: Some("env-1".to_string()),
        };

        let secrets = secrets();
        save_environments_inner(root.clone(), input, secrets.clone()).unwrap();
        let snapshot = list_environments_inner(root.clone(), secrets).unwrap();

        assert_eq!(snapshot.environments.len(), 1);
        assert_eq!(snapshot.environments[0].name, "Staging");
        assert_eq!(
            snapshot.environments[0].variables[0].value,
            "https://staging.example.com"
        );
        assert_eq!(snapshot.active_environment_id, Some("env-1".to_string()));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_rejects_invalid_environment_data() {
        let root = temp_root();
        let input = SaveEnvironmentsInput {
            root_path: root.to_string_lossy().to_string(),
            environments: vec![EnvironmentInput {
                id: "env-1".to_string(),
                name: "".to_string(),
                variables: vec![],
            }],
            active_environment_id: None,
        };

        let error = save_environments_inner(root, input, secrets()).unwrap_err();

        assert!(matches!(error, EnvironmentsError::Invalid { .. }));
    }

    #[test]
    fn environments_are_not_shared_between_workspaces() {
        let root_a = temp_root();
        let root_b = temp_root();
        let input = SaveEnvironmentsInput {
            root_path: root_a.to_string_lossy().to_string(),
            environments: vec![EnvironmentInput {
                id: "env-1".to_string(),
                name: "Staging".to_string(),
                variables: vec![],
            }],
            active_environment_id: Some("env-1".to_string()),
        };

        save_environments_inner(root_a.clone(), input, secrets()).unwrap();
        let snapshot_b = list_environments_inner(root_b.clone(), secrets()).unwrap();

        assert_eq!(snapshot_b.environments[0].name, "Development");

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }

    fn sensitive_input(root: &std::path::Path) -> SaveEnvironmentsInput {
        SaveEnvironmentsInput {
            root_path: root.to_string_lossy().to_string(),
            environments: vec![EnvironmentInput {
                id: "env-1".to_string(),
                name: "Staging".to_string(),
                variables: vec![EnvironmentVariableDto {
                    name: "token".to_string(),
                    value: "s3cr3t".to_string(),
                    sensitive: true,
                }],
            }],
            active_environment_id: Some("env-1".to_string()),
        }
    }

    #[test]
    fn sensitive_values_are_encrypted_on_disk_and_listed_in_plain_text() {
        let root = temp_root();
        let secrets = secrets();

        save_environments_inner(root.clone(), sensitive_input(&root), secrets.clone()).unwrap();
        let snapshot = list_environments_inner(root.clone(), secrets).unwrap();

        let raw = std::fs::read_to_string(root.join("alcy-environments.json")).unwrap();
        assert!(!raw.contains("s3cr3t"));
        assert_eq!(snapshot.environments[0].variables[0].value, "s3cr3t");
        assert!(snapshot.unreadable_secrets.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn listing_migrates_plain_text_secrets_from_the_old_format() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("alcy-environments.json"),
            r#"{"version": 1, "active_environment_id": "env-1", "environments": [{"id": "env-1", "name": "Staging", "variables": [{"name": "token", "value": "s3cr3t", "sensitive": true}]}]}"#,
        )
        .unwrap();

        let snapshot = list_environments_inner(root.clone(), secrets()).unwrap();

        let raw = std::fs::read_to_string(root.join("alcy-environments.json")).unwrap();
        assert!(!raw.contains("s3cr3t"));
        assert_eq!(snapshot.environments[0].variables[0].value, "s3cr3t");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn secrets_sealed_by_another_machine_are_reported() {
        let root = temp_root();
        save_environments_inner(root.clone(), sensitive_input(&root), secrets()).unwrap();

        let snapshot = list_environments_inner(root.clone(), secrets()).unwrap();

        assert_eq!(snapshot.environments[0].variables[0].value, "");
        assert_eq!(snapshot.unreadable_secrets, vec!["Staging › token"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn redaction_replaces_only_sensitive_values_with_their_placeholder() {
        let variables = vec![
            EnvironmentVariableDto {
                name: "baseUrl".to_string(),
                value: "https://api.example.com".to_string(),
                sensitive: false,
            },
            EnvironmentVariableDto {
                name: "token".to_string(),
                value: "s3cr3t".to_string(),
                sensitive: true,
            },
        ];

        let redacted = redact_sensitive_variables(&variables).unwrap();

        assert_eq!(redacted[0], variables[0]);
        assert_eq!(redacted[1].value, "{{token}}");
        assert_eq!(redact_sensitive_variables(&variables[..1]), None);
    }
}
