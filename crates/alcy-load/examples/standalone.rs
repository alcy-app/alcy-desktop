//! Demonstra o runner sem alcy-app, Flow, workspace, Tauri ou rede real.
//! Substitua SimulatedHttp por uma implementação de LoadTransport para HTTP.

use std::collections::BTreeMap;
use std::future::pending;

use alcy_domain::{
    Endpoint, ExecutionError, HttpMethod, RedirectPolicy, Request, Response, ResponseMetadata,
};
use alcy_load::{
    LoadCancellation, LoadCheckPlan, LoadExecutor, LoadMetricSelector, LoadMetricStatistic,
    LoadPlan, LoadRequestPlan, LoadRunProgress, LoadRunSink, LoadRunSummary, LoadScenarioPlan,
    LoadSchedule, LoadThreshold, LoadThresholdComparison, LoadTransport, execute_load_plan_report,
};

struct SimulatedHttp;
impl LoadTransport for SimulatedHttp {
    async fn execute(&self, _request: &Request) -> Result<Response, ExecutionError> {
        Ok(Response::new(
            200,
            0,
            "",
            vec![],
            ResponseMetadata::default(),
        ))
    }
}

struct NeverCancelled;
impl LoadCancellation for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
    async fn cancelled(&self) {
        pending().await
    }
}

struct ConsoleSink;
impl LoadRunSink for ConsoleSink {
    fn progress(&self, _snapshot: LoadRunProgress) {}
    fn scenario_finished(&self, id: &str, summary: LoadRunSummary) {
        println!(
            "{id}: {} iterações, {} requests",
            summary.completed_iterations, summary.requests
        );
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let plan = LoadPlan {
        setup: None,
        teardown: None,
        scenarios: vec![LoadScenarioPlan {
            body: vec![],
            node_id: "health".into(),
            label: "Health".into(),
            schedule: LoadSchedule::new(LoadExecutor::PerVuIterations {
                vus: 2,
                iterations_per_vu: 3,
                max_duration: None,
            })?,
            requests: vec![LoadRequestPlan {
                node_id: "get-health".into(),
                method: HttpMethod::Get,
                endpoint: Endpoint::new("https://example.test/health")?,
                body: String::new(),
                timeout: None,
                headers: vec![],
                redirect_policy: RedirectPolicy::Follow,
                tags: BTreeMap::new(),
                before: vec![],
                checks: vec![LoadCheckPlan {
                    node_id: "status".into(),
                    name: "status 200".into(),
                    expected_status: 200,
                }],
                metrics: vec![],
            }],
        }],
        thresholds: vec![LoadThreshold {
            selector: LoadMetricSelector {
                name: "http_requests".into(),
                tags: BTreeMap::new(),
            },
            statistic: LoadMetricStatistic::Count,
            comparison: LoadThresholdComparison::Equal,
            target: 6.0,
        }],
    };
    let report =
        execute_load_plan_report(&plan, &SimulatedHttp, &ConsoleSink, &NeverCancelled).await?;
    println!(
        "passed={} requests={} checks={}",
        report.passed, report.summary.requests, report.summary.checks_passed
    );
    if !report.passed {
        std::process::exit(1);
    }
    Ok(())
}
