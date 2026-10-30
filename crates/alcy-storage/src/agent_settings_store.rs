use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use alcy_domain::{AgentProvider, AgentProviderKind, AgentSettings};
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    active_provider_id: Option<String>,
    providers: Vec<PersistedProvider>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProvider {
    id: String,
    kind: PersistedKind,
    label: String,
    base_url: String,
    model: String,
    /// Optional since they were added; files without them load as "no limit".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    daily_token_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    weekly_token_limit: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PersistedKind {
    Anthropic,
    OpenaiCompatible,
}

/// Agent providers and the active one (`agent-settings.json` in app data).
/// API keys are never written here: they live in the system keyring.
pub struct AgentSettingsStore {
    path: PathBuf,
}

impl AgentSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Without a file, no providers and none active.
    pub fn load(&self) -> Result<AgentSettings, StorageError> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(AgentSettings::default());
            }
            Err(error) => return Err(StorageError::Read(error.to_string())),
        };
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        AgentSettings {
            providers: file
                .providers
                .into_iter()
                .map(|provider| AgentProvider {
                    id: provider.id,
                    kind: match provider.kind {
                        PersistedKind::Anthropic => AgentProviderKind::Anthropic,
                        PersistedKind::OpenaiCompatible => AgentProviderKind::OpenAiCompatible,
                    },
                    label: provider.label,
                    base_url: provider.base_url,
                    model: provider.model,
                    daily_token_limit: provider.daily_token_limit,
                    weekly_token_limit: provider.weekly_token_limit,
                })
                .collect(),
            active_provider_id: file.active_provider_id,
        }
        .validated()
        .map_err(|error| StorageError::Corrupted(error.to_string()))
    }

    pub fn save(&self, settings: &AgentSettings) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            active_provider_id: settings.active_provider_id.clone(),
            providers: settings
                .providers
                .iter()
                .map(|provider| PersistedProvider {
                    id: provider.id.clone(),
                    kind: match provider.kind {
                        AgentProviderKind::Anthropic => PersistedKind::Anthropic,
                        AgentProviderKind::OpenAiCompatible => PersistedKind::OpenaiCompatible,
                    },
                    label: provider.label.clone(),
                    base_url: provider.base_url.clone(),
                    model: provider.model.clone(),
                    daily_token_limit: provider.daily_token_limit,
                    weekly_token_limit: provider.weekly_token_limit,
                })
                .collect(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        crate::agent_session_store::write_atomically(&self.path, json.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_path() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "alcy-agent-settings-test-{}-{}.json",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn missing_file_loads_the_presets() {
        let store = AgentSettingsStore::new(temp_path());
        assert_eq!(store.load().unwrap(), AgentSettings::default());
    }

    #[test]
    fn roundtrips_and_never_stores_keys() {
        let path = temp_path();
        let store = AgentSettingsStore::new(path.clone());
        let settings = AgentSettings {
            providers: vec![AgentProvider {
                id: "opencode".into(),
                kind: AgentProviderKind::OpenAiCompatible,
                label: "OpenCode Zen".into(),
                base_url: "https://opencode.ai/inference/openai/v1".into(),
                model: "kimi-k2.6".into(),
                daily_token_limit: Some(200_000),
                weekly_token_limit: None,
            }],
            active_provider_id: Some("opencode".into()),
        };
        store.save(&settings).unwrap();
        assert_eq!(store.load().unwrap(), settings);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"openaiCompatible\""));
        assert!(raw.contains("\"dailyTokenLimit\": 200000"));
        assert!(!raw.contains("weeklyTokenLimit"));
        assert!(!raw.to_lowercase().contains("key"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn files_without_token_limits_still_load() {
        let path = temp_path();
        fs::write(
            &path,
            r#"{"version":1,"activeProviderId":null,"providers":[{"id":"claude","kind":"anthropic","label":"Claude","baseUrl":"https://api.anthropic.com","model":"m"}]}"#,
        )
        .unwrap();
        let settings = AgentSettingsStore::new(path.clone()).load().unwrap();
        assert_eq!(settings.providers[0].daily_token_limit, None);
        assert_eq!(settings.providers[0].weekly_token_limit, None);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn an_invalid_file_is_corrupted() {
        let path = temp_path();
        fs::write(
            &path,
            r#"{"version":1,"activeProviderId":"x","providers":[]}"#,
        )
        .unwrap();
        assert!(matches!(
            AgentSettingsStore::new(path.clone()).load(),
            Err(StorageError::Corrupted(_))
        ));
        let _ = fs::remove_file(path);
    }
}
