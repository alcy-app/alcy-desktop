use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use alcy_domain::{Environment, EnvironmentVariable};
use serde::{Deserialize, Serialize};

use crate::local_secrets::{LocalSecrets, SecretKeys};
use crate::storage_error::StorageError;

/// Versão 2: valores sensíveis cifrados em `encrypted` (valor em `value`
/// fica vazio).
const CURRENT_VERSION: u32 = 2;
/// Versão 1: tudo em texto claro. Ainda é lida (migrada no primeiro
/// `load`) e é o formato da visão portátil enviada ao controle de versão —
/// assim versões anteriores do Alcy continuam lendo o arquivo remoto.
const PORTABLE_VERSION: u32 = 1;
const MANIFEST_FILE_NAME: &str = "alcy-environments.json";

/// Estado completo de ambientes lido ou gravado de uma vez.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EnvironmentsSnapshot {
    pub environments: Vec<Environment>,
    pub active_environment_id: Option<String>,
}

/// Variável sensível cujo valor cifrado não pôde ser lido nesta máquina
/// (ex.: workspace copiado de outro computador ou chave local perdida). Ela
/// é carregada com valor vazio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableSecret {
    pub environment_name: String,
    pub variable_name: String,
}

/// Resultado de `EnvironmentStore::load`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LoadedEnvironments {
    pub snapshot: EnvironmentsSnapshot,
    pub unreadable_secrets: Vec<UnreadableSecret>,
    /// O arquivo ainda guarda valores sensíveis em texto claro (versão 1) e
    /// deve ser regravado para cifrá-los.
    pub needs_migration: bool,
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    active_environment_id: Option<String>,
    environments: Vec<PersistedEnvironment>,
}

#[derive(Serialize, Deserialize)]
struct PersistedEnvironment {
    id: String,
    name: String,
    variables: Vec<PersistedVariable>,
}

#[derive(Serialize, Deserialize)]
struct PersistedVariable {
    name: String,
    value: String,
    sensitive: bool,
    /// Só na versão 2, para variáveis sensíveis com valor não vazio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    encrypted: Option<String>,
}

/// Obtém as chaves locais só na primeira vez que forem necessárias — um
/// arquivo sem nada sensível nunca toca o chaveiro.
struct LazyKeys<'a> {
    secrets: &'a LocalSecrets,
    keys: Option<Arc<SecretKeys>>,
}

impl<'a> LazyKeys<'a> {
    fn new(secrets: &'a LocalSecrets) -> Self {
        Self {
            secrets,
            keys: None,
        }
    }

    fn get(&mut self) -> Result<&SecretKeys, StorageError> {
        if self.keys.is_none() {
            self.keys = Some(self.secrets.keys()?);
        }
        match &self.keys {
            Some(keys) => Ok(keys),
            None => Err(StorageError::Secrets("chave local indisponível".into())),
        }
    }

    fn seal(&mut self, plaintext: &str) -> Result<String, StorageError> {
        self.get()?
            .encrypt(plaintext)
            .map_err(|error| StorageError::Secrets(error.to_string()))
    }

    /// Valor em claro da variável; `None` se o cifrado não pôde ser lido.
    fn reveal(&mut self, variable: &PersistedVariable) -> Result<Option<String>, StorageError> {
        match &variable.encrypted {
            Some(sealed) => Ok(self.get()?.decrypt(sealed).ok()),
            None => Ok(Some(variable.value.clone())),
        }
    }
}

/// Lê e grava os ambientes de um workspace (`alcy-environments.json`) na
/// raiz da pasta do workspace, com escrita atômica (arquivo temporário +
/// rename) e formato versionado. Ambientes não são compartilhados entre
/// workspaces — cada um tem seu próprio arquivo, como coleções e histórico.
///
/// Valores de variáveis sensíveis são cifrados com a chave local
/// (`LocalSecrets`) ao gravar e decifrados ao ler.
pub struct EnvironmentStore {
    path: PathBuf,
    secrets: LocalSecrets,
}

impl EnvironmentStore {
    pub fn new(root: PathBuf, secrets: LocalSecrets) -> Self {
        Self {
            path: root.join(MANIFEST_FILE_NAME),
            secrets,
        }
    }

    pub fn load(&self) -> Result<LoadedEnvironments, StorageError> {
        if !self.path.exists() {
            return Ok(LoadedEnvironments::default());
        }

        let raw = fs::read(&self.path).map_err(|error| StorageError::Read(error.to_string()))?;
        let persisted = parse_file(&raw)?;
        let needs_migration = persisted.version == PORTABLE_VERSION
            && variables(&persisted)
                .any(|variable| variable.sensitive && !variable.value.is_empty());

        let mut keys = LazyKeys::new(&self.secrets);
        let mut unreadable_secrets = Vec::new();
        let mut environments = Vec::with_capacity(persisted.environments.len());
        for environment in persisted.environments {
            let mut variables = Vec::with_capacity(environment.variables.len());
            for variable in &environment.variables {
                let value = match keys.reveal(variable)? {
                    Some(value) => value,
                    None => {
                        unreadable_secrets.push(UnreadableSecret {
                            environment_name: environment.name.clone(),
                            variable_name: variable.name.clone(),
                        });
                        String::new()
                    }
                };
                variables.push(
                    EnvironmentVariable::new(variable.name.clone(), value, variable.sensitive)
                        .map_err(|error| StorageError::Corrupted(error.to_string()))?,
                );
            }
            environments.push(
                Environment::new(environment.id, environment.name, variables)
                    .map_err(|error| StorageError::Corrupted(error.to_string()))?,
            );
        }

        Ok(LoadedEnvironments {
            snapshot: EnvironmentsSnapshot {
                environments,
                active_environment_id: persisted.active_environment_id,
            },
            unreadable_secrets,
            needs_migration,
        })
    }

    pub fn save(&self, snapshot: &EnvironmentsSnapshot) -> Result<(), StorageError> {
        let mut keys = LazyKeys::new(&self.secrets);
        let mut environments = Vec::with_capacity(snapshot.environments.len());
        for environment in &snapshot.environments {
            let mut variables = Vec::with_capacity(environment.variables().len());
            for variable in environment.variables() {
                let (value, encrypted) = if variable.sensitive && !variable.value().is_empty() {
                    (String::new(), Some(keys.seal(variable.value())?))
                } else {
                    (variable.value().to_string(), None)
                };
                variables.push(PersistedVariable {
                    name: variable.name().to_string(),
                    value,
                    sensitive: variable.sensitive,
                    encrypted,
                });
            }
            environments.push(PersistedEnvironment {
                id: environment.id.clone(),
                name: environment.name().to_string(),
                variables,
            });
        }

        let persisted = PersistedFile {
            version: CURRENT_VERSION,
            active_environment_id: snapshot.active_environment_id.clone(),
            environments,
        };
        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }

        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.path)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        Ok(())
    }
}

/// Visão portátil do arquivo de ambientes — o que o controle de versão lê,
/// compara e envia. Sai no formato da versão 1, sem valores cifrados (a
/// chave local não existe em outras máquinas): variáveis sensíveis vão
/// vazias, ou com o valor em claro quando `include_sensitive` (o usuário
/// desligou a proteção nas configurações).
pub fn environments_to_portable(
    local: &[u8],
    secrets: &LocalSecrets,
    include_sensitive: bool,
) -> Result<Vec<u8>, StorageError> {
    let mut file = parse_file(local)?;
    let mut keys = LazyKeys::new(secrets);
    for variable in variables_mut(&mut file) {
        if variable.sensitive {
            variable.value = if include_sensitive {
                keys.reveal(variable)?.unwrap_or_default()
            } else {
                String::new()
            };
        }
        variable.encrypted = None;
    }
    file.version = PORTABLE_VERSION;
    to_json(&file)
}

/// Converte a visão portátil (vinda do remoto) no arquivo local. Uma
/// variável sensível que chega vazia mantém o valor que já existia nesta
/// máquina (mesmo ambiente e nome) — receber do remoto nunca apaga um
/// segredo local; uma que chega com valor é cifrada.
pub fn environments_from_portable(
    portable: &[u8],
    current_local: Option<&[u8]>,
    secrets: &LocalSecrets,
) -> Result<Vec<u8>, StorageError> {
    let mut file = parse_file(portable)?;
    let local = current_local.and_then(|bytes| parse_file(bytes).ok());
    let local_secrets: HashMap<(&str, &str), &PersistedVariable> = local
        .iter()
        .flat_map(|local| &local.environments)
        .flat_map(|environment| {
            environment
                .variables
                .iter()
                .filter(|variable| variable.sensitive)
                .map(|variable| ((environment.id.as_str(), variable.name.as_str()), variable))
        })
        .collect();

    let mut keys = LazyKeys::new(secrets);
    for environment in &mut file.environments {
        for variable in &mut environment.variables {
            if !variable.sensitive {
                variable.encrypted = None;
                continue;
            }
            if !variable.value.is_empty() {
                variable.encrypted = Some(keys.seal(&variable.value)?);
                variable.value.clear();
            } else if let Some(existing) =
                local_secrets.get(&(environment.id.as_str(), variable.name.as_str()))
            {
                variable.encrypted = match &existing.encrypted {
                    Some(sealed) => Some(sealed.clone()),
                    None if existing.value.is_empty() => None,
                    None => Some(keys.seal(&existing.value)?),
                };
            }
        }
    }
    file.version = CURRENT_VERSION;
    to_json(&file)
}

fn parse_file(raw: &[u8]) -> Result<PersistedFile, StorageError> {
    let persisted: PersistedFile =
        serde_json::from_slice(raw).map_err(|error| StorageError::Corrupted(error.to_string()))?;
    if persisted.version != CURRENT_VERSION && persisted.version != PORTABLE_VERSION {
        return Err(StorageError::UnsupportedVersion(persisted.version));
    }
    Ok(persisted)
}

fn to_json(file: &PersistedFile) -> Result<Vec<u8>, StorageError> {
    serde_json::to_vec_pretty(file).map_err(|error| StorageError::Write(error.to_string()))
}

fn variables(file: &PersistedFile) -> impl Iterator<Item = &PersistedVariable> {
    file.environments
        .iter()
        .flat_map(|environment| &environment.variables)
}

fn variables_mut(file: &mut PersistedFile) -> impl Iterator<Item = &mut PersistedVariable> {
    file.environments
        .iter_mut()
        .flat_map(|environment| &mut environment.variables)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_secrets::tests::{FakeKeyring, temp_key_path, test_secrets};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-environment-store-test-{nanos}-{count}"))
    }

    /// Segredos cujo chaveiro falha: qualquer tentativa de obter a chave
    /// vira erro — serve para provar que ela não foi pedida.
    fn secrets_that_must_not_be_used() -> LocalSecrets {
        LocalSecrets::new(
            Box::new(FakeKeyring {
                failing: true,
                ..FakeKeyring::default()
            }),
            temp_key_path(),
        )
    }

    fn sample_snapshot() -> EnvironmentsSnapshot {
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("token", "secret", true).unwrap(),
        ];
        let environment = Environment::new("env-1", "Development", variables).unwrap();

        EnvironmentsSnapshot {
            environments: vec![environment],
            active_environment_id: Some("env-1".to_string()),
        }
    }

    fn portable_file(token: &str) -> String {
        format!(
            r#"{{"version": 1, "active_environment_id": "env-1", "environments": [{{"id": "env-1", "name": "Development", "variables": [{{"name": "baseUrl", "value": "https://api.example.com", "sensitive": false}}, {{"name": "token", "value": "{token}", "sensitive": true}}]}}]}}"#
        )
    }

    fn value_of(snapshot: &EnvironmentsSnapshot, name: &str) -> String {
        snapshot.environments[0]
            .variables()
            .iter()
            .find(|variable| variable.name() == name)
            .map(|variable| variable.value().to_string())
            .unwrap()
    }

    #[test]
    fn load_returns_an_empty_snapshot_when_the_file_does_not_exist() {
        let store = EnvironmentStore::new(temp_root(), test_secrets());

        let loaded = store.load().unwrap();

        assert_eq!(loaded, LoadedEnvironments::default());
    }

    #[test]
    fn save_then_load_round_trips_the_snapshot() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), test_secrets());
        let snapshot = sample_snapshot();

        store.save(&snapshot).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded.snapshot, snapshot);
        assert!(loaded.unreadable_secrets.is_empty());
        assert!(!loaded.needs_migration);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_encrypts_sensitive_values_only() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        store.save(&sample_snapshot()).unwrap();
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();

        assert!(!raw.contains("\"secret\""));
        assert!(raw.contains("\"encrypted\": \"v1:"));
        assert!(raw.contains("https://api.example.com"));
        assert!(raw.contains("\"version\": 2"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn files_without_sensitive_values_never_touch_the_key() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), secrets_that_must_not_be_used());
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("empty", "", true).unwrap(),
        ];
        let snapshot = EnvironmentsSnapshot {
            environments: vec![Environment::new("env-1", "Development", variables).unwrap()],
            active_environment_id: None,
        };

        store.save(&snapshot).unwrap();

        assert_eq!(store.load().unwrap().snapshot, snapshot);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_reads_version_1_and_asks_for_migration() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), portable_file("secret")).unwrap();
        let store = EnvironmentStore::new(root.clone(), secrets_that_must_not_be_used());

        let loaded = store.load().unwrap();

        assert_eq!(loaded.snapshot, sample_snapshot());
        assert!(loaded.needs_migration);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn version_1_without_sensitive_values_needs_no_migration() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), portable_file("")).unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        assert!(!store.load().unwrap().needs_migration);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn values_sealed_with_another_key_load_empty_and_are_reported() {
        let root = temp_root();
        EnvironmentStore::new(root.clone(), test_secrets())
            .save(&sample_snapshot())
            .unwrap();

        let loaded = EnvironmentStore::new(root.clone(), test_secrets())
            .load()
            .unwrap();

        assert_eq!(value_of(&loaded.snapshot, "token"), "");
        assert_eq!(
            value_of(&loaded.snapshot, "baseUrl"),
            "https://api.example.com"
        );
        assert_eq!(
            loaded.unreadable_secrets,
            vec![UnreadableSecret {
                environment_name: "Development".to_string(),
                variable_name: "token".to_string(),
            }]
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_does_not_leave_a_temporary_file_behind() {
        let root = temp_root();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        store.save(&sample_snapshot()).unwrap();

        assert!(!root.join(MANIFEST_FILE_NAME).with_extension("tmp").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), "not json").unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 99, "active_environment_id": null, "environments": []}"#,
        )
        .unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        let error = store.load().unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_data_that_violates_domain_invariants() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "active_environment_id": null, "environments": [{"id": "env-1", "name": "", "variables": []}]}"#,
        )
        .unwrap();
        let store = EnvironmentStore::new(root.clone(), test_secrets());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    fn saved_local_file(secrets: &LocalSecrets) -> (PathBuf, Vec<u8>) {
        let root = temp_root();
        EnvironmentStore::new(root.clone(), secrets.clone())
            .save(&sample_snapshot())
            .unwrap();
        let bytes = fs::read(root.join(MANIFEST_FILE_NAME)).unwrap();
        (root, bytes)
    }

    fn canonical(json: &str) -> Vec<u8> {
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        let file: PersistedFile = serde_json::from_value(value).unwrap();
        to_json(&file).unwrap()
    }

    #[test]
    fn portable_view_strips_sensitive_values_by_default() {
        let secrets = test_secrets();
        let (root, local) = saved_local_file(&secrets);

        let portable = environments_to_portable(&local, &secrets, false).unwrap();

        assert_eq!(portable, canonical(&portable_file("")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn portable_view_carries_plain_values_when_allowed() {
        let secrets = test_secrets();
        let (root, local) = saved_local_file(&secrets);

        let portable = environments_to_portable(&local, &secrets, true).unwrap();

        assert_eq!(portable, canonical(&portable_file("secret")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stripping_does_not_need_the_key() {
        let secrets = test_secrets();
        let (root, local) = saved_local_file(&secrets);

        let portable =
            environments_to_portable(&local, &secrets_that_must_not_be_used(), false).unwrap();

        assert_eq!(portable, canonical(&portable_file("")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn receiving_an_empty_secret_keeps_the_local_one() {
        let secrets = test_secrets();
        let (root, local) = saved_local_file(&secrets);
        let remote = canonical(&portable_file(""));

        let merged = environments_from_portable(&remote, Some(&local), &secrets).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), &merged).unwrap();

        let loaded = EnvironmentStore::new(root.clone(), secrets.clone())
            .load()
            .unwrap();
        assert_eq!(loaded.snapshot, sample_snapshot());
        assert_eq!(
            environments_to_portable(&merged, &secrets, false).unwrap(),
            remote
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn receiving_a_plain_secret_encrypts_it() {
        let secrets = test_secrets();
        let remote = canonical(&portable_file("secret"));

        let merged = environments_from_portable(&remote, None, &secrets).unwrap();

        let text = String::from_utf8(merged.clone()).unwrap();
        assert!(!text.contains("\"secret\""));
        assert_eq!(
            environments_to_portable(&merged, &secrets, true).unwrap(),
            remote
        );
    }

    #[test]
    fn receiving_keeps_a_plain_secret_from_a_version_1_local_file_encrypted() {
        let secrets = test_secrets();
        let local = portable_file("secret").into_bytes();
        let remote = canonical(&portable_file(""));

        let merged = environments_from_portable(&remote, Some(&local), &secrets).unwrap();

        let text = String::from_utf8(merged.clone()).unwrap();
        assert!(!text.contains("\"secret\""));
        assert_eq!(
            environments_to_portable(&merged, &secrets, true).unwrap(),
            canonical(&portable_file("secret"))
        );
    }

    #[test]
    fn portable_conversion_rejects_invalid_content() {
        let secrets = test_secrets();

        assert!(matches!(
            environments_to_portable(b"not json", &secrets, false),
            Err(StorageError::Corrupted(_))
        ));
        assert!(matches!(
            environments_from_portable(
                br#"{"version": 99, "active_environment_id": null, "environments": []}"#,
                None,
                &secrets
            ),
            Err(StorageError::UnsupportedVersion(99))
        ));
    }
}
