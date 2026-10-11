//! Histórico de runs do runner de coleções (spec 0073, ADR 0027): mesmo
//! desenho do histórico de runs de flow — índice leve
//! (`alcy-collection-runs.json`) mais um detalhe por run
//! (`alcy-collection-runs/<id>.json`), escrita atômica e poda por retenção.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const MANIFEST_VERSION: u32 = 1;
const DETAIL_VERSION: u32 = 1;
const MANIFEST_FILE_NAME: &str = "alcy-collection-runs.json";
const DETAIL_DIR_NAME: &str = "alcy-collection-runs";

/// Como um run terminou: cancelado tem precedência sobre falha, e falha
/// (alguma requisição que não passou) sobre concluído.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectionRunStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordedStepOutcome {
    Passed,
    Failed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionRunSummaryEntry {
    pub id: String,
    pub scope_name: String,
    pub started_at: SystemTime,
    pub finished_at: SystemTime,
    pub status: CollectionRunStatus,
    pub passed: u32,
    pub total: u32,
}

/// Opções com que o run foi executado, para o relatório.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRunOptions {
    pub iterations: u32,
    pub delay_ms: u64,
    pub stop_on_error: bool,
    pub http_errors_fail: bool,
    pub keep_variable_values: bool,
    pub share_cookies: bool,
    pub persist_responses: bool,
    pub disable_logs: bool,
    pub data_file_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedPlanItem {
    pub request_id: String,
    pub name: String,
    pub protocol: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedTest {
    pub name: String,
    pub passed: bool,
    pub message: Option<String>,
}

/// Uma requisição terminada, no mesmo formato do evento `requestFinished`
/// do canal ao vivo, com o instante em que terminou.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRunStep {
    pub at_ms: u64,
    pub iteration: u32,
    pub position: usize,
    pub request_id: String,
    pub name: String,
    pub protocol: Option<String>,
    pub method: String,
    pub resolved_url: String,
    pub outcome: RecordedStepOutcome,
    pub status_code: Option<u16>,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<usize>,
    pub error_message: Option<String>,
    pub tests: Vec<RecordedTest>,
    pub logs: Vec<String>,
}

/// Resposta de um passo, com o corpo já limitado pelo chamador.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedStepOutput {
    pub iteration: u32,
    pub position: usize,
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub base64: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionRunRecord {
    pub id: String,
    pub scope_name: String,
    /// Ambiente ativo no run, quando havia um.
    pub environment_name: Option<String>,
    pub started_at: SystemTime,
    pub finished_at: SystemTime,
    pub cancelled: bool,
    pub stopped_on_error: bool,
    pub iterations: u32,
    pub options: RecordedRunOptions,
    pub plan: Vec<RecordedPlanItem>,
    pub steps: Vec<RecordedRunStep>,
    pub outputs: Vec<RecordedStepOutput>,
}

impl CollectionRunRecord {
    pub fn status(&self) -> CollectionRunStatus {
        if self.cancelled {
            CollectionRunStatus::Cancelled
        } else if self
            .steps
            .iter()
            .any(|step| step.outcome != RecordedStepOutcome::Passed)
        {
            CollectionRunStatus::Failed
        } else {
            CollectionRunStatus::Completed
        }
    }

    fn passed(&self) -> u32 {
        self.steps
            .iter()
            .filter(|step| step.outcome == RecordedStepOutcome::Passed)
            .count() as u32
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedManifest {
    version: u32,
    entries: Vec<PersistedIndexEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedIndexEntry {
    id: String,
    scope_name: String,
    started_at_ms: u64,
    finished_at_ms: u64,
    status: CollectionRunStatus,
    passed: u32,
    total: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDetail {
    version: u32,
    scope_name: String,
    /// Campo acrescentado depois da v1: ausente nos registros antigos.
    #[serde(default)]
    environment_name: Option<String>,
    started_at_ms: u64,
    finished_at_ms: u64,
    cancelled: bool,
    stopped_on_error: bool,
    iterations: u32,
    options: RecordedRunOptions,
    plan: Vec<RecordedPlanItem>,
    steps: Vec<RecordedRunStep>,
    outputs: Vec<RecordedStepOutput>,
}

pub struct CollectionRunHistoryStore {
    manifest_path: PathBuf,
    detail_dir: PathBuf,
    retention: Duration,
}

impl CollectionRunHistoryStore {
    pub fn new(root: PathBuf, retention: Duration) -> Self {
        Self {
            manifest_path: root.join(MANIFEST_FILE_NAME),
            detail_dir: root.join(DETAIL_DIR_NAME),
            retention,
        }
    }

    /// Resumo de cada run, mais recente primeiro, sem abrir nenhum detalhe.
    pub fn load_summaries(&self) -> Result<Vec<CollectionRunSummaryEntry>, StorageError> {
        Ok(self
            .load_index()?
            .into_iter()
            .map(|entry| CollectionRunSummaryEntry {
                id: entry.id,
                scope_name: entry.scope_name,
                started_at: from_millis(entry.started_at_ms),
                finished_at: from_millis(entry.finished_at_ms),
                status: entry.status,
                passed: entry.passed,
                total: entry.total,
            })
            .collect())
    }

    /// `Ok(None)` quando `id` não está no índice (ou não tem formato de id).
    pub fn load_record(&self, id: &str) -> Result<Option<CollectionRunRecord>, StorageError> {
        if !is_valid_id(id) || !self.load_index()?.iter().any(|entry| entry.id == id) {
            return Ok(None);
        }

        let raw = fs::read_to_string(self.detail_path(id)).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                StorageError::NotFound(format!("detalhe do run não encontrado: {id}"))
            } else {
                StorageError::Read(error.to_string())
            }
        })?;
        let detail: PersistedDetail = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if detail.version != DETAIL_VERSION {
            return Err(StorageError::UnsupportedVersion(detail.version));
        }

        Ok(Some(CollectionRunRecord {
            id: id.to_string(),
            scope_name: detail.scope_name,
            environment_name: detail.environment_name,
            started_at: from_millis(detail.started_at_ms),
            finished_at: from_millis(detail.finished_at_ms),
            cancelled: detail.cancelled,
            stopped_on_error: detail.stopped_on_error,
            iterations: detail.iterations,
            options: detail.options,
            plan: detail.plan,
            steps: detail.steps,
            outputs: detail.outputs,
        }))
    }

    /// Grava o detalhe, põe o resumo no início do índice e poda os runs mais
    /// antigos que a retenção.
    pub fn record(&self, record: &CollectionRunRecord) -> Result<(), StorageError> {
        if !is_valid_id(&record.id) {
            return Err(StorageError::Write(format!(
                "id de run inválido: {}",
                record.id
            )));
        }

        let mut index = self.load_index()?;

        let detail = PersistedDetail {
            version: DETAIL_VERSION,
            scope_name: record.scope_name.clone(),
            environment_name: record.environment_name.clone(),
            started_at_ms: to_millis(record.started_at),
            finished_at_ms: to_millis(record.finished_at),
            cancelled: record.cancelled,
            stopped_on_error: record.stopped_on_error,
            iterations: record.iterations,
            options: record.options.clone(),
            plan: record.plan.clone(),
            steps: record.steps.clone(),
            outputs: record.outputs.clone(),
        };
        let json = serde_json::to_string(&detail)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        write_atomic(&self.detail_path(&record.id), &json)?;

        index.insert(
            0,
            PersistedIndexEntry {
                id: record.id.clone(),
                scope_name: record.scope_name.clone(),
                started_at_ms: to_millis(record.started_at),
                finished_at_ms: to_millis(record.finished_at),
                status: record.status(),
                passed: record.passed(),
                total: record.steps.len() as u32,
            },
        );

        self.write_retained(index, true)
    }

    /// Remove os runs mais antigos que a retenção sem gravar nada novo; sem
    /// nada a podar, não reescreve o índice.
    pub fn prune(&self) -> Result<(), StorageError> {
        let index = self.load_index()?;
        self.write_retained(index, false)
    }

    fn write_retained(
        &self,
        index: Vec<PersistedIndexEntry>,
        always_write: bool,
    ) -> Result<(), StorageError> {
        let now = SystemTime::now();
        let (kept, pruned): (Vec<_>, Vec<_>) = index.into_iter().partition(|entry| {
            now.duration_since(from_millis(entry.started_at_ms))
                .unwrap_or(Duration::ZERO)
                <= self.retention
        });
        if !always_write && pruned.is_empty() {
            return Ok(());
        }

        let manifest = PersistedManifest {
            version: MANIFEST_VERSION,
            entries: kept,
        };
        let json = serde_json::to_string(&manifest)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        write_atomic(&self.manifest_path, &json)?;

        for entry in &pruned {
            // Best-effort: a entrada já saiu do índice.
            let _ = fs::remove_file(self.detail_path(&entry.id));
        }

        Ok(())
    }

    fn load_index(&self) -> Result<Vec<PersistedIndexEntry>, StorageError> {
        if !self.manifest_path.exists() {
            return Ok(Vec::new());
        }

        let raw = fs::read_to_string(&self.manifest_path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let manifest: PersistedManifest = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if manifest.version != MANIFEST_VERSION {
            return Err(StorageError::UnsupportedVersion(manifest.version));
        }

        Ok(manifest.entries)
    }

    fn detail_path(&self, id: &str) -> PathBuf {
        self.detail_dir.join(format!("{id}.json"))
    }
}

/// O id vira nome de arquivo: só o alfabeto que o backend gera.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn to_millis(instant: SystemTime) -> u64 {
    instant
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

fn from_millis(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), StorageError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
    }

    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, contents).map_err(|error| StorageError::Write(error.to_string()))?;
    fs::rename(&tmp_path, path).map_err(|error| StorageError::Write(error.to_string()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEEK: Duration = Duration::from_secs(7 * 24 * 60 * 60);

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "alcy-collection-runs-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn step(position: usize, outcome: RecordedStepOutcome) -> RecordedRunStep {
        RecordedRunStep {
            at_ms: 10,
            iteration: 0,
            position,
            request_id: format!("r{position}"),
            name: format!("Req {position}"),
            protocol: Some("rest".to_string()),
            method: "get".to_string(),
            resolved_url: "https://api.test/".to_string(),
            outcome,
            status_code: Some(200),
            duration_ms: Some(3),
            size_bytes: Some(2),
            error_message: None,
            tests: vec![RecordedTest {
                name: "ok".to_string(),
                passed: true,
                message: None,
            }],
            logs: Vec::new(),
        }
    }

    fn record(
        id: &str,
        started_at: SystemTime,
        steps: Vec<RecordedRunStep>,
    ) -> CollectionRunRecord {
        CollectionRunRecord {
            id: id.to_string(),
            scope_name: "Loja".to_string(),
            environment_name: Some("Dev".to_string()),
            started_at,
            finished_at: started_at + Duration::from_millis(500),
            cancelled: false,
            stopped_on_error: false,
            iterations: 1,
            options: RecordedRunOptions {
                iterations: 1,
                delay_ms: 0,
                stop_on_error: false,
                http_errors_fail: true,
                keep_variable_values: true,
                share_cookies: true,
                persist_responses: true,
                disable_logs: false,
                data_file_name: Some("dados.csv".to_string()),
            },
            plan: vec![RecordedPlanItem {
                request_id: "r0".to_string(),
                name: "Req 0".to_string(),
                protocol: "rest".to_string(),
                method: "get".to_string(),
            }],
            steps,
            outputs: vec![RecordedStepOutput {
                iteration: 0,
                position: 0,
                status_code: 200,
                duration_ms: 3,
                size_bytes: 2,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: "{}".to_string(),
                base64: false,
                truncated: false,
            }],
        }
    }

    #[test]
    fn records_and_loads_a_run() {
        let root = temp_root("roundtrip");
        let store = CollectionRunHistoryStore::new(root.clone(), WEEK);
        let run = record(
            "run-1",
            SystemTime::now(),
            vec![
                step(0, RecordedStepOutcome::Passed),
                step(1, RecordedStepOutcome::Failed),
            ],
        );

        store.record(&run).unwrap();

        let summaries = store.load_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].scope_name, "Loja");
        assert_eq!(summaries[0].status, CollectionRunStatus::Failed);
        assert_eq!((summaries[0].passed, summaries[0].total), (1, 2));

        let loaded = store.load_record("run-1").unwrap().unwrap();
        assert_eq!(loaded.steps, run.steps);
        assert_eq!(loaded.outputs, run.outputs);
        assert_eq!(loaded.options, run.options);
        assert_eq!(loaded.plan, run.plan);
        assert_eq!(loaded.environment_name.as_deref(), Some("Dev"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn loads_details_written_before_the_environment_name_existed() {
        let root = temp_root("legacy");
        let store = CollectionRunHistoryStore::new(root.clone(), WEEK);
        store
            .record(&record("old", SystemTime::now(), Vec::new()))
            .unwrap();
        let path = root.join(DETAIL_DIR_NAME).join("old.json");
        let mut detail: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        detail.as_object_mut().unwrap().remove("environmentName");
        fs::write(&path, detail.to_string()).unwrap();

        let loaded = store.load_record("old").unwrap().unwrap();

        assert_eq!(loaded.environment_name, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_prefers_cancelled_then_failed() {
        let now = SystemTime::now();
        let mut run = record("a", now, vec![step(0, RecordedStepOutcome::Passed)]);
        assert_eq!(run.status(), CollectionRunStatus::Completed);
        run.steps.push(step(1, RecordedStepOutcome::Error));
        assert_eq!(run.status(), CollectionRunStatus::Failed);
        run.cancelled = true;
        assert_eq!(run.status(), CollectionRunStatus::Cancelled);
    }

    #[test]
    fn prunes_runs_older_than_the_retention() {
        let root = temp_root("prune");
        let store = CollectionRunHistoryStore::new(root.clone(), WEEK);
        let old = SystemTime::now() - WEEK - Duration::from_secs(60);

        store.record(&record("old", old, Vec::new())).unwrap();
        store
            .record(&record("new", SystemTime::now(), Vec::new()))
            .unwrap();

        let ids: Vec<_> = store
            .load_summaries()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["new"]);
        assert!(!root.join(DETAIL_DIR_NAME).join("old.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prune_drops_runs_outside_a_shorter_retention() {
        let root = temp_root("prune-only");
        CollectionRunHistoryStore::new(root.clone(), WEEK)
            .record(&record("run-1", SystemTime::now(), Vec::new()))
            .unwrap();

        let disabled = CollectionRunHistoryStore::new(root.clone(), Duration::ZERO);
        disabled.prune().unwrap();

        assert!(disabled.load_summaries().unwrap().is_empty());
        assert!(!root.join(DETAIL_DIR_NAME).join("run-1.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_ids_that_are_not_file_safe() {
        let root = temp_root("ids");
        let store = CollectionRunHistoryStore::new(root.clone(), WEEK);

        assert!(
            store
                .record(&record("../x", SystemTime::now(), Vec::new()))
                .is_err()
        );
        assert_eq!(store.load_record("../x").unwrap(), None);
        assert_eq!(store.load_record("missing").unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }
}
