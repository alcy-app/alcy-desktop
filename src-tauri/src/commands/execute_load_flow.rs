use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use alcy_app::{
    LoadExecutionError, LoadMetricKind, LoadMetricSnapshot, LoadMetricStatistic, LoadRequestSample,
    LoadRunProgress, LoadRunSink, LoadRunSummary, LoadThresholdComparison, LoadThresholdResult,
    execute_load_plan_report as run_load_plan_report, plan_load_flow_with_datasets,
};
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{
    FlowRunHistoryStore, FlowStore, LoadFlowRunRecord, RecordedLoadMetric, RecordedLoadRunSummary,
    RecordedLoadSample, RecordedLoadThreshold,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::commands::flow_execution_registry::{FlowExecutionRegistry, WatchCancellation};
use crate::commands::general_settings::HistoryPreferencesState;
use crate::commands::load_dataset_assets::resolve_load_dataset_assets;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteLoadFlowInput {
    pub load_run_id: String,
    pub root_path: String,
    pub flow_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoadRunEventDto {
    Progress {
        active_vus: u32,
        planned_vus: u32,
        completed_iterations: u64,
        dropped_iterations: u64,
        requests: u64,
        failed_requests: u64,
        checks_passed: u64,
        checks_failed: u64,
        elapsed_ms: u64,
    },
    ScenarioFinished {
        scenario_id: String,
        cancelled: bool,
        completed_iterations: u64,
        dropped_iterations: u64,
        requests: u64,
        failed_requests: u64,
        checks_passed: u64,
        checks_failed: u64,
    },
    RunFinished {
        cancelled: bool,
        passed: bool,
        completed_iterations: u64,
        dropped_iterations: u64,
        requests: u64,
        failed_requests: u64,
        checks_passed: u64,
        checks_failed: u64,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecuteLoadFlowError {
    NotFound,
    Invalid { message: String },
    Storage { message: String },
}

struct ChannelSink<'a> {
    channel: &'a Channel<LoadRunEventDto>,
    samples: Mutex<LoadSamples>,
}

/// Amostras são só para o histórico. O teto impede que uma taxa alta faça a
/// memória do desktop ou o detalhe persistido crescer proporcionalmente.
const MAX_LOAD_RUN_SAMPLES: usize = 500;

#[derive(Default)]
struct LoadSamples {
    values: Vec<RecordedLoadSample>,
    omitted: u64,
}

impl ChannelSink<'_> {
    fn take_samples(&self) -> LoadSamples {
        let mut samples = self
            .samples
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *samples)
    }
}

impl LoadRunSink for ChannelSink<'_> {
    fn progress(&self, snapshot: LoadRunProgress) {
        let _ = self.channel.send(LoadRunEventDto::Progress {
            active_vus: snapshot.active_vus,
            planned_vus: snapshot.planned_vus,
            completed_iterations: snapshot.completed_iterations,
            dropped_iterations: snapshot.dropped_iterations,
            requests: snapshot.requests,
            failed_requests: snapshot.failed_requests,
            checks_passed: snapshot.checks_passed,
            checks_failed: snapshot.checks_failed,
            elapsed_ms: snapshot.elapsed.as_millis() as u64,
        });
    }

    fn scenario_finished(&self, scenario_id: &str, summary: LoadRunSummary) {
        let _ = self.channel.send(LoadRunEventDto::ScenarioFinished {
            scenario_id: scenario_id.to_string(),
            cancelled: summary.cancelled,
            completed_iterations: summary.completed_iterations,
            dropped_iterations: summary.dropped_iterations,
            requests: summary.requests,
            failed_requests: summary.failed_requests,
            checks_passed: summary.checks_passed,
            checks_failed: summary.checks_failed,
        });
    }

    fn request_finished(&self, sample: LoadRequestSample) {
        let mut samples = self
            .samples
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if samples.values.len() < MAX_LOAD_RUN_SAMPLES {
            samples.values.push(RecordedLoadSample {
                scenario_id: sample.scenario_id,
                vu_id: sample.vu_id,
                node_id: sample.node_id,
                method: sample.method,
                status: sample.status,
                failed: sample.failed,
                duration_ms: sample.duration_ms,
            });
        } else {
            samples.omitted = samples.omitted.saturating_add(1);
        }
    }
}

/// Executa um flow de carga persistido. O flow é relido do workspace pelo ID,
/// em vez de receber o canvas pelo IPC, para que a confirmação e a execução
/// usem o mesmo artefato salvo. O channel só recebe agregados limitados.
#[tauri::command]
pub async fn execute_load_flow(
    input: ExecuteLoadFlowInput,
    on_event: Channel<LoadRunEventDto>,
    flow_registry: tauri::State<'_, FlowExecutionRegistry>,
    rest_executor: tauri::State<'_, ReqwestRestExecutor>,
    history: tauri::State<'_, HistoryPreferencesState>,
) -> Result<(), ExecuteLoadFlowError> {
    let root = PathBuf::from(&input.root_path);
    let snapshot =
        FlowStore::new(root.clone())
            .load()
            .map_err(|error| ExecuteLoadFlowError::Storage {
                message: error.to_string(),
            })?;
    let flow = snapshot
        .flows
        .iter()
        .find(|flow| flow.id == input.flow_id)
        .cloned()
        .ok_or(ExecuteLoadFlowError::NotFound)?;
    let datasets = resolve_load_dataset_assets(&root, &flow).map_err(|error| {
        ExecuteLoadFlowError::Invalid {
            message: error.to_string(),
        }
    })?;
    let plan = plan_load_flow_with_datasets(&flow, &datasets).map_err(|error| {
        ExecuteLoadFlowError::Invalid {
            message: error.to_string(),
        }
    })?;

    let registry_id = load_registry_id(&input.load_run_id);
    let (sender, receiver) = watch::channel(false);
    flow_registry.register(registry_id.clone(), sender);
    let cancellation = WatchCancellation(receiver);
    let sink = ChannelSink {
        channel: &on_event,
        samples: Mutex::new(LoadSamples::default()),
    };
    let started_at = SystemTime::now();
    let retention = history.get().retention.duration();

    let result = run_load_plan_report(&plan, &*rest_executor, &sink, &cancellation).await;
    flow_registry.remove(&registry_id);

    match result {
        Ok(report) => {
            let samples = sink.take_samples();
            let record = LoadFlowRunRecord {
                id: input.load_run_id.clone(),
                flow_id: input.flow_id,
                flow_name: flow.name().to_string(),
                started_at,
                finished_at: SystemTime::now(),
                passed: report.passed,
                summary: recorded_summary(report.summary),
                metrics: report.metrics.iter().map(recorded_metric).collect(),
                thresholds: report.thresholds.iter().map(recorded_threshold).collect(),
                samples: samples.values,
                omitted_samples: samples.omitted,
            };
            let root_path = PathBuf::from(input.root_path);
            tauri::async_runtime::spawn_blocking(move || {
                FlowRunHistoryStore::new(root_path, retention).record_load(&record)
            })
            .await
            .map_err(|error| ExecuteLoadFlowError::Storage {
                message: error.to_string(),
            })?
            .map_err(|error| ExecuteLoadFlowError::Storage {
                message: error.to_string(),
            })?;
            let _ = on_event.send(LoadRunEventDto::RunFinished {
                cancelled: report.summary.cancelled,
                passed: report.passed,
                completed_iterations: report.summary.completed_iterations,
                dropped_iterations: report.summary.dropped_iterations,
                requests: report.summary.requests,
                failed_requests: report.summary.failed_requests,
                checks_passed: report.summary.checks_passed,
                checks_failed: report.summary.checks_failed,
            });
            Ok(())
        }
        Err(error) => Err(execution_error(error)),
    }
}

fn recorded_summary(summary: LoadRunSummary) -> RecordedLoadRunSummary {
    RecordedLoadRunSummary {
        cancelled: summary.cancelled,
        completed_iterations: summary.completed_iterations,
        dropped_iterations: summary.dropped_iterations,
        requests: summary.requests,
        failed_requests: summary.failed_requests,
        checks_passed: summary.checks_passed,
        checks_failed: summary.checks_failed,
    }
}

fn recorded_metric(metric: &LoadMetricSnapshot) -> RecordedLoadMetric {
    RecordedLoadMetric {
        name: metric.selector.name.clone(),
        tags: metric
            .selector
            .tags
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        kind: metric_kind_to_str(metric.kind).to_string(),
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

fn recorded_threshold(threshold: &LoadThresholdResult) -> RecordedLoadThreshold {
    RecordedLoadThreshold {
        metric: threshold.threshold.selector.name.clone(),
        tags: threshold
            .threshold
            .selector
            .tags
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        statistic: metric_statistic_to_str(threshold.threshold.statistic).to_string(),
        comparison: threshold_comparison_to_str(threshold.threshold.comparison).to_string(),
        target: threshold.threshold.target,
        actual: threshold.actual,
        passed: threshold.passed,
    }
}

fn metric_kind_to_str(kind: LoadMetricKind) -> &'static str {
    match kind {
        LoadMetricKind::Counter => "counter",
        LoadMetricKind::Gauge => "gauge",
        LoadMetricKind::Rate => "rate",
        LoadMetricKind::Trend => "trend",
    }
}

fn metric_statistic_to_str(statistic: LoadMetricStatistic) -> &'static str {
    match statistic {
        LoadMetricStatistic::Count => "count",
        LoadMetricStatistic::Value => "value",
        LoadMetricStatistic::Rate => "rate",
        LoadMetricStatistic::Average => "average",
        LoadMetricStatistic::Minimum => "minimum",
        LoadMetricStatistic::Maximum => "maximum",
        LoadMetricStatistic::P90 => "p90",
        LoadMetricStatistic::P95 => "p95",
        LoadMetricStatistic::P99 => "p99",
    }
}

fn threshold_comparison_to_str(comparison: LoadThresholdComparison) -> &'static str {
    match comparison {
        LoadThresholdComparison::LessThan => "lessThan",
        LoadThresholdComparison::LessOrEqual => "lessOrEqual",
        LoadThresholdComparison::GreaterThan => "greaterThan",
        LoadThresholdComparison::GreaterOrEqual => "greaterOrEqual",
        LoadThresholdComparison::Equal => "equal",
        LoadThresholdComparison::NotEqual => "notEqual",
    }
}

pub(crate) fn load_registry_id(load_run_id: &str) -> String {
    format!("load:{load_run_id}")
}

fn execution_error(error: LoadExecutionError) -> ExecuteLoadFlowError {
    ExecuteLoadFlowError::Invalid {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn uses_a_separate_registry_namespace_from_standard_flows() {
        assert_eq!(load_registry_id("run-1"), "load:run-1");
    }

    #[test]
    fn serializes_durations_as_milliseconds() {
        let sink_event = LoadRunEventDto::Progress {
            active_vus: 1,
            planned_vus: 1,
            completed_iterations: 0,
            dropped_iterations: 0,
            requests: 0,
            failed_requests: 0,
            checks_passed: 0,
            checks_failed: 0,
            elapsed_ms: Duration::from_millis(12).as_millis() as u64,
        };
        assert!(matches!(
            sink_event,
            LoadRunEventDto::Progress { elapsed_ms: 12, .. }
        ));
    }

    #[test]
    fn persists_metric_and_threshold_names_in_the_ipc_contract_format() {
        assert_eq!(metric_kind_to_str(LoadMetricKind::Trend), "trend");
        assert_eq!(metric_statistic_to_str(LoadMetricStatistic::P95), "p95");
        assert_eq!(
            threshold_comparison_to_str(LoadThresholdComparison::LessOrEqual),
            "lessOrEqual"
        );
    }
}
