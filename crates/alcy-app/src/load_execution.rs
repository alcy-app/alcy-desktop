//! Adaptadores de flows e portas da aplicação para o runner independente.

use crate::{FlowCancellation, LoadFlowError, LoadFlowPlan, RequestExecutor, plan_load_flow};
use alcy_domain::Flow;
use alcy_load::{LoadCancellation, LoadTransport};
use thiserror::Error;

use crate::LoadMetricError;
pub use alcy_load::{
    LOAD_PROGRESS_INTERVAL, LoadRequestSample, LoadRunAccumulator, LoadRunProgress, LoadRunReport,
    LoadRunSink, LoadRunSummary,
};
#[derive(Debug, Error)]
pub enum LoadExecutionError {
    #[error(transparent)]
    InvalidFlow(#[from] LoadFlowError),
    #[error(transparent)]
    Metric(#[from] LoadMetricError),
    #[error(transparent)]
    InvalidPlan(alcy_load::LoadPlanError),
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
    #[error("cenário '{scenario_id}' usa o executor '{executor}', que ainda não é executável")]
    UnsupportedExecutor {
        scenario_id: String,
        executor: &'static str,
    },
}

impl From<alcy_load::LoadExecutionError> for LoadExecutionError {
    fn from(error: alcy_load::LoadExecutionError) -> Self {
        match error {
            alcy_load::LoadExecutionError::InvalidPlan(error) => Self::InvalidPlan(error),
            alcy_load::LoadExecutionError::Metric(error) => Self::Metric(error),
            alcy_load::LoadExecutionError::LifecycleTimeout { node_id } => {
                Self::LifecycleTimeout { node_id }
            }
            alcy_load::LoadExecutionError::Variables { node_id } => Self::Variables { node_id },
            alcy_load::LoadExecutionError::DatasetExhausted { node_id } => {
                Self::DatasetExhausted { node_id }
            }
            alcy_load::LoadExecutionError::ForEach { node_id, message } => {
                Self::ForEach { node_id, message }
            }
            alcy_load::LoadExecutionError::Extract { node_id, message } => {
                Self::Extract { node_id, message }
            }
            alcy_load::LoadExecutionError::Script { node_id, message } => {
                Self::Script { node_id, message }
            }
            alcy_load::LoadExecutionError::UnsupportedExecutor {
                scenario_id,
                executor,
            } => Self::UnsupportedExecutor {
                scenario_id,
                executor,
            },
        }
    }
}

struct TransportAdapter<'a, E>(&'a E);
impl<E: RequestExecutor + Sync> LoadTransport for TransportAdapter<'_, E> {
    fn execute(
        &self,
        request: &alcy_domain::Request,
    ) -> impl std::future::Future<
        Output = Result<alcy_domain::Response, alcy_domain::ExecutionError>,
    > + Send {
        self.0.execute(request)
    }

    async fn execute_instrumented(
        &self,
        request: &alcy_domain::Request,
    ) -> Result<alcy_load::LoadTransportResponse, alcy_domain::ExecutionError> {
        self.0.execute_instrumented(request).await.map(|exchange| {
            alcy_load::LoadTransportResponse::new(
                exchange.response,
                alcy_load::LoadRequestTimings {
                    dns: exchange.timings.dns,
                    connecting: exchange.timings.connecting,
                    tls_handshaking: exchange.timings.tls_handshaking,
                    sending: exchange.timings.sending,
                    waiting: exchange.timings.waiting,
                    receiving: exchange.timings.receiving,
                    total: std::time::Duration::ZERO,
                },
            )
        })
    }
}

struct CancellationAdapter<'a, C>(&'a C);
impl<C: FlowCancellation> LoadCancellation for CancellationAdapter<'_, C> {
    fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }
    fn cancelled(&self) -> impl std::future::Future<Output = ()> + Send {
        self.0.cancelled()
    }
}

/// Compila um `Flow` persistido e o delega para o runner reutilizável.
/// Adaptadores de desktop usam esta conveniência; ferramentas Rust podem
/// compilar a própria fonte para `LoadFlowPlan` e chamar
/// [`execute_load_plan`] sem depender do grafo de flows.
pub async fn execute_load_flow<E, S, C>(
    flow: &Flow,
    executor: &E,
    sink: &S,
    cancellation: &C,
) -> Result<LoadRunSummary, LoadExecutionError>
where
    E: RequestExecutor + Sync,
    S: LoadRunSink,
    C: FlowCancellation,
{
    Ok(execute_load_flow_report(flow, executor, sink, cancellation)
        .await?
        .summary)
}

/// Variante detalhada da execução de um flow persistido. Mantém as métricas
/// agregadas e o resultado dos thresholds fora do canal de progresso.
pub async fn execute_load_flow_report<E, S, C>(
    flow: &Flow,
    executor: &E,
    sink: &S,
    cancellation: &C,
) -> Result<LoadRunReport, LoadExecutionError>
where
    E: RequestExecutor + Sync,
    S: LoadRunSink,
    C: FlowCancellation,
{
    let plan = plan_load_flow(flow)?;
    execute_load_plan_report(&plan, executor, sink, cancellation).await
}

/// Executa um plano de carga canônico sem depender de Tauri, armazenamento ou
/// `Flow`. Cada cenário mantém workers concorrentes, e todos os cenários são
/// iniciados simultaneamente. Este é o ponto de entrada para futuros binários
/// Rust que exponham o runner fora do desktop.
pub async fn execute_load_plan<E, S, C>(
    plan: &LoadFlowPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
) -> Result<LoadRunSummary, LoadExecutionError>
where
    E: RequestExecutor + Sync,
    S: LoadRunSink,
    C: FlowCancellation,
{
    Ok(execute_load_plan_report(plan, executor, sink, cancellation)
        .await?
        .summary)
}

/// Executa um plano e preserva o relatório agregado para CLI, histórico ou
/// UI. Nenhuma amostra de resposta cruza esta fronteira.
pub async fn execute_load_plan_report<E, S, C>(
    plan: &LoadFlowPlan,
    executor: &E,
    sink: &S,
    cancellation: &C,
) -> Result<LoadRunReport, LoadExecutionError>
where
    E: RequestExecutor + Sync,
    S: LoadRunSink,
    C: FlowCancellation,
{
    Ok(alcy_load::execute_load_plan_report(
        plan,
        &TransportAdapter(executor),
        sink,
        &CancellationAdapter(cancellation),
    )
    .await?)
}

#[cfg(test)]
mod tests {
    use alcy_domain::Request;
    use std::collections::BTreeMap;
    use std::future::pending;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, UNIX_EPOCH};

    use alcy_domain::{
        FlowEdge, FlowExecutionKind, FlowNode, FlowNodeKind, FlowPosition, LoadNode, LoadNodeKind,
        Response, ResponseMetadata,
    };
    use serde_json::json;

    use super::*;
    use crate::{InstrumentedResponse, RequestExecutionTimings};

    struct SuccessfulExecutor(AtomicU64);

    impl RequestExecutor for SuccessfulExecutor {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(Response::new(
                200,
                1,
                "",
                Vec::new(),
                ResponseMetadata::default(),
            ))
        }
    }

    struct InstrumentedExecutor;

    impl RequestExecutor for InstrumentedExecutor {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            unreachable!("the load adapter must use the instrumented execution path")
        }

        async fn execute_instrumented(
            &self,
            _request: &Request,
        ) -> Result<InstrumentedResponse, alcy_domain::ExecutionError> {
            Ok(InstrumentedResponse {
                response: Response::new(200, 0, "", Vec::new(), ResponseMetadata::default()),
                timings: RequestExecutionTimings {
                    waiting: Some(Duration::from_millis(4)),
                    receiving: Some(Duration::from_millis(2)),
                    ..RequestExecutionTimings::default()
                },
            })
        }
    }

    struct DelayedExecutor {
        calls: AtomicU64,
        delay: Duration,
    }

    impl RequestExecutor for DelayedExecutor {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(self.delay).await;
            Ok(Response::new(
                200,
                self.delay.as_millis() as u64,
                "",
                Vec::new(),
                ResponseMetadata::default(),
            ))
        }
    }

    #[derive(Default)]
    struct CookieExecutor {
        calls: AtomicU64,
        received_cookies: Mutex<Vec<Option<String>>>,
    }

    impl RequestExecutor for CookieExecutor {
        async fn execute(
            &self,
            request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            let cookie = request
                .headers
                .iter()
                .find(|header| header.name().eq_ignore_ascii_case("cookie"))
                .map(|header| header.value().to_string());
            self.received_cookies.lock().unwrap().push(cookie);
            let first = self.calls.fetch_add(1, Ordering::Relaxed) == 0;
            Ok(Response::new(
                200,
                1,
                "",
                Vec::new(),
                ResponseMetadata {
                    cookies: first
                        .then(|| alcy_domain::Cookie {
                            name: "sid".to_string(),
                            value: "vu-1".to_string(),
                            ..alcy_domain::Cookie::default()
                        })
                        .into_iter()
                        .collect(),
                    ..ResponseMetadata::default()
                },
            ))
        }
    }

    #[derive(Default)]
    struct SessionExecutor {
        calls: AtomicU64,
        received_headers: Mutex<Vec<(Option<String>, Option<String>)>>,
    }

    impl RequestExecutor for SessionExecutor {
        async fn execute(
            &self,
            request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            let header = |name: &str| {
                request
                    .headers
                    .iter()
                    .find(|header| header.name().eq_ignore_ascii_case(name))
                    .map(|header| header.value().to_string())
            };
            self.received_headers
                .lock()
                .unwrap()
                .push((header("X-Run"), header("Cookie")));
            let first = self.calls.fetch_add(1, Ordering::Relaxed) == 0;
            Ok(Response::new(
                200,
                1,
                "",
                Vec::new(),
                ResponseMetadata {
                    cookies: first
                        .then(|| alcy_domain::Cookie {
                            name: "sid".to_string(),
                            value: "should-not-persist".to_string(),
                            ..alcy_domain::Cookie::default()
                        })
                        .into_iter()
                        .collect(),
                    ..ResponseMetadata::default()
                },
            ))
        }
    }

    struct NeverCancelled;

    impl FlowCancellation for NeverCancelled {
        fn is_cancelled(&self) -> bool {
            false
        }

        async fn cancelled(&self) {
            pending().await
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        finished: Mutex<Vec<(String, LoadRunSummary)>>,
    }

    impl LoadRunSink for RecordingSink {
        fn progress(&self, _snapshot: LoadRunProgress) {}

        fn scenario_finished(&self, scenario_id: &str, summary: LoadRunSummary) {
            self.finished
                .lock()
                .unwrap()
                .push((scenario_id.to_string(), summary));
        }
    }

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

    fn flow(executor: serde_json::Value) -> Flow {
        Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            vec![
                node("scenario", LoadNodeKind::Scenario, executor),
                node(
                    "request",
                    LoadNodeKind::Request,
                    json!({"method":"POST", "url":"https://api.example.test/jobs", "body":"{}"}),
                ),
                node(
                    "check",
                    LoadNodeKind::Check,
                    json!({"name":"status is 200", "status":200}),
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
        .unwrap()
    }

    #[test]
    fn preserves_dynamic_foreach_diagnostics_at_the_application_boundary() {
        let error = LoadExecutionError::from(alcy_load::LoadExecutionError::ForEach {
            node_id: "each".to_string(),
            message: "maxItems excedido".to_string(),
        });
        assert!(matches!(
            error,
            LoadExecutionError::ForEach { node_id, message }
                if node_id == "each" && message == "maxItems excedido"
        ));
    }

    #[tokio::test]
    async fn runs_a_compiled_plan_and_keeps_only_aggregates() {
        let flow = flow(json!({"executor":"sharedIterations", "vus":2, "iterations":3}));
        let plan = plan_load_flow(&flow).unwrap();
        let executor = SuccessfulExecutor(AtomicU64::new(0));
        let sink = RecordingSink::default();

        let summary = execute_load_plan(&plan, &executor, &sink, &NeverCancelled)
            .await
            .unwrap();

        assert_eq!(summary.completed_iterations, 3);
        assert_eq!(summary.requests, 3);
        assert_eq!(summary.checks_passed, 3);
        assert_eq!(executor.0.load(Ordering::Relaxed), 3);
        assert_eq!(sink.finished.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn forwards_concrete_transport_phase_timings_to_load_metrics() {
        let plan = plan_load_flow(&flow(
            json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
        ))
        .unwrap();

        let report = execute_load_plan_report(
            &plan,
            &InstrumentedExecutor,
            &RecordingSink::default(),
            &NeverCancelled,
        )
        .await
        .unwrap();

        for (name, milliseconds) in [("http_req_waiting", 4.0), ("http_req_receiving", 2.0)] {
            let metric = report
                .metrics
                .iter()
                .find(|metric| metric.selector.name == name)
                .unwrap();
            assert_eq!(metric.count, 1);
            assert_eq!(metric.average, Some(milliseconds));
        }
    }

    #[derive(Default)]
    struct UnevenVuExecutor {
        next_id: AtomicU64,
        calls_by_vu: Mutex<BTreeMap<String, u64>>,
    }

    impl RequestExecutor for UnevenVuExecutor {
        async fn execute(
            &self,
            request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            let id = request
                .headers
                .iter()
                .find(|header| header.name().eq_ignore_ascii_case("cookie"))
                .and_then(|header| header.value().strip_prefix("vu="))
                .map(str::to_string)
                .unwrap_or_else(|| self.next_id.fetch_add(1, Ordering::Relaxed).to_string());
            *self
                .calls_by_vu
                .lock()
                .unwrap()
                .entry(id.clone())
                .or_default() += 1;
            if id == "1" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok(Response::new(
                200,
                0,
                "",
                Vec::new(),
                ResponseMetadata {
                    cookies: vec![alcy_domain::Cookie {
                        name: "vu".to_string(),
                        value: id,
                        ..alcy_domain::Cookie::default()
                    }],
                    ..ResponseMetadata::default()
                },
            ))
        }
    }

    #[tokio::test]
    async fn per_vu_iterations_keeps_each_quota_despite_different_worker_speeds() {
        let flow = flow(json!({"executor":"perVuIterations", "vus":2, "iterationsPerVu":3}));
        let executor = UnevenVuExecutor::default();
        let summary =
            execute_load_flow(&flow, &executor, &RecordingSink::default(), &NeverCancelled)
                .await
                .unwrap();
        assert_eq!(summary.completed_iterations, 6);
        assert_eq!(summary.requests, 6);
        assert_eq!(
            *executor.calls_by_vu.lock().unwrap(),
            BTreeMap::from([("0".to_string(), 3), ("1".to_string(), 3),])
        );
    }

    #[tokio::test]
    async fn shared_iterations_still_distributes_available_work_to_fast_workers() {
        let flow = flow(json!({"executor":"sharedIterations", "vus":2, "iterations":6}));
        let executor = UnevenVuExecutor::default();
        let summary =
            execute_load_flow(&flow, &executor, &RecordingSink::default(), &NeverCancelled)
                .await
                .unwrap();
        assert_eq!(summary.completed_iterations, 6);
        let calls = executor.calls_by_vu.lock().unwrap();
        assert!(calls["0"] > calls["1"]);
        assert_eq!(calls.values().sum::<u64>(), 6);
    }

    struct CancelAfterFirstResponse(std::sync::atomic::AtomicBool);

    impl FlowCancellation for CancelAfterFirstResponse {
        fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }

        async fn cancelled(&self) {
            while !self.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }

    impl RequestExecutor for CancelAfterFirstResponse {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            if self.0.swap(true, Ordering::SeqCst) {
                pending().await
            } else {
                Ok(Response::new(
                    200,
                    0,
                    "",
                    Vec::new(),
                    ResponseMetadata::default(),
                ))
            }
        }
    }

    #[tokio::test]
    async fn cancellation_keeps_completed_requests_checks_and_metrics_of_an_unfinished_iteration() {
        let mut plan = plan_load_flow(&flow(
            json!({"executor":"sharedIterations", "vus":1, "iterations":1}),
        ))
        .unwrap();
        let mut next = plan.scenarios[0].requests[0].clone();
        next.node_id = "blocked-request".to_string();
        plan.scenarios[0].requests.push(next);
        let cancellation = CancelAfterFirstResponse(std::sync::atomic::AtomicBool::new(false));
        let report = execute_load_plan_report(
            &plan,
            &cancellation,
            &RecordingSink::default(),
            &cancellation,
        )
        .await
        .unwrap();
        assert!(report.summary.cancelled);
        assert!(!report.passed);
        assert_eq!(report.summary.completed_iterations, 0);
        assert_eq!(report.summary.requests, 1);
        assert_eq!(report.summary.checks_passed, 1);
        assert_eq!(
            report
                .metrics
                .iter()
                .find(|metric| metric.selector.name == "http_requests")
                .unwrap()
                .value,
            1.0
        );
    }

    #[tokio::test]
    async fn keeps_response_cookies_on_the_same_vu() {
        let flow = flow(json!({"executor":"sharedIterations", "vus":1, "iterations":2}));
        let executor = CookieExecutor::default();
        let sink = RecordingSink::default();

        execute_load_flow(&flow, &executor, &sink, &NeverCancelled)
            .await
            .unwrap();

        assert_eq!(
            *executor.received_cookies.lock().unwrap(),
            vec![None, Some("sid=vu-1".to_string())]
        );
    }

    #[tokio::test]
    async fn applies_session_headers_and_disables_cookie_state_for_a_vu() {
        let flow = Flow::new_with_execution_kind(
            "load",
            "Load",
            FlowExecutionKind::Load,
            vec![
                node(
                    "scenario",
                    LoadNodeKind::Scenario,
                    json!({"executor":"sharedIterations", "vus":1, "iterations":2}),
                ),
                node(
                    "session",
                    LoadNodeKind::ConfigureSession,
                    json!({"headers":[{"name":"X-Run", "value":"load"}], "cookiesEnabled":false}),
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
                    id: "session-request".to_string(),
                    source_node_id: "session".to_string(),
                    target_node_id: "request".to_string(),
                    source_handle: None,
                },
            ],
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();
        let executor = SessionExecutor::default();
        let sink = RecordingSink::default();

        execute_load_flow(&flow, &executor, &sink, &NeverCancelled)
            .await
            .unwrap();

        assert_eq!(
            *executor.received_headers.lock().unwrap(),
            vec![
                (Some("load".to_string()), None),
                (Some("load".to_string()), None),
            ]
        );
    }

    #[tokio::test]
    async fn reports_automatic_and_custom_metrics_with_threshold_results() {
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
                    json!({"method":"GET", "url":"https://api.example.test/health", "tags":{"operation":"health"}}),
                ),
                node(
                    "metric",
                    LoadNodeKind::Metric,
                    json!({"name":"business_events", "kind":"counter", "value":2}),
                ),
                node(
                    "request-threshold",
                    LoadNodeKind::Threshold,
                    json!({"metric":"http_requests", "statistic":"value", "comparison":"gte", "target":1}),
                ),
                node(
                    "custom-threshold",
                    LoadNodeKind::Threshold,
                    json!({"metric":"business_events", "statistic":"value", "comparison":"eq", "target":2}),
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
                    id: "request-metric".to_string(),
                    source_node_id: "request".to_string(),
                    target_node_id: "metric".to_string(),
                    source_handle: Some("success".to_string()),
                },
            ],
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();
        let executor = SuccessfulExecutor(AtomicU64::new(0));
        let sink = RecordingSink::default();

        let report = execute_load_flow_report(&flow, &executor, &sink, &NeverCancelled)
            .await
            .unwrap();

        assert!(report.passed);
        assert_eq!(report.thresholds.len(), 2);
        assert!(report.thresholds.iter().all(|threshold| threshold.passed));
        assert!(report.metrics.iter().any(|metric| {
            metric.selector.name == "http_requests"
                && metric.selector.tags.get("operation") == Some(&"health".to_string())
        }));
        assert!(
            report
                .metrics
                .iter()
                .any(|metric| { metric.selector.name == "business_events" && metric.value == 2.0 })
        );
    }

    #[tokio::test]
    async fn runs_constant_vus_until_its_deadline() {
        let flow = flow(json!({"executor":"constantVus", "vus":2, "durationMs":25}));
        let executor = DelayedExecutor {
            calls: AtomicU64::new(0),
            delay: Duration::from_millis(5),
        };
        let sink = RecordingSink::default();

        let summary = execute_load_flow(&flow, &executor, &sink, &NeverCancelled)
            .await
            .unwrap();

        assert!(!summary.cancelled);
        assert!(summary.completed_iterations >= 2);
        assert!(executor.calls.load(Ordering::Relaxed) >= 2);
    }

    #[tokio::test]
    async fn drops_open_arrivals_when_all_vus_are_busy() {
        let flow = flow(json!({
            "executor":"constantArrivalRate",
            "rate":4,
            "timeUnitMs":10,
            "durationMs":20,
            "preAllocatedVus":1
        }));
        let executor = DelayedExecutor {
            calls: AtomicU64::new(0),
            delay: Duration::from_millis(50),
        };
        let sink = RecordingSink::default();

        let summary = execute_load_flow(&flow, &executor, &sink, &NeverCancelled)
            .await
            .unwrap();

        assert!(!summary.cancelled);
        assert_eq!(executor.calls.load(Ordering::Relaxed), 1);
        assert!(summary.dropped_iterations >= 1);
    }
}
