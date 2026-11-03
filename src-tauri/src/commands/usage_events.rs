//! Usage events (spec 0142, ADR 0068). The frontend activates the hub once at
//! startup when its feature flag is on, and reports the few events that only
//! it sees. Everything else is recorded natively where it happens.

use alcy_app::{
    RequestExecuted, ShortcutChange, StatusClass, UsageEvent, UsageHub, UsageIdentifier,
    UsageOutcome,
};
use alcy_domain::ProtocolId;
use alcy_storage::UsagePreferencesStore;
use serde::{Deserialize, Serialize};

/// How long closing the app may wait for the sink to deliver or persist.
pub const USAGE_SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutChangeInput {
    Assigned,
    Removed,
    Reset,
    ResetAll,
}

/// Events only the interface sees. Native events are not accepted here, so
/// the webview cannot forge them.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "name",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UsageEventInput {
    ShortcutChanged {
        action: Option<String>,
        change: ShortcutChangeInput,
    },
    EnvironmentSwitched {},
    SettingsChanged {
        category: String,
        key: Option<String>,
    },
    SidebarModuleOpened {
        module: String,
    },
}

impl UsageEventInput {
    /// `None` when an identifier is not a code identifier (free text).
    fn into_event(self) -> Option<UsageEvent> {
        let optional = |value: Option<String>| match value {
            Some(value) => UsageIdentifier::new(value).map(Some),
            None => Some(None),
        };
        Some(match self {
            Self::ShortcutChanged { action, change } => UsageEvent::ShortcutChanged {
                action: optional(action)?,
                change: match change {
                    ShortcutChangeInput::Assigned => ShortcutChange::Assigned,
                    ShortcutChangeInput::Removed => ShortcutChange::Removed,
                    ShortcutChangeInput::Reset => ShortcutChange::Reset,
                    ShortcutChangeInput::ResetAll => ShortcutChange::ResetAll,
                },
            },
            Self::EnvironmentSwitched {} => UsageEvent::EnvironmentSwitched,
            Self::SettingsChanged { category, key } => UsageEvent::SettingsChanged {
                category: UsageIdentifier::new(category)?,
                key: optional(key)?,
            },
            Self::SidebarModuleOpened { module } => UsageEvent::SidebarModuleOpened {
                module: UsageIdentifier::new(module)?,
            },
        })
    }
}

/// A request sent from a request tab that got an answer (any status).
pub(crate) fn request_answered(
    protocol: ProtocolId,
    operation: Option<&str>,
    status_class: StatusClass,
    error_kind: Option<&str>,
    duration_ms: u64,
) -> UsageEvent {
    UsageEvent::RequestExecuted(RequestExecuted {
        protocol,
        operation: operation.and_then(UsageIdentifier::new),
        status_class,
        error_kind: error_kind.and_then(UsageIdentifier::new),
        error_cause: None,
        duration_ms,
    })
}

/// A request sent from a request tab that failed before an answer. Keeps
/// only the error's serde tag and typed cause, like `logging::error_summary`.
pub(crate) fn request_failed<E: Serialize>(
    protocol: ProtocolId,
    operation: Option<&str>,
    error: &E,
    duration_ms: u64,
) -> UsageEvent {
    let value = serde_json::to_value(error).unwrap_or_default();
    let tag = |value: Option<&serde_json::Value>| {
        value
            .and_then(serde_json::Value::as_str)
            .and_then(UsageIdentifier::new)
    };
    UsageEvent::RequestExecuted(RequestExecuted {
        protocol,
        operation: operation.and_then(UsageIdentifier::new),
        status_class: StatusClass::Error,
        error_kind: tag(value.get("kind")),
        error_cause: tag(value.get("cause").and_then(|cause| cause.get("type"))),
        duration_ms,
    })
}

/// Operation type of a GraphQL document (`query`, `mutation`,
/// `subscription`), read from its first keyword; never the operation name.
pub(crate) fn graphql_operation_type(document: &str) -> &'static str {
    let first_word = document
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .find(|line| !line.is_empty())
        .and_then(|line| {
            line.split(|c: char| !c.is_ascii_alphabetic())
                .find(|word| !word.is_empty())
        });
    match first_word {
        Some("mutation") => "mutation",
        Some("subscription") => "subscription",
        _ => "query",
    }
}

/// Records a successful export in `format` (`alcy`, `har`, `png`…).
pub(crate) fn record_export<T, E>(usage: &UsageHub, format: &str, result: &Result<T, E>) {
    if result.is_ok()
        && let Some(format) = UsageIdentifier::new(format)
    {
        usage.record(UsageEvent::ExportFinished { format });
    }
}

/// Records a version control push or pull (`operation`).
pub(crate) fn record_sync<T, E: Serialize>(
    usage: &UsageHub,
    operation: &str,
    result: &Result<T, E>,
) {
    let Some(operation) = UsageIdentifier::new(operation) else {
        return;
    };
    let outcome = match result {
        Ok(_) => UsageOutcome::Succeeded,
        Err(error) if crate::logging::error_kind(error) == "cancelled" => UsageOutcome::Cancelled,
        Err(_) => UsageOutcome::Failed,
    };
    usage.record(UsageEvent::VersionControlSynced { operation, outcome });
}

/// Records that a setting of `category` (and `key`, when known) was saved;
/// never its value.
pub(crate) fn record_setting<T, E>(
    usage: &UsageHub,
    category: &str,
    key: Option<&str>,
    result: &Result<T, E>,
) {
    if result.is_err() {
        return;
    }
    let Some(category) = UsageIdentifier::new(category) else {
        return;
    };
    usage.record(UsageEvent::SettingsChanged {
        category,
        key: key.and_then(UsageIdentifier::new),
    });
}

/// Whether this build collects usage events and whether the person lets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEventsStatusDto {
    /// An extension collects usage events in this build.
    pub available: bool,
    /// The person's preference (on by default).
    pub enabled: bool,
}

fn status(usage: &UsageHub) -> UsageEventsStatusDto {
    UsageEventsStatusDto {
        available: usage.is_available(),
        enabled: usage.is_enabled(),
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UsageEventsError {
    Storage { message: String },
}

/// Starts the hub when an extension registered a sink. The interface sends
/// its offset from UTC (`-new Date().getTimezoneOffset()`) so events carry
/// the local date; an offset outside UTC−14:00..UTC+14:00 is refused. The
/// interface reports events only when the answer is available and enabled.
#[tauri::command]
pub fn activate_usage_events(
    utc_offset_minutes: i32,
    usage: tauri::State<'_, UsageHub>,
) -> UsageEventsStatusDto {
    let available = usage.activate(utc_offset_minutes);
    UsageEventsStatusDto {
        available,
        ..status(&usage)
    }
}

#[tauri::command]
pub fn get_usage_events_status(usage: tauri::State<'_, UsageHub>) -> UsageEventsStatusDto {
    status(&usage)
}

/// Saves the person's choice and applies it at once; turning usage events
/// off drops what was recorded and not sent yet.
#[tauri::command]
pub fn set_usage_events_enabled(
    enabled: bool,
    usage: tauri::State<'_, UsageHub>,
    store: tauri::State<'_, UsagePreferencesStore>,
) -> Result<UsageEventsStatusDto, UsageEventsError> {
    let result = store
        .save(enabled)
        .map(|()| {
            usage.set_enabled(enabled);
            status(&usage)
        })
        .map_err(|error| UsageEventsError::Storage {
            message: error.to_string(),
        });
    crate::logging::logged("alcy::settings", "salvar preferência de telemetria", result)
}

/// The events recorded in this run, as they are handed to the extension,
/// for Settings > Telemetry.
#[tauri::command]
pub fn list_recent_usage_events(usage: tauri::State<'_, UsageHub>) -> Vec<serde_json::Value> {
    usage
        .recent_events()
        .iter()
        .map(alcy_app::UsageEnvelope::to_json)
        .collect()
}

/// Records an interface event. Returns whether it was accepted.
#[tauri::command]
pub fn record_usage_event(event: UsageEventInput, usage: tauri::State<'_, UsageHub>) -> bool {
    record(&usage, event)
}

fn record(usage: &UsageHub, event: UsageEventInput) -> bool {
    if !usage.is_active() {
        return false;
    }
    match event.into_event() {
        Some(event) => {
            usage.record(event);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use alcy_app::{UsageEnvelope, UsageEventSink};
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<UsageEnvelope>>);

    impl UsageEventSink for RecordingSink {
        fn record(&self, envelope: UsageEnvelope) {
            self.0.lock().unwrap().push(envelope);
        }
    }

    fn input(value: serde_json::Value) -> UsageEventInput {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn interface_events_are_dropped_while_the_hub_is_dormant() {
        let usage = UsageHub::new("1.0.0", "linux");
        assert!(!record(
            &usage,
            input(json!({ "name": "environment_switched" }))
        ));
    }

    #[test]
    fn interface_events_reach_the_sink_with_code_identifiers_only() {
        let usage = UsageHub::new("1.0.0", "linux");
        let sink = Arc::new(RecordingSink::default());
        usage.register_sink(sink.clone());
        usage.activate(0);

        assert!(record(
            &usage,
            input(
                json!({ "name": "shortcut_changed", "action": "request.send", "change": "assigned" })
            )
        ));
        assert!(record(
            &usage,
            input(json!({ "name": "settings_changed", "category": "general", "key": "timeout" }))
        ));
        assert!(!record(
            &usage,
            input(json!({ "name": "sidebar_module_opened", "module": "my private notes" }))
        ));

        let events: Vec<_> = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|envelope| envelope.to_json())
            .collect();
        assert_eq!(events.len(), 3);
        assert_eq!(
            events[1]["props"],
            json!({ "action": "request.send", "change": "assigned" })
        );
        assert_eq!(
            events[2]["props"],
            json!({ "category": "general", "key": "timeout" })
        );
    }

    #[test]
    fn graphql_operation_types_ignore_comments_and_names() {
        assert_eq!(graphql_operation_type("{ me { id } }"), "query");
        assert_eq!(
            graphql_operation_type("# create\nmutation CreateUser { x }"),
            "mutation"
        );
        assert_eq!(graphql_operation_type("subscription{x}"), "subscription");
        assert_eq!(graphql_operation_type(""), "query");
    }

    #[test]
    fn failed_requests_keep_only_the_error_tags() {
        let error = json!({
            "kind": "network",
            "message": "connection to secret.internal failed",
            "cause": { "type": "hostNotFound", "host": "secret.internal" },
        });
        let event = request_failed(ProtocolId::Rest, Some("GET"), &error, 5);
        let props = event.props();
        assert_eq!(props["errorKind"], "network");
        assert_eq!(props["errorCause"], "hostNotFound");
        assert_eq!(props["statusClass"], "error");
        assert!(!props.to_string().contains("secret"));
    }

    #[test]
    fn native_events_cannot_come_from_the_interface() {
        for name in ["request_executed", "app_opened", "mock_requests_served"] {
            assert!(serde_json::from_value::<UsageEventInput>(json!({ "name": name })).is_err());
        }
        assert!(
            serde_json::from_value::<UsageEventInput>(
                json!({ "name": "environment_switched", "environmentName": "prod" })
            )
            .is_err()
        );
    }
}
