//! Load flow validation and execution preview.
//!
//! This module only knows the canonical graph and the pure `alcy-load`
//! scheduler. It opens no connections and has no Tauri dependency, so the
//! preview can feed both UI confirmation and the subsequent executor.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use alcy_domain::{
    Endpoint, Flow, FlowExecutionKind, FlowNodeKind, HeaderEntry, HttpMethod, LoadNodeKind,
    RedirectPolicy,
};
use alcy_load::{LoadExecutor, LoadSchedule, LoadStage};
use serde::Deserialize;
use thiserror::Error;

use crate::{
    LoadMetricKind, LoadMetricSelector, LoadMetricStatistic, LoadThreshold, LoadThresholdComparison,
};

#[derive(Debug, Clone, PartialEq)]
pub struct LoadScenarioPreview {
    pub node_id: String,
    pub label: String,
    pub peak_vus: u32,
    pub duration_ms: Option<u64>,
    pub peak_arrival_rate_per_second: Option<f64>,
    pub request_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadFlowPreview {
    pub scenarios: Vec<LoadScenarioPreview>,
    pub destinations: Vec<String>,
    pub peak_vus: u32,
    pub duration_ms: Option<u64>,
    pub peak_arrival_rate_per_second: Option<f64>,
}

/// Legacy name of the canonical plan, preserved for existing consumers.
pub type LoadFlowPlan = alcy_load::LoadPlan;

/// Dataset rows read and validated by the workspace adapter, by `assetId`.
/// The compiler accepts injected rows and never opens files.
pub type LoadDatasetAssets = BTreeMap<String, Arc<[BTreeMap<String, String>]>>;

pub use alcy_load::{
    LoadCheckPlan, LoadDatasetPlan, LoadExtractKind, LoadExtractPlan, LoadIterationAction,
    LoadLifecyclePlan, LoadMetricPlan, LoadRequestPlan, LoadScenarioPlan, LoadScriptPhase,
    LoadScriptPlan, LoadSelectOperator, LoadSessionPlan, LoadStep, LoadTimerKind, LoadTimerPlan,
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LoadFlowError {
    #[error("limites de execução de carga: {message}")]
    ExecutionLimits { message: String },
    #[error("flow não é de carga")]
    NotLoadFlow,
    #[error("flow de carga não tem cenário")]
    MissingScenario,
    #[error("cenário '{node_id}' tem configuração inválida: {message}")]
    InvalidScenarioConfig { node_id: String, message: String },
    #[error("request de carga '{node_id}' tem configuração inválida: {message}")]
    InvalidRequestConfig { node_id: String, message: String },
    #[error("check de carga '{node_id}' tem configuração inválida: {message}")]
    InvalidCheckConfig { node_id: String, message: String },
    #[error("métrica de carga '{node_id}' tem configuração inválida: {message}")]
    InvalidMetricConfig { node_id: String, message: String },
    #[error("threshold de carga '{node_id}' tem configuração inválida: {message}")]
    InvalidThresholdConfig { node_id: String, message: String },
    #[error("corpo do cenário '{scenario_id}' é inválido: {message}")]
    InvalidScenarioBody {
        scenario_id: String,
        message: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioConfig {
    executor: String,
    vus: Option<u32>,
    iterations: Option<u64>,
    iterations_per_vu: Option<u64>,
    max_duration_ms: Option<u64>,
    duration_ms: Option<u64>,
    start_vus: Option<u32>,
    graceful_ramp_down_ms: Option<u64>,
    rate: Option<u32>,
    start_rate: Option<u32>,
    time_unit_ms: Option<u64>,
    pre_allocated_vus: Option<u32>,
    max_vus: Option<u32>,
    #[serde(default)]
    stages: Vec<ScenarioStageConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhaseConfig {
    phase: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LifecycleConfig {
    phase: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioStageConfig {
    target: u32,
    duration_ms: u64,
}

#[derive(Debug, Deserialize)]
struct LoadRequestConfig {
    method: String,
    url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(default)]
    headers: Vec<LoadHeaderConfig>,
    #[serde(default)]
    #[serde(rename = "redirectPolicy")]
    redirect_policy: Option<String>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct LoadCheckConfig {
    name: String,
    status: u16,
}

#[derive(Debug, Deserialize)]
struct LoadMetricConfig {
    name: String,
    kind: String,
    value: f64,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct LoadThresholdConfig {
    metric: String,
    #[serde(default)]
    tags: BTreeMap<String, String>,
    statistic: String,
    comparison: String,
    target: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadTimerConfig {
    #[serde(default = "fixed_timer_kind")]
    kind: String,
    duration_ms: Option<u64>,
    min_duration_ms: Option<u64>,
    max_duration_ms: Option<u64>,
    mean_ms: Option<u64>,
    standard_deviation_ms: Option<u64>,
    period_ms: Option<u64>,
}

fn fixed_timer_kind() -> String {
    "fixed".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadSessionConfig {
    #[serde(default)]
    headers: Vec<LoadHeaderConfig>,
    cookies_enabled: Option<bool>,
    #[serde(default)]
    variables: BTreeMap<String, String>,
    #[serde(default)]
    required_variables: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatasetConfig {
    rows: Option<Vec<BTreeMap<String, String>>>,
    asset_id: Option<String>,
    #[serde(default)]
    recycle: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoadExtractConfig {
    name: String,
    #[serde(default = "json_pointer_extract_kind")]
    kind: String,
    json_pointer: Option<String>,
    pattern: Option<String>,
    group: Option<usize>,
    expression: Option<String>,
    selector: Option<String>,
    attribute: Option<String>,
}

fn json_pointer_extract_kind() -> String {
    "jsonPointer".into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoadScriptConfig {
    phase: String,
    code: String,
}

#[derive(Debug, Deserialize)]
struct LoadHeaderConfig {
    name: String,
    value: String,
    #[serde(default = "enabled_header")]
    enabled: bool,
}

fn enabled_header() -> bool {
    true
}

/// Produce the canonical preview, including body and lifecycle destinations.
pub fn preview_load_flow(flow: &Flow) -> Result<LoadFlowPreview, LoadFlowError> {
    preview_load_flow_with_datasets(flow, &BTreeMap::new())
}

/// Preview with workspace datasets already resolved by the adapter.
pub fn preview_load_flow_with_datasets(
    flow: &Flow,
    datasets: &LoadDatasetAssets,
) -> Result<LoadFlowPreview, LoadFlowError> {
    let plan = plan_load_flow_with_datasets(flow, datasets)?;
    plan.validate_ready()
        .map_err(|error| plan_error_for_flow(flow, error))?;
    let configured_variables = plan.configured_variables();
    let mut destinations = BTreeSet::new();
    let mut peak_vus = 0_u32;
    let mut peak_arrival_rate_per_second = 0.0_f64;
    let mut has_arrival_rate = false;
    let mut duration_ms = Some(0_u64);
    let mut scenarios = Vec::with_capacity(plan.scenarios.len());

    for lifecycle in plan.setup.iter().chain(&plan.teardown) {
        let mut requests = Vec::new();
        collect_body_requests(&lifecycle.body, &mut requests);
        for request in requests {
            destinations.insert(
                request
                    .resolve_endpoint(&configured_variables)
                    .map_err(|error| plan_error_for_flow(flow, error))?
                    .url()
                    .to_string(),
            );
        }
    }

    for scenario in plan.scenarios {
        for request in scenario.request_plans() {
            destinations.insert(
                request
                    .resolve_endpoint(&configured_variables)
                    .map_err(|error| plan_error_for_flow(flow, error))?
                    .url()
                    .to_string(),
            );
        }
        peak_vus = peak_vus.saturating_add(scenario.schedule.maximum_vus());
        if let Some(rate) = scenario.schedule.maximum_arrival_rate_per_second() {
            peak_arrival_rate_per_second += rate;
            has_arrival_rate = true;
        }
        duration_ms = match (duration_ms, scenario.schedule.scheduled_end()) {
            (Some(current), Some(duration)) => Some(current.max(duration.as_millis() as u64)),
            _ => None,
        };
        let request_count = scenario.request_plans().len();
        scenarios.push(LoadScenarioPreview {
            node_id: scenario.node_id,
            label: scenario.label,
            peak_vus: scenario.schedule.maximum_vus(),
            duration_ms: scenario
                .schedule
                .scheduled_end()
                .map(|value| value.as_millis() as u64),
            peak_arrival_rate_per_second: scenario.schedule.maximum_arrival_rate_per_second(),
            request_count,
        });
    }
    if let Some(duration) = &mut duration_ms {
        for lifecycle in plan.setup.iter().chain(&plan.teardown) {
            *duration = duration.saturating_add(lifecycle.timeout.as_millis() as u64);
        }
    }

    Ok(LoadFlowPreview {
        scenarios,
        destinations: destinations.into_iter().collect(),
        peak_vus,
        duration_ms,
        peak_arrival_rate_per_second: has_arrival_rate.then_some(peak_arrival_rate_per_second),
    })
}

/// Compile delimited bodies; reject sharing, cycles and unrepresentable
/// effects before confirmation or execution.
pub fn plan_load_flow(flow: &Flow) -> Result<LoadFlowPlan, LoadFlowError> {
    plan_load_flow_with_datasets(flow, &BTreeMap::new())
}

/// Compile a flow with caller-loaded datasets. At this workspace/runner
/// boundary, `alcy-load` only receives rows.
pub fn plan_load_flow_with_datasets(
    flow: &Flow,
    datasets: &LoadDatasetAssets,
) -> Result<LoadFlowPlan, LoadFlowError> {
    if flow.execution_kind() != FlowExecutionKind::Load {
        return Err(LoadFlowError::NotLoadFlow);
    }

    let nodes: HashMap<&str, &FlowNodeKind> = flow
        .nodes()
        .iter()
        .map(|node| (node.id.as_str(), &node.kind))
        .collect();
    let scenarios = flow
        .nodes()
        .iter()
        .filter_map(|flow_node| match &flow_node.kind {
            FlowNodeKind::Load { node: load_node } if load_node.kind == LoadNodeKind::Scenario => {
                Some((
                    flow_node.id.as_str(),
                    load_node.label.as_str(),
                    load_node.config.as_str(),
                ))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if scenarios.is_empty() {
        return Err(LoadFlowError::MissingScenario);
    }

    let mut planned_scenarios = Vec::with_capacity(scenarios.len());
    let mut compiler = BodyCompiler::new(flow, &nodes, datasets);
    let mut setup = None;
    let mut teardown = None;
    // Legacy imports share the whole entry between scenarios. Each consumer
    // receives its own body/state; partial tails and sharing between nested
    // bodies remain forbidden.
    let mut root_bodies: HashMap<&str, Vec<LoadStep>> = HashMap::new();
    for (id, _, _) in &scenarios {
        compiler.visited.insert(id);
    }

    for (scenario_id, label, config) in scenarios {
        if compiler.next(scenario_id, Some("done"))?.is_some() {
            return Err(compiler.error(
                scenario_id,
                "saída done do cenário não admite efeitos; use phase para lifecycle",
            ));
        }
        let first = compiler.next(scenario_id, Some("iteration"))?;
        let body = match first.and_then(|id| root_bodies.get(id)) {
            Some(body) => body.clone(),
            None => {
                let body = compiler.chain(first, 0)?;
                if let Some(id) = first {
                    root_bodies.insert(id, body.clone());
                }
                body
            }
        };
        let phase: PhaseConfig = serde_json::from_str(config)
            .map_err(|error| compiler.error(scenario_id, error.to_string()))?;
        match phase.phase.as_deref().unwrap_or("scenario") {
            "setup" | "teardown" => {
                let config: LifecycleConfig = serde_json::from_str(config)
                    .map_err(|error| compiler.error(scenario_id, error.to_string()))?;
                let target = if config.phase == "setup" {
                    &mut setup
                } else {
                    &mut teardown
                };
                if target.is_some() {
                    return Err(
                        compiler.error(scenario_id, "apenas um corpo por fase de lifecycle")
                    );
                }
                *target = Some(LoadLifecyclePlan {
                    node_id: scenario_id.into(),
                    body,
                    timeout: Duration::from_millis(config.timeout_ms.unwrap_or(60_000)),
                });
                continue;
            }
            "scenario" => {}
            other => {
                return Err(compiler.error(scenario_id, format!("phase não suportada: {other}")));
            }
        }
        let schedule = parse_schedule(scenario_id, config)?;
        let (requests, body) = match legacy_requests(&body) {
            Some(requests) => (requests, Vec::new()),
            None => (Vec::new(), body),
        };
        planned_scenarios.push(LoadScenarioPlan {
            node_id: scenario_id.to_string(),
            label: label.to_string(),
            schedule,
            requests,
            body,
        });
    }

    for flow_node in flow.nodes() {
        if let FlowNodeKind::Load { node } = &flow_node.kind {
            if node.kind == LoadNodeKind::Threshold {
                if flow
                    .edges()
                    .iter()
                    .any(|edge| edge.source_node_id == flow_node.id)
                {
                    return Err(compiler.error(
                        &flow_node.id,
                        "saídas de threshold ainda não executam corpos",
                    ));
                }
            } else if !compiler.visited.contains(flow_node.id.as_str()) {
                return Err(
                    compiler.error(&flow_node.id, "bloco de carga fora de um corpo executável")
                );
            }
        }
    }
    for edge in flow.edges() {
        if matches!(
            nodes.get(edge.target_node_id.as_str()),
            Some(FlowNodeKind::Load { .. })
        ) && !matches!(
            nodes.get(edge.source_node_id.as_str()),
            Some(FlowNodeKind::Load { .. })
        ) {
            let allowed = matches!(
                nodes.get(edge.source_node_id.as_str()),
                Some(FlowNodeKind::Start)
            ) && matches!(nodes.get(edge.target_node_id.as_str()), Some(FlowNodeKind::Load { node }) if node.kind == LoadNodeKind::Scenario);
            if !allowed {
                return Err(
                    compiler.error(&edge.target_node_id, "entrada externa em corpo delimitado")
                );
            }
        }
    }

    let thresholds = flow
        .nodes()
        .iter()
        .filter_map(|flow_node| match &flow_node.kind {
            FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Threshold => {
                Some(parse_threshold(&flow_node.id, &node.config))
            }
            _ => None,
        })
        .collect::<Result<Vec<_>, _>>()?;

    let plan = LoadFlowPlan {
        setup,
        teardown,
        scenarios: planned_scenarios,
        thresholds,
    };
    plan.validate()
        .map_err(|error| plan_error_for_flow(flow, error))?;
    Ok(plan)
}

fn collect_body_requests<'a>(body: &'a [LoadStep], requests: &mut Vec<&'a LoadRequestPlan>) {
    for step in body {
        if let LoadStep::Request(request) = step {
            requests.push(request);
        }
        collect_body_requests(step.body(), requests);
    }
}

fn plan_error_for_flow(flow: &Flow, error: alcy_load::LoadPlanError) -> LoadFlowError {
    match error {
        error @ (alcy_load::LoadPlanError::ResourceLimit { .. }
        | alcy_load::LoadPlanError::InvalidLimits { .. }) => LoadFlowError::ExecutionLimits {
            message: error.to_string(),
        },
        alcy_load::LoadPlanError::MissingScenario => LoadFlowError::MissingScenario,
        alcy_load::LoadPlanError::Scenario { id, message } => LoadFlowError::InvalidScenarioBody {
            scenario_id: id,
            message,
        },
        alcy_load::LoadPlanError::Request { id, message } => LoadFlowError::InvalidRequestConfig {
            node_id: id,
            message,
        },
        alcy_load::LoadPlanError::Metric { id, message } => LoadFlowError::InvalidMetricConfig {
            node_id: id,
            message,
        },
        alcy_load::LoadPlanError::Threshold { index, message } => {
            let node_id = flow.nodes().iter().filter(|node| {
                matches!(&node.kind, FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Threshold)
            }).nth(index).map(|node| node.id.clone()).unwrap_or_default();
            LoadFlowError::InvalidThresholdConfig { node_id, message }
        }
    }
}

fn parse_schedule(node_id: &str, raw: &str) -> Result<LoadSchedule, LoadFlowError> {
    let config: ScenarioConfig =
        serde_json::from_str(raw).map_err(|error| LoadFlowError::InvalidScenarioConfig {
            node_id: node_id.to_string(),
            message: format!("JSON inválido: {error}"),
        })?;
    let required = |value: Option<u32>, field: &str| {
        value.ok_or_else(|| LoadFlowError::InvalidScenarioConfig {
            node_id: node_id.to_string(),
            message: format!("campo '{field}' é obrigatório"),
        })
    };
    let required_u64 = |value: Option<u64>, field: &str| {
        value.ok_or_else(|| LoadFlowError::InvalidScenarioConfig {
            node_id: node_id.to_string(),
            message: format!("campo '{field}' é obrigatório"),
        })
    };
    let duration =
        |value: Option<u64>, field: &str| required_u64(value, field).map(Duration::from_millis);
    let stages = || {
        config
            .stages
            .iter()
            .map(|stage| LoadStage {
                target: stage.target,
                duration: Duration::from_millis(stage.duration_ms),
            })
            .collect::<Vec<_>>()
    };

    let executor = match config.executor.as_str() {
        "sharedIterations" => LoadExecutor::SharedIterations {
            vus: required(config.vus, "vus")?,
            iterations: required_u64(config.iterations, "iterations")?,
            max_duration: config.max_duration_ms.map(Duration::from_millis),
        },
        "perVuIterations" => LoadExecutor::PerVuIterations {
            vus: required(config.vus, "vus")?,
            iterations_per_vu: required_u64(config.iterations_per_vu, "iterationsPerVu")?,
            max_duration: config.max_duration_ms.map(Duration::from_millis),
        },
        "constantVus" => LoadExecutor::ConstantVus {
            vus: required(config.vus, "vus")?,
            duration: duration(config.duration_ms, "durationMs")?,
        },
        "rampingVus" => LoadExecutor::RampingVus {
            start_vus: required(config.start_vus, "startVus")?,
            stages: stages(),
            graceful_ramp_down: Duration::from_millis(config.graceful_ramp_down_ms.unwrap_or(0)),
        },
        "constantArrivalRate" => LoadExecutor::ConstantArrivalRate {
            rate: required(config.rate, "rate")?,
            time_unit: duration(config.time_unit_ms, "timeUnitMs")?,
            duration: duration(config.duration_ms, "durationMs")?,
            pre_allocated_vus: required(config.pre_allocated_vus, "preAllocatedVus")?,
            max_vus: config.max_vus,
        },
        "rampingArrivalRate" => LoadExecutor::RampingArrivalRate {
            start_rate: required(config.start_rate, "startRate")?,
            time_unit: duration(config.time_unit_ms, "timeUnitMs")?,
            stages: stages(),
            pre_allocated_vus: required(config.pre_allocated_vus, "preAllocatedVus")?,
            max_vus: config.max_vus,
        },
        other => {
            return Err(LoadFlowError::InvalidScenarioConfig {
                node_id: node_id.to_string(),
                message: format!("executor não suportado: {other}"),
            });
        }
    };
    LoadSchedule::new(executor).map_err(|error| LoadFlowError::InvalidScenarioConfig {
        node_id: node_id.to_string(),
        message: error.to_string(),
    })
}

struct BodyCompiler<'a> {
    nodes: &'a HashMap<&'a str, &'a FlowNodeKind>,
    datasets: &'a LoadDatasetAssets,
    edges: HashMap<(&'a str, Option<&'a str>), Vec<&'a str>>,
    visited: HashSet<&'a str>,
}

impl<'a> BodyCompiler<'a> {
    fn new(
        flow: &'a Flow,
        nodes: &'a HashMap<&'a str, &'a FlowNodeKind>,
        datasets: &'a LoadDatasetAssets,
    ) -> Self {
        let mut edges: HashMap<_, Vec<_>> = HashMap::new();
        for edge in flow.edges() {
            edges
                .entry((edge.source_node_id.as_str(), edge.source_handle.as_deref()))
                .or_default()
                .push(edge.target_node_id.as_str());
        }
        Self {
            nodes,
            datasets,
            edges,
            visited: HashSet::new(),
        }
    }

    fn error(&self, node: &str, message: impl Into<String>) -> LoadFlowError {
        LoadFlowError::InvalidScenarioBody {
            scenario_id: node.to_string(),
            message: message.into(),
        }
    }

    fn next(&self, node: &str, handle: Option<&str>) -> Result<Option<&'a str>, LoadFlowError> {
        match self
            .edges
            .get(&(node, handle))
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            [] => Ok(None),
            [next] => Ok(Some(*next)),
            _ => Err(self.error(node, "saída tem mais de um destino")),
        }
    }

    fn chain(
        &mut self,
        first: Option<&'a str>,
        depth: usize,
    ) -> Result<Vec<LoadStep>, LoadFlowError> {
        if depth > 32 {
            return Err(self.error(first.unwrap_or("body"), "profundidade de corpo excede 32"));
        }
        let mut result = Vec::new();
        let mut current = first;
        while let Some(id) = current {
            if !self.visited.insert(id) {
                return Err(self.error(id, "ciclo ou bloco compartilhado entre corpos"));
            }
            if self.visited.len() > 1024 {
                return Err(self.error(id, "flow excede 1024 blocos executáveis"));
            }
            let Some(FlowNodeKind::Load { node }) = self.nodes.get(id).copied() else {
                return Err(self.error(id, "corpo contém bloco que não é de carga"));
            };
            let step = match node.kind {
                LoadNodeKind::Request => {
                    if self.next(id, Some("failure"))?.is_some() {
                        return Err(self.error(id, "branch failure ainda não é executável"));
                    }
                    LoadStep::Request(parse_request(id, &node.config)?)
                }
                LoadNodeKind::Check => {
                    let check: LoadCheckConfig =
                        serde_json::from_str(&node.config).map_err(|error| {
                            LoadFlowError::InvalidCheckConfig {
                                node_id: id.into(),
                                message: error.to_string(),
                            }
                        })?;
                    if check.name.trim().is_empty() {
                        return Err(self.error(id, "Check exige name"));
                    }
                    LoadStep::Check(LoadCheckPlan {
                        node_id: id.into(),
                        name: check.name,
                        expected_status: check.status,
                    })
                }
                LoadNodeKind::Extract => LoadStep::Extract(parse_extract(id, &node.config)?),
                LoadNodeKind::Script => LoadStep::Script(parse_script(id, &node.config)?),
                LoadNodeKind::Metric => LoadStep::Metric(parse_metric(id, &node.config)?),
                LoadNodeKind::Timer => LoadStep::Timer(parse_timer(id, &node.config)?),
                LoadNodeKind::ConfigureSession => {
                    LoadStep::ConfigureSession(parse_session(id, &node.config)?)
                }
                LoadNodeKind::Dataset => {
                    let config: DatasetConfig =
                        serde_json::from_str(&node.config).map_err(|error| {
                            self.error(
                                id,
                                format!(
                                    "Dataset exige rows resolvidas, sem caminhos externos: {error}"
                                ),
                            )
                        })?;
                    let rows = match (config.rows, config.asset_id) {
                        (Some(rows), None) => Arc::from(rows),
                        (None, Some(asset_id)) => {
                            self.datasets.get(&asset_id).cloned().ok_or_else(|| {
                                self.error(
                                    id,
                                    format!("Dataset assetId '{asset_id}' não foi resolvido"),
                                )
                            })?
                        }
                        _ => {
                            return Err(self
                                .error(id, "Dataset exige exatamente um de 'rows' ou 'assetId'"));
                        }
                    };
                    LoadStep::Dataset(LoadDatasetPlan {
                        node_id: id.into(),
                        rows,
                        recycle: config.recycle,
                    })
                }
                kind if kind.requires_body() && kind != LoadNodeKind::Scenario => {
                    let value: serde_json::Value =
                        serde_json::from_str(&node.config).map_err(|error| {
                            self.error(id, format!("configuração inválida: {error}"))
                        })?;
                    let allowed: &[&str] = match kind {
                        LoadNodeKind::Repeat => &["count"],
                        LoadNodeKind::ForEach => {
                            &["variable", "items", "itemsVariable", "maxItems"]
                        }
                        LoadNodeKind::Select => &["variable", "equals", "operator"],
                        LoadNodeKind::OncePerVu => &[],
                        LoadNodeKind::TimeBox => &["durationMs"],
                        LoadNodeKind::Group => &["name", "tags", "includeTimers", "emitParent"],
                        _ => &[],
                    };
                    let fields = value
                        .as_object()
                        .ok_or_else(|| self.error(id, "configuração deve ser objeto"))?;
                    if let Some(field) = fields
                        .keys()
                        .find(|field| !allowed.contains(&field.as_str()))
                    {
                        return Err(self.error(
                            id,
                            format!("campo '{field}' não é executável neste controlador"),
                        ));
                    }
                    let config: ControllerConfig =
                        serde_json::from_value(value).map_err(|error| {
                            self.error(id, format!("configuração inválida: {error}"))
                        })?;
                    let first = self.next(id, Some("body"))?;
                    if first.is_none() {
                        return Err(self.error(id, "controlador exige corpo"));
                    }
                    let body = self.chain(first, depth + 1)?;
                    let missing = |field| self.error(id, format!("campo '{field}' é obrigatório"));
                    match kind {
                        LoadNodeKind::Repeat => LoadStep::Repeat {
                            node_id: id.into(),
                            count: config.count.ok_or_else(|| missing("count"))?,
                            body,
                        },
                        LoadNodeKind::ForEach => {
                            let has_items = config.items.is_some();
                            let has_items_variable = config.items_variable.is_some();
                            if has_items == has_items_variable {
                                return Err(self.error(
                                    id,
                                    "ForEach exige exatamente um de 'items' ou 'itemsVariable'",
                                ));
                            }
                            LoadStep::ForEach {
                                node_id: id.into(),
                                variable: config.variable.ok_or_else(|| missing("variable"))?,
                                items: config.items.unwrap_or_default(),
                                items_variable: config.items_variable,
                                max_items: config.max_items,
                                body,
                            }
                        }
                        LoadNodeKind::Select => {
                            let operator = match config.operator.as_deref().unwrap_or("equals") {
                                "equals" => LoadSelectOperator::Equals,
                                "notEquals" => LoadSelectOperator::NotEquals,
                                "exists" => LoadSelectOperator::Exists,
                                "notExists" => LoadSelectOperator::NotExists,
                                other => {
                                    return Err(self.error(
                                        id,
                                        format!("operador Select não suportado: {other}"),
                                    ));
                                }
                            };
                            let equals = match operator {
                                LoadSelectOperator::Equals | LoadSelectOperator::NotEquals => {
                                    config.equals.ok_or_else(|| missing("equals"))?
                                }
                                LoadSelectOperator::Exists | LoadSelectOperator::NotExists => {
                                    config.equals.unwrap_or_default()
                                }
                            };
                            LoadStep::Select {
                                node_id: id.into(),
                                variable: config.variable.ok_or_else(|| missing("variable"))?,
                                operator,
                                equals,
                                body,
                            }
                        }
                        LoadNodeKind::OncePerVu => LoadStep::OncePerVu {
                            node_id: id.into(),
                            body,
                        },
                        LoadNodeKind::TimeBox => LoadStep::TimeBox {
                            node_id: id.into(),
                            duration: Duration::from_millis(
                                config.duration_ms.ok_or_else(|| missing("durationMs"))?,
                            ),
                            body,
                        },
                        LoadNodeKind::Group => LoadStep::Group {
                            node_id: id.into(),
                            name: config.name.unwrap_or_else(|| node.label.clone()),
                            tags: config.tags,
                            include_timers: config.include_timers.unwrap_or(true),
                            emit_parent: config.emit_parent.unwrap_or(true),
                            body,
                        },
                        _ => return Err(self.error(id, "controlador não executável")),
                    }
                }
                _ => {
                    return Err(self.error(
                        id,
                        format!("bloco '{}' ainda não é executável no corpo", node.label),
                    ));
                }
            };
            let handle = match node.kind {
                LoadNodeKind::Request => Some("success"),
                kind if kind.requires_body() => Some("done"),
                _ => None,
            };
            result.push(step);
            current = self.next(id, handle)?;
        }
        Ok(result)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControllerConfig {
    count: Option<u64>,
    variable: Option<String>,
    items: Option<Vec<String>>,
    items_variable: Option<String>,
    max_items: Option<usize>,
    equals: Option<String>,
    operator: Option<String>,
    duration_ms: Option<u64>,
    name: Option<String>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
    include_timers: Option<bool>,
    emit_parent: Option<bool>,
}

fn parse_request(id: &str, raw: &str) -> Result<LoadRequestPlan, LoadFlowError> {
    let invalid = |message| LoadFlowError::InvalidRequestConfig {
        node_id: id.into(),
        message,
    };
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| invalid(format!("JSON inválido: {error}")))?;
    let scheme = value
        .get("url")
        .and_then(serde_json::Value::as_str)
        .and_then(|url| url.split_once("://"))
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    let protocol = value.get("protocol").and_then(serde_json::Value::as_str);
    if protocol == Some("grpc")
        || value.get("grpc").is_some_and(|grpc| !grpc.is_null())
        || matches!(scheme.as_deref(), Some("grpc" | "grpcs"))
    {
        return Err(invalid(
            "gRPC não é suportado em testes de carga; use uma requisição HTTP.".into(),
        ));
    }
    if protocol == Some("websocket")
        || value
            .get("websocket")
            .is_some_and(|websocket| !websocket.is_null())
        || matches!(scheme.as_deref(), Some("ws" | "wss"))
    {
        return Err(invalid(
            "WebSocket não é suportado em testes de carga; use uma requisição HTTP.".into(),
        ));
    }
    let config: LoadRequestConfig = serde_json::from_value(value)
        .map_err(|error| invalid(format!("JSON inválido: {error}")))?;
    let method = parse_method(id, &config.method)?;
    let endpoint = Endpoint::new(config.url)
        .map_err(|error| invalid(format!("endpoint inválido: {error}")))?;
    let headers = config
        .headers
        .into_iter()
        .map(|header| {
            let header = HeaderEntry::new(header.name, header.value, header.enabled)
                .map_err(|error| invalid(error.to_string()))?;
            header
                .validate_http()
                .map_err(|error| invalid(error.to_string()))?;
            Ok(header)
        })
        .collect::<Result<Vec<_>, LoadFlowError>>()?;
    let redirect_policy = match config.redirect_policy.as_deref().unwrap_or("follow") {
        "follow" => RedirectPolicy::Follow,
        "manual" => RedirectPolicy::Manual,
        other => return Err(invalid(format!("redirectPolicy não suportada: {other}"))),
    };
    Ok(LoadRequestPlan {
        node_id: id.into(),
        method,
        endpoint,
        body: config.body.unwrap_or_default(),
        timeout: config.timeout_ms.map(Duration::from_millis),
        headers,
        redirect_policy,
        tags: config.tags,
        before: Vec::new(),
        checks: Vec::new(),
        metrics: Vec::new(),
    })
}

fn parse_extract(id: &str, raw: &str) -> Result<LoadExtractPlan, LoadFlowError> {
    let config: LoadExtractConfig =
        serde_json::from_str(raw).map_err(|error| LoadFlowError::InvalidScenarioBody {
            scenario_id: id.to_string(),
            message: format!("Extract tem JSON inválido: {error}"),
        })?;
    let required = |value: Option<String>, field: &str| {
        value.ok_or_else(|| LoadFlowError::InvalidScenarioBody {
            scenario_id: id.to_string(),
            message: format!("Extract requires '{field}'"),
        })
    };
    let kind = match config.kind.as_str() {
        "jsonPointer" => LoadExtractKind::JsonPointer {
            pointer: required(config.json_pointer, "jsonPointer")?,
        },
        "regex" => LoadExtractKind::Regex {
            pattern: required(config.pattern, "pattern")?,
            group: config.group.unwrap_or(1),
        },
        "xpath" => LoadExtractKind::XPath {
            expression: required(config.expression, "expression")?,
        },
        "css" => LoadExtractKind::Css {
            selector: required(config.selector, "selector")?,
            attribute: config.attribute,
        },
        other => {
            return Err(LoadFlowError::InvalidScenarioBody {
                scenario_id: id.to_string(),
                message: format!("Extract kind '{other}' is not supported"),
            });
        }
    };
    Ok(LoadExtractPlan {
        node_id: id.to_string(),
        name: config.name,
        kind,
    })
}

fn parse_script(id: &str, raw: &str) -> Result<LoadScriptPlan, LoadFlowError> {
    let config: LoadScriptConfig =
        serde_json::from_str(raw).map_err(|error| LoadFlowError::InvalidScenarioBody {
            scenario_id: id.to_string(),
            message: format!("Script tem JSON inválido: {error}"),
        })?;
    let phase = match config.phase.as_str() {
        "preRequest" => LoadScriptPhase::PreRequest,
        "postResponse" => LoadScriptPhase::PostResponse,
        _ => {
            return Err(LoadFlowError::InvalidScenarioBody {
                scenario_id: id.to_string(),
                message: "Script exige phase 'preRequest' ou 'postResponse'".into(),
            });
        }
    };
    Ok(LoadScriptPlan {
        node_id: id.to_string(),
        phase,
        code: config.code,
    })
}

/// Preserve the legacy public shape when the chain has the same semantics.
/// Bodies with controllers or final effects are not flattened.
fn legacy_requests(body: &[LoadStep]) -> Option<Vec<LoadRequestPlan>> {
    let mut requests: Vec<LoadRequestPlan> = Vec::new();
    let mut before = Vec::new();
    for step in body {
        match step {
            LoadStep::Request(request) => {
                let mut request = request.clone();
                request.before = std::mem::take(&mut before);
                requests.push(request);
            }
            LoadStep::Timer(timer) => before.push(LoadIterationAction::Timer(timer.clone())),
            LoadStep::ConfigureSession(session) => {
                before.push(LoadIterationAction::ConfigureSession(session.clone()))
            }
            LoadStep::Check(check) if before.is_empty() => {
                requests.last_mut()?.checks.push(check.clone())
            }
            LoadStep::Metric(metric) if before.is_empty() => {
                requests.last_mut()?.metrics.push(metric.clone())
            }
            _ => return None,
        }
    }
    if requests.is_empty() || !before.is_empty() {
        return None;
    }
    Some(requests)
}

fn parse_timer(node_id: &str, raw: &str) -> Result<LoadTimerPlan, LoadFlowError> {
    let config: LoadTimerConfig =
        serde_json::from_str(raw).map_err(|error| LoadFlowError::InvalidScenarioBody {
            scenario_id: node_id.to_string(),
            message: format!("Timer tem JSON inválido: {error}"),
        })?;
    let required = |value: Option<u64>, name: &str| {
        value.ok_or_else(|| LoadFlowError::InvalidScenarioBody {
            scenario_id: node_id.to_string(),
            message: format!("Timer exige '{name}'"),
        })
    };
    let kind = match config.kind.as_str() {
        "fixed" => LoadTimerKind::Fixed(Duration::from_millis(required(
            config.duration_ms,
            "durationMs",
        )?)),
        "uniform" => {
            let min = Duration::from_millis(required(config.min_duration_ms, "minDurationMs")?);
            let max = Duration::from_millis(required(config.max_duration_ms, "maxDurationMs")?);
            if min > max {
                return Err(LoadFlowError::InvalidScenarioBody {
                    scenario_id: node_id.to_string(),
                    message: "Timer uniform exige minDurationMs <= maxDurationMs".into(),
                });
            }
            LoadTimerKind::Uniform { min, max }
        }
        "gaussian" => LoadTimerKind::Gaussian {
            mean: Duration::from_millis(required(config.mean_ms, "meanMs")?),
            standard_deviation: Duration::from_millis(required(
                config.standard_deviation_ms,
                "standardDeviationMs",
            )?),
        },
        "poisson" => LoadTimerKind::Poisson {
            mean: Duration::from_millis(required(config.mean_ms, "meanMs")?),
        },
        "pacing" => LoadTimerKind::Pacing {
            period: Duration::from_millis(required(config.period_ms, "periodMs")?),
        },
        other => {
            return Err(LoadFlowError::InvalidScenarioBody {
                scenario_id: node_id.to_string(),
                message: format!("Timer '{other}' não é suportado"),
            });
        }
    };
    Ok(LoadTimerPlan {
        node_id: node_id.to_string(),
        kind,
    })
}

fn parse_session(node_id: &str, raw: &str) -> Result<LoadSessionPlan, LoadFlowError> {
    let config: LoadSessionConfig =
        serde_json::from_str(raw).map_err(|error| LoadFlowError::InvalidScenarioBody {
            scenario_id: node_id.to_string(),
            message: format!("ConfigureSession tem JSON inválido: {error}"),
        })?;
    let headers = config
        .headers
        .into_iter()
        .map(|header| {
            HeaderEntry::new(&header.name, &header.value, header.enabled)
                .and_then(|header| {
                    header.validate_http()?;
                    Ok(header)
                })
                .map_err(|error| LoadFlowError::InvalidScenarioBody {
                    scenario_id: node_id.to_string(),
                    message: format!("header inválido: {error}"),
                })
        })
        .collect::<Result<Vec<_>, LoadFlowError>>()?;
    Ok(LoadSessionPlan {
        node_id: node_id.to_string(),
        headers,
        cookies_enabled: config.cookies_enabled,
        variables: config.variables,
        required_variables: config.required_variables,
    })
}

fn parse_metric(node_id: &str, raw: &str) -> Result<LoadMetricPlan, LoadFlowError> {
    let config: LoadMetricConfig =
        serde_json::from_str(raw).map_err(|error| LoadFlowError::InvalidMetricConfig {
            node_id: node_id.to_string(),
            message: format!("JSON inválido: {error}"),
        })?;
    if config.name.trim().is_empty() {
        return Err(LoadFlowError::InvalidMetricConfig {
            node_id: node_id.to_string(),
            message: "name é obrigatório".to_string(),
        });
    }
    if !config.value.is_finite() {
        return Err(LoadFlowError::InvalidMetricConfig {
            node_id: node_id.to_string(),
            message: "value precisa ser finito".to_string(),
        });
    }
    let kind = match config.kind.as_str() {
        "counter" => LoadMetricKind::Counter,
        "gauge" => LoadMetricKind::Gauge,
        "rate" => LoadMetricKind::Rate,
        "trend" => LoadMetricKind::Trend,
        _ => {
            return Err(LoadFlowError::InvalidMetricConfig {
                node_id: node_id.to_string(),
                message: format!("kind não suportado: {}", config.kind),
            });
        }
    };
    if kind == LoadMetricKind::Counter && config.value < 0.0 {
        return Err(LoadFlowError::InvalidMetricConfig {
            node_id: node_id.to_string(),
            message: "counter não aceita value negativo".to_string(),
        });
    }
    if kind == LoadMetricKind::Rate && !matches!(config.value, 0.0 | 1.0) {
        return Err(LoadFlowError::InvalidMetricConfig {
            node_id: node_id.to_string(),
            message: "rate aceita somente value 0 ou 1".to_string(),
        });
    }
    Ok(LoadMetricPlan {
        node_id: node_id.to_string(),
        name: config.name,
        kind,
        value: config.value,
        tags: config.tags,
    })
}

fn parse_threshold(node_id: &str, raw: &str) -> Result<LoadThreshold, LoadFlowError> {
    let config: LoadThresholdConfig =
        serde_json::from_str(raw).map_err(|error| LoadFlowError::InvalidThresholdConfig {
            node_id: node_id.to_string(),
            message: format!("JSON inválido: {error}"),
        })?;
    if config.metric.trim().is_empty() || !config.target.is_finite() {
        return Err(LoadFlowError::InvalidThresholdConfig {
            node_id: node_id.to_string(),
            message: "metric é obrigatório e target precisa ser finito".to_string(),
        });
    }
    let statistic = match config.statistic.as_str() {
        "count" => LoadMetricStatistic::Count,
        "value" => LoadMetricStatistic::Value,
        "rate" => LoadMetricStatistic::Rate,
        "avg" => LoadMetricStatistic::Average,
        "min" => LoadMetricStatistic::Minimum,
        "max" => LoadMetricStatistic::Maximum,
        "p90" => LoadMetricStatistic::P90,
        "p95" => LoadMetricStatistic::P95,
        "p99" => LoadMetricStatistic::P99,
        _ => {
            return Err(LoadFlowError::InvalidThresholdConfig {
                node_id: node_id.to_string(),
                message: format!("statistic não suportada: {}", config.statistic),
            });
        }
    };
    let comparison = match config.comparison.as_str() {
        "lt" => LoadThresholdComparison::LessThan,
        "lte" => LoadThresholdComparison::LessOrEqual,
        "gt" => LoadThresholdComparison::GreaterThan,
        "gte" => LoadThresholdComparison::GreaterOrEqual,
        "eq" => LoadThresholdComparison::Equal,
        "ne" => LoadThresholdComparison::NotEqual,
        _ => {
            return Err(LoadFlowError::InvalidThresholdConfig {
                node_id: node_id.to_string(),
                message: format!("comparison não suportada: {}", config.comparison),
            });
        }
    };
    Ok(LoadThreshold {
        selector: LoadMetricSelector {
            name: config.metric,
            tags: config.tags,
        },
        statistic,
        comparison,
        target: config.target,
    })
}

fn parse_method(node_id: &str, raw: &str) -> Result<HttpMethod, LoadFlowError> {
    let method = match raw.to_ascii_uppercase().as_str() {
        "GET" => HttpMethod::Get,
        "POST" => HttpMethod::Post,
        "PUT" => HttpMethod::Put,
        "PATCH" => HttpMethod::Patch,
        "DELETE" => HttpMethod::Delete,
        "HEAD" => HttpMethod::Head,
        "OPTIONS" => HttpMethod::Options,
        _ => {
            return Err(LoadFlowError::InvalidRequestConfig {
                node_id: node_id.to_string(),
                message: format!("método HTTP não suportado: {raw}"),
            });
        }
    };
    Ok(method)
}

#[cfg(test)]
mod tests {
    use std::time::UNIX_EPOCH;

    use alcy_domain::{FlowEdge, FlowNode, FlowPosition, LoadNode};
    use serde_json::json;

    use super::*;

    fn node(id: &str, kind: LoadNodeKind, config: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::Load {
                node: LoadNode {
                    kind,
                    label: id.to_string(),
                    config: config.to_string(),
                },
            },
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn rejects_grpc_load_requests_before_http_compilation() {
        for config in [
            json!({"protocol":"grpc"}),
            json!({"method":"POST", "url":"https://api.test", "grpc":{"service":"test.Greeter"}}),
            json!({"method":"POST", "url":"grpcs://api.test"}),
            json!({"method":"POST", "url":"grpc://localhost:50051"}),
        ] {
            assert!(
                matches!(parse_request("rpc", &config.to_string()), Err(LoadFlowError::InvalidRequestConfig { node_id, message }) if node_id == "rpc" && message.contains("gRPC"))
            );
        }
    }

    #[test]
    fn rejects_websocket_load_requests_before_http_compilation() {
        for config in [
            json!({"protocol":"websocket"}),
            json!({"method":"GET", "url":"https://api.test", "websocket":{"subprotocols":[]}}),
            json!({"method":"GET", "url":"wss://api.test/socket"}),
            json!({"method":"GET", "url":"WS://localhost:8080"}),
        ] {
            assert!(
                matches!(parse_request("ws", &config.to_string()), Err(LoadFlowError::InvalidRequestConfig { node_id, message }) if node_id == "ws" && message.contains("WebSocket"))
            );
        }
    }

    #[test]
    fn parses_each_timer_distribution_and_rejects_invalid_bounds() {
        assert_eq!(
            parse_timer("timer", r#"{"kind":"fixed","durationMs":10}"#)
                .unwrap()
                .kind,
            LoadTimerKind::Fixed(Duration::from_millis(10)),
        );
        assert_eq!(
            parse_timer(
                "timer",
                r#"{"kind":"uniform","minDurationMs":10,"maxDurationMs":20}"#,
            )
            .unwrap()
            .kind,
            LoadTimerKind::Uniform {
                min: Duration::from_millis(10),
                max: Duration::from_millis(20),
            },
        );
        assert_eq!(
            parse_timer(
                "timer",
                r#"{"kind":"gaussian","meanMs":20,"standardDeviationMs":3}"#,
            )
            .unwrap()
            .kind,
            LoadTimerKind::Gaussian {
                mean: Duration::from_millis(20),
                standard_deviation: Duration::from_millis(3),
            },
        );
        assert!(matches!(
            parse_timer("timer", r#"{"kind":"poisson","meanMs":20}"#),
            Ok(LoadTimerPlan {
                kind: LoadTimerKind::Poisson { .. },
                ..
            })
        ));
        assert!(matches!(
            parse_timer("timer", r#"{"kind":"pacing","periodMs":20}"#),
            Ok(LoadTimerPlan {
                kind: LoadTimerKind::Pacing { .. },
                ..
            })
        ));
        assert!(matches!(
            parse_timer(
                "timer",
                r#"{"kind":"uniform","minDurationMs":20,"maxDurationMs":10}"#,
            ),
            Err(LoadFlowError::InvalidScenarioBody { .. })
        ));
    }

    #[test]
    fn previews_all_six_executors_and_deduplicates_destinations() {
        let configs = [
            json!({"executor":"sharedIterations", "vus": 2, "iterations": 3}),
            json!({"executor":"perVuIterations", "vus": 3, "iterationsPerVu": 2}),
            json!({"executor":"constantVus", "vus": 4, "durationMs": 10}),
            json!({"executor":"rampingVus", "startVus": 1, "stages":[{"target": 5, "durationMs": 10}]}),
            json!({"executor":"constantArrivalRate", "rate": 2, "timeUnitMs": 10, "durationMs": 20, "preAllocatedVus": 1}),
            json!({"executor":"rampingArrivalRate", "startRate": 1, "timeUnitMs": 10, "preAllocatedVus": 2, "stages":[{"target": 3, "durationMs": 10}]}),
        ];
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for (index, config) in configs.into_iter().enumerate() {
            let scenario = format!("scenario-{index}");
            let request = format!("request-{index}");
            nodes.push(node(&scenario, LoadNodeKind::Scenario, config));
            nodes.push(node(
                &request,
                LoadNodeKind::Request,
                json!({"method":"GET", "url":"https://api.example.test/health"}),
            ));
            edges.push(FlowEdge {
                id: format!("edge-{index}"),
                source_node_id: scenario,
                target_node_id: request,
                source_handle: Some("iteration".to_string()),
            });
        }
        let flow = Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            nodes,
            edges,
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();

        let preview = preview_load_flow(&flow).unwrap();
        assert_eq!(preview.scenarios.len(), 6);
        assert_eq!(preview.peak_vus, 17);
        assert_eq!(
            preview.destinations,
            vec!["https://api.example.test/health"]
        );
        assert_eq!(preview.duration_ms, None);
        assert_eq!(preview.peak_arrival_rate_per_second, Some(500.0));
    }

    #[test]
    fn rejects_a_non_load_flow() {
        let flow = Flow::new(
            "standard",
            "Standard",
            Vec::new(),
            Vec::new(),
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();
        assert_eq!(preview_load_flow(&flow), Err(LoadFlowError::NotLoadFlow));
    }

    #[test]
    fn accepts_absent_null_and_empty_bodies_from_existing_imports() {
        for body in [None, Some(serde_json::Value::Null), Some(json!(""))] {
            let mut config = json!({"method":"GET", "url":"https://api.example.test/health"});
            if let Some(body) = body {
                config["body"] = body;
            }
            let flow = Flow::new_with_execution_kind(
                "load",
                "Load",
                FlowExecutionKind::Load,
                vec![
                    node(
                        "scenario",
                        LoadNodeKind::Scenario,
                        json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
                    ),
                    node("request", LoadNodeKind::Request, config),
                ],
                vec![FlowEdge {
                    id: "body".to_string(),
                    source_node_id: "scenario".to_string(),
                    target_node_id: "request".to_string(),
                    source_handle: Some("iteration".to_string()),
                }],
                UNIX_EPOCH,
                UNIX_EPOCH,
            )
            .unwrap();
            assert!(
                plan_load_flow(&flow).unwrap().scenarios[0].requests[0]
                    .body
                    .is_empty()
            );
        }
    }

    #[test]
    fn plan_preserves_request_method_and_body() {
        let flow = Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            vec![
                node(
                    "scenario",
                    LoadNodeKind::Scenario,
                    json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
                ),
                node(
                    "request",
                    LoadNodeKind::Request,
                    json!({"method":"PATCH", "url":"https://api.example.test/job/1", "body":"{\"state\":\"ready\"}", "timeoutMs": 1500}),
                ),
            ],
            vec![FlowEdge {
                id: "edge".to_string(),
                source_node_id: "scenario".to_string(),
                target_node_id: "request".to_string(),
                source_handle: Some("iteration".to_string()),
            }],
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();

        let plan = plan_load_flow(&flow).unwrap();
        assert_eq!(plan.scenarios[0].requests[0].method, HttpMethod::Patch);
        assert_eq!(plan.scenarios[0].requests[0].body, "{\"state\":\"ready\"}");
        assert_eq!(
            plan.scenarios[0].requests[0].timeout,
            Some(Duration::from_millis(1500))
        );
    }

    #[test]
    fn plan_preserves_request_headers_and_metric_tags() {
        let flow = Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            vec![
                node(
                    "scenario",
                    LoadNodeKind::Scenario,
                    json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
                ),
                node(
                    "request",
                    LoadNodeKind::Request,
                    json!({
                        "method":"GET",
                        "url":"https://api.example.test/health",
                        "headers":[{"name":"X-Trace", "value":"run-1"}],
                        "tags":{"operation":"health"},
                    }),
                ),
            ],
            vec![FlowEdge {
                id: "edge".to_string(),
                source_node_id: "scenario".to_string(),
                target_node_id: "request".to_string(),
                source_handle: Some("iteration".to_string()),
            }],
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();

        let plan = plan_load_flow(&flow).unwrap();
        let request = &plan.scenarios[0].requests[0];
        assert_eq!(request.headers[0].name(), "X-Trace");
        assert_eq!(request.headers[0].value(), "run-1");
        assert_eq!(request.tags.get("operation"), Some(&"health".to_string()));
    }

    #[test]
    fn plan_preserves_manual_redirects_and_rejects_unknown_policies() {
        let build = |redirect_policy: &str| {
            Flow::new_with_execution_kind(
                "load",
                "Load",
                FlowExecutionKind::Load,
                vec![
                    node(
                        "scenario",
                        LoadNodeKind::Scenario,
                        json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
                    ),
                    node(
                        "request",
                        LoadNodeKind::Request,
                        json!({"method":"GET", "url":"https://api.example.test/start", "redirectPolicy":redirect_policy}),
                    ),
                ],
                vec![FlowEdge {
                    id: "edge".to_string(),
                    source_node_id: "scenario".to_string(),
                    target_node_id: "request".to_string(),
                    source_handle: Some("iteration".to_string()),
                }],
                UNIX_EPOCH,
                UNIX_EPOCH,
            )
            .unwrap()
        };

        assert_eq!(
            plan_load_flow(&build("manual")).unwrap().scenarios[0].requests[0].redirect_policy,
            RedirectPolicy::Manual
        );
        assert!(matches!(
            plan_load_flow(&build("invalid")),
            Err(LoadFlowError::InvalidRequestConfig { message, .. })
                if message.contains("redirectPolicy")
        ));
    }

    #[test]
    fn plan_attaches_a_check_to_the_preceding_request() {
        let flow = Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            vec![
                node(
                    "scenario",
                    LoadNodeKind::Scenario,
                    json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
                ),
                node(
                    "request",
                    LoadNodeKind::Request,
                    json!({"method":"GET", "url":"https://api.example.test/health"}),
                ),
                node(
                    "check",
                    LoadNodeKind::Check,
                    json!({"name":"status is healthy", "status":200}),
                ),
            ],
            vec![
                FlowEdge {
                    id: "scenario-request".to_string(),
                    source_node_id: "scenario".to_string(),
                    target_node_id: "request".to_string(),
                    source_handle: Some("iteration".to_string()),
                },
                FlowEdge {
                    id: "request-check".to_string(),
                    source_node_id: "request".to_string(),
                    target_node_id: "check".to_string(),
                    source_handle: Some("success".to_string()),
                },
            ],
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();

        let plan = plan_load_flow(&flow).unwrap();
        assert_eq!(plan.scenarios[0].requests[0].checks.len(), 1);
        assert_eq!(plan.scenarios[0].requests[0].checks[0].expected_status, 200);
    }

    #[test]
    fn plan_attaches_session_and_timer_to_the_next_request() {
        let flow = Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            vec![
                node(
                    "scenario",
                    LoadNodeKind::Scenario,
                    json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
                ),
                node(
                    "session",
                    LoadNodeKind::ConfigureSession,
                    json!({"headers":[{"name":"X-Run", "value":"load"}], "cookiesEnabled":false}),
                ),
                node(
                    "timer",
                    LoadNodeKind::Timer,
                    json!({"kind":"fixed", "durationMs":5}),
                ),
                node(
                    "request",
                    LoadNodeKind::Request,
                    json!({"method":"GET", "url":"https://api.example.test/health"}),
                ),
            ],
            vec![
                FlowEdge {
                    id: "scenario-session".to_string(),
                    source_node_id: "scenario".to_string(),
                    target_node_id: "session".to_string(),
                    source_handle: Some("iteration".to_string()),
                },
                FlowEdge {
                    id: "session-timer".to_string(),
                    source_node_id: "session".to_string(),
                    target_node_id: "timer".to_string(),
                    source_handle: None,
                },
                FlowEdge {
                    id: "timer-request".to_string(),
                    source_node_id: "timer".to_string(),
                    target_node_id: "request".to_string(),
                    source_handle: None,
                },
            ],
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();

        let plan = plan_load_flow(&flow).unwrap();
        assert_eq!(plan.scenarios[0].requests[0].before.len(), 2);
        assert!(matches!(
            &plan.scenarios[0].requests[0].before[0],
            LoadIterationAction::ConfigureSession(_)
        ));
        match &plan.scenarios[0].requests[0].before[1] {
            LoadIterationAction::Timer(timer) => {
                assert_eq!(timer.kind, LoadTimerKind::Fixed(Duration::from_millis(5)));
            }
            _ => panic!("ação deveria ser Timer"),
        }
    }

    fn link(source: &str, handle: Option<&str>, target: &str) -> FlowEdge {
        FlowEdge {
            id: format!("{source}-{target}"),
            source_node_id: source.into(),
            target_node_id: target.into(),
            source_handle: handle.map(str::to_string),
        }
    }

    fn structured_flow(nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) -> Flow {
        Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            nodes,
            edges,
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap()
    }

    fn scenario_node(id: &str) -> FlowNode {
        node(
            id,
            LoadNodeKind::Scenario,
            json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
        )
    }

    fn request_node(id: &str) -> FlowNode {
        node(
            id,
            LoadNodeKind::Request,
            json!({"method":"GET", "url":format!("https://api.example.test/{id}")}),
        )
    }

    #[test]
    fn compiles_nested_bodies_with_a_separate_done_continuation_and_final_timer() {
        let flow = structured_flow(
            vec![
                scenario_node("scenario"),
                node("repeat", LoadNodeKind::Repeat, json!({"count":3})),
                node(
                    "group",
                    LoadNodeKind::Group,
                    json!({"name":"inner", "tags":{"scope":"group"}}),
                ),
                request_node("request"),
                node(
                    "metric",
                    LoadNodeKind::Metric,
                    json!({"name":"events", "kind":"counter", "value":1}),
                ),
                node("final", LoadNodeKind::Timer, json!({"durationMs":2})),
            ],
            vec![
                link("scenario", Some("iteration"), "repeat"),
                link("repeat", Some("body"), "group"),
                link("group", Some("body"), "request"),
                link("group", Some("done"), "metric"),
                link("repeat", Some("done"), "final"),
            ],
        );
        let p = plan_load_flow(&flow).unwrap();
        assert!(p.scenarios[0].requests.is_empty());
        let LoadStep::Repeat { count, body, .. } = &p.scenarios[0].body[0] else {
            panic!("Repeat esperado")
        };
        assert_eq!(*count, 3);
        assert!(
            matches!(&body[0], LoadStep::Group { body, .. } if matches!(&body[0], LoadStep::Request(_)))
        );
        assert!(matches!(&body[1], LoadStep::Metric(_)));
        assert!(matches!(&p.scenarios[0].body[1], LoadStep::Timer(_)));
        assert_eq!(
            preview_load_flow(&flow).unwrap().destinations,
            ["https://api.example.test/request"]
        );
    }

    #[test]
    fn compiles_each_declarative_controller_and_rejects_unused_config_fields() {
        for (kind, config) in [
            (LoadNodeKind::Repeat, json!({"count":2})),
            (
                LoadNodeKind::ForEach,
                json!({"variable":"item", "items":["a","b"]}),
            ),
            (
                LoadNodeKind::Select,
                json!({"variable":"item", "equals":"a"}),
            ),
            (LoadNodeKind::OncePerVu, json!({})),
            (LoadNodeKind::TimeBox, json!({"durationMs":5})),
            (LoadNodeKind::Group, json!({"name":"work"})),
        ] {
            let edges = vec![
                link("scenario", Some("iteration"), "control"),
                link("control", Some("body"), "request"),
            ];
            let build = |config| {
                structured_flow(
                    vec![
                        scenario_node("scenario"),
                        node("control", kind, config),
                        request_node("request"),
                    ],
                    edges.clone(),
                )
            };
            assert!(plan_load_flow(&build(config.clone())).is_ok());
            let mut wrong = config;
            wrong["unsupported"] = json!(true);
            assert!(matches!(
                plan_load_flow(&build(wrong)),
                Err(LoadFlowError::InvalidScenarioBody { .. })
            ));
        }
    }

    #[test]
    fn compiles_bounded_dynamic_foreach_and_rejects_ambiguous_sources() {
        let build = |config| {
            structured_flow(
                vec![
                    scenario_node("scenario"),
                    node("each", LoadNodeKind::ForEach, config),
                    request_node("request"),
                ],
                vec![
                    link("scenario", Some("iteration"), "each"),
                    link("each", Some("body"), "request"),
                ],
            )
        };
        let flow = build(json!({
            "variable":"item",
            "itemsVariable":"preparedItems",
            "maxItems":3,
        }));
        let plan = plan_load_flow(&flow).unwrap();
        assert!(matches!(
            &plan.scenarios[0].body[0],
            LoadStep::ForEach {
                items,
                items_variable: Some(variable),
                max_items: Some(3),
                ..
            } if items.is_empty() && variable == "preparedItems"
        ));

        for config in [
            json!({"variable":"item"}),
            json!({"variable":"item", "items":["one"], "itemsVariable":"preparedItems", "maxItems":3}),
        ] {
            assert!(matches!(
                plan_load_flow(&build(config)),
                Err(LoadFlowError::InvalidScenarioBody { .. })
            ));
        }
    }

    #[test]
    fn compiles_select_operators_with_equals_backwards_compatible() {
        let build = |config| {
            structured_flow(
                vec![
                    scenario_node("scenario"),
                    node("select", LoadNodeKind::Select, config),
                    request_node("request"),
                ],
                vec![
                    link("scenario", Some("iteration"), "select"),
                    link("select", Some("body"), "request"),
                ],
            )
        };
        let legacy = plan_load_flow(&build(json!({"variable":"value", "equals":"ok"}))).unwrap();
        assert!(matches!(
            &legacy.scenarios[0].body[0],
            LoadStep::Select {
                operator: LoadSelectOperator::Equals,
                equals,
                ..
            } if equals == "ok"
        ));

        let exists =
            plan_load_flow(&build(json!({"variable":"value", "operator":"exists"}))).unwrap();
        assert!(matches!(
            &exists.scenarios[0].body[0],
            LoadStep::Select {
                operator: LoadSelectOperator::Exists,
                equals,
                ..
            } if equals.is_empty()
        ));
        assert!(plan_load_flow(&build(json!({"variable":"value", "operator":"invalid"}))).is_err());
    }

    #[test]
    fn compiles_group_transaction_options_with_safe_defaults() {
        let build = |config| {
            structured_flow(
                vec![
                    scenario_node("scenario"),
                    node("group", LoadNodeKind::Group, config),
                    request_node("request"),
                ],
                vec![
                    link("scenario", Some("iteration"), "group"),
                    link("group", Some("body"), "request"),
                ],
            )
        };
        let defaults = plan_load_flow(&build(json!({"name":"work"}))).unwrap();
        assert!(matches!(
            &defaults.scenarios[0].body[0],
            LoadStep::Group {
                include_timers: true,
                emit_parent: true,
                ..
            }
        ));

        let configured = plan_load_flow(&build(json!({
            "name":"work",
            "includeTimers":false,
            "emitParent":false,
        })))
        .unwrap();
        assert!(matches!(
            &configured.scenarios[0].body[0],
            LoadStep::Group {
                include_timers: false,
                emit_parent: false,
                ..
            }
        ));
    }

    #[test]
    fn lifecycle_has_distinct_phases_and_preview_includes_all_destinations_and_timeouts() {
        let nodes = vec![
            node(
                "setup",
                LoadNodeKind::Scenario,
                json!({"phase":"setup", "timeoutMs":5}),
            ),
            request_node("prepare"),
            node(
                "scenario",
                LoadNodeKind::Scenario,
                json!({"executor":"constantVus", "vus":1, "durationMs":10}),
            ),
            request_node("job"),
            node(
                "teardown",
                LoadNodeKind::Scenario,
                json!({"phase":"teardown", "timeoutMs":7}),
            ),
            request_node("finish"),
        ];
        let flow = structured_flow(
            nodes.clone(),
            vec![
                link("setup", Some("iteration"), "prepare"),
                link("scenario", Some("iteration"), "job"),
                link("teardown", Some("iteration"), "finish"),
            ],
        );
        let p = plan_load_flow(&flow).unwrap();
        assert_eq!(p.scenarios.len(), 1);
        assert_eq!(p.setup.unwrap().node_id, "setup");
        assert_eq!(p.teardown.unwrap().node_id, "teardown");
        let preview = preview_load_flow(&flow).unwrap();
        assert_eq!(preview.duration_ms, Some(22));
        assert_eq!(preview.destinations.len(), 3);
        let mut duplicate = nodes;
        duplicate.push(node(
            "setup-2",
            LoadNodeKind::Scenario,
            json!({"phase":"setup"}),
        ));
        duplicate.push(request_node("prepare-2"));
        let mut edges = flow.edges().to_vec();
        edges.push(link("setup-2", Some("iteration"), "prepare-2"));
        assert!(plan_load_flow(&structured_flow(duplicate, edges)).is_err());
    }

    #[test]
    fn entire_legacy_body_can_be_reused_but_partial_tails_cannot() {
        let nodes = vec![
            scenario_node("first"),
            scenario_node("second"),
            request_node("a"),
            request_node("b"),
        ];
        let build = |second_entry| {
            structured_flow(
                nodes.clone(),
                vec![
                    link("first", Some("iteration"), "a"),
                    link("second", Some("iteration"), second_entry),
                    link("a", Some("success"), "b"),
                ],
            )
        };
        let p = plan_load_flow(&build("a")).unwrap();
        assert_eq!(p.scenarios.len(), 2);
        assert!(p.scenarios.iter().all(|s| s.requests.len() == 2));
        assert!(matches!(
            plan_load_flow(&build("b")),
            Err(LoadFlowError::InvalidScenarioBody { .. })
        ));
    }

    #[test]
    fn rejects_a_body_that_escapes_into_done_a_cycle_or_an_external_entry() {
        let nodes = vec![
            scenario_node("scenario"),
            node("repeat", LoadNodeKind::Repeat, json!({"count":2})),
            request_node("inner"),
            request_node("outside"),
        ];
        let edges = vec![
            link("scenario", Some("iteration"), "repeat"),
            link("repeat", Some("body"), "inner"),
            link("repeat", Some("done"), "outside"),
        ];
        for target in ["outside", "inner", "repeat"] {
            let mut invalid = edges.clone();
            invalid.push(link("inner", Some("success"), target));
            assert!(plan_load_flow(&structured_flow(nodes.clone(), invalid)).is_err());
        }
        let mut nodes = nodes;
        nodes.push(FlowNode {
            id: "start".into(),
            kind: FlowNodeKind::Start,
            position: FlowPosition { x: 0.0, y: 0.0 },
        });
        let mut edges = edges;
        edges.push(link("start", None, "inner"));
        assert!(plan_load_flow(&structured_flow(nodes, edges)).is_err());
    }

    #[test]
    fn rejects_unsupported_blocks_or_effect_branches_instead_of_ignoring_them() {
        let flow = structured_flow(
            vec![
                scenario_node("scenario"),
                request_node("request"),
                node(
                    "unsupported",
                    LoadNodeKind::Script,
                    json!({"phase":"before"}),
                ),
            ],
            vec![link("scenario", Some("iteration"), "request")],
        );
        assert!(plan_load_flow(&flow).is_err());
        let flow = structured_flow(
            vec![
                scenario_node("scenario"),
                request_node("request"),
                request_node("failure"),
            ],
            vec![
                link("scenario", Some("iteration"), "request"),
                link("request", Some("failure"), "failure"),
            ],
        );
        assert!(plan_load_flow(&flow).is_err());
    }

    #[test]
    fn compiles_extract_kinds_with_strict_configs() {
        let build = |config| {
            structured_flow(
                vec![
                    scenario_node("scenario"),
                    request_node("request"),
                    node("extract", LoadNodeKind::Extract, config),
                ],
                vec![
                    link("scenario", Some("iteration"), "request"),
                    link("request", Some("success"), "extract"),
                ],
            )
        };
        let plan =
            plan_load_flow(&build(json!({"name":"userId", "jsonPointer":"/user/id"}))).unwrap();
        assert!(matches!(
            &plan.scenarios[0].body[1],
            LoadStep::Extract(extract)
                if extract.name == "userId"
                    && matches!(
                        &extract.kind,
                        LoadExtractKind::JsonPointer { pointer } if pointer == "/user/id"
                    )
        ));
        for config in [
            json!({"name":"token", "kind":"regex", "pattern":"token=(\\w+)", "group":1}),
            json!({"name":"title", "kind":"xpath", "expression":"//title/text()"}),
            json!({"name":"href", "kind":"css", "selector":"a.link", "attribute":"href"}),
        ] {
            assert!(plan_load_flow(&build(config)).is_ok());
        }
        assert!(
            plan_load_flow(&build(
                json!({"name":"userId", "jsonPointer":"/id", "extra":true})
            ))
            .is_err()
        );
        assert!(plan_load_flow(&build(json!({"name":"token", "kind":"regex"}))).is_err());
    }

    #[test]
    fn compiles_script_with_an_explicit_phase() {
        let flow = structured_flow(
            vec![
                scenario_node("scenario"),
                node(
                    "script",
                    LoadNodeKind::Script,
                    json!({"phase":"preRequest", "code":"al.runtime.set('token', 'ok');"}),
                ),
                request_node("request"),
            ],
            vec![
                link("scenario", Some("iteration"), "script"),
                link("script", None, "request"),
            ],
        );
        let plan = plan_load_flow(&flow).unwrap();
        assert!(matches!(
            &plan.scenarios[0].body[0],
            LoadStep::Script(script) if script.phase == LoadScriptPhase::PreRequest
        ));
        let invalid = structured_flow(
            vec![
                scenario_node("scenario"),
                node(
                    "script",
                    LoadNodeKind::Script,
                    json!({"phase":"invalid", "code":""}),
                ),
            ],
            vec![link("scenario", Some("iteration"), "script")],
        );
        assert!(plan_load_flow(&invalid).is_err());
    }

    #[test]
    fn dataset_accepts_inline_rows_or_pre_resolved_assets() {
        let build = |config| {
            structured_flow(
                vec![
                    scenario_node("scenario"),
                    node("dataset", LoadNodeKind::Dataset, config),
                    request_node("request"),
                ],
                vec![
                    link("scenario", Some("iteration"), "dataset"),
                    link("dataset", None, "request"),
                ],
            )
        };
        let p = plan_load_flow(&build(
            json!({"rows":[{"key":"one"},{"key":"two"}], "recycle":true}),
        ))
        .unwrap();
        assert!(matches!(&p.scenarios[0].body[0], LoadStep::Dataset(data) if data.rows.len() == 2));
        assert!(plan_load_flow(&build(json!({"assetId":"../outside.csv"}))).is_err());
        let assets = BTreeMap::from([(
            "dataset.csv".to_string(),
            Arc::from(vec![BTreeMap::from([(
                "key".to_string(),
                "asset".to_string(),
            )])]),
        )]);
        let plan = plan_load_flow_with_datasets(&build(json!({"assetId":"dataset.csv"})), &assets)
            .unwrap();
        assert!(
            matches!(&plan.scenarios[0].body[0], LoadStep::Dataset(data) if data.rows[0]["key"] == "asset")
        );
    }
}
