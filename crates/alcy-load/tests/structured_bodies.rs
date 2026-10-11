//! Exercises the public body/lifecycle contract without desktop or filesystem.

use std::collections::BTreeMap;
use std::future::pending;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alcy_domain::{
    Endpoint, ExecutionError, HeaderEntry, HttpMethod, RedirectPolicy, Request, Response,
    ResponseMetadata,
};
use alcy_load::*;

#[derive(Default)]
struct Trace(Mutex<Vec<RecordedRequest>>);
type RecordedRequest = (String, String, Vec<HeaderEntry>);
impl LoadTransport for Trace {
    async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
        self.0.lock().unwrap().push((
            request.endpoint.url().into(),
            request.document.body.clone(),
            request.headers.clone(),
        ));
        if request.endpoint.url().ends_with("/slow") {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(Response::new(
            200,
            0,
            "",
            vec![],
            ResponseMetadata::default(),
        ))
    }
}

struct NeverCancel;
impl LoadCancellation for NeverCancel {
    fn is_cancelled(&self) -> bool {
        false
    }
    async fn cancelled(&self) {
        pending().await
    }
}

struct Sink;
impl LoadRunSink for Sink {
    fn progress(&self, _: LoadRunProgress) {}
    fn scenario_finished(&self, _: &str, _: LoadRunSummary) {}
}

#[derive(Default)]
struct JsonTrace(Mutex<Vec<RecordedRequest>>);
impl LoadTransport for JsonTrace {
    async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
        self.0.lock().unwrap().push((
            request.endpoint.url().into(),
            request.document.body.clone(),
            request.headers.clone(),
        ));
        let body = if request.endpoint.url().ends_with("/source") {
            r#"{"user":{"id":7}}"#
        } else if request.endpoint.url().ends_with("/setup-source") {
            r#"{"items":["red",{"id":7}]}"#
        } else if request.endpoint.url().ends_with("/regex-source") {
            "token=alpha-42"
        } else if request.endpoint.url().ends_with("/xml-source") {
            "<response><id>seven</id></response>"
        } else if request.endpoint.url().ends_with("/html-source") {
            r#"<article><a class="link" href="/docs">Read</a></article>"#
        } else {
            ""
        };
        Ok(Response::new(
            200,
            0,
            body,
            vec![],
            ResponseMetadata::default(),
        ))
    }
}

fn request(id: &str, body: &str) -> LoadRequestPlan {
    LoadRequestPlan {
        node_id: id.into(),
        method: HttpMethod::Post,
        endpoint: Endpoint::new(format!("https://example.test/{id}")).unwrap(),
        body: body.into(),
        timeout: None,
        headers: vec![],
        redirect_policy: RedirectPolicy::Follow,
        tags: BTreeMap::new(),
        before: vec![],
        checks: vec![],
        metrics: vec![],
    }
}

fn plan(body: Vec<LoadStep>) -> LoadPlan {
    LoadPlan {
        setup: None,
        teardown: None,
        thresholds: vec![],
        scenarios: vec![LoadScenarioPlan {
            node_id: "scenario".into(),
            label: "Scenario".into(),
            requests: vec![],
            body,
            schedule: LoadSchedule::new(LoadExecutor::PerVuIterations {
                vus: 2,
                iterations_per_vu: 3,
                max_duration: None,
            })
            .unwrap(),
        }],
    }
}

fn lifecycle(id: &str, body: Vec<LoadStep>) -> LoadLifecyclePlan {
    LoadLifecyclePlan {
        node_id: id.into(),
        body,
        timeout: Duration::from_secs(1),
    }
}

fn metric(id: &str) -> LoadMetricPlan {
    LoadMetricPlan {
        node_id: id.into(),
        name: "events".into(),
        kind: LoadMetricKind::Counter,
        value: 1.0,
        tags: BTreeMap::new(),
    }
}

#[tokio::test]
async fn extract_reads_json_pointer_into_the_current_vu_variables() {
    let p = plan(vec![
        LoadStep::Request(request("source", "")),
        LoadStep::Extract(LoadExtractPlan {
            node_id: "extract".into(),
            name: "user_id".into(),
            kind: LoadExtractKind::JsonPointer {
                pointer: "/user/id".into(),
            },
        }),
        LoadStep::Request(request("target", "{{user_id}}")),
    ]);
    let trace = JsonTrace::default();

    let report = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();

    assert_eq!(report.summary.requests, 12);
    let trace = trace.0.lock().unwrap();
    assert_eq!(
        trace
            .iter()
            .filter(|(url, _, _)| url.ends_with("/target"))
            .map(|(_, body, _)| body.as_str())
            .collect::<Vec<_>>(),
        vec!["7"; 6]
    );
}

#[tokio::test]
async fn extract_reads_regex_xpath_and_css_values_into_the_current_vu_variables() {
    let p = plan(vec![
        LoadStep::Request(request("regex-source", "")),
        LoadStep::Extract(LoadExtractPlan {
            node_id: "regex".into(),
            name: "token".into(),
            kind: LoadExtractKind::Regex {
                pattern: r"token=([a-z]+-\d+)".into(),
                group: 1,
            },
        }),
        LoadStep::Request(request("regex-target", "{{token}}")),
        LoadStep::Request(request("xml-source", "")),
        LoadStep::Extract(LoadExtractPlan {
            node_id: "xpath".into(),
            name: "identifier".into(),
            kind: LoadExtractKind::XPath {
                expression: "//id/text()".into(),
            },
        }),
        LoadStep::Request(request("xpath-target", "{{identifier}}")),
        LoadStep::Request(request("html-source", "")),
        LoadStep::Extract(LoadExtractPlan {
            node_id: "css".into(),
            name: "link".into(),
            kind: LoadExtractKind::Css {
                selector: "a.link".into(),
                attribute: Some("href".into()),
            },
        }),
        LoadStep::Request(request("css-target", "{{link}}")),
    ]);
    let trace = JsonTrace::default();

    execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();

    let trace = trace.0.lock().unwrap();
    for (target, expected) in [
        ("regex-target", "alpha-42"),
        ("xpath-target", "seven"),
        ("css-target", "/docs"),
    ] {
        assert_eq!(
            trace
                .iter()
                .filter(|(url, _, _)| url.ends_with(&format!("/{target}")))
                .map(|(_, body, _)| body.as_str())
                .collect::<Vec<_>>(),
            vec![expected; 6]
        );
    }
}

#[tokio::test]
async fn foreach_uses_a_bounded_json_array_prepared_by_setup() {
    let mut p = plan(vec![LoadStep::ForEach {
        node_id: "each".into(),
        variable: "item".into(),
        items: vec![],
        items_variable: Some("items".into()),
        max_items: Some(2),
        body: vec![LoadStep::Request(request("target", "{{item}}"))],
    }]);
    p.setup = Some(lifecycle(
        "setup",
        vec![
            LoadStep::Request(request("setup-source", "")),
            LoadStep::Extract(LoadExtractPlan {
                node_id: "extract-items".into(),
                name: "items".into(),
                kind: LoadExtractKind::JsonPointer {
                    pointer: "/items".into(),
                },
            }),
        ],
    ));
    let trace = JsonTrace::default();

    execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();

    let trace = trace.0.lock().unwrap();
    let targets: Vec<_> = trace
        .iter()
        .filter(|(url, _, _)| url.ends_with("/target"))
        .map(|(_, body, _)| body.as_str())
        .collect();
    assert_eq!(targets.len(), 12);
    assert_eq!(targets.iter().filter(|body| **body == "red").count(), 6);
    assert_eq!(
        targets
            .iter()
            .filter(|body| **body == r#"{"id":7}"#)
            .count(),
        6
    );
}

#[tokio::test]
async fn foreach_rejects_a_dynamic_array_above_its_declared_limit() {
    let mut p = plan(vec![LoadStep::ForEach {
        node_id: "each".into(),
        variable: "item".into(),
        items: vec![],
        items_variable: Some("items".into()),
        max_items: Some(1),
        body: vec![LoadStep::Request(request("should-not-run", "{{item}}"))],
    }]);
    p.setup = Some(lifecycle(
        "setup",
        vec![
            LoadStep::Request(request("setup-source", "")),
            LoadStep::Extract(LoadExtractPlan {
                node_id: "extract-items".into(),
                name: "items".into(),
                kind: LoadExtractKind::JsonPointer {
                    pointer: "/items".into(),
                },
            }),
        ],
    ));
    let trace = JsonTrace::default();

    let error = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        LoadExecutionError::ForEach { node_id, .. } if node_id == "each"
    ));
    assert!(
        trace
            .0
            .lock()
            .unwrap()
            .iter()
            .all(|(url, _, _)| !url.ends_with("/should-not-run"))
    );
}

#[tokio::test]
async fn script_changes_only_the_runtime_variables_of_its_vu() {
    let p = plan(vec![
        LoadStep::Script(LoadScriptPlan {
            node_id: "script".into(),
            phase: LoadScriptPhase::PreRequest,
            code: "al.runtime.set('token', al.runtime.get('__VU') + '-' + al.iteration.index + '/' + al.iteration.count);".into(),
        }),
        LoadStep::Request(request("scripted", "{{token}}")),
    ]);
    let trace = Trace::default();

    execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();

    let trace = trace.0.lock().unwrap();
    for vu in [1, 2] {
        for iteration in 0..3 {
            assert!(trace.iter().any(|(url, body, _)| {
                url.ends_with("/scripted") && body == &format!("{vu}-{iteration}/3")
            }));
        }
    }
}

#[tokio::test]
async fn script_rejects_effects_outside_the_runtime_scope() {
    let p = plan(vec![LoadStep::Script(LoadScriptPlan {
        node_id: "script".into(),
        phase: LoadScriptPhase::PreRequest,
        code: "al.request.setUrl('https://outside.test');".into(),
    })]);

    let error = execute_load_plan_report(&p, &Trace::default(), &Sink, &NeverCancel)
        .await
        .unwrap_err();

    assert!(matches!(error, LoadExecutionError::Script { .. }));
}

#[tokio::test]
async fn post_response_script_receives_the_last_http_response() {
    let p = plan(vec![
        LoadStep::Request(request("source", "")),
        LoadStep::Script(LoadScriptPlan {
            node_id: "post".into(),
            phase: LoadScriptPhase::PostResponse,
            code: "al.runtime.set('response', al.response.status + ':' + al.response.text());"
                .into(),
        }),
        LoadStep::Request(request("target", "{{response}}")),
    ]);
    let trace = JsonTrace::default();

    execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();

    let trace = trace.0.lock().unwrap();
    assert_eq!(
        trace
            .iter()
            .filter(|(url, _, _)| url.ends_with("/target"))
            .map(|(_, body, _)| body.as_str())
            .collect::<Vec<_>>(),
        vec![r#"200:{"user":{"id":7}}"#; 6]
    );
}

#[tokio::test]
async fn group_can_delimit_tags_without_emitting_a_parent_sample() {
    let p = plan(vec![LoadStep::Group {
        node_id: "group".into(),
        name: "background".into(),
        tags: BTreeMap::from([("source".into(), "import".into())]),
        include_timers: false,
        emit_parent: false,
        body: vec![LoadStep::Metric(metric("events"))],
    }]);

    let report = execute_load_plan_report(&p, &Trace::default(), &Sink, &NeverCancel)
        .await
        .unwrap();

    assert!(report.metrics.iter().any(|metric| {
        metric.selector.name == "events"
            && metric.selector.tags.get("group").map(String::as_str) == Some("::background")
    }));
    assert!(
        !report
            .metrics
            .iter()
            .any(|metric| metric.selector.name == "group_duration")
    );
}

#[tokio::test]
async fn dynamic_control_values_fail_before_their_body_when_a_variable_is_missing() {
    let p = plan(vec![LoadStep::ForEach {
        node_id: "each".into(),
        variable: "item".into(),
        items: vec!["{{missing}}".into()],
        items_variable: None,
        max_items: None,
        body: vec![LoadStep::Request(request("should-not-run", ""))],
    }]);
    let trace = Trace::default();

    let error = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        LoadExecutionError::Variables { node_id } if node_id == "each"
    ));
    assert!(trace.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn select_supports_negative_and_existence_conditions() {
    let p = plan(vec![
        LoadStep::ConfigureSession(LoadSessionPlan {
            node_id: "session".into(),
            headers: vec![],
            cookies_enabled: None,
            variables: BTreeMap::from([("value".into(), "red".into())]),
        }),
        LoadStep::Select {
            node_id: "not-equal".into(),
            variable: "value".into(),
            operator: LoadSelectOperator::NotEquals,
            equals: "blue".into(),
            body: vec![LoadStep::Request(request("not-equal-request", ""))],
        },
        LoadStep::Select {
            node_id: "exists".into(),
            variable: "value".into(),
            operator: LoadSelectOperator::Exists,
            equals: String::new(),
            body: vec![LoadStep::Request(request("exists-request", ""))],
        },
        LoadStep::Select {
            node_id: "not-exists".into(),
            variable: "missing".into(),
            operator: LoadSelectOperator::NotExists,
            equals: String::new(),
            body: vec![LoadStep::Request(request("not-exists-request", ""))],
        },
        LoadStep::Select {
            node_id: "skipped".into(),
            variable: "value".into(),
            operator: LoadSelectOperator::NotEquals,
            equals: "red".into(),
            body: vec![LoadStep::Request(request("must-not-run", ""))],
        },
    ]);
    let trace = Trace::default();

    execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();

    let trace = trace.0.lock().unwrap();
    for id in ["not-equal-request", "exists-request", "not-exists-request"] {
        assert_eq!(
            trace
                .iter()
                .filter(|(url, _, _)| url.ends_with(&format!("/{id}")))
                .count(),
            6
        );
    }
    assert!(
        trace
            .iter()
            .all(|(url, _, _)| !url.ends_with("must-not-run"))
    );
}

#[test]
fn extract_requires_a_preceding_request_and_a_valid_definition() {
    let invalid = plan(vec![LoadStep::Extract(LoadExtractPlan {
        node_id: "extract".into(),
        name: "value".into(),
        kind: LoadExtractKind::JsonPointer {
            pointer: "missing-slash".into(),
        },
    })]);

    assert!(invalid.validate().is_err());

    let invalid_regex = plan(vec![
        LoadStep::Request(request("source", "")),
        LoadStep::Extract(LoadExtractPlan {
            node_id: "regex".into(),
            name: "value".into(),
            kind: LoadExtractKind::Regex {
                pattern: "(".into(),
                group: 1,
            },
        }),
    ]);
    assert!(invalid_regex.validate().is_err());
}

#[test]
fn post_response_script_requires_a_preceding_request() {
    let invalid = plan(vec![LoadStep::Script(LoadScriptPlan {
        node_id: "script".into(),
        phase: LoadScriptPhase::PostResponse,
        code: "al.runtime.set('value', 'ok');".into(),
    })]);

    assert!(invalid.validate().is_err());
}

#[tokio::test]
async fn lifecycle_and_nested_controls_preserve_vu_state_order_and_tag_scopes() {
    let mut p = plan(vec![
        LoadStep::OncePerVu {
            node_id: "once".into(),
            body: vec![LoadStep::Request(request("warm", "{{__VU}}"))],
        },
        LoadStep::Repeat {
            node_id: "repeat".into(),
            count: 2,
            body: vec![LoadStep::ForEach {
                node_id: "each".into(),
                variable: "item".into(),
                items: vec!["red".into(), "{{choice}}".into()],
                items_variable: None,
                max_items: None,
                body: vec![LoadStep::Group {
                    node_id: "group".into(),
                    name: "work".into(),
                    tags: BTreeMap::from([("phase".into(), "nested".into())]),
                    include_timers: true,
                    emit_parent: true,
                    body: vec![LoadStep::Select {
                        node_id: "select".into(),
                        variable: "item".into(),
                        operator: LoadSelectOperator::Equals,
                        equals: "{{choice}}".into(),
                        body: vec![
                            LoadStep::Request(request(
                                "job",
                                "{{token}}/{{item}}/{{__VU}}/{{__ITER}}",
                            )),
                            LoadStep::Check(LoadCheckPlan {
                                node_id: "check".into(),
                                name: "ok".into(),
                                expected_status: 200,
                            }),
                            LoadStep::Metric(metric("emit")),
                        ],
                    }],
                }],
            }],
        },
        LoadStep::Request(request("outside", "{{item}}")),
    ]);
    p.setup = Some(lifecycle(
        "setup",
        vec![
            LoadStep::Request(request("prepare", "")),
            LoadStep::ConfigureSession(LoadSessionPlan {
                node_id: "seed".into(),
                headers: vec![],
                cookies_enabled: None,
                variables: BTreeMap::from([
                    ("token".into(), "shared".into()),
                    ("item".into(), "outer".into()),
                    ("choice".into(), "blue".into()),
                ]),
            }),
        ],
    ));
    p.teardown = Some(lifecycle(
        "teardown",
        vec![LoadStep::Request(request("finish", "{{token}}"))],
    ));
    p.thresholds.push(LoadThreshold {
        selector: LoadMetricSelector {
            name: "events".into(),
            tags: BTreeMap::from([("group".into(), "::work".into())]),
        },
        statistic: LoadMetricStatistic::Count,
        comparison: LoadThresholdComparison::Equal,
        target: 12.0,
    });
    let trace = Trace::default();
    let report = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();
    assert!(report.passed);
    assert_eq!(report.summary.completed_iterations, 6);
    assert_eq!(report.summary.requests, 22);
    assert_eq!(report.summary.checks_passed, 12);
    let trace = trace.0.lock().unwrap();
    assert!(trace.first().unwrap().0.ends_with("/prepare"));
    assert!(trace.last().unwrap().0.ends_with("/finish"));
    assert_eq!(trace.iter().filter(|r| r.0.ends_with("/warm")).count(), 2);
    assert!(
        trace
            .iter()
            .filter(|r| r.0.ends_with("/outside"))
            .all(|r| r.1 == "outer")
    );
    for vu in [1, 2] {
        let expected: Vec<_> = (0..3)
            .flat_map(|iteration| std::iter::repeat_n(format!("shared/blue/{vu}/{iteration}"), 2))
            .collect();
        let actual: Vec<_> = trace
            .iter()
            .filter(|r| r.0.ends_with("/job") && r.1.contains(&format!("/blue/{vu}/")))
            .map(|r| r.1.clone())
            .collect();
        assert_eq!(actual, expected);
    }
    assert!(
        report
            .metrics
            .iter()
            .filter(|m| m.selector.name == "http_requests"
                && m.selector.tags.get("request").map(String::as_str) == Some("outside"))
            .all(|m| !m.selector.tags.contains_key("group"))
    );
}

fn dataset(id: &str, name: &str, values: &[&str], recycle: bool) -> LoadStep {
    LoadStep::Dataset(LoadDatasetPlan {
        node_id: id.into(),
        recycle,
        rows: values
            .iter()
            .map(|value| BTreeMap::from([(name.into(), (*value).into())]))
            .collect::<Vec<_>>()
            .into(),
    })
}

#[tokio::test]
async fn dataset_cursors_are_independent_by_dataset_and_vu() {
    let p = plan(vec![
        dataset("first", "a", &["0", "1"], true),
        dataset("second", "b", &["z"], true),
        LoadStep::Request(request("data", "{{__VU}}/{{a}}/{{b}}")),
    ]);
    let trace = Trace::default();
    let report = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap();
    assert_eq!(report.summary.requests, 6);
    let trace = trace.0.lock().unwrap();
    for vu in [1, 2] {
        let actual: Vec<_> = trace
            .iter()
            .filter(|r| r.1.starts_with(&format!("{vu}/")))
            .map(|r| r.1.clone())
            .collect();
        assert_eq!(
            actual,
            vec![
                format!("{vu}/0/z"),
                format!("{vu}/1/z"),
                format!("{vu}/0/z")
            ]
        );
    }
}

#[tokio::test]
async fn exhausted_dataset_aborts_scenarios_and_runs_teardown_once() {
    let mut p = plan(vec![
        dataset("data", "a", &["one"], false),
        LoadStep::Request(request("job", "{{a}}")),
    ]);
    p.teardown = Some(lifecycle(
        "teardown",
        vec![
            LoadStep::Request(request("finish", "")),
            LoadStep::Request(request("cleanup-fails", "{{unknown}}")),
        ],
    ));
    let trace = Trace::default();
    let error = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap_err();
    assert!(matches!(error, LoadExecutionError::DatasetExhausted { .. }));
    let trace = trace.0.lock().unwrap();
    assert_eq!(trace.iter().filter(|r| r.0.ends_with("/finish")).count(), 1);
    assert!(trace.last().unwrap().0.ends_with("/finish"));
}

#[tokio::test]
async fn timebox_discards_in_flight_request_then_continues_outside_body() {
    let mut p = plan(vec![
        LoadStep::TimeBox {
            node_id: "box".into(),
            duration: Duration::from_millis(5),
            body: vec![LoadStep::ForEach {
                node_id: "each".into(),
                variable: "item".into(),
                items: vec!["inner".into()],
                items_variable: None,
                max_items: None,
                body: vec![LoadStep::Request(request("slow", "{{item}}"))],
            }],
        },
        LoadStep::Request(request("outside", "{{item}}")),
    ]);
    p.setup = Some(lifecycle(
        "setup",
        vec![LoadStep::ConfigureSession(LoadSessionPlan {
            node_id: "seed".into(),
            headers: vec![],
            cookies_enabled: None,
            variables: BTreeMap::from([("item".into(), "outer".into())]),
        })],
    ));
    let trace = Trace::default();
    let report = tokio::time::timeout(
        Duration::from_millis(300),
        execute_load_plan_report(&p, &trace, &Sink, &NeverCancel),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(report.summary.requests, 6);
    assert!(
        trace
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.0.ends_with("/outside"))
            .all(|r| r.1 == "outer")
    );
}

#[tokio::test]
async fn zero_io_timebox_yields_until_deadline() {
    let p = plan(vec![LoadStep::TimeBox {
        node_id: "box".into(),
        duration: Duration::from_millis(2),
        body: vec![LoadStep::Metric(metric("emit"))],
    }]);
    let report = tokio::time::timeout(
        Duration::from_millis(300),
        execute_load_plan_report(&p, &Trace::default(), &Sink, &NeverCancel),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(report.summary.completed_iterations, 6);
    assert!(
        report
            .metrics
            .iter()
            .any(|m| m.selector.name == "events" && m.count > 0)
    );
}

#[tokio::test]
async fn setup_timeout_does_not_start_scenarios_or_teardown() {
    let mut p = plan(vec![LoadStep::Request(request("job", ""))]);
    p.setup = Some(LoadLifecyclePlan {
        node_id: "setup".into(),
        timeout: Duration::from_millis(2),
        body: vec![LoadStep::Request(request("slow", ""))],
    });
    p.teardown = Some(lifecycle(
        "teardown",
        vec![LoadStep::Request(request("finish", ""))],
    ));
    let trace = Trace::default();
    let error = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel)
        .await
        .unwrap_err();
    assert!(matches!(error, LoadExecutionError::LifecycleTimeout { .. }));
    assert_eq!(trace.0.lock().unwrap().len(), 1);
}

struct TimedCancellation {
    cancelled: Arc<AtomicBool>,
}
impl LoadCancellation for TimedCancellation {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
    async fn cancelled(&self) {
        tokio::time::sleep(Duration::from_millis(5)).await;
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

#[tokio::test]
async fn explicit_cancellation_does_not_launch_teardown_network_effects() {
    let mut p = plan(vec![LoadStep::Repeat {
        node_id: "repeat".into(),
        count: 100,
        body: vec![
            LoadStep::Timer(LoadTimerPlan {
                node_id: "wait".into(),
                kind: LoadTimerKind::Fixed(Duration::from_millis(10)),
            }),
            LoadStep::Request(request("job", "")),
        ],
    }]);
    p.teardown = Some(lifecycle(
        "teardown",
        vec![LoadStep::Request(request("finish", ""))],
    ));
    let trace = Trace::default();
    let cancellation = TimedCancellation {
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    let report = execute_load_plan_report(&p, &trace, &Sink, &cancellation)
        .await
        .unwrap();
    assert!(report.summary.cancelled);
    assert_eq!(report.summary.completed_iterations, 0);
    assert!(trace.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn structured_validation_rejects_ambiguous_or_unsafe_plans_before_effects() {
    let mut invalid = vec![
        plan(vec![LoadStep::Repeat {
            node_id: "repeat".into(),
            count: u64::MAX,
            body: vec![LoadStep::Request(request("job", ""))],
        }]),
        plan(vec![dataset("empty", "a", &[], false)]),
        plan(vec![dataset("reserved", "__VU", &["overwrite"], false)]),
        plan(vec![LoadStep::TimeBox {
            node_id: "box".into(),
            duration: Duration::ZERO,
            body: vec![LoadStep::Request(request("job", ""))],
        }]),
        plan(vec![LoadStep::Check(LoadCheckPlan {
            node_id: "check".into(),
            name: "bad".into(),
            expected_status: 200,
        })]),
        plan(vec![
            LoadStep::Request(request("duplicate", "")),
            LoadStep::Request(request("duplicate", "")),
        ]),
    ];
    let mut deep = vec![LoadStep::Request(request("job", ""))];
    for index in 0..34 {
        deep = vec![LoadStep::Repeat {
            node_id: format!("r{index}"),
            count: 1,
            body: deep,
        }];
    }
    invalid.push(plan(deep));
    let mut both = plan(vec![LoadStep::Request(request("job", ""))]);
    both.scenarios[0].requests.push(request("old", ""));
    invalid.push(both);
    for p in invalid {
        let trace = Trace::default();
        assert!(matches!(
            execute_load_plan_report(&p, &trace, &Sink, &NeverCancel).await,
            Err(LoadExecutionError::InvalidPlan(_))
        ));
        assert!(trace.0.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn session_headers_resolve_variables_and_reject_header_injection() {
    for value in ["valid", "bad\r\nInjected: yes"] {
        let p = plan(vec![
            LoadStep::ConfigureSession(LoadSessionPlan {
                node_id: "session".into(),
                headers: vec![HeaderEntry::new("X-Token", "{{token}}", true).unwrap()],
                cookies_enabled: None,
                variables: BTreeMap::from([("token".into(), value.into())]),
            }),
            LoadStep::Request(request("job", "")),
        ]);
        let trace = Trace::default();
        let result = execute_load_plan_report(&p, &trace, &Sink, &NeverCancel).await;
        if value == "valid" {
            assert!(result.is_ok());
            assert!(trace.0.lock().unwrap().iter().all(|r| {
                r.2.iter()
                    .any(|h| h.name() == "X-Token" && h.value() == "valid")
            }));
        } else {
            assert!(matches!(result, Err(LoadExecutionError::Variables { .. })));
            assert!(trace.0.lock().unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn empty_repeat_body_is_rejected_even_with_a_huge_count() {
    let p = plan(vec![LoadStep::Repeat {
        node_id: "spin".into(),
        count: u64::MAX,
        body: vec![],
    }]);
    assert!(matches!(p.validate(), Err(LoadPlanError::Scenario { .. })));
}

struct SignalCancellation(AtomicBool);
impl LoadCancellation for SignalCancellation {
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
    async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
}

struct CancellingTransport<'a> {
    cancellation: &'a SignalCancellation,
    calls: Mutex<usize>,
}
impl LoadTransport for CancellingTransport<'_> {
    async fn execute(&self, _: &Request) -> Result<Response, ExecutionError> {
        *self.calls.lock().unwrap() += 1;
        self.cancellation.0.store(true, Ordering::Relaxed);
        Ok(Response::new(
            200,
            0,
            "",
            vec![],
            ResponseMetadata::default(),
        ))
    }
}

#[tokio::test]
async fn cancellation_signalled_by_a_request_prevents_the_next_effect() {
    let mut p = plan(vec![
        LoadStep::Request(request("first", "")),
        LoadStep::Request(request("second", "")),
    ]);
    p.teardown = Some(lifecycle(
        "teardown",
        vec![LoadStep::Request(request("finish", ""))],
    ));
    let cancellation = SignalCancellation(AtomicBool::new(false));
    let transport = CancellingTransport {
        cancellation: &cancellation,
        calls: Mutex::new(0),
    };
    let report = execute_load_plan_report(&p, &transport, &Sink, &cancellation)
        .await
        .unwrap();
    assert!(report.summary.cancelled);
    assert_eq!(report.summary.completed_iterations, 0);
    assert_eq!(*transport.calls.lock().unwrap(), 1);
    assert_eq!(report.summary.requests, 1);
}
