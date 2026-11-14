use alcy_domain::SecuritySettings;
use alcy_storage::{SecuritySettingsStore, StorageError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettingsDto {
    /// Versiona os valores de variáveis sensíveis (em texto claro).
    pub sync_sensitive_values: bool,
    /// Lets sends read body files outside the workspace (spec 0163).
    pub allow_body_files_outside_workspace: bool,
}

/// Preferences to change; the ones left out keep their saved value.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSecuritySettingsInput {
    #[serde(default)]
    pub sync_sensitive_values: Option<bool>,
    #[serde(default)]
    pub allow_body_files_outside_workspace: Option<bool>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SecuritySettingsCommandError {
    Storage { message: String },
}

impl From<StorageError> for SecuritySettingsCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

fn to_dto(settings: &SecuritySettings) -> SecuritySettingsDto {
    SecuritySettingsDto {
        sync_sensitive_values: settings.sync_sensitive_values,
        allow_body_files_outside_workspace: settings.allow_body_files_outside_workspace,
    }
}

#[tauri::command]
pub fn get_security_settings(
    store: State<'_, SecuritySettingsStore>,
) -> Result<SecuritySettingsDto, SecuritySettingsCommandError> {
    crate::logging::logged_with(
        "alcy::settings",
        "ler configurações de segurança",
        || Ok(to_dto(&store.load()?)),
    )
}

#[tauri::command]
pub fn save_security_settings(
    input: SaveSecuritySettingsInput,
    store: State<'_, SecuritySettingsStore>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<SecuritySettingsDto, SecuritySettingsCommandError> {
    let result = crate::logging::logged_with(
        "alcy::settings",
        "salvar configurações de segurança",
        || {
            // An unreadable file falls back to the defaults, which protect.
            let saved = store.load().unwrap_or_default();
            let settings = SecuritySettings {
                sync_sensitive_values: input
                    .sync_sensitive_values
                    .unwrap_or(saved.sync_sensitive_values),
                allow_body_files_outside_workspace: input
                    .allow_body_files_outside_workspace
                    .unwrap_or(saved.allow_body_files_outside_workspace),
            };
            store.save(&settings)?;
            Ok(to_dto(&settings))
        },
    );
    crate::commands::usage_events::record_setting(&usage, "security", None, &result);
    result
}
