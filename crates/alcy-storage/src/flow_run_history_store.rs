use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alcy_domain::Flow;
use serde::{Deserialize, Serialize};

use crate::flow_store::{PersistedFlow, flow_from_persisted, persisted_from_flow};
use crate::storage_error::StorageError;

/// A v2 discrimina execuções normais e de carga no mesmo índice. Arquivos v1
/// continuam sendo lidos como runs normais e são atualizados na próxima gravação.
const MANIFEST_VERSION: u32 = 2;
const DETAIL_VERSION: u32 = 1;
const MANIFEST_FILE_NAME: &str = "alcy-flow-runs.json";
const DETAIL_DIR_NAME: &str = "alcy-flow-runs";

/// Como um run terminou, derivado dos eventos gravados: cancelado tem
/// precedência sobre falha, e falha sobre concluído.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowRunStatus {
    Completed,
    Failed,
    Cancelled,
}

/// Tipo de detalhe a que uma entrada do índice aponta. Mantém o histórico de
/// flows num único arquivo, sem forçar consumidores de flows normais a abrir
/// ou desserializar relatórios de carga.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowRunKind {
    #[default]
    Standard,
    Load,
}

/// Resumo leve de um run — o que o índice guarda e basta para listar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowRunSummary {
    pub id: String,
    pub flow_name: String,
    pub started_at: SystemTime,
    pub finished_at: SystemTime,
    pub status: FlowRunStatus,
}

/// Resumo leve de uma execução de carga, usado para a lista unificada de
/// histórico sem transferir métricas, thresholds ou amostras.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadFlowRunSummary {
    pub id: String,
    pub flow_id: String,
    pub flow_name: String,
    pub started_at: SystemTime,
    pub finished_at: SystemTime,
    pub status: FlowRunStatus,
    pub passed: bool,
    pub requests: u64,
    pub failed_requests: u64,
}

/// Contadores finais do runner de carga. Não há corpos de resposta nesta
/// estrutura nem nos arquivos de histórico de carga.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedLoadRunSummary {
    pub cancelled: bool,
    pub completed_iterations: u64,
    pub dropped_iterations: u64,
    pub requests: u64,
    pub failed_requests: u64,
    pub checks_passed: u64,
    pub checks_failed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedLoadMetric {
    pub name: String,
    pub tags: Vec<(String, String)>,
    pub kind: String,
    pub count: u64,
    pub value: f64,
    pub average: Option<f64>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    #[serde(default)]
    pub p90: Option<f64>,
    #[serde(default)]
    pub p95: Option<f64>,
    #[serde(default)]
    pub p99: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedLoadThreshold {
    pub metric: String,
    pub tags: Vec<(String, String)>,
    pub statistic: String,
    pub comparison: String,
    pub target: f64,
    pub actual: Option<f64>,
    pub passed: bool,
}

/// Request compacta usada pela paginação de resultados. O tamanho é limitado
/// pelo command antes da persistência; nenhum dado de resposta é armazenado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedLoadSample {
    pub scenario_id: String,
    pub vu_id: u32,
    pub node_id: String,
    pub method: String,
    pub status: Option<u16>,
    pub failed: bool,
    pub duration_ms: u64,
}

/// Relatório persistido de carga. `samples` é deliberadamente uma amostra
/// limitada para que o tamanho do histórico não acompanhe a taxa do teste.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadFlowRunRecord {
    pub id: String,
    pub flow_id: String,
    pub flow_name: String,
    pub started_at: SystemTime,
    pub finished_at: SystemTime,
    pub passed: bool,
    pub summary: RecordedLoadRunSummary,
    pub metrics: Vec<RecordedLoadMetric>,
    pub thresholds: Vec<RecordedLoadThreshold>,
    pub samples: Vec<RecordedLoadSample>,
    pub omitted_samples: u64,
}

impl LoadFlowRunRecord {
    pub fn status(&self) -> FlowRunStatus {
        if self.summary.cancelled {
            FlowRunStatus::Cancelled
        } else if self.passed {
            FlowRunStatus::Completed
        } else {
            FlowRunStatus::Failed
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedCallVariable {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordedSkipReason {
    NotRunnable,
    Unreachable,
    Cancelled,
    BranchNotTaken,
    /// Aditivo (spec 0085).
    LoopInterrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecordedEventKind {
    NodeStarted,
    CallResolved {
        request_url: String,
        resolved_url: String,
        variables: Vec<RecordedCallVariable>,
    },
    Succeeded {
        status_code: u16,
        duration_ms: u64,
    },
    Branched {
        result: bool,
        /// Aditivo (spec 0121): explicação dos nodes de mock com saídas
        /// `true`/`false`; `If` não traz mensagem.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Failed {
        message: String,
    },
    Cancelled,
    Skipped {
        reason: RecordedSkipReason,
    },
    /// Aditivo (spec 0083): conclusão de `Log`/`Display`/`SetVariables`/
    /// `Sleep`, com o texto já mascarado.
    Completed {
        #[serde(default)]
        message: Option<String>,
    },
    /// Aditivos (spec 0084): iteração iniciada e saída de um `While`.
    LoopIteration {
        iteration: u32,
    },
    LoopFinished {
        iterations: u32,
    },
}

/// Um evento do run com o instante em que chegou, para o frontend
/// reexecutá-los e reconstruir status, rastro e log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedFlowEvent {
    pub at_ms: u64,
    pub node_id: String,
    #[serde(flatten)]
    pub kind: RecordedEventKind,
}

/// Saída de um node de requisição, com o corpo já limitado pelo chamador.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedNodeOutput {
    pub node_id: String,
    pub status_code: u16,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub base64: bool,
    pub truncated: bool,
    /// Aditivo (spec 0121): presente quando a saída é a chamada recebida por
    /// um node `MockWaitRequest` — `headers`/`body` são os da chamada.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<RecordedRequestLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRequestLine {
    pub method: String,
    pub path: String,
}

/// Um run de flow completo: o grafo como foi executado (snapshot, não uma
/// referência ao flow salvo, que pode mudar depois), os eventos e as saídas.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowRunRecord {
    pub id: String,
    pub flow: Flow,
    pub started_at: SystemTime,
    pub finished_at: SystemTime,
    pub cancelled: bool,
    pub events: Vec<RecordedFlowEvent>,
    pub outputs: Vec<RecordedNodeOutput>,
}

impl FlowRunRecord {
    pub fn status(&self) -> FlowRunStatus {
        if self.cancelled {
            FlowRunStatus::Cancelled
        } else if self
            .events
            .iter()
            .any(|event| matches!(event.kind, RecordedEventKind::Failed { .. }))
        {
            FlowRunStatus::Failed
        } else {
            FlowRunStatus::Completed
        }
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
    flow_name: String,
    started_at_ms: u64,
    finished_at_ms: u64,
    status: FlowRunStatus,
    #[serde(default)]
    kind: FlowRunKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    load: Option<PersistedLoadIndex>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedLoadIndex {
    flow_id: String,
    passed: bool,
    requests: u64,
    failed_requests: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDetail {
    version: u32,
    flow: PersistedFlow,
    cancelled: bool,
    started_at_ms: u64,
    finished_at_ms: u64,
    events: Vec<RecordedFlowEvent>,
    outputs: Vec<RecordedNodeOutput>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedLoadDetail {
    version: u32,
    flow_id: String,
    flow_name: String,
    started_at_ms: u64,
    finished_at_ms: u64,
    passed: bool,
    summary: RecordedLoadRunSummary,
    metrics: Vec<RecordedLoadMetric>,
    thresholds: Vec<RecordedLoadThreshold>,
    samples: Vec<RecordedLoadSample>,
    omitted_samples: u64,
}

/// Runs de flow do workspace, um registro por execução (`alcy-flow-runs.json`
/// como índice + `alcy-flow-runs/<id>.json` como detalhe), com escrita atômica
/// e poda por retenção — mesmo desenho do histórico de requisições, em
/// arquivos separados para não tocar o formato dele.
pub struct FlowRunHistoryStore {
    manifest_path: PathBuf,
    detail_dir: PathBuf,
    retention: Duration,
}

impl FlowRunHistoryStore {
    pub fn new(root: PathBuf, retention: Duration) -> Self {
        Self {
            manifest_path: root.join(MANIFEST_FILE_NAME),
            detail_dir: root.join(DETAIL_DIR_NAME),
            retention,
        }
    }

    /// Resumo de cada run, mais recente primeiro, sem abrir nenhum detalhe.
    pub fn load_summaries(&self) -> Result<Vec<FlowRunSummary>, StorageError> {
        Ok(self
            .load_index()?
            .into_iter()
            .filter(|entry| entry.kind == FlowRunKind::Standard)
            .map(|entry| FlowRunSummary {
                id: entry.id,
                flow_name: entry.flow_name,
                started_at: from_millis(entry.started_at_ms),
                finished_at: from_millis(entry.finished_at_ms),
                status: entry.status,
            })
            .collect())
    }

    /// Resumos de carga, mais recentes primeiro, sem abrir os relatórios.
    pub fn load_load_summaries(&self) -> Result<Vec<LoadFlowRunSummary>, StorageError> {
        Ok(self
            .load_index()?
            .into_iter()
            .filter_map(|entry| {
                if entry.kind != FlowRunKind::Load {
                    return None;
                }
                let load = entry.load?;
                Some(LoadFlowRunSummary {
                    id: entry.id,
                    flow_id: load.flow_id,
                    flow_name: entry.flow_name,
                    started_at: from_millis(entry.started_at_ms),
                    finished_at: from_millis(entry.finished_at_ms),
                    status: entry.status,
                    passed: load.passed,
                    requests: load.requests,
                    failed_requests: load.failed_requests,
                })
            })
            .collect())
    }

    /// `Ok(None)` quando `id` não está no índice (ou não tem formato de id).
    pub fn load_record(&self, id: &str) -> Result<Option<FlowRunRecord>, StorageError> {
        if !is_valid_id(id)
            || !self
                .load_index()?
                .iter()
                .any(|entry| entry.id == id && entry.kind == FlowRunKind::Standard)
        {
            return Ok(None);
        }

        let path = self.detail_path(id);
        let raw = fs::read_to_string(&path).map_err(|error| {
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

        Ok(Some(FlowRunRecord {
            id: id.to_string(),
            flow: flow_from_persisted(detail.flow)?,
            started_at: from_millis(detail.started_at_ms),
            finished_at: from_millis(detail.finished_at_ms),
            cancelled: detail.cancelled,
            events: detail.events,
            outputs: detail.outputs,
        }))
    }

    /// Carrega somente o detalhe de uma execução de carga identificada no
    /// índice v2. IDs de runs normais não expõem nem desserializam este formato.
    pub fn load_load_record(&self, id: &str) -> Result<Option<LoadFlowRunRecord>, StorageError> {
        if !is_valid_id(id)
            || !self
                .load_index()?
                .iter()
                .any(|entry| entry.id == id && entry.kind == FlowRunKind::Load)
        {
            return Ok(None);
        }

        let raw = fs::read_to_string(self.detail_path(id)).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                StorageError::NotFound(format!("detalhe do run de carga não encontrado: {id}"))
            } else {
                StorageError::Read(error.to_string())
            }
        })?;
        let detail: PersistedLoadDetail = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if detail.version != DETAIL_VERSION {
            return Err(StorageError::UnsupportedVersion(detail.version));
        }

        Ok(Some(LoadFlowRunRecord {
            id: id.to_string(),
            flow_id: detail.flow_id,
            flow_name: detail.flow_name,
            started_at: from_millis(detail.started_at_ms),
            finished_at: from_millis(detail.finished_at_ms),
            passed: detail.passed,
            summary: detail.summary,
            metrics: detail.metrics,
            thresholds: detail.thresholds,
            samples: detail.samples,
            omitted_samples: detail.omitted_samples,
        }))
    }

    /// Grava o detalhe, põe o resumo no início do índice e poda os runs mais
    /// antigos que a retenção (índice e arquivo de detalhe).
    pub fn record(&self, record: &FlowRunRecord) -> Result<(), StorageError> {
        if !is_valid_id(&record.id) {
            return Err(StorageError::Write(format!(
                "id de run inválido: {}",
                record.id
            )));
        }

        let mut index = self.load_index()?;

        let detail = PersistedDetail {
            version: DETAIL_VERSION,
            flow: persisted_from_flow(&record.flow),
            cancelled: record.cancelled,
            started_at_ms: to_millis(record.started_at),
            finished_at_ms: to_millis(record.finished_at),
            events: record.events.clone(),
            outputs: record.outputs.clone(),
        };
        let json = serde_json::to_string(&detail)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        write_atomic(&self.detail_path(&record.id), &json)?;

        index.insert(
            0,
            PersistedIndexEntry {
                id: record.id.clone(),
                flow_name: record.flow.name().to_string(),
                started_at_ms: to_millis(record.started_at),
                finished_at_ms: to_millis(record.finished_at),
                status: record.status(),
                kind: FlowRunKind::Standard,
                load: None,
            },
        );

        self.write_retained(index, true)
    }

    /// Grava um relatório de carga no mesmo índice versionado dos flows
    /// normais. Somente os agregados e a amostra já limitada são persistidos.
    pub fn record_load(&self, record: &LoadFlowRunRecord) -> Result<(), StorageError> {
        if !is_valid_id(&record.id) {
            return Err(StorageError::Write(format!(
                "id de run inválido: {}",
                record.id
            )));
        }

        let mut index = self.load_index()?;
        let detail = PersistedLoadDetail {
            version: DETAIL_VERSION,
            flow_id: record.flow_id.clone(),
            flow_name: record.flow_name.clone(),
            started_at_ms: to_millis(record.started_at),
            finished_at_ms: to_millis(record.finished_at),
            passed: record.passed,
            summary: record.summary,
            metrics: record.metrics.clone(),
            thresholds: record.thresholds.clone(),
            samples: record.samples.clone(),
            omitted_samples: record.omitted_samples,
        };
        let json = serde_json::to_string(&detail)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        write_atomic(&self.detail_path(&record.id), &json)?;

        index.insert(
            0,
            PersistedIndexEntry {
                id: record.id.clone(),
                flow_name: record.flow_name.clone(),
                started_at_ms: to_millis(record.started_at),
                finished_at_ms: to_millis(record.finished_at),
                status: record.status(),
                kind: FlowRunKind::Load,
                load: Some(PersistedLoadIndex {
                    flow_id: record.flow_id.clone(),
                    passed: record.passed,
                    requests: record.summary.requests,
                    failed_requests: record.summary.failed_requests,
                }),
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
            // Best-effort: a entrada já saiu do índice, então um arquivo
            // órfão nunca mais é referenciado.
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
        if !matches!(manifest.version, 1 | MANIFEST_VERSION) {
            return Err(StorageError::UnsupportedVersion(manifest.version));
        }

        Ok(manifest.entries)
    }

    fn detail_path(&self, id: &str) -> PathBuf {
        self.detail_dir.join(format!("{id}.json"))
    }
}

/// O id vira nome de arquivo: só o alfabeto que o backend gera, para que um id
/// vindo do frontend nunca escape do diretório de detalhes.
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
    use alcy_domain::{FlowEdge, FlowNode, FlowNodeKind, FlowPosition};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-flow-runs-test-{nanos}-{count}"))
    }

    fn week() -> Duration {
        Duration::from_secs(7 * 24 * 60 * 60)
    }

    fn record(id: &str, started_at: SystemTime, events: Vec<RecordedFlowEvent>) -> FlowRunRecord {
        let flow = Flow::new(
            id,
            "Meu flow",
            vec![
                FlowNode {
                    id: "start".to_string(),
                    kind: FlowNodeKind::Start,
                    position: FlowPosition { x: 0.0, y: 0.0 },
                },
                FlowNode {
                    id: "req".to_string(),
                    kind: FlowNodeKind::Request {
                        request_id: "r1".to_string(),
                    },
                    position: FlowPosition { x: 10.0, y: 5.0 },
                },
            ],
            vec![FlowEdge {
                id: "e1".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "req".to_string(),
                source_handle: None,
            }],
            started_at,
            started_at,
        )
        .unwrap();

        FlowRunRecord {
            id: id.to_string(),
            flow,
            started_at,
            finished_at: started_at,
            cancelled: false,
            events,
            outputs: vec![RecordedNodeOutput {
                node_id: "req".to_string(),
                status_code: 200,
                duration_ms: 12,
                size_bytes: 2,
                headers: vec![("a".to_string(), "b".to_string())],
                body: "{}".to_string(),
                base64: false,
                truncated: false,
                request: None,
            }],
        }
    }

    fn event(node_id: &str, kind: RecordedEventKind) -> RecordedFlowEvent {
        RecordedFlowEvent {
            at_ms: 1,
            node_id: node_id.to_string(),
            kind,
        }
    }

    fn now_ms_precision() -> SystemTime {
        from_millis(to_millis(SystemTime::now()))
    }

    fn load_record(id: &str, started_at: SystemTime) -> LoadFlowRunRecord {
        LoadFlowRunRecord {
            id: id.to_string(),
            flow_id: "flow-load".to_string(),
            flow_name: "Carga".to_string(),
            started_at,
            finished_at: started_at + Duration::from_millis(20),
            passed: false,
            summary: RecordedLoadRunSummary {
                completed_iterations: 3,
                requests: 4,
                failed_requests: 1,
                checks_passed: 2,
                checks_failed: 1,
                ..RecordedLoadRunSummary::default()
            },
            metrics: vec![RecordedLoadMetric {
                name: "http_req_duration".to_string(),
                tags: vec![("status".to_string(), "200".to_string())],
                kind: "trend".to_string(),
                count: 3,
                value: 0.0,
                average: Some(12.0),
                minimum: Some(4.0),
                maximum: Some(20.0),
                p90: Some(18.0),
                p95: Some(19.0),
                p99: Some(20.0),
            }],
            thresholds: vec![RecordedLoadThreshold {
                metric: "http_req_failed".to_string(),
                tags: vec![],
                statistic: "rate".to_string(),
                comparison: "lessThan".to_string(),
                target: 0.1,
                actual: Some(0.25),
                passed: false,
            }],
            samples: vec![RecordedLoadSample {
                scenario_id: "scenario".to_string(),
                vu_id: 1,
                node_id: "request".to_string(),
                method: "GET".to_string(),
                status: Some(500),
                failed: true,
                duration_ms: 20,
            }],
            omitted_samples: 9,
        }
    }

    #[test]
    fn record_then_load_round_trips_a_run() {
        let root = temp_root();
        let store = FlowRunHistoryStore::new(root.clone(), week());
        let run = record(
            "run-1",
            now_ms_precision(),
            vec![
                event("req", RecordedEventKind::NodeStarted),
                event(
                    "req",
                    RecordedEventKind::Succeeded {
                        status_code: 200,
                        duration_ms: 12,
                    },
                ),
            ],
        );

        store.record(&run).unwrap();

        assert_eq!(store.load_record("run-1").unwrap(), Some(run));
        let summaries = store.load_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].flow_name, "Meu flow");
        assert_eq!(summaries[0].status, FlowRunStatus::Completed);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn records_load_reports_in_the_v2_index_without_exposing_them_as_standard_runs() {
        let root = temp_root();
        let store = FlowRunHistoryStore::new(root.clone(), week());
        let started_at = now_ms_precision();
        let standard = record("standard", started_at, vec![]);
        let load = load_record("load", started_at + Duration::from_millis(1));

        store.record(&standard).unwrap();
        store.record_load(&load).unwrap();

        assert_eq!(store.load_record("load").unwrap(), None);
        assert_eq!(store.load_load_record("standard").unwrap(), None);
        assert_eq!(store.load_load_record("load").unwrap(), Some(load));
        assert_eq!(store.load_summaries().unwrap().len(), 1);
        let summaries = store.load_load_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].flow_id, "flow-load");
        assert_eq!(summaries[0].status, FlowRunStatus::Failed);

        let manifest = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(manifest.contains("\"version\":2"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn status_is_failed_when_a_node_failed_and_cancelled_takes_precedence() {
        let failed_events = vec![event(
            "req",
            RecordedEventKind::Failed {
                message: "boom".to_string(),
            },
        )];
        let mut run = record("run-1", now_ms_precision(), failed_events);
        assert_eq!(run.status(), FlowRunStatus::Failed);

        run.cancelled = true;
        assert_eq!(run.status(), FlowRunStatus::Cancelled);
    }

    #[test]
    fn newest_run_is_listed_first_and_old_runs_are_pruned() {
        let root = temp_root();
        let store = FlowRunHistoryStore::new(root.clone(), week());
        let old = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);

        store.record(&record("old", old, vec![])).unwrap();
        store
            .record(&record("mid", now_ms_precision(), vec![]))
            .unwrap();
        store
            .record(&record("new", now_ms_precision(), vec![]))
            .unwrap();

        let ids: Vec<_> = store
            .load_summaries()
            .unwrap()
            .into_iter()
            .map(|summary| summary.id)
            .collect();
        assert_eq!(ids, vec!["new", "mid"]);
        assert!(!store.detail_path("old").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_drops_runs_outside_a_shorter_retention() {
        let root = temp_root();
        FlowRunHistoryStore::new(root.clone(), week())
            .record(&record("run-1", now_ms_precision(), vec![]))
            .unwrap();

        let disabled = FlowRunHistoryStore::new(root.clone(), Duration::ZERO);
        disabled.prune().unwrap();

        assert!(disabled.load_summaries().unwrap().is_empty());
        assert!(!disabled.detail_path("run-1").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_record_ignores_unknown_and_path_like_ids() {
        let root = temp_root();
        let store = FlowRunHistoryStore::new(root.clone(), week());
        store
            .record(&record("run-1", now_ms_precision(), vec![]))
            .unwrap();

        assert_eq!(store.load_record("missing").unwrap(), None);
        assert_eq!(store.load_record("../alcy-flow-runs").unwrap(), None);

        fs::remove_dir_all(&root).ok();
    }
}
