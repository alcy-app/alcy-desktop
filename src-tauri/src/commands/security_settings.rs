use alcy_domain::SecuritySettings;
use alcy_storage::{SecuritySettingsStore, StorageError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettingsDto {
    /// Versiona os valores de variáveis sensíveis (em texto claro).
    pub sync_sensitive_values: bool,
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
    input: SecuritySettingsDto,
    store: State<'_, SecuritySettingsStore>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<SecuritySettingsDto, SecuritySettingsCommandError> {
    let result = crate::logging::logged_with(
        "alcy::settings",
        "salvar configurações de segurança",
        || {
            let settings = SecuritySettings {
                sync_sensitive_values: input.sync_sensitive_values,
            };
            store.save(&settings)?;
            Ok(to_dto(&settings))
        },
    );
    crate::commands::usage_events::record_setting(&usage, "security", None, &result);
    result
}
