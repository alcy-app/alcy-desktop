//! Execução observável de planos de carga, independente de sua fonte.

use std::collections::BTreeMap;
use std::future::pending;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::LoadExecutor;
use alcy_domain::{
    Authentication, ExecutionError, HttpMethod, ProtocolId, Request, RequestDocument,
};
use alcy_scripting::{
    ScriptInput, ScriptPhase, ScriptRequest, ScriptResponse, ScriptVariable, run_script,
};
use futures_util::stream::FuturesUnordered;
use futures_util::{FutureExt, StreamExt};
use regex::Regex;
use scraper::{Html, Selector};
use sxd_document::parser as xml_parser;
use sxd_xpath::{Context as XPathContext, Factory as XPathFactory, Value as XPathValue};
use thiserror::Error;

use crate::{LoadCancellation, LoadTransport};
use crate::{
    LoadExtractKind, LoadIterationAction, LoadLifecyclePlan, LoadMetricError, LoadMetricKind,
    LoadMetricPlan, LoadMetricRegistry, LoadMetricSnapshot, LoadPlan, LoadPlanError,
    LoadRequestPlan, LoadRequestTimings, LoadRunLimits, LoadScenarioPlan, LoadScriptPhase,
    LoadScriptPlan, LoadStep, LoadThresholdResult, LoadTimerKind, LoadTimerPlan, LoadVuState,
};

/// Intervalo mínimo entre snapshots de um cenário. Evita transformar cada
/// request em um evento de IPC quando o sink for conectado ao adapter Tauri.
pub const LOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Granularidade do relógio real usada pelos executores fechados. O formato
/// de agendamento permanece em `alcy-load`; este pulso só acorda o runtime
/// para refletir um novo alvo de VUs sem criar IPC por request.
const CLOSED_SCHEDULER_TICK: Duration = Duration::from_millis(10);
const MAX_EXTRACT_RESPONSE_BYTES: usize = 1024 * 1024;

/// Snapshot agregado e limitado emitido periodicamente pelo executor. Nunca
/// contém corpos de resposta nem um evento por request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LoadRunProgress {
    pub active_vus: u32,
    pub planned_vus: u32,
    pub completed_iterations: u64,
    pub dropped_iterations: u64,
    pub requests: u64,
    pub failed_requests: u64,
    pub checks_passed: u64,
    pub checks_failed: u64,
    pub elapsed: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LoadRunSummary {
    pub cancelled: bool,
    pub completed_iterations: u64,
    pub dropped_iterations: u64,
    pub requests: u64,
    pub failed_requests: u64,
    pub checks_passed: u64,
    pub checks_failed: u64,
}

/// Resultado completo para consumidores que precisam mostrar métricas e a
/// decisão final, mantendo o resumo legado pequeno para o IPC existente.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadRunReport {
    pub summary: LoadRunSummary,
    pub metrics: Vec<LoadMetricSnapshot>,
    pub thresholds: Vec<LoadThresholdResult>,
    pub passed: bool,
}

/// Uma amostra compacta de uma request concluída. Não contém headers, corpo,
/// cookies ou erro de transporte; consumidores que a retêm devem aplicar seu
/// próprio limite. Ela nunca é emitida pelo channel de progresso.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadRequestSample {
    pub scenario_id: String,
    pub vu_id: u32,
    pub node_id: String,
    pub method: String,
    pub status: Option<u16>,
    pub failed: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Error)]
pub enum LoadExecutionError {
    #[error(transparent)]
    InvalidPlan(#[from] LoadPlanError),
    #[error("lifecycle '{node_id}' excedeu seu timeout")]
    LifecycleTimeout { node_id: String },
    #[error("bloco '{node_id}' não pôde resolver suas variáveis")]
    Variables { node_id: String },
    #[error("dataset '{node_id}' esgotou as linhas deste VU")]
    DatasetExhausted { node_id: String },
    #[error("ForEach '{node_id}' não pôde resolver seus itens: {message}")]
    ForEach { node_id: String, message: String },
    #[error("Extract '{node_id}' não pôde ler a última resposta: {message}")]
    Extract { node_id: String, message: String },
    #[error("Script '{node_id}' não pôde executar: {message}")]
    Script { node_id: String, message: String },
    #[error(transparent)]
    Metric(#[from] LoadMetricError),
    #[error("cenário '{scenario_id}' usa o executor '{executor}', que ainda não é executável")]
    UnsupportedExecutor {
        scenario_id: String,
        executor: &'static str,
    },
}

/// Adaptador de progresso para IPC, histórico ou testes. Implementações
/// recebem snapshots; o runtime controla a frequência para proteger IPC.
pub trait LoadRunSink: Sync {
    fn progress(&self, snapshot: LoadRunProgress);
    fn scenario_finished(&self, scenario_id: &str, summary: LoadRunSummary);
    /// Recebe uma request concluída no mesmo processo do runner. O adapter
    /// Tauri não a encaminha por IPC; ele só preserva uma amostra limitada
    /// para histórico e paginação posterior.
    fn request_finished(&self, _sample: LoadRequestSample) {}
    /// Snapshot agregado de métricas, emitido ao concluir a execução. O
    /// adapter pode persistir ou encaminhar esse dado sem receber eventos por
    /// request; implementações existentes podem ignorá-lo.
    fn metrics(&self, _metrics: &[LoadMetricSnapshot]) {}
}

/// Estado interno pequeno, atualizado pelos workers e convertido em snapshot
/// pelo coordenador no intervalo de progresso escolhido.
#[derive(Debug, Default)]
pub struct LoadRunAccumulator {
    active_vus: u32,
    planned_vus: u32,
    completed_iterations: u64,
    dropped_iterations: u64,
    requests: u64,
    failed_requests: u64,
    checks_passed: u64,
    checks_failed: u64,
}

#[cfg(test)]
mod accumulator_tests {
    use super::*;

    #[test]
    fn aggregates_without_retaining_individual_requests() {
        let mut accumulator = LoadRunAccumulator::default();
        accumulator.set_vus(2, 3);
        accumulator.record_iteration();
        accumulator.record_dropped_iteration();
        accumulator.record_request(false);
        accumulator.record_request(true);
        accumulator.record_check(true);
        accumulator.record_check(false);

        assert_eq!(
            accumulator.progress(Duration::from_millis(20)),
            LoadRunProgress {
                active_vus: 2,
                planned_vus: 3,
                completed_iterations: 1,
                dropped_iterations: 1,
                requests: 2,
                failed_requests: 1,
                checks_passed: 1,
                checks_failed: 1,
                elapsed: Duration::from_millis(20)
            },
        );
        assert!(!accumulator.summary(false).cancelled);
    }

    #[test]
    fn group_duration_can_exclude_waited_timers() {
        assert_eq!(
            group_duration(Duration::from_millis(30), Duration::from_millis(12), false),
            Duration::from_millis(18)
        );
        assert_eq!(
            group_duration(Duration::from_millis(30), Duration::from_millis(12), true),
            Duration::from_millis(30)
        );
    }

    #[test]
    fn timer_distributions_respect_their_declared_bounds() {
        assert_eq!(
            sample_timer_duration(
                &LoadTimerKind::Uniform {
                    min: Duration::from_millis(20),
                    max: Duration::from_millis(40),
                },
                Duration::ZERO,
                || 0.5,
            ),
            Duration::from_millis(30),
        );
        assert_eq!(
            sample_timer_duration(
                &LoadTimerKind::Gaussian {
                    mean: Duration::from_millis(40),
                    standard_deviation: Duration::ZERO,
                },
                Duration::ZERO,
                || 0.5,
            ),
            Duration::from_millis(40),
        );
        assert_eq!(
            sample_timer_duration(
                &LoadTimerKind::Pacing {
                    period: Duration::from_millis(100),
                },
                Duration::from_millis(30),
                || 0.0,
            ),
            Duration::from_millis(70),
        );
        let poisson = sample_timer_duration(
            &LoadTimerKind::Poisson {
                mean: Duration::from_millis(100),
            },
            Duration::ZERO,
            || 0.5,
        );
        assert!(poisson > Duration::ZERO);
        assert!(poisson < Duration::from_secs(1));
    }
}

impl LoadRunAccumulator {
    pub fn set_vus(&mut self, active: u32, planned: u32) {
        self.active_vus = active;
        self.planned_vus = planned;
    }

    pub fn record_iteration(&mut self) {
        self.completed_iterations = self.completed_iterations.saturating_add(1);
    }
    pub fn record_dropped_iteration(&mut self) {
        self.dropped_iterations = self.dropped_iterations.saturating_add(1);
    }
    pub fn record_request(&mut self, failed: bool) {
        self.requests = self.requests.saturating_add(1);
        if failed {
            self.failed_requests = self.failed_requests.saturating_add(1);
        }
    }
    pub fn record_check(&mut self, passed: bool) {
        if passed {
            self.checks_passed = self.checks_passed.saturating_add(1);
        } else {
            self.checks_failed = self.checks_failed.saturating_add(1);
        }
    }
    fn merge_summary(&mut self, summary: LoadRunSummary) {
        self.completed_iterations = self
            .completed_iterations
            .saturating_add(summary.completed_iterations);
        self.dropped_iterations = self
            .dropped_iterations
            .saturating_add(summary.dropped_iterations);
        self.requests = self.requests.saturating_add(summary.requests);
        self.failed_requests = self.failed_requests.saturating_add(summary.failed_requests);
        self.checks_passed = self.checks_passed.saturating_add(summary.checks_passed);
        self.checks_failed = self.checks_failed.saturating_add(summary.checks_failed);
    }
    pub fn progress(&self, elapsed: Duration) -> LoadRunProgress {
        LoadRunProgress {
            active_vus: self.active_vus,
            planned_vus: self.planned_vus,
            completed_iterations: self.completed_iterations,
            dropped_iterations: self.dropped_iterations,
            requests: self.requests,
            failed_requests: self.failed_requests,
            checks_passed: self.checks_passed,
            checks_failed: self.checks_failed,
            elapsed,
        }
    }
    pub fn summary(&self, cancelled: bool) -> LoadRunSummary {
        LoadRunSummary {
            cancelled,
            completed_iterations: self.completed_iterations,
            dropped_iterations: self.dropped_iterations,
            requests: self.requests,
            failed_requests: self.failed_requests,
            checks_passed: self.checks_passed,
            checks_failed: self.checks_failed,
        }
    }
}

/// Executa um plano de carga canônico sem depender de Tauri, armazenamento ou
/// `Flow`. Cada cenário mantém workers concorrentes, e todos os cenários são
/// iniciados simultaneamente. Este é o ponto de entrada para futuros binários
/// Rust que exponham o runner fora do desktop.
pub async fn execute_load_plan<E, S, C>(
    plan: &LoadPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
) -> Result<LoadRunSummary, LoadExecutionError>
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    Ok(execute_load_plan_report(plan, executor, sink, cancellation)
        .await?
        .summary)
}

/// Executa um plano e preserva o relatório agregado para CLI, histórico ou
/// UI. Nenhuma amostra de resposta cruza esta fronteira.
pub async fn execute_load_plan_report<E, S, C>(
    plan: &LoadPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
) -> Result<LoadRunReport, LoadExecutionError>
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    execute_load_plan_report_with_limits(
        plan,
        executor,
        sink,
        cancellation,
        &LoadRunLimits::default(),
    )
    .await
}

/// Mesma execução, com orçamentos explícitos do consumidor. Um limite não
/// altera o plano: a validação falha antes de qualquer request ou alocação de VU.
pub async fn execute_load_plan_report_with_limits<E, S, C>(
    plan: &LoadPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
    limits: &LoadRunLimits,
) -> Result<LoadRunReport, LoadExecutionError>
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    plan.validate_with_limits(limits)?;
    let metrics = Arc::new(Mutex::new(LoadMetricRegistry::with_sample_budget(
        limits.max_trend_sample_bytes,
    )));
    let script_workers = Arc::new(ScriptWorkerGate::new(limits.max_script_workers));
    let lifecycle_state = Arc::new(Mutex::new(LoadVuState::new(1)));
    let lifecycle_accounting = Arc::new(LoadRequestAccounting::new(
        Arc::clone(&metrics),
        Arc::clone(&script_workers),
    ));
    if let Some(setup) = &plan.setup {
        run_lifecycle(
            setup,
            executor,
            sink,
            cancellation,
            Arc::clone(&lifecycle_state),
            Arc::clone(&lifecycle_accounting),
        )
        .await?;
    }
    let initial_variables = lock_vu_state(&lifecycle_state).variables().clone();
    let mut scenarios = FuturesUnordered::new();
    for scenario in &plan.scenarios {
        scenarios.push(
            run_scenario(
                scenario,
                executor,
                sink,
                cancellation,
                Arc::clone(&metrics),
                Arc::clone(&script_workers),
                &initial_variables,
            )
            .boxed(),
        );
    }

    let mut total = LoadRunAccumulator::default();
    let mut cancelled = false;
    let mut first_error = None;
    while let Some(result) = scenarios.next().await {
        let (scenario_id, summary) = match result {
            Ok(result) => result,
            Err(error) => {
                first_error = Some(error);
                break;
            }
        };
        cancelled |= summary.cancelled;
        total.merge_summary(summary);
        sink.scenario_finished(&scenario_id, summary);
    }
    // Cancela futures pendentes antes de iniciar teardown, inclusive em erro.
    drop(scenarios);
    if !cancellation.is_cancelled()
        && let Some(teardown) = &plan.teardown
    {
        let result = run_lifecycle(
            teardown,
            executor,
            sink,
            cancellation,
            lifecycle_state,
            Arc::clone(&lifecycle_accounting),
        )
        .await;
        if first_error.is_none() {
            first_error = result.err();
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    cancelled |= cancellation.is_cancelled();
    total.merge_summary(lifecycle_accounting.summary(&LoadRunAccumulator::default(), false));
    let summary = total.summary(cancelled);
    let registry = lock_metrics(&metrics);
    let thresholds = plan
        .thresholds
        .iter()
        .cloned()
        .map(|threshold| match registry.evaluate(threshold.clone()) {
            Ok(result) => Ok(result),
            Err(LoadMetricError::NoValues { .. }) => Ok(LoadThresholdResult {
                threshold,
                actual: None,
                passed: false,
            }),
            Err(error) => Err(LoadExecutionError::Metric(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let passed = !summary.cancelled && thresholds.iter().all(|threshold| threshold.passed);
    let metric_snapshots = registry.snapshots()?;
    sink.metrics(&metric_snapshots);
    Ok(LoadRunReport {
        summary,
        metrics: metric_snapshots,
        thresholds,
        passed,
    })
}

async fn run_scenario<E, S, C>(
    scenario: &LoadScenarioPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
    metrics: Metrics,
    script_workers: Arc<ScriptWorkerGate>,
    initial_variables: &BTreeMap<String, String>,
) -> Result<(String, LoadRunSummary), LoadExecutionError>
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    if cancellation.is_cancelled() {
        return Ok((
            scenario.node_id.clone(),
            LoadRunSummary {
                cancelled: true,
                ..LoadRunSummary::default()
            },
        ));
    }
    match scenario.schedule.executor() {
        LoadExecutor::SharedIterations { .. } | LoadExecutor::PerVuIterations { .. } => {
            run_finite_scenario(
                scenario,
                executor,
                sink,
                cancellation,
                metrics,
                script_workers,
                initial_variables,
            )
            .await
        }
        LoadExecutor::ConstantVus { .. } | LoadExecutor::RampingVus { .. } => {
            run_closed_scenario(
                scenario,
                executor,
                sink,
                cancellation,
                metrics,
                script_workers,
                initial_variables,
            )
            .await
        }
        LoadExecutor::ConstantArrivalRate { .. } | LoadExecutor::RampingArrivalRate { .. } => {
            run_open_scenario(
                scenario,
                executor,
                sink,
                cancellation,
                metrics,
                script_workers,
                initial_variables,
            )
            .await
        }
    }
}

fn executor_name(executor: &LoadExecutor) -> &'static str {
    match executor {
        LoadExecutor::SharedIterations { .. } => "sharedIterations",
        LoadExecutor::PerVuIterations { .. } => "perVuIterations",
        LoadExecutor::ConstantVus { .. } => "constantVus",
        LoadExecutor::RampingVus { .. } => "rampingVus",
        LoadExecutor::ConstantArrivalRate { .. } => "constantArrivalRate",
        LoadExecutor::RampingArrivalRate { .. } => "rampingArrivalRate",
    }
}

/// `al.iteration.count` só é conhecido por VU no executor per-VU. Os demais
/// podem distribuir ou manter iterações indefinidamente; neles zero sinaliza
/// contagem não delimitada, sem inventar um valor para o script.
fn script_iteration_count(executor: &LoadExecutor) -> u32 {
    match executor {
        LoadExecutor::PerVuIterations {
            iterations_per_vu, ..
        } => u32::try_from(*iterations_per_vu).unwrap_or(u32::MAX),
        _ => 0,
    }
}

async fn run_finite_scenario<E, S, C>(
    scenario: &LoadScenarioPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
    metrics: Metrics,
    script_workers: Arc<ScriptWorkerGate>,
    initial_variables: &BTreeMap<String, String>,
) -> Result<(String, LoadRunSummary), LoadExecutionError>
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    let started = Instant::now();
    let mut accumulator = LoadRunAccumulator::default();
    let accounting = Arc::new(LoadRequestAccounting::new(metrics, script_workers));
    let (vus, total_iterations, max_duration) = match scenario.schedule.executor() {
        LoadExecutor::SharedIterations {
            vus,
            iterations,
            max_duration,
        } => (*vus, *iterations, *max_duration),
        LoadExecutor::PerVuIterations {
            vus,
            iterations_per_vu,
            max_duration,
        } => (
            *vus,
            u64::from(*vus).saturating_mul(*iterations_per_vu),
            *max_duration,
        ),
        executor => {
            return Err(LoadExecutionError::UnsupportedExecutor {
                scenario_id: scenario.node_id.clone(),
                executor: executor_name(executor),
            });
        }
    };
    let workers = usize::try_from(u64::from(vus).min(total_iterations)).unwrap_or(0);
    accumulator.set_vus(workers as u32, vus);
    sink.progress(accumulator.progress(Duration::ZERO));

    let vu_states = vu_states(vus, initial_variables);
    let mut in_flight = FuturesUnordered::new();
    let mut queued = total_iterations.saturating_sub(workers as u64);
    let mut remaining_per_vu = match scenario.schedule.executor() {
        LoadExecutor::PerVuIterations {
            iterations_per_vu, ..
        } => Some(vec![iterations_per_vu.saturating_sub(1); workers]),
        _ => None,
    };
    for (vu_id, state) in vu_states.iter().enumerate().take(workers) {
        in_flight.push(run_vu_iteration(
            executor,
            sink,
            scenario,
            cancellation,
            vu_id,
            Arc::clone(state),
            Arc::clone(&accounting),
        ));
    }

    let deadline = max_duration.map(|duration| tokio::time::Instant::now() + duration);
    let deadline_wait = async {
        match deadline {
            Some(deadline) => tokio::time::sleep_until(deadline).await,
            None => pending::<()>().await,
        }
    };
    tokio::pin!(deadline_wait);
    let mut last_progress = Instant::now();
    let mut cancelled = cancellation.is_cancelled();

    while !in_flight.is_empty() && !cancelled {
        tokio::select! {
            _ = cancellation.cancelled() => {
                cancelled = true;
            }
            _ = &mut deadline_wait => {
                accumulator.dropped_iterations = accumulator
                    .dropped_iterations
                    .saturating_add(queued)
                    .saturating_add(in_flight.len() as u64);
                queued = 0;
                cancelled = true;
            }
            result = in_flight.next() => {
                if let Some((vu_id, result)) = result {
                    result?;
                    accumulator.record_iteration();
                    let schedule_next = match &mut remaining_per_vu {
                        Some(remaining) if remaining[vu_id] > 0 => {
                            remaining[vu_id] -= 1;
                            true
                        }
                        Some(_) => false,
                        None => queued > 0,
                    };
                    if schedule_next {
                        queued -= 1;
                        in_flight.push(run_vu_iteration(
                            executor,
                            sink,
                            scenario,
                            cancellation,
                            vu_id,
                            Arc::clone(&vu_states[vu_id]),
                            Arc::clone(&accounting),
                        ));
                    }
                    accumulator.set_vus(in_flight.len() as u32, vus);
                    if last_progress.elapsed() >= LOAD_PROGRESS_INTERVAL {
                        sink.progress(accounting.progress(&accumulator, started.elapsed()));
                        last_progress = Instant::now();
                    }
                }
            }
        }
    }

    if cancelled && cancellation.is_cancelled() {
        accumulator.dropped_iterations = accumulator
            .dropped_iterations
            .saturating_add(queued)
            .saturating_add(in_flight.len() as u64);
    }
    accumulator.set_vus(0, vus);
    sink.progress(accounting.progress(&accumulator, started.elapsed()));
    Ok((
        scenario.node_id.clone(),
        accounting.summary(&accumulator, cancelled && cancellation.is_cancelled()),
    ))
}

async fn run_closed_scenario<E, S, C>(
    scenario: &LoadScenarioPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
    metrics: Metrics,
    script_workers: Arc<ScriptWorkerGate>,
    initial_variables: &BTreeMap<String, String>,
) -> Result<(String, LoadRunSummary), LoadExecutionError>
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    let Some(deadline_after) = scenario.schedule.scheduled_end() else {
        return Err(LoadExecutionError::UnsupportedExecutor {
            scenario_id: scenario.node_id.clone(),
            executor: executor_name(scenario.schedule.executor()),
        });
    };
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + deadline_after;
    let mut accumulator = LoadRunAccumulator::default();
    let accounting = Arc::new(LoadRequestAccounting::new(metrics, script_workers));
    let planned_vus = scenario.schedule.maximum_vus();
    let vu_states = vu_states(planned_vus, initial_variables);
    let mut busy = vec![false; vu_states.len()];
    let mut in_flight = FuturesUnordered::new();
    let mut last_progress = Instant::now();
    let mut user_cancelled = cancellation.is_cancelled();
    let mut deadline_reached = false;
    let mut emitted_initial_progress = false;

    while !user_cancelled && !deadline_reached {
        let elapsed = started.elapsed();
        if elapsed >= deadline_after {
            break;
        }
        let target = scenario.schedule.target_vus_at(elapsed);
        for vu_id in 0..target as usize {
            if !busy[vu_id] {
                busy[vu_id] = true;
                in_flight.push(run_vu_iteration(
                    executor,
                    sink,
                    scenario,
                    cancellation,
                    vu_id,
                    Arc::clone(&vu_states[vu_id]),
                    Arc::clone(&accounting),
                ));
            }
        }
        accumulator.set_vus(in_flight.len() as u32, planned_vus);
        if !emitted_initial_progress || last_progress.elapsed() >= LOAD_PROGRESS_INTERVAL {
            sink.progress(accounting.progress(&accumulator, elapsed));
            last_progress = Instant::now();
            emitted_initial_progress = true;
        }

        if in_flight.is_empty() {
            if elapsed >= deadline_after {
                break;
            }
            tokio::select! {
                _ = cancellation.cancelled() => user_cancelled = true,
                _ = tokio::time::sleep_until(deadline) => deadline_reached = true,
                _ = tokio::time::sleep(CLOSED_SCHEDULER_TICK) => {}
            }
            continue;
        }

        tokio::select! {
            _ = cancellation.cancelled() => user_cancelled = true,
            _ = tokio::time::sleep_until(deadline) => deadline_reached = true,
            result = in_flight.next() => {
                if let Some((vu_id, result)) = result {
                    busy[vu_id] = false;
                    result?;
                    accumulator.record_iteration();
                }
            }
            _ = tokio::time::sleep(CLOSED_SCHEDULER_TICK) => {}
        }
    }

    if user_cancelled || deadline_reached {
        accumulator.dropped_iterations = accumulator
            .dropped_iterations
            .saturating_add(in_flight.len() as u64);
    }
    accumulator.set_vus(0, planned_vus);
    sink.progress(accounting.progress(&accumulator, started.elapsed()));
    Ok((
        scenario.node_id.clone(),
        accounting.summary(&accumulator, user_cancelled),
    ))
}

fn record_request_result(
    accumulator: &mut LoadRunAccumulator,
    request: LoadRequestResult,
    checks: impl Iterator<Item = (String, bool)>,
    metrics: &Metrics,
) -> Result<(), LoadExecutionError> {
    let mut registry = lock_metrics(metrics);
    accumulator.record_request(request.failed);
    let mut tags = request.tags;
    tags.insert("method".to_string(), request.method);
    tags.insert("request".to_string(), request.node_id);
    tags.insert(
        "status".to_string(),
        request
            .status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "error".to_string()),
    );
    registry.record("http_requests", LoadMetricKind::Counter, tags.clone(), 1.0)?;
    registry.record(
        "http_req_failed",
        LoadMetricKind::Rate,
        tags.clone(),
        f64::from(request.failed),
    )?;
    registry.record(
        "http_req_duration",
        LoadMetricKind::Trend,
        tags.clone(),
        request.timings.total.as_secs_f64() * 1_000.0,
    )?;
    for (name, duration) in [
        ("http_req_dns", request.timings.dns),
        ("http_req_connecting", request.timings.connecting),
        ("http_req_tls_handshaking", request.timings.tls_handshaking),
        ("http_req_sending", request.timings.sending),
        ("http_req_waiting", request.timings.waiting),
        ("http_req_receiving", request.timings.receiving),
    ] {
        if let Some(duration) = duration {
            registry.record(
                name,
                LoadMetricKind::Trend,
                tags.clone(),
                duration.as_secs_f64() * 1_000.0,
            )?;
        }
    }
    for metric in request.metrics {
        registry.record(metric.name, metric.kind, metric.tags, metric.value)?;
    }
    for (name, passed) in checks {
        accumulator.record_check(passed);
        let mut tags = request.check_tags.clone();
        tags.insert("check".into(), name);
        registry.record("checks", LoadMetricKind::Rate, tags, f64::from(passed))?;
    }
    Ok(())
}

async fn run_open_scenario<E, S, C>(
    scenario: &LoadScenarioPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
    metrics: Metrics,
    script_workers: Arc<ScriptWorkerGate>,
    initial_variables: &BTreeMap<String, String>,
) -> Result<(String, LoadRunSummary), LoadExecutionError>
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    let Some(duration) = scenario.schedule.duration() else {
        return Err(LoadExecutionError::UnsupportedExecutor {
            scenario_id: scenario.node_id.clone(),
            executor: executor_name(scenario.schedule.executor()),
        });
    };
    let started = Instant::now();
    let started_at = tokio::time::Instant::now();
    let deadline = started_at + duration;
    let capacity = scenario.schedule.maximum_vus();
    let vu_states = vu_states(capacity, initial_variables);
    let mut busy = vec![false; vu_states.len()];
    let mut accumulator = LoadRunAccumulator::default();
    let accounting = Arc::new(LoadRequestAccounting::new(metrics, script_workers));
    let mut in_flight = FuturesUnordered::new();
    let mut next_ordinal = 0_u64;
    let mut next_arrival = scenario.schedule.arrival(next_ordinal);
    let mut last_progress = Instant::now();
    let mut emitted_initial_progress = false;
    let mut user_cancelled = cancellation.is_cancelled();
    let mut deadline_reached = false;

    while !user_cancelled && !deadline_reached {
        let elapsed = started.elapsed();
        if elapsed >= duration {
            break;
        }
        accumulator.set_vus(in_flight.len() as u32, capacity);
        if !emitted_initial_progress || last_progress.elapsed() >= LOAD_PROGRESS_INTERVAL {
            sink.progress(accounting.progress(&accumulator, elapsed));
            last_progress = Instant::now();
            emitted_initial_progress = true;
        }

        if in_flight.is_empty() {
            let Some(arrival) = next_arrival else {
                break;
            };
            tokio::select! {
                _ = cancellation.cancelled() => user_cancelled = true,
                _ = tokio::time::sleep_until(deadline) => deadline_reached = true,
                _ = tokio::time::sleep_until(started_at + arrival.at) => {
                    if let Some(vu_id) = busy.iter().position(|busy| !busy) {
                        busy[vu_id] = true;
                        in_flight.push(run_vu_iteration(
                            executor,
                            sink,
                            scenario,
                            cancellation,
                            vu_id,
                            Arc::clone(&vu_states[vu_id]),
                            Arc::clone(&accounting),
                        ));
                    } else {
                        accumulator.record_dropped_iteration();
                    }
                    next_ordinal = next_ordinal.saturating_add(1);
                    next_arrival = scenario.schedule.arrival(next_ordinal);
                }
            }
            continue;
        }

        if let Some(arrival) = next_arrival {
            let arrival_at = started_at + arrival.at;
            tokio::select! {
                _ = cancellation.cancelled() => user_cancelled = true,
                _ = tokio::time::sleep_until(deadline) => deadline_reached = true,
                result = in_flight.next() => {
                    if let Some((vu_id, result)) = result {
                        busy[vu_id] = false;
                        result?;
                        accumulator.record_iteration();
                    }
                }
                _ = tokio::time::sleep_until(arrival_at) => {
                    if let Some(vu_id) = busy.iter().position(|busy| !busy) {
                        busy[vu_id] = true;
                        in_flight.push(run_vu_iteration(
                            executor,
                            sink,
                            scenario,
                            cancellation,
                            vu_id,
                            Arc::clone(&vu_states[vu_id]),
                            Arc::clone(&accounting),
                        ));
                    } else {
                        accumulator.record_dropped_iteration();
                    }
                    next_ordinal = next_ordinal.saturating_add(1);
                    next_arrival = scenario.schedule.arrival(next_ordinal);
                }
            }
        } else {
            tokio::select! {
                _ = cancellation.cancelled() => user_cancelled = true,
                _ = tokio::time::sleep_until(deadline) => deadline_reached = true,
                result = in_flight.next() => {
                    if let Some((vu_id, result)) = result {
                        busy[vu_id] = false;
                        result?;
                        accumulator.record_iteration();
                    }
                }
            }
        }
    }

    accumulator.set_vus(0, capacity);
    sink.progress(accounting.progress(&accumulator, started.elapsed()));
    Ok((
        scenario.node_id.clone(),
        accounting.summary(&accumulator, user_cancelled),
    ))
}

/// Requests são contabilizadas ao concluir, inclusive quando a iteração é
/// interrompida durante um efeito posterior. Nenhuma lista por iteração é retida.
struct LoadRequestAccounting {
    counters: Mutex<LoadRunAccumulator>,
    metrics: Metrics,
    script_workers: Arc<ScriptWorkerGate>,
}

impl LoadRequestAccounting {
    fn new(metrics: Metrics, script_workers: Arc<ScriptWorkerGate>) -> Self {
        Self {
            counters: Mutex::new(LoadRunAccumulator::default()),
            metrics,
            script_workers,
        }
    }

    fn script_workers(&self) -> &ScriptWorkerGate {
        &self.script_workers
    }

    fn counters(&self) -> std::sync::MutexGuard<'_, LoadRunAccumulator> {
        self.counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn progress(&self, accumulator: &LoadRunAccumulator, elapsed: Duration) -> LoadRunProgress {
        let counters = self.counters();
        LoadRunProgress {
            requests: counters.requests,
            failed_requests: counters.failed_requests,
            checks_passed: counters.checks_passed,
            checks_failed: counters.checks_failed,
            ..accumulator.progress(elapsed)
        }
    }

    fn summary(&self, accumulator: &LoadRunAccumulator, cancelled: bool) -> LoadRunSummary {
        let counters = self.counters();
        LoadRunSummary {
            requests: counters.requests,
            failed_requests: counters.failed_requests,
            checks_passed: counters.checks_passed,
            checks_failed: counters.checks_failed,
            ..accumulator.summary(cancelled)
        }
    }
}

/// Limita os interpretadores Boa em uma execução, em vez de delegar toda a
/// contenção ao pool bloqueante global do Tokio. A espera cede o runtime e
/// observa cancelamento; um interpretador que já começou termina sob os
/// limites do Boa antes de liberar a permissão.
#[derive(Debug)]
struct ScriptWorkerGate {
    available: AtomicUsize,
}

impl ScriptWorkerGate {
    fn new(workers: usize) -> Self {
        Self {
            available: AtomicUsize::new(workers),
        }
    }

    async fn acquire<C: LoadCancellation>(&self, cancellation: &C) -> ScriptWorkerPermit<'_> {
        loop {
            let available = self.available.load(Ordering::Acquire);
            if available > 0
                && self
                    .available
                    .compare_exchange_weak(
                        available,
                        available - 1,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
            {
                return ScriptWorkerPermit { gate: self };
            }

            tokio::select! {
                _ = cancellation.cancelled() => pending::<()>().await,
                _ = tokio::time::sleep(Duration::from_millis(1)) => {}
            }
        }
    }
}

struct ScriptWorkerPermit<'a> {
    gate: &'a ScriptWorkerGate,
}

impl Drop for ScriptWorkerPermit<'_> {
    fn drop(&mut self) {
        self.gate.available.fetch_add(1, Ordering::Release);
    }
}

#[derive(Debug)]
struct LoadRequestResult {
    node_id: String,
    method: String,
    status: Option<u16>,
    failed: bool,
    timings: LoadRequestTimings,
    tags: BTreeMap<String, String>,
    metrics: Vec<LoadMetricPlan>,
    check_tags: BTreeMap<String, String>,
}

impl LoadRequestResult {
    fn sample(&self, scenario_id: &str, vu_id: usize) -> LoadRequestSample {
        LoadRequestSample {
            scenario_id: scenario_id.to_string(),
            vu_id: (vu_id as u32).saturating_add(1),
            node_id: self.node_id.clone(),
            method: self.method.clone(),
            status: self.status,
            failed: self.failed,
            duration_ms: self.timings.total.as_millis() as u64,
        }
    }
}

type VuState = Arc<Mutex<LoadVuState>>;
type Metrics = Arc<Mutex<LoadMetricRegistry>>;

fn vu_states(count: u32, initial_variables: &BTreeMap<String, String>) -> Vec<VuState> {
    (0..count)
        .map(|index| {
            let mut state = LoadVuState::new(u64::from(index) + 1);
            state.variables_mut().clone_from(initial_variables);
            Arc::new(Mutex::new(state))
        })
        .collect()
}

async fn run_vu_iteration<E, S, C>(
    executor: &E,
    sink: &S,
    scenario: &LoadScenarioPlan,
    cancellation: &C,
    vu_id: usize,
    state: VuState,
    accounting: Arc<LoadRequestAccounting>,
) -> (usize, Result<(), LoadExecutionError>)
where
    E: LoadTransport + Sync,
    S: LoadRunSink,
    C: LoadCancellation,
{
    let iteration_index = lock_vu_state(&state).begin_iteration(vu_id);
    let mut iteration = Iteration {
        executor,
        sink,
        cancellation,
        scenario_id: &scenario.node_id,
        vu_id,
        state,
        accounting,
        iteration_index: u32::try_from(iteration_index).unwrap_or(u32::MAX),
        iteration_count: script_iteration_count(scenario.schedule.executor()),
        timer_waited: Duration::ZERO,
        last_status: None,
        last_response: None,
        last_script_response: None,
        tags: BTreeMap::new(),
    };
    let result = async {
        for request in &scenario.requests {
            iteration.request(request).await?;
        }
        iteration.body(&scenario.body).await
    }
    .await;
    (vu_id, result)
}

async fn run_lifecycle<E: LoadTransport, S: LoadRunSink, C: LoadCancellation>(
    plan: &LoadLifecyclePlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
    state: VuState,
    accounting: Arc<LoadRequestAccounting>,
) -> Result<(), LoadExecutionError> {
    if cancellation.is_cancelled() {
        return Ok(());
    }
    let mut iteration = Iteration {
        executor,
        sink,
        cancellation,
        scenario_id: &plan.node_id,
        vu_id: 0,
        state,
        accounting,
        iteration_index: 0,
        iteration_count: 1,
        timer_waited: Duration::ZERO,
        last_status: None,
        last_response: None,
        last_script_response: None,
        tags: BTreeMap::new(),
    };
    tokio::select! {
        _ = cancellation.cancelled() => Ok(()),
        result = tokio::time::timeout(plan.timeout, iteration.body(&plan.body)) => {
            result.map_err(|_| LoadExecutionError::LifecycleTimeout { node_id: plan.node_id.clone() })?
        }
    }
}

struct Iteration<'a, E, S, C> {
    executor: &'a E,
    sink: &'a S,
    cancellation: &'a C,
    scenario_id: &'a str,
    vu_id: usize,
    state: VuState,
    accounting: Arc<LoadRequestAccounting>,
    iteration_index: u32,
    iteration_count: u32,
    timer_waited: Duration,
    last_status: Option<u16>,
    last_response: Option<String>,
    last_script_response: Option<ScriptResponse>,
    tags: BTreeMap<String, String>,
}

impl<E: LoadTransport, S: LoadRunSink, C: LoadCancellation> Iteration<'_, E, S, C> {
    fn body<'a>(
        &'a mut self,
        body: &'a [LoadStep],
    ) -> futures_util::future::BoxFuture<'a, Result<(), LoadExecutionError>> {
        async move {
            for step in body {
                // Corpos sem I/O também cedem o runtime para cancelamento/deadlines.
                yield_execution().await;
                self.guard_cancellation().await;
                match step {
                    LoadStep::Request(request) => self.request(request).await?,
                    LoadStep::Timer(timer) => self.wait_for_timer(timer).await,
                    LoadStep::ConfigureSession(session) => self.configure(session),
                    LoadStep::Check(check) => {
                        let passed = self.last_status == Some(check.expected_status);
                        self.accounting.counters().record_check(passed);
                        let mut tags = self.tags.clone();
                        tags.insert("check".into(), check.name.clone());
                        lock_metrics(&self.accounting.metrics).record(
                            "checks",
                            LoadMetricKind::Rate,
                            tags,
                            f64::from(passed),
                        )?;
                    }
                    LoadStep::Extract(extract) => self.extract(extract)?,
                    LoadStep::Script(script) => self.script(script).await?,
                    LoadStep::Metric(metric) => {
                        let mut tags = self.tags.clone();
                        tags.extend(metric.tags.clone());
                        lock_metrics(&self.accounting.metrics).record(
                            &metric.name,
                            metric.kind,
                            tags,
                            metric.value,
                        )?;
                    }
                    LoadStep::Dataset(dataset) => {
                        let mut state = lock_vu_state(&self.state);
                        let ordinal = state.dataset_row_for(&dataset.node_id);
                        let count = dataset.rows.len() as u64;
                        if ordinal >= count && !dataset.recycle {
                            return Err(LoadExecutionError::DatasetExhausted {
                                node_id: dataset.node_id.clone(),
                            });
                        }
                        let row = &dataset.rows[(ordinal % count) as usize];
                        state.variables_mut().extend(row.clone());
                    }
                    LoadStep::Repeat { count, body, .. } => {
                        for _ in 0..*count {
                            self.body(body).await?;
                        }
                    }
                    LoadStep::ForEach {
                        variable,
                        items,
                        items_variable,
                        max_items,
                        node_id,
                        body,
                        ..
                    } => {
                        let items = {
                            let state = lock_vu_state(&self.state);
                            match items_variable {
                                Some(items_variable) => resolve_dynamic_items(
                                    node_id,
                                    items_variable,
                                    (*max_items).ok_or_else(|| LoadExecutionError::ForEach {
                                        node_id: node_id.clone(),
                                        message: "maxItems ausente no plano dinâmico".into(),
                                    })?,
                                    state.variables(),
                                )?,
                                None => items
                                    .iter()
                                    .map(|item| {
                                        resolve_template(item, state.variables()).ok_or_else(|| {
                                            LoadExecutionError::Variables {
                                                node_id: node_id.clone(),
                                            }
                                        })
                                    })
                                    .collect::<Result<Vec<_>, _>>()?,
                            }
                        };
                        let previous = lock_vu_state(&self.state)
                            .variables()
                            .get(variable)
                            .cloned();
                        let _scope = VariableScope {
                            state: Arc::clone(&self.state),
                            name: variable.clone(),
                            previous,
                        };
                        for item in &items {
                            lock_vu_state(&self.state)
                                .variables_mut()
                                .insert(variable.clone(), item.clone());
                            self.body(body).await?;
                        }
                    }
                    LoadStep::Select {
                        variable,
                        operator,
                        equals,
                        node_id,
                        body,
                        ..
                    } => {
                        let selected = {
                            let state = lock_vu_state(&self.state);
                            match operator {
                                crate::LoadSelectOperator::Equals => {
                                    resolve_template(equals, state.variables())
                                        .map(|equals| {
                                            state.variables().get(variable) == Some(&equals)
                                        })
                                        .ok_or_else(|| LoadExecutionError::Variables {
                                            node_id: node_id.clone(),
                                        })
                                }
                                crate::LoadSelectOperator::NotEquals => {
                                    resolve_template(equals, state.variables())
                                        .map(|equals| {
                                            state.variables().get(variable) != Some(&equals)
                                        })
                                        .ok_or_else(|| LoadExecutionError::Variables {
                                            node_id: node_id.clone(),
                                        })
                                }
                                crate::LoadSelectOperator::Exists => {
                                    Ok(state.variables().contains_key(variable))
                                }
                                crate::LoadSelectOperator::NotExists => {
                                    Ok(!state.variables().contains_key(variable))
                                }
                            }
                        }?;
                        if selected {
                            self.body(body).await?;
                        }
                    }
                    LoadStep::OncePerVu { node_id, body } => {
                        let first = lock_vu_state(&self.state).enter_once(node_id);
                        if first {
                            self.body(body).await?;
                        }
                    }
                    LoadStep::TimeBox { duration, body, .. } => {
                        let (last_status, last_response, last_script_response, timer_waited) = {
                            let mut child = self.child();
                            let deadline = tokio::time::Instant::now() + *duration;
                            while tokio::time::Instant::now() < deadline {
                                match tokio::time::timeout_at(deadline, child.body(body)).await {
                                    Ok(result) => result?,
                                    Err(_) => break,
                                }
                            }
                            (
                                child.last_status,
                                child.last_response,
                                child.last_script_response,
                                child.timer_waited,
                            )
                        };
                        self.last_status = last_status;
                        self.last_response = last_response;
                        self.last_script_response = last_script_response;
                        self.timer_waited = self.timer_waited.saturating_add(timer_waited);
                    }
                    LoadStep::Group {
                        name,
                        tags,
                        include_timers,
                        emit_parent,
                        body,
                        ..
                    } => {
                        let parent = self.tags.get("group").cloned().unwrap_or_default();
                        let metrics = Arc::clone(&self.accounting.metrics);
                        let (
                            last_status,
                            last_response,
                            last_script_response,
                            timer_waited,
                            child_tags,
                            duration,
                        ) = {
                            let mut child = self.child();
                            child.tags.extend(tags.clone());
                            child
                                .tags
                                .insert("group".into(), format!("{parent}::{name}"));
                            let started = Instant::now();
                            child.body(body).await?;
                            (
                                child.last_status,
                                child.last_response,
                                child.last_script_response,
                                child.timer_waited,
                                child.tags,
                                started.elapsed(),
                            )
                        };
                        if *emit_parent {
                            let duration = group_duration(duration, timer_waited, *include_timers);
                            lock_metrics(&metrics).record(
                                "group_duration",
                                LoadMetricKind::Trend,
                                child_tags,
                                duration.as_secs_f64() * 1000.0,
                            )?;
                        }
                        self.last_status = last_status;
                        self.last_response = last_response;
                        self.last_script_response = last_script_response;
                        self.timer_waited = self.timer_waited.saturating_add(timer_waited);
                    }
                }
            }
            Ok(())
        }
        .boxed()
    }

    fn child(&mut self) -> Iteration<'_, E, S, C> {
        Iteration {
            executor: self.executor,
            sink: self.sink,
            cancellation: self.cancellation,
            scenario_id: self.scenario_id,
            vu_id: self.vu_id,
            state: Arc::clone(&self.state),
            accounting: Arc::clone(&self.accounting),
            iteration_index: self.iteration_index,
            iteration_count: self.iteration_count,
            timer_waited: Duration::ZERO,
            last_status: self.last_status,
            last_response: self.last_response.take(),
            last_script_response: self.last_script_response.take(),
            tags: self.tags.clone(),
        }
    }

    fn configure(&self, session: &crate::LoadSessionPlan) {
        let mut state = lock_vu_state(&self.state);
        state.configure_headers(&session.headers);
        state.variables_mut().extend(session.variables.clone());
        if let Some(enabled) = session.cookies_enabled {
            state.set_cookies_enabled(enabled);
        }
    }

    async fn request(&mut self, request_plan: &LoadRequestPlan) -> Result<(), LoadExecutionError> {
        self.guard_cancellation().await;
        for action in &request_plan.before {
            self.guard_cancellation().await;
            match action {
                LoadIterationAction::Timer(timer) => self.wait_for_timer(timer).await,
                LoadIterationAction::ConfigureSession(session) => {
                    self.configure(session);
                }
            }
        }
        let invalid_variables = || LoadExecutionError::Variables {
            node_id: request_plan.node_id.clone(),
        };
        let body = resolve_template(&request_plan.body, lock_vu_state(&self.state).variables())
            .ok_or_else(invalid_variables)?;
        let mut request = Request::new(
            request_plan.endpoint.clone(),
            RequestDocument::new(ProtocolId::Rest, body),
            "",
            request_plan.headers.clone(),
            Authentication::None,
        )
        .with_method(request_plan.method)
        .with_redirect_policy(request_plan.redirect_policy);
        {
            let mut state = lock_vu_state(&self.state);
            state.apply_defaults(&mut request);
            state.apply_cookies(&mut request);
        }
        request.headers = {
            let state = lock_vu_state(&self.state);
            request
                .headers
                .iter()
                .map(|header| {
                    let value = resolve_template(header.value(), state.variables())
                        .ok_or_else(invalid_variables)?;
                    let header =
                        alcy_domain::HeaderEntry::new(header.name(), value, header.enabled)
                            .map_err(|_| invalid_variables())?;
                    header.validate_http().map_err(|_| invalid_variables())?;
                    Ok(header)
                })
                .collect::<Result<Vec<_>, LoadExecutionError>>()?
        };
        let requested_url = request.endpoint.url().to_string();
        self.guard_cancellation().await;
        let request_started = Instant::now();
        let exchange = match request_plan.timeout {
            Some(timeout) => {
                match tokio::time::timeout(timeout, self.executor.execute_instrumented(&request))
                    .await
                {
                    Ok(result) => result,
                    Err(_) => Err(ExecutionError::Timeout),
                }
            }
            None => self.executor.execute_instrumented(&request).await,
        };
        let (status, response_body, script_response, timings) = match exchange {
            Ok(mut exchange) => {
                let status = exchange.response.status_code;
                lock_vu_state(&self.state).remember_cookies(&requested_url, &exchange.response);
                let script_response = ScriptResponse {
                    status,
                    status_text: String::new(),
                    time_ms: exchange.response.duration_ms,
                    size_bytes: exchange.response.size_bytes,
                    url: exchange
                        .response
                        .final_url
                        .clone()
                        .unwrap_or_else(|| requested_url.clone()),
                    headers: exchange
                        .response
                        .headers
                        .iter()
                        .map(|header| alcy_scripting::ScriptHeader {
                            name: header.name.clone(),
                            value: header.value.clone(),
                        })
                        .collect(),
                    body: matches!(exchange.response.encoding, alcy_domain::BodyEncoding::Text)
                        .then(|| exchange.response.body.clone()),
                };
                (
                    Some(status),
                    Some(std::mem::take(&mut exchange.response.body)),
                    Some(script_response),
                    exchange.timings.with_total(request_started.elapsed()),
                )
            }
            Err(_) => (
                None,
                None,
                None,
                LoadRequestTimings {
                    total: request_started.elapsed(),
                    ..LoadRequestTimings::default()
                },
            ),
        };
        let failed = status.is_none_or(|status| status >= 400);
        self.last_status = status;
        self.last_response = response_body;
        self.last_script_response = script_response;
        let mut tags = self.tags.clone();
        tags.extend(request_plan.tags.clone());
        let result = LoadRequestResult {
            node_id: request_plan.node_id.clone(),
            method: http_method_name(request_plan.method).to_string(),
            status,
            failed,
            timings,
            tags,
            metrics: request_plan
                .metrics
                .iter()
                .map(|metric| {
                    let mut metric = metric.clone();
                    let mut tags = self.tags.clone();
                    tags.extend(metric.tags);
                    metric.tags = tags;
                    metric
                })
                .collect(),
            check_tags: self.tags.clone(),
        };
        let checks = request_plan
            .checks
            .iter()
            .map(|check| (check.name.clone(), status == Some(check.expected_status)));
        let sample = result.sample(self.scenario_id, self.vu_id);
        record_request_result(
            &mut self.accounting.counters(),
            result,
            checks,
            &self.accounting.metrics,
        )?;
        self.sink.request_finished(sample);
        Ok(())
    }

    async fn wait_for_timer(&mut self, timer: &LoadTimerPlan) {
        let duration = self.sample_timer(timer);
        let started = Instant::now();
        tokio::time::sleep(duration).await;
        self.timer_waited = self.timer_waited.saturating_add(started.elapsed());
    }

    fn sample_timer(&self, timer: &LoadTimerPlan) -> Duration {
        let elapsed = lock_vu_state(&self.state).iteration_elapsed();
        sample_timer_duration(&timer.kind, elapsed, || {
            unit_interval(lock_vu_state(&self.state).next_random())
        })
    }

    fn extract(&mut self, extract: &crate::LoadExtractPlan) -> Result<(), LoadExecutionError> {
        let response =
            self.last_response
                .as_deref()
                .ok_or_else(|| LoadExecutionError::Extract {
                    node_id: extract.node_id.clone(),
                    message: "there is no preceding response".into(),
                })?;
        if response.len() > MAX_EXTRACT_RESPONSE_BYTES {
            return Err(LoadExecutionError::Extract {
                node_id: extract.node_id.clone(),
                message: format!(
                    "response exceeds the {} byte extraction limit",
                    MAX_EXTRACT_RESPONSE_BYTES
                ),
            });
        }
        let value = extract_value(&extract.kind, response).map_err(|message| {
            LoadExecutionError::Extract {
                node_id: extract.node_id.clone(),
                message,
            }
        })?;
        lock_vu_state(&self.state)
            .variables_mut()
            .insert(extract.name.clone(), value);
        Ok(())
    }

    async fn script(&mut self, script: &LoadScriptPlan) -> Result<(), LoadExecutionError> {
        let phase = match script.phase {
            LoadScriptPhase::PreRequest => ScriptPhase::PreRequest,
            LoadScriptPhase::PostResponse => ScriptPhase::PostResponse,
        };
        let initial_runtime = lock_vu_state(&self.state).variables().clone();
        let runtime: Vec<_> = initial_runtime
            .iter()
            .map(|(name, value)| ScriptVariable {
                name: name.clone(),
                value: value.clone(),
            })
            .collect();
        let request = ScriptRequest {
            url: String::new(),
            method: "GET".into(),
            body: String::new(),
            headers: Vec::new(),
        };
        let response = if script.phase == LoadScriptPhase::PostResponse {
            self.last_script_response.clone()
        } else {
            None
        };
        let input = ScriptInput {
            request: request.clone(),
            response,
            environment: Vec::new(),
            collection: None,
            folder: None,
            local: Vec::new(),
            runtime,
            iteration: alcy_scripting::ScriptIteration {
                index: self.iteration_index,
                count: self.iteration_count,
                data: Vec::new(),
            },
        };
        let node_id = script.node_id.clone();
        let code = script.code.clone();
        let worker_permit = self.script_workers().acquire(self.cancellation).await;
        let output = tokio::task::spawn_blocking(move || run_script(phase, &code, &input))
            .await
            .map_err(|error| LoadExecutionError::Script {
                node_id: node_id.clone(),
                message: format!("worker do Script terminou inesperadamente: {error}"),
            })?
            .map_err(|error| LoadExecutionError::Script {
                node_id: node_id.clone(),
                message: error.to_string(),
            })?;
        drop(worker_permit);
        self.guard_cancellation().await;
        if output.request != request
            || !output.environment.is_empty()
            || !output.changed_variables.is_empty()
            || !output.removed_variables.is_empty()
            || output.collection.is_some()
            || !output.changed_collection.is_empty()
            || !output.removed_collection.is_empty()
            || output.folder.is_some()
            || !output.changed_folder.is_empty()
            || !output.removed_folder.is_empty()
            || !output.local.is_empty()
            || !output.logs.is_empty()
            || !output.tests.is_empty()
        {
            return Err(LoadExecutionError::Script {
                node_id: script.node_id.clone(),
                message: "somente al.runtime pode produzir efeitos no runner de carga".into(),
            });
        }
        let variables: BTreeMap<_, _> = output
            .runtime
            .into_iter()
            .map(|variable| (variable.name, variable.value))
            .collect();
        let altered_reserved = variables
            .iter()
            .filter(|(name, _)| !is_runtime_variable_name(name))
            .any(|(name, value)| initial_runtime.get(name) != Some(value))
            || initial_runtime
                .iter()
                .filter(|(name, _)| !is_runtime_variable_name(name))
                .any(|(name, value)| variables.get(name) != Some(value));
        if altered_reserved {
            return Err(LoadExecutionError::Script {
                node_id: script.node_id.clone(),
                message: "Script tentou gravar variável vazia ou reservada".into(),
            });
        }
        *lock_vu_state(&self.state).variables_mut() = variables;
        Ok(())
    }

    fn script_workers(&self) -> &ScriptWorkerGate {
        self.accounting.script_workers()
    }

    async fn guard_cancellation(&self) {
        if self.cancellation.is_cancelled() {
            // O coordenador observa o sinal e descarta esta iteração: não
            // marque como completa nem inicie efeitos após o cancelamento.
            pending::<()>().await;
        }
    }
}

fn unit_interval(value: u64) -> f64 {
    // Os 53 bits altos são exatamente representáveis em f64. O resultado está
    // em [0, 1), adequado para as distribuições sem produzir o limite superior.
    (value >> 11) as f64 / (1_u64 << 53) as f64
}

fn sample_timer_duration(
    kind: &LoadTimerKind,
    iteration_elapsed: Duration,
    mut random: impl FnMut() -> f64,
) -> Duration {
    match kind {
        LoadTimerKind::Fixed(duration) => *duration,
        LoadTimerKind::Pacing { period } => period.saturating_sub(iteration_elapsed),
        LoadTimerKind::Uniform { min, max } => {
            let span = max.saturating_sub(*min).as_nanos();
            min.saturating_add(Duration::from_nanos((random() * span as f64) as u64))
        }
        LoadTimerKind::Gaussian {
            mean,
            standard_deviation,
        } => {
            let u1 = random().max(f64::MIN_POSITIVE);
            let u2 = random();
            let z = (-2.0 * u1.ln()).sqrt() * (core::f64::consts::TAU * u2).cos();
            Duration::from_secs_f64(
                (mean.as_secs_f64() + z * standard_deviation.as_secs_f64()).max(0.0),
            )
        }
        // Uma chegada de processo de Poisson é exponencialmente distribuída.
        LoadTimerKind::Poisson { mean } => {
            Duration::from_secs_f64((-random().max(f64::MIN_POSITIVE).ln()) * mean.as_secs_f64())
        }
    }
}

fn extract_value(kind: &LoadExtractKind, response: &str) -> Result<String, String> {
    match kind {
        LoadExtractKind::JsonPointer { pointer } => {
            let value: serde_json::Value = serde_json::from_str(response)
                .map_err(|error| format!("response is not valid JSON: {error}"))?;
            let extracted = value
                .pointer(pointer)
                .ok_or_else(|| format!("JSON Pointer '{pointer}' did not match a value"))?;
            match extracted {
                serde_json::Value::String(value) => Ok(value.clone()),
                value => serde_json::to_string(value)
                    .map_err(|error| format!("failed to serialize extracted JSON value: {error}")),
            }
        }
        LoadExtractKind::Regex { pattern, group } => {
            let regex = Regex::new(pattern)
                .map_err(|error| format!("invalid regular expression at execution: {error}"))?;
            regex
                .captures(response)
                .and_then(|captures| captures.get(*group))
                .map(|value| value.as_str().to_string())
                .ok_or_else(|| format!("regular expression did not match capture group {group}"))
        }
        LoadExtractKind::XPath { expression } => {
            let package = xml_parser::parse(response)
                .map_err(|error| format!("response is not valid XML: {error}"))?;
            let xpath = XPathFactory::new()
                .build(expression)
                .map_err(|error| format!("invalid XPath at execution: {error}"))?
                .ok_or_else(|| "XPath does not select a value".to_string())?;
            match xpath
                .evaluate(&XPathContext::new(), package.as_document().root())
                .map_err(|error| format!("XPath evaluation failed: {error}"))?
            {
                XPathValue::Nodeset(nodes) => nodes
                    .document_order_first()
                    .map(|node| node.string_value())
                    .ok_or_else(|| "XPath did not match a value".to_string()),
                value => Ok(value.string()),
            }
        }
        LoadExtractKind::Css {
            selector,
            attribute,
        } => {
            let selector = Selector::parse(selector)
                .map_err(|error| format!("invalid CSS selector at execution: {error}"))?;
            let document = Html::parse_document(response);
            let element = document
                .select(&selector)
                .next()
                .ok_or_else(|| "CSS selector did not match an element".to_string())?;
            match attribute {
                Some(attribute) => element
                    .value()
                    .attr(attribute)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        format!("CSS selector matched but has no '{attribute}' attribute")
                    }),
                None => Ok(element.text().collect()),
            }
        }
    }
}

fn is_runtime_variable_name(name: &str) -> bool {
    !name.trim().is_empty()
        && !name.starts_with("__")
        && !name.contains(['{', '}'])
        && name.trim() == name
}

fn group_duration(duration: Duration, timer_waited: Duration, include_timers: bool) -> Duration {
    if include_timers {
        duration
    } else {
        duration.saturating_sub(timer_waited)
    }
}

struct VariableScope {
    state: VuState,
    name: String,
    previous: Option<String>,
}
impl Drop for VariableScope {
    fn drop(&mut self) {
        let mut state = lock_vu_state(&self.state);
        match self.previous.take() {
            Some(value) => {
                state.variables_mut().insert(self.name.clone(), value);
            }
            None => {
                state.variables_mut().remove(&self.name);
            }
        }
    }
}

fn resolve_template(value: &str, variables: &BTreeMap<String, String>) -> Option<String> {
    let mut result = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("{{") {
        result.push_str(&remaining[..start]);
        let tail = &remaining[start + 2..];
        let end = tail.find("}}")?;
        result.push_str(variables.get(tail[..end].trim())?);
        remaining = &tail[end + 2..];
    }
    result.push_str(remaining);
    Some(result)
}

fn resolve_dynamic_items(
    node_id: &str,
    variable: &str,
    max_items: usize,
    variables: &BTreeMap<String, String>,
) -> Result<Vec<String>, LoadExecutionError> {
    let source = variables
        .get(variable)
        .ok_or_else(|| LoadExecutionError::Variables {
            node_id: node_id.into(),
        })?;
    let value: serde_json::Value =
        serde_json::from_str(source).map_err(|error| LoadExecutionError::ForEach {
            node_id: node_id.into(),
            message: format!("a variável '{variable}' não contém um array JSON válido: {error}"),
        })?;
    let values = value
        .as_array()
        .ok_or_else(|| LoadExecutionError::ForEach {
            node_id: node_id.into(),
            message: format!("a variável '{variable}' precisa conter um array JSON"),
        })?;
    if values.len() > max_items {
        return Err(LoadExecutionError::ForEach {
            node_id: node_id.into(),
            message: format!(
                "a variável '{variable}' contém {} itens, acima de maxItems ({max_items})",
                values.len()
            ),
        });
    }
    values
        .iter()
        .map(|value| match value {
            serde_json::Value::String(value) => Ok(value.clone()),
            value => serde_json::to_string(value).map_err(|error| LoadExecutionError::ForEach {
                node_id: node_id.into(),
                message: format!("não foi possível serializar item dinâmico: {error}"),
            }),
        })
        .collect()
}

async fn yield_execution() {
    let mut yielded = false;
    std::future::poll_fn(|context| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            context.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    })
    .await;
}

fn lock_vu_state(state: &VuState) -> std::sync::MutexGuard<'_, LoadVuState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_metrics(metrics: &Metrics) -> std::sync::MutexGuard<'_, LoadMetricRegistry> {
    metrics
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn http_method_name(method: HttpMethod) -> &'static str {
    match method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Put => "PUT",
        HttpMethod::Patch => "PATCH",
        HttpMethod::Delete => "DELETE",
        HttpMethod::Head => "HEAD",
        HttpMethod::Options => "OPTIONS",
    }
}
