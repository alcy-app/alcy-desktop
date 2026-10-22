//! Regressões pela API pública, sem compilar grafos ou depender de alcy-app.

use std::collections::BTreeMap;
use std::future::pending;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use alcy_domain::{
    Endpoint, ExecutionError, HeaderEntry, HttpMethod, RedirectPolicy, Request, Response,
    ResponseMetadata,
};
use alcy_load::*;

#[derive(Default)]
struct Transport(AtomicU64);
impl LoadTransport for Transport {
    async fn execute(&self, _request: &Request) -> Result<Response, ExecutionError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(Response::new(
            200,
            0,
            "",
            vec![],
            ResponseMetadata::default(),
        ))
    }
}

struct InstrumentedTransport;
impl LoadTransport for InstrumentedTransport {
    async fn execute(&self, _request: &Request) -> Result<Response, ExecutionError> {
        Ok(Response::new(
            200,
            0,
            "",
            vec![],
            ResponseMetadata::default(),
        ))
    }

    async fn execute_instrumented(
        &self,
        _request: &Request,
    ) -> Result<LoadTransportResponse, ExecutionError> {
        Ok(LoadTransportResponse::new(
            Response::new(200, 0, "", vec![], ResponseMetadata::default()),
            LoadRequestTimings {
                dns: Some(Duration::from_millis(1)),
                connecting: Some(Duration::from_millis(2)),
                tls_handshaking: Some(Duration::from_millis(3)),
                sending: Some(Duration::from_millis(4)),
                waiting: Some(Duration::from_millis(5)),
                receiving: Some(Duration::from_millis(6)),
                total: Duration::ZERO,
            },
        ))
    }
}

#[derive(Default)]
struct SlowTransport(AtomicU64);
impl LoadTransport for SlowTransport {
    async fn execute(&self, _request: &Request) -> Result<Response, ExecutionError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(30)).await;
        Ok(Response::new(
            200,
            0,
            "",
            vec![],
            ResponseMetadata::default(),
        ))
    }
}

struct Cancellation(bool);
impl LoadCancellation for Cancellation {
    fn is_cancelled(&self) -> bool {
        self.0
    }
    async fn cancelled(&self) {
        if !self.0 {
            pending().await
        }
    }
}

#[derive(Default)]
struct Sink(Mutex<Vec<String>>);
impl LoadRunSink for Sink {
    fn progress(&self, _snapshot: LoadRunProgress) {}
    fn scenario_finished(&self, id: &str, _summary: LoadRunSummary) {
        self.0.lock().unwrap().push(id.into());
    }
}

fn plan() -> LoadPlan {
    LoadPlan {
        setup: None,
        teardown: None,
        scenarios: vec![LoadScenarioPlan {
            body: vec![],
            node_id: "scenario".into(),
            label: "Scenario".into(),
            schedule: LoadSchedule::new(LoadExecutor::PerVuIterations {
                vus: 2,
                iterations_per_vu: 3,
                max_duration: None,
            })
            .unwrap(),
            requests: vec![LoadRequestPlan {
                node_id: "request".into(),
                method: HttpMethod::Get,
                endpoint: Endpoint::new("https://example.test/health").unwrap(),
                body: String::new(),
                timeout: None,
                headers: vec![],
                redirect_policy: RedirectPolicy::Follow,
                tags: BTreeMap::new(),
                before: vec![],
                checks: vec![LoadCheckPlan {
                    node_id: "check".into(),
                    name: "status".into(),
                    expected_status: 200,
                }],
                metrics: vec![LoadMetricPlan {
                    node_id: "metric".into(),
                    name: "events".into(),
                    kind: LoadMetricKind::Counter,
                    value: 2.0,
                    tags: BTreeMap::new(),
                }],
            }],
        }],
        thresholds: vec![LoadThreshold {
            selector: LoadMetricSelector {
                name: "events".into(),
                tags: BTreeMap::new(),
            },
            statistic: LoadMetricStatistic::Count,
            comparison: LoadThresholdComparison::Equal,
            target: 12.0,
        }],
    }
}

#[tokio::test]
async fn rejects_resource_limits_before_effects_and_allows_explicit_overrides() {
    let p = plan();
    let transport = Transport::default();
    for limits in [
        LoadRunLimits {
            max_total_vus: 1,
            ..LoadRunLimits::default()
        },
        LoadRunLimits {
            max_steps_per_iteration: 2,
            ..LoadRunLimits::default()
        },
        LoadRunLimits {
            max_scenarios: 0,
            ..LoadRunLimits::default()
        },
        LoadRunLimits {
            max_script_workers: 0,
            ..LoadRunLimits::default()
        },
        LoadRunLimits {
            max_trend_sample_bytes: 7,
            ..LoadRunLimits::default()
        },
    ] {
        let error = execute_load_plan_report_with_limits(
            &p,
            &transport,
            &Sink::default(),
            &Cancellation(false),
            &limits,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, LoadExecutionError::InvalidPlan(_)));
        assert_eq!(transport.0.load(Ordering::Relaxed), 0);
    }
    let mut p = plan();
    // Excede o limite default de cenários, mas cabe em um budget explícito.
    for n in 1..65 {
        let mut s = p.scenarios[0].clone();
        s.node_id = format!("scenario-{n}");
        p.scenarios.push(s);
    }
    p.thresholds[0].target = 65.0 * 12.0;
    assert!(matches!(
        p.validate(),
        Err(LoadPlanError::ResourceLimit {
            resource: "cenários",
            ..
        })
    ));
    let limits = LoadRunLimits {
        max_scenarios: 65,
        ..LoadRunLimits::default()
    };
    let report = execute_load_plan_report_with_limits(
        &p,
        &transport,
        &Sink::default(),
        &Cancellation(false),
        &limits,
    )
    .await
    .unwrap();
    assert!(report.passed);
    assert_eq!(report.summary.requests, 65 * 6);
}

#[test]
fn accounts_for_concurrent_peaks_and_timer_duration() {
    let mut p = plan();
    let mut s = p.scenarios[0].clone();
    s.node_id = "second".into();
    p.scenarios.push(s);
    let limits = LoadRunLimits {
        max_total_vus: 3,
        ..LoadRunLimits::default()
    };
    assert!(matches!(
        p.validate_with_limits(&limits),
        Err(LoadPlanError::ResourceLimit {
            required: 4,
            limit: 3,
            ..
        })
    ));
    p.scenarios[0].requests[0]
        .before
        .push(LoadIterationAction::Timer(LoadTimerPlan {
            node_id: "timer".into(),
            kind: LoadTimerKind::Fixed(Duration::MAX),
        }));
    assert!(matches!(
        p.validate(),
        Err(LoadPlanError::ResourceLimit {
            resource: "duração configurada (ns)",
            ..
        })
    ));
}

#[test]
fn normalizes_open_rates_before_allocating_workers() {
    let mut p = plan();
    for executor in [
        LoadExecutor::ConstantArrivalRate {
            rate: 2,
            time_unit: Duration::from_nanos(1),
            duration: Duration::from_secs(1),
            pre_allocated_vus: 1,
            max_vus: None,
        },
        LoadExecutor::RampingArrivalRate {
            start_rate: 1,
            time_unit: Duration::from_millis(1),
            stages: vec![LoadStage {
                target: 200,
                duration: Duration::from_secs(1),
            }],
            pre_allocated_vus: 1,
            max_vus: None,
        },
    ] {
        p.scenarios[0].schedule = LoadSchedule::new(executor).unwrap();
        assert!(matches!(
            p.validate(),
            Err(LoadPlanError::ResourceLimit {
                resource: "taxa de chegada por cenário (/s)",
                ..
            })
        ));
    }
}

#[tokio::test]
async fn exhausted_sample_budget_fails_instead_of_truncating_or_passing_thresholds() {
    let limits = LoadRunLimits {
        max_trend_sample_bytes: 8,
        ..LoadRunLimits::default()
    };
    let transport = Transport::default();
    let error = execute_load_plan_report_with_limits(
        &plan(),
        &transport,
        &Sink::default(),
        &Cancellation(false),
        &limits,
    )
    .await
    .unwrap_err();
    assert!(matches!(
        error,
        LoadExecutionError::Metric(LoadMetricError::SampleStorageLimit { limit: 8 })
    ));
    assert_eq!(transport.0.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn executes_typed_plan_and_reports_metrics_without_desktop() {
    let report = execute_load_plan_report(
        &plan(),
        &Transport::default(),
        &Sink::default(),
        &Cancellation(false),
    )
    .await
    .unwrap();
    assert!(report.passed);
    assert_eq!(report.summary.completed_iterations, 6);
    assert_eq!(report.summary.requests, 6);
    assert_eq!(report.summary.checks_passed, 6);
    assert_eq!(report.thresholds[0].actual, Some(12.0));
    assert!(!report.metrics.iter().any(|metric| {
        matches!(
            metric.selector.name.as_str(),
            "http_req_dns"
                | "http_req_connecting"
                | "http_req_tls_handshaking"
                | "http_req_sending"
                | "http_req_waiting"
                | "http_req_receiving"
        )
    }));
}

#[tokio::test]
async fn records_only_explicit_transport_phase_timings() {
    let mut p = plan();
    p.scenarios[0].schedule = LoadSchedule::new(LoadExecutor::PerVuIterations {
        vus: 1,
        iterations_per_vu: 1,
        max_duration: None,
    })
    .unwrap();
    p.thresholds.clear();

    let report = execute_load_plan_report(
        &p,
        &InstrumentedTransport,
        &Sink::default(),
        &Cancellation(false),
    )
    .await
    .unwrap();
    for (name, expected) in [
        ("http_req_dns", 1.0),
        ("http_req_connecting", 2.0),
        ("http_req_tls_handshaking", 3.0),
        ("http_req_sending", 4.0),
        ("http_req_waiting", 5.0),
        ("http_req_receiving", 6.0),
    ] {
        let metric = report
            .metrics
            .iter()
            .find(|metric| metric.selector.name == name)
            .unwrap();
        assert_eq!(metric.count, 1);
        assert_eq!(metric.average, Some(expected));
    }
    assert!(
        report
            .metrics
            .iter()
            .any(|metric| metric.selector.name == "http_req_duration")
    );
}

#[tokio::test]
async fn request_timeout_fails_the_request_without_leaking_the_iteration() {
    let mut p = plan();
    p.scenarios[0].schedule = LoadSchedule::new(LoadExecutor::PerVuIterations {
        vus: 1,
        iterations_per_vu: 1,
        max_duration: None,
    })
    .unwrap();
    p.scenarios[0].requests[0].timeout = Some(Duration::from_millis(1));
    p.thresholds.clear();
    let transport = SlowTransport::default();

    let report = execute_load_plan_report(&p, &transport, &Sink::default(), &Cancellation(false))
        .await
        .unwrap();

    assert_eq!(transport.0.load(Ordering::Relaxed), 1);
    assert_eq!(report.summary.completed_iterations, 1);
    assert_eq!(report.summary.requests, 1);
    assert_eq!(report.summary.failed_requests, 1);
    assert!(
        report
            .metrics
            .iter()
            .any(|metric| metric.selector.name == "http_req_duration")
    );
}

#[test]
fn rejects_a_zero_request_timeout_before_transport() {
    let mut p = plan();
    p.scenarios[0].requests[0].timeout = Some(Duration::ZERO);
    assert!(matches!(
        p.validate(),
        Err(LoadPlanError::Request { message, .. }) if message == "timeout precisa ser maior que zero"
    ));
}

#[test]
fn rejects_a_request_timeout_above_the_configured_duration_budget() {
    let mut p = plan();
    p.scenarios[0].requests[0].timeout = Some(Duration::from_secs(24 * 60 * 60 + 1));
    assert!(matches!(
        p.validate(),
        Err(LoadPlanError::ResourceLimit {
            resource: "duração configurada (ns)",
            ..
        })
    ));
}

#[tokio::test]
async fn rejects_invalid_manual_plans_before_any_request() {
    let mut invalid_plans = vec![];
    let mut p = plan();
    p.scenarios.clear();
    invalid_plans.push(p);
    let mut p = plan();
    p.scenarios.push(p.scenarios[0].clone());
    invalid_plans.push(p);
    let mut p = plan();
    p.scenarios[0].requests.clear();
    invalid_plans.push(p);
    let mut p = plan();
    p.scenarios[0].requests[0]
        .headers
        .push(HeaderEntry::new("Invalid Header", "v", true).unwrap());
    invalid_plans.push(p);
    let mut p = plan();
    p.scenarios[0].requests[0]
        .before
        .push(LoadIterationAction::ConfigureSession(LoadSessionPlan {
            required_variables: Vec::new(),
            variables: BTreeMap::new(),
            node_id: "session".into(),
            headers: vec![HeaderEntry::new("Invalid Header", "v", true).unwrap()],
            cookies_enabled: None,
        }));
    invalid_plans.push(p);
    for value in [f64::NAN, f64::INFINITY, -1.0] {
        let mut p = plan();
        p.scenarios[0].requests[0].metrics[0].value = value;
        invalid_plans.push(p);
    }
    let mut p = plan();
    let mut metric = p.scenarios[0].requests[0].metrics[0].clone();
    metric.kind = LoadMetricKind::Gauge;
    p.scenarios[0].requests[0].metrics.push(metric);
    invalid_plans.push(p);
    let mut p = plan();
    p.thresholds[0].selector.name = "unknown".into();
    invalid_plans.push(p);
    let mut p = plan();
    p.thresholds[0].statistic = LoadMetricStatistic::Rate;
    invalid_plans.push(p);
    let mut p = plan();
    p.thresholds[0].target = f64::NAN;
    invalid_plans.push(p);
    for p in invalid_plans {
        let transport = Transport::default();
        let error =
            execute_load_plan_report(&p, &transport, &Sink::default(), &Cancellation(false))
                .await
                .unwrap_err();
        assert!(matches!(error, LoadExecutionError::InvalidPlan(_)));
        assert_eq!(transport.0.load(Ordering::Relaxed), 0);
    }
}

#[tokio::test]
async fn already_cancelled_plan_does_not_dispatch_requests() {
    let transport = Transport::default();
    let report =
        execute_load_plan_report(&plan(), &transport, &Sink::default(), &Cancellation(true))
            .await
            .unwrap();
    assert!(report.summary.cancelled);
    assert!(!report.passed);
    assert_eq!(transport.0.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn ramping_vus_waits_for_in_flight_iterations_during_graceful_ramp_down() {
    let plan = LoadPlan {
        setup: None,
        teardown: None,
        scenarios: vec![LoadScenarioPlan {
            body: vec![],
            node_id: "ramp".into(),
            label: "Ramp".into(),
            schedule: LoadSchedule::new(LoadExecutor::RampingVus {
                start_vus: 1,
                stages: vec![LoadStage {
                    target: 1,
                    duration: Duration::from_millis(10),
                }],
                graceful_ramp_down: Duration::from_millis(80),
            })
            .unwrap(),
            requests: vec![LoadRequestPlan {
                node_id: "slow".into(),
                method: HttpMethod::Get,
                endpoint: Endpoint::new("https://example.test/slow").unwrap(),
                body: String::new(),
                timeout: None,
                headers: vec![],
                redirect_policy: RedirectPolicy::Follow,
                tags: BTreeMap::new(),
                before: vec![],
                checks: vec![],
                metrics: vec![],
            }],
        }],
        thresholds: vec![],
    };
    let transport = SlowTransport::default();

    let report =
        execute_load_plan_report(&plan, &transport, &Sink::default(), &Cancellation(false))
            .await
            .unwrap();

    assert!(!report.summary.cancelled);
    assert_eq!(report.summary.completed_iterations, 1);
    assert_eq!(report.summary.dropped_iterations, 0);
    assert_eq!(transport.0.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn scenarios_are_polled_concurrently_and_finish_independently() {
    // O segundo cenário conclui enquanto o primeiro está esperando. Falha
    // caso a execução serialize acidentalmente as futures dos cenários.
    let mut p = plan();
    let mut second = p.scenarios[0].clone();
    second.node_id = "second".into();
    p.scenarios[0].requests[0]
        .before
        .push(LoadIterationAction::Timer(LoadTimerPlan {
            node_id: "timer".into(),
            kind: LoadTimerKind::Fixed(Duration::from_millis(30)),
        }));
    p.scenarios.push(second);
    p.thresholds[0].target = 24.0;
    let sink = Sink::default();
    let report = execute_load_plan_report(&p, &Transport::default(), &sink, &Cancellation(false))
        .await
        .unwrap();
    assert!(report.passed);
    assert_eq!(report.summary.completed_iterations, 12);
    assert_eq!(sink.0.lock().unwrap()[0], "second");
}
