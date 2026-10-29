use thiserror::Error;

/// Wire format a provider speaks. The agent loop is the same for both; only
/// the adapter changes (ADR 0064).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentProviderKind {
    /// Anthropic Messages API (`POST {base}/v1/messages`).
    Anthropic,
    /// OpenAI Chat Completions (`POST {base}/chat/completions`): OpenCode Zen,
    /// Ollama, LM Studio and other compatible servers.
    OpenAiCompatible,
}

/// A configured model provider. The API key is not part of it: it lives in
/// the system keyring under `agent_credential_key(id)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProvider {
    pub id: String,
    pub kind: AgentProviderKind,
    pub label: String,
    pub base_url: String,
    /// Model used when the chat does not pick another one. May be empty for
    /// a custom provider until the user chooses one.
    pub model: String,
}

pub const CLAUDE_PROVIDER_ID: &str = "claude";
pub const OPENCODE_PROVIDER_ID: &str = "opencode";
pub const MAX_AGENT_PROVIDERS: usize = 16;

/// Agent preferences: the providers and which one new chats use. Other
/// providers (local servers, gateways) are added by the user from presets. `None`
/// means the agent has not been set up; nothing is sent anywhere until the
/// user picks a provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSettings {
    pub providers: Vec<AgentProvider>,
    pub active_provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AgentSettingsError {
    #[error("provider id must be non-empty and use only letters, digits, '-' or '_'")]
    InvalidId,
    #[error("provider id '{0}' is repeated")]
    DuplicateId(String),
    #[error("provider '{0}' needs a base URL starting with http:// or https://")]
    InvalidBaseUrl(String),
    #[error("at most {MAX_AGENT_PROVIDERS} providers are allowed")]
    TooManyProviders,
    #[error("the active provider '{0}' does not exist")]
    UnknownActiveProvider(String),
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            providers: vec![
                AgentProvider {
                    id: CLAUDE_PROVIDER_ID.into(),
                    kind: AgentProviderKind::Anthropic,
                    label: "Claude".into(),
                    base_url: "https://api.anthropic.com".into(),
                    model: "claude-sonnet-5-5".into(),
                },
                AgentProvider {
                    id: OPENCODE_PROVIDER_ID.into(),
                    kind: AgentProviderKind::OpenAiCompatible,
                    label: "OpenCode Zen".into(),
                    base_url: "https://opencode.ai/inference/openai/v1".into(),
                    model: "claude-sonnet-5-5".into(),
                },
            ],
            active_provider_id: None,
        }
    }
}

impl AgentSettings {
    /// Trims the fields and checks ids, URLs and the active provider.
    pub fn validated(mut self) -> Result<Self, AgentSettingsError> {
        if self.providers.len() > MAX_AGENT_PROVIDERS {
            return Err(AgentSettingsError::TooManyProviders);
        }
        let mut seen = Vec::with_capacity(self.providers.len());
        for provider in &mut self.providers {
            provider.id = provider.id.trim().to_string();
            provider.label = provider.label.trim().to_string();
            provider.base_url = provider.base_url.trim().trim_end_matches('/').to_string();
            provider.model = provider.model.trim().to_string();
            if !is_valid_id(&provider.id) {
                return Err(AgentSettingsError::InvalidId);
            }
            if seen.contains(&provider.id) {
                return Err(AgentSettingsError::DuplicateId(provider.id.clone()));
            }
            if !has_http_host(&provider.base_url) {
                return Err(AgentSettingsError::InvalidBaseUrl(provider.id.clone()));
            }
            if provider.label.is_empty() {
                provider.label = provider.id.clone();
            }
            seen.push(provider.id.clone());
        }
        if let Some(active) = &self.active_provider_id
            && !seen.contains(active)
        {
            return Err(AgentSettingsError::UnknownActiveProvider(active.clone()));
        }
        Ok(self)
    }

    pub fn provider(&self, id: &str) -> Option<&AgentProvider> {
        self.providers.iter().find(|provider| provider.id == id)
    }
}

/// Keyring entry holding a provider's API key.
pub fn agent_credential_key(provider_id: &str) -> String {
    format!("agent:{provider_id}")
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn has_http_host(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["http://", "https://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_not_active() {
        let settings = AgentSettings::default().validated().unwrap();
        assert_eq!(settings.active_provider_id, None);
        assert!(settings.provider(CLAUDE_PROVIDER_ID).is_some());
        assert!(settings.provider(OPENCODE_PROVIDER_ID).is_some());
    }

    #[test]
    fn trims_and_drops_the_trailing_slash() {
        let mut settings = AgentSettings::default();
        settings.providers[0].base_url = "  https://api.anthropic.com/ ".into();
        let settings = settings.validated().unwrap();
        assert_eq!(settings.providers[0].base_url, "https://api.anthropic.com");
    }

    #[test]
    fn rejects_bad_urls_ids_and_active_provider() {
        let mut settings = AgentSettings::default();
        settings.providers[0].base_url = "ftp://example.com".into();
        assert_eq!(
            settings.validated(),
            Err(AgentSettingsError::InvalidBaseUrl("claude".into()))
        );

        let mut settings = AgentSettings::default();
        settings.providers[1].id = "claude".into();
        assert_eq!(
            settings.validated(),
            Err(AgentSettingsError::DuplicateId("claude".into()))
        );

        let mut settings = AgentSettings::default();
        settings.providers[0].id = "a b".into();
        assert_eq!(settings.validated(), Err(AgentSettingsError::InvalidId));

        let settings = AgentSettings {
            active_provider_id: Some("missing".into()),
            ..AgentSettings::default()
        };
        assert_eq!(
            settings.validated(),
            Err(AgentSettingsError::UnknownActiveProvider("missing".into()))
        );
    }

    #[test]
    fn credential_key_is_namespaced() {
        assert_eq!(agent_credential_key("claude"), "agent:claude");
    }
}
