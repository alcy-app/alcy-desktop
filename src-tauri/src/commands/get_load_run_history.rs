//! Leitura paginada de resultados de carga. O detalhe não traz corpos de
//! resposta, e as amostras ficam em outro command para manter o IPC pequeno.

use std::path::PathBuf;

use alcy_storage::{
    FlowRunHistoryStore, LoadFlowRunRecord, RecordedLoadMetric, RecordedLoadSample,
    RecordedLoadThreshold,
};
use serde::Serialize;

use crate::commands::general_settings::HistoryPreferencesState;
use crate::commands::history::{GetHistoryEntryInput, HistoryCommandError};

/// Uma página pequena previne que o inspector ou a lista de resultados faça o
/// frontend alocar proporcionalmente à taxa do teste.
const MAX_LOAD_SAMPLE_PAGE_SIZE: usize = 100;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadRunSummaryDto {
    pub cancelled: bool,
    pub completed_iterations: u64,
    pub dropped_iterations: u64,
    pub requests: u64,
    pub failed_requests: u64,
    pub checks_passed: u64,
    pub checks_failed: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadMetricDto {
    pub name: String,
    pub tags: Vec<(String, String)>,
    pub kind: String,
    pub count: u64,
    pub value: f64,
    pub average: Option<f64>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub p90: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadThresholdDto {
    pub metric: String,
    pub tags: Vec<(String, String)>,
    pub statistic: String,
    pub comparison: String,
    pub target: f64,
    pub actual: Option<f64>,
    pub passed: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadRunSampleDto {
    pub scenario_id: String,
    pub vu_id: u32,
    pub node_id: String,
    pub method: String,
    pub status: Option<u16>,
    pub failed: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadRunDetailDto {
    pub id: String,
    pub flow_id: String,
    pub flow_name: String,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub passed: bool,
    pub summary: LoadRunSummaryDto,
    pub metrics: Vec<LoadMetricDto>,
    pub thresholds: Vec<LoadThresholdDto>,
    pub sample_count: usize,
    pub omitted_samples: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLoadRunSamplesInput {
    pub root_path: String,
    pub id: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_page_size")]
    pub limit: usize,
}

fn default_page_size() -> usize {
    50
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadRunSamplesPageDto {
    pub samples: Vec<LoadRunSampleDto>,
    pub offset: usize,
    pub total: usize,
    pub next_offset: Option<usize>,
}

/// Lê o relatório agregado de uma execução de carga.
#[tauri::command]
pub async fn get_load_run_history(
    input: GetHistoryEntryInput,
    history: tauri::State<'_, HistoryPreferencesState>,
) -> Result<LoadRunDetailDto, HistoryCommandError> {
    let retention = history.get().retention.duration();
    let result =
        run_blocking(move || load_record(PathBuf::from(input.root_path), &input.id, retention))
            .await
            .map(load_detail_from_record);
    crate::logging::logged("alcy::history", "abrir histórico de carga", result)
}

/// Lê uma página de amostras já limitada pelo executor. O limite solicitado é
/// truncado no backend, de modo que um chamador malformado não amplia o IPC.
#[tauri::command]
pub async fn get_load_run_samples(
    input: GetLoadRunSamplesInput,
    history: tauri::State<'_, HistoryPreferencesState>,
) -> Result<LoadRunSamplesPageDto, HistoryCommandError> {
    let limit = input.limit.clamp(1, MAX_LOAD_SAMPLE_PAGE_SIZE);
    let offset = input.offset;
    let retention = history.get().retention.duration();
    let result =
        run_blocking(move || load_record(PathBuf::from(input.root_path), &input.id, retention))
            .await
            .map(|record| samples_page(&record.samples, offset, limit));
    crate::logging::logged("alcy::history", "listar amostras de carga", result)
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, HistoryCommandError> + Send + 'static,
) -> Result<T, HistoryCommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(HistoryCommandError::Storage {
                message: error.to_string(),
            })
        })
}

fn load_record(
    root: PathBuf,
    id: &str,
    retention: std::time::Duration,
) -> Result<LoadFlowRunRecord, HistoryCommandError> {
    FlowRunHistoryStore::new(root, retention)
        .load_load_record(id)?
        .ok_or(HistoryCommandError::NotFound)
}

fn millis(value: std::time::SystemTime) -> u64 {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::ZERO)
        .as_millis() as u64
}

fn load_detail_from_record(record: LoadFlowRunRecord) -> LoadRunDetailDto {
    LoadRunDetailDto {
        id: record.id,
        flow_id: record.flow_id,
        flow_name: record.flow_name,
        started_at_ms: millis(record.started_at),
        finished_at_ms: millis(record.finished_at),
        passed: record.passed,
        summary: LoadRunSummaryDto {
            cancelled: record.summary.cancelled,
            completed_iterations: record.summary.completed_iterations,
            dropped_iterations: record.summary.dropped_iterations,
            requests: record.summary.requests,
            failed_requests: record.summary.failed_requests,
            checks_passed: record.summary.checks_passed,
            checks_failed: record.summary.checks_failed,
        },
        metrics: record.metrics.iter().map(metric_from_recorded).collect(),
        thresholds: record
            .thresholds
            .iter()
            .map(threshold_from_recorded)
            .collect(),
        sample_count: record.samples.len(),
        omitted_samples: record.omitted_samples,
    }
}

fn metric_from_recorded(metric: &RecordedLoadMetric) -> LoadMetricDto {
    LoadMetricDto {
        name: metric.name.clone(),
        tags: metric.tags.clone(),
        kind: metric.kind.clone(),
        count: metric.count,
        value: metric.value,
        average: metric.average,
        minimum: metric.minimum,
        maximum: metric.maximum,
        p90: metric.p90,
        p95: metric.p95,
        p99: metric.p99,
    }
}

fn threshold_from_recorded(threshold: &RecordedLoadThreshold) -> LoadThresholdDto {
    LoadThresholdDto {
        metric: threshold.metric.clone(),
        tags: threshold.tags.clone(),
        statistic: threshold.statistic.clone(),
        comparison: threshold.comparison.clone(),
        target: threshold.target,
        actual: threshold.actual,
        passed: threshold.passed,
    }
}

fn sample_from_recorded(sample: &RecordedLoadSample) -> LoadRunSampleDto {
    LoadRunSampleDto {
        scenario_id: sample.scenario_id.clone(),
        vu_id: sample.vu_id,
        node_id: sample.node_id.clone(),
        method: sample.method.clone(),
        status: sample.status,
        failed: sample.failed,
        duration_ms: sample.duration_ms,
    }
}

fn samples_page(
    samples: &[RecordedLoadSample],
    offset: usize,
    limit: usize,
) -> LoadRunSamplesPageDto {
    let total = samples.len();
    let start = offset.min(total);
    let end = start.saturating_add(limit).min(total);
    LoadRunSamplesPageDto {
        samples: samples[start..end]
            .iter()
            .map(sample_from_recorded)
            .collect(),
        offset: start,
        total,
        next_offset: (end < total).then_some(end),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> RecordedLoadSample {
        RecordedLoadSample {
            scenario_id: "scenario".to_string(),
            vu_id: 1,
            node_id: id.to_string(),
            method: "GET".to_string(),
            status: Some(200),
            failed: false,
            duration_ms: 4,
        }
    }

    #[test]
    fn samples_are_read_in_bounded_pages() {
        let values = vec![sample("one"), sample("two"), sample("three")];

        let first = samples_page(&values, 0, 2);
        assert_eq!(first.total, 3);
        assert_eq!(first.offset, 0);
        assert_eq!(first.next_offset, Some(2));
        assert_eq!(first.samples[1].node_id, "two");

        let final_page = samples_page(&values, 2, 2);
        assert_eq!(final_page.samples.len(), 1);
        assert_eq!(final_page.next_offset, None);
    }
}
