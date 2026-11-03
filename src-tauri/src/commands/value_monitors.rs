use std::path::PathBuf;

use alcy_app::{
    MonitorCandidate, MonitorChange, UsageEvent, UsageHub, ValueFinding,
    evaluate_value_monitors as evaluate_monitors,
};
use alcy_domain::{ValueMonitor, ValuePathSegment};
use alcy_storage::{InvalidValueMonitor, StorageError, ValueMonitorRecord, ValueMonitorStore};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListValueMonitorsInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveValueMonitorsInput {
    pub root_path: String,
    pub monitors: Vec<ValueMonitorRecord>,
}

/// Segmento de caminho vindo do frontend: chave (texto) ou índice (número).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum PathSegmentDto {
    Index(usize),
    Key(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorCandidateDto {
    pub path: Vec<PathSegmentDto>,
    pub literal: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateValueMonitorsInput {
    /// Monitores como estão na interface (o save tem debounce, então o
    /// disco pode estar um passo atrás).
    pub monitors: Vec<ValueMonitorRecord>,
    pub values: Vec<MonitorCandidateDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValueFindingDto {
    pub value_index: usize,
    pub monitor_id: String,
    pub field: String,
    pub failed_rule_ids: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ValueMonitorsError {
    Invalid {
        message: String,
        monitor_id: String,
        rule_id: Option<String>,
    },
    Storage {
        message: String,
    },
}

impl From<StorageError> for ValueMonitorsError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

impl From<InvalidValueMonitor> for ValueMonitorsError {
    fn from(error: InvalidValueMonitor) -> Self {
        Self::Invalid {
            message: error.message,
            monitor_id: error.monitor_id,
            rule_id: error.rule_id,
        }
    }
}

fn to_domain(records: &[ValueMonitorRecord]) -> Result<Vec<ValueMonitor>, ValueMonitorsError> {
    records
        .iter()
        .map(|record| record.to_domain().map_err(ValueMonitorsError::from))
        .collect()
}

fn list_value_monitors_inner(
    input: ListValueMonitorsInput,
) -> Result<Vec<ValueMonitorRecord>, ValueMonitorsError> {
    let monitors = ValueMonitorStore::new(PathBuf::from(input.root_path)).load()?;
    Ok(monitors
        .iter()
        .map(ValueMonitorRecord::from_domain)
        .collect())
}

/// Saves and returns the usage events of what changed (created, enabled,
/// disabled, deleted). Without a readable previous file, nothing is reported.
fn save_value_monitors_inner(
    input: SaveValueMonitorsInput,
) -> Result<Vec<UsageEvent>, ValueMonitorsError> {
    let monitors = to_domain(&input.monitors)?;
    let store = ValueMonitorStore::new(PathBuf::from(input.root_path));
    let previous: Option<Vec<ValueMonitorRecord>> = store.load().ok().map(|previous| {
        previous
            .iter()
            .map(ValueMonitorRecord::from_domain)
            .collect()
    });
    store.save(&monitors)?;
    Ok(previous
        .map(|previous| monitor_changes(&previous, &input.monitors))
        .unwrap_or_default())
}

fn monitor_changes(
    previous: &[ValueMonitorRecord],
    next: &[ValueMonitorRecord],
) -> Vec<UsageEvent> {
    let event = |change, monitor: &ValueMonitorRecord| UsageEvent::MonitorChanged {
        change,
        rule_count: u64::try_from(monitor.rules.len()).unwrap_or(u64::MAX),
    };
    let mut events = Vec::new();
    for monitor in next {
        match previous.iter().find(|old| old.id == monitor.id) {
            None => events.push(event(MonitorChange::Created, monitor)),
            Some(old) if old.enabled != monitor.enabled => events.push(event(
                if monitor.enabled {
                    MonitorChange::Enabled
                } else {
                    MonitorChange::Disabled
                },
                monitor,
            )),
            Some(_) => {}
        }
    }
    for old in previous {
        if !next.iter().any(|monitor| monitor.id == old.id) {
            events.push(event(MonitorChange::Deleted, old));
        }
    }
    events
}

fn evaluate_value_monitors_inner(
    input: EvaluateValueMonitorsInput,
) -> Result<Vec<ValueFindingDto>, ValueMonitorsError> {
    // Um monitor ainda em edição (regex incompleta, faixa vazia) não impede
    // os demais de destacar a resposta: fica de fora até ficar válido.
    let monitors: Vec<ValueMonitor> = input
        .monitors
        .iter()
        .filter_map(|record| record.to_domain().ok())
        .collect();
    let candidates: Vec<MonitorCandidate> = input
        .values
        .into_iter()
        .map(|value| MonitorCandidate {
            path: value
                .path
                .into_iter()
                .map(|segment| match segment {
                    PathSegmentDto::Index(index) => ValuePathSegment::Index(index),
                    PathSegmentDto::Key(key) => ValuePathSegment::Key(key),
                })
                .collect(),
            literal: value.literal,
        })
        .collect();
    Ok(evaluate_monitors(&monitors, &candidates)
        .into_iter()
        .map(|finding: ValueFinding| ValueFindingDto {
            value_index: finding.value_index,
            monitor_id: finding.monitor_id,
            field: finding.field,
            failed_rule_ids: finding.failed_rule_ids,
        })
        .collect())
}

#[tauri::command]
pub async fn list_value_monitors(
    input: ListValueMonitorsInput,
) -> Result<Vec<ValueMonitorRecord>, ValueMonitorsError> {
    let result: Result<Vec<ValueMonitorRecord>, ValueMonitorsError> =
        async { run_blocking(move || list_value_monitors_inner(input)).await }.await;
    crate::logging::logged("alcy::monitors", "carregar monitores", result)
}

#[tauri::command]
pub async fn save_value_monitors(
    input: SaveValueMonitorsInput,
    usage: tauri::State<'_, UsageHub>,
) -> Result<(), ValueMonitorsError> {
    let result = run_blocking(move || save_value_monitors_inner(input))
        .await
        .map(|events| events.into_iter().for_each(|event| usage.record(event)));
    crate::logging::logged("alcy::monitors", "salvar monitores", result)
}

#[tauri::command]
pub async fn evaluate_value_monitors(
    input: EvaluateValueMonitorsInput,
) -> Result<Vec<ValueFindingDto>, ValueMonitorsError> {
    run_blocking(move || evaluate_value_monitors_inner(input)).await
}

async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, ValueMonitorsError> + Send + 'static,
) -> Result<T, ValueMonitorsError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| ValueMonitorsError::Storage {
            message: error.to_string(),
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_storage::{RuleKindRecord, ValueRuleRecord};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "alcy-value-monitors-command-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn record(pattern: &str) -> ValueMonitorRecord {
        ValueMonitorRecord {
            id: "m1".into(),
            name: "Nome curto".into(),
            enabled: true,
            fields: vec!["nome".into()],
            rules: vec![ValueRuleRecord {
                id: "r1".into(),
                kind: RuleKindRecord::Regex {
                    pattern: pattern.into(),
                },
            }],
        }
    }

    #[test]
    fn saves_and_lists_monitors() {
        let root = temp_root();
        let root_path = root.to_string_lossy().to_string();

        save_value_monitors_inner(SaveValueMonitorsInput {
            root_path: root_path.clone(),
            monitors: vec![record("[a-z]+")],
        })
        .unwrap();

        let listed = list_value_monitors_inner(ListValueMonitorsInput { root_path }).unwrap();
        assert_eq!(listed, vec![record("[a-z]+")]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn saving_reports_created_enabled_disabled_and_deleted_monitors() {
        let root = temp_root();
        let root_path = root.to_string_lossy().to_string();
        let save = |monitors: Vec<ValueMonitorRecord>| {
            save_value_monitors_inner(SaveValueMonitorsInput {
                root_path: root_path.clone(),
                monitors,
            })
            .unwrap()
            .iter()
            .map(UsageEvent::name)
            .collect::<Vec<_>>()
        };
        let disabled = ValueMonitorRecord {
            enabled: false,
            ..record("[a-z]+")
        };

        assert_eq!(save(vec![record("[a-z]+")]), ["monitor_created"]);
        assert!(save(vec![record("[a-z]+")]).is_empty());
        assert_eq!(save(vec![disabled.clone()]), ["monitor_disabled"]);
        assert_eq!(save(vec![record("[a-z]+")]), ["monitor_enabled"]);
        assert_eq!(save(Vec::new()), ["monitor_deleted"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn save_rejects_invalid_rule_pointing_to_it() {
        let root = temp_root();
        let error = save_value_monitors_inner(SaveValueMonitorsInput {
            root_path: root.to_string_lossy().to_string(),
            monitors: vec![record("(")],
        })
        .unwrap_err();

        assert!(matches!(
            error,
            ValueMonitorsError::Invalid { ref monitor_id, rule_id: Some(ref rule_id), .. }
                if monitor_id == "m1" && rule_id == "r1"
        ));
        assert!(!root.exists());
    }

    #[test]
    fn evaluates_candidates_and_skips_invalid_monitors() {
        let findings = evaluate_value_monitors_inner(EvaluateValueMonitorsInput {
            monitors: vec![
                record("[a-z]+"),
                ValueMonitorRecord {
                    id: "broken".into(),
                    ..record("(")
                },
            ],
            values: vec![
                MonitorCandidateDto {
                    path: vec![
                        PathSegmentDto::Key("itens".into()),
                        PathSegmentDto::Index(0),
                        PathSegmentDto::Key("nome".into()),
                    ],
                    literal: r#""ana""#.into(),
                },
                MonitorCandidateDto {
                    path: vec![PathSegmentDto::Key("nome".into())],
                    literal: r#""Ana""#.into(),
                },
            ],
        })
        .unwrap();

        assert_eq!(
            findings,
            vec![
                ValueFindingDto {
                    value_index: 0,
                    monitor_id: "m1".into(),
                    field: "nome".into(),
                    failed_rule_ids: vec![],
                },
                ValueFindingDto {
                    value_index: 1,
                    monitor_id: "m1".into(),
                    field: "nome".into(),
                    failed_rule_ids: vec!["r1".into()],
                },
            ]
        );
    }

    #[test]
    fn path_segments_deserialize_as_key_or_index() {
        let input: MonitorCandidateDto =
            serde_json::from_str(r#"{ "path": ["a", 0, "b"], "literal": "1" }"#).unwrap();
        assert!(matches!(input.path[1], PathSegmentDto::Index(0)));
        assert!(matches!(input.path[2], PathSegmentDto::Key(ref key) if key == "b"));
    }
}
