//! Runner de coleções (spec 0073): roda um plano ordenado de requisições
//! salvas, por N iterações, com delay e parada no primeiro erro.
//!
//! O use case orquestra (ordem, iterações, ambiente acumulado, classificação
//! e parada); o que acontece dentro de um passo — scripts, resolução de
//! `{{var}}`, cookies e HTTP — fica atrás da porta `CollectionRunStep`.

use std::future::Future;
use std::time::Duration;

use alcy_domain::{
    Collection, CollectionRunOptions, EnvironmentVariable, ExecutionError, ProtocolId, Response,
    RunStepOutcome, RunTestResult, ScopedVariableChange, VariableScope, apply_scoped_changes,
    effective_authentication, find_saved_request, merge_variables, record_scoped_change,
    variable_scopes,
};

use crate::FlowCancellation;
use crate::iteration_data::IterationData;

/// Iteração em que um passo roda.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunIteration {
    /// A partir de 0.
    pub index: u32,
    pub count: u32,
    /// Linha do arquivo de dados desta iteração (vazia sem arquivo).
    pub data: Vec<(String, String)>,
}

/// O que um passo produziu, do ponto de vista do adaptador que o executou.
#[derive(Debug)]
pub struct StepResult {
    /// Método efetivamente enviado (o pré-script pode trocá-lo).
    pub method: String,
    /// URL enviada, com variáveis resolvidas (vazia quando nem chegou a
    /// ser resolvida).
    pub resolved_url: String,
    pub response: Result<Response, ExecutionError>,
    /// Variáveis gravadas pelos scripts, na ordem em que foram gravadas.
    pub environment_changes: Vec<(String, Option<String>)>,
    /// Variáveis de coleção/pasta gravadas pelos scripts (ADR 0031).
    pub scoped_changes: Vec<ScopedVariableChange>,
    pub logs: Vec<String>,
    pub tests: Vec<RunTestResult>,
    /// Falha do pós-script (a resposta continua válida).
    pub post_script_error: Option<String>,
}

/// Porta de execução de um passo: recebe a requisição salva (com a
/// autenticação herdada já aplicada, `{{var}}` ainda sem resolver), o
/// ambiente vigente (acumulado, sobreposto pelos dados da iteração) e as
/// camadas de variáveis da coleção/pastas da requisição, já com o que os
/// passos anteriores gravaram. A resolução de `{{var}}` usa
/// `step_variables`.
pub trait CollectionRunStep: Sync {
    fn run(
        &self,
        request: &alcy_domain::Request,
        variables: &[EnvironmentVariable],
        scopes: &[VariableScope],
        iteration: &RunIteration,
    ) -> impl Future<Output = StepResult> + Send;
}

/// Variáveis para resolver `{{var}}` num passo: ambiente < coleção < pastas
/// < dados da iteração (`data`).
pub fn step_variables(
    environment: &[EnvironmentVariable],
    scopes: &[VariableScope],
    data: &[(String, String)],
) -> Vec<EnvironmentVariable> {
    with_iteration_data(&merge_variables(environment, scopes), data)
}

/// Relatório de uma requisição terminada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStepReport {
    pub iteration: u32,
    pub position: usize,
    pub request_id: String,
    pub name: String,
    pub protocol: Option<ProtocolId>,
    pub method: String,
    pub resolved_url: String,
    pub outcome: RunStepOutcome,
    pub status_code: Option<u16>,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<usize>,
    pub error_message: Option<String>,
    pub tests: Vec<RunTestResult>,
    pub logs: Vec<String>,
}

/// Porta de progresso do run (ex.: um `tauri::ipc::Channel` em `src-tauri`).
pub trait CollectionRunSink: Sync {
    fn run_started(&self, iterations: u32, requests_per_iteration: usize);
    fn iteration_started(&self, iteration: u32);
    fn request_started(&self, iteration: u32, position: usize, request_id: &str);
    /// `response` vem junto quando houve resposta, para quem guarda a saída.
    fn request_finished(&self, report: &RunStepReport, response: Option<&Response>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionRunSummary {
    pub cancelled: bool,
    pub stopped_on_error: bool,
    /// Valor final de cada variável gravada pelos scripts durante o run.
    pub environment_changes: Vec<(String, Option<String>)>,
    /// Valor final de cada variável de coleção/pasta gravada pelos scripts.
    pub scoped_changes: Vec<ScopedVariableChange>,
}

/// O que um run executa: requisições salvas na ordem de execução, as
/// coleções onde estão, a configuração, o ambiente inicial e os dados.
#[derive(Debug, Clone, Copy)]
pub struct CollectionRunPlan<'a> {
    pub request_ids: &'a [String],
    pub collections: &'a [Collection],
    pub options: &'a CollectionRunOptions,
    pub environment: &'a [EnvironmentVariable],
    pub data: &'a IterationData,
}

/// Executa o plano.
///
/// Com arquivo de dados, o número de iterações é o número de linhas.
/// Mudanças de ambiente feitas por um passo valem para a resolução de
/// `{{var}}` dos passos seguintes, inclusive nas iterações seguintes; os
/// dados da iteração têm precedência sobre o ambiente.
pub async fn run_collection<S, K, C>(
    plan: &CollectionRunPlan<'_>,
    step: &S,
    sink: &K,
    cancellation: &C,
) -> CollectionRunSummary
where
    S: CollectionRunStep,
    K: CollectionRunSink,
    C: FlowCancellation,
{
    let CollectionRunPlan {
        request_ids,
        options,
        environment,
        data,
        ..
    } = *plan;
    let iterations = if data.is_empty() {
        options.iterations()
    } else {
        data.len() as u32
    };
    sink.run_started(iterations, request_ids.len());

    let mut environment = environment.to_vec();
    let mut changes: Vec<(String, Option<String>)> = Vec::new();
    let mut scoped_changes: Vec<ScopedVariableChange> = Vec::new();
    let mut summary = CollectionRunSummary {
        cancelled: false,
        stopped_on_error: false,
        environment_changes: Vec::new(),
        scoped_changes: Vec::new(),
    };
    let mut first_step = true;

    'iterations: for index in 0..iterations {
        let iteration = RunIteration {
            index,
            count: iterations,
            data: data.rows.get(index as usize).cloned().unwrap_or_default(),
        };
        sink.iteration_started(index);

        for (position, request_id) in request_ids.iter().enumerate() {
            if !first_step && options.delay_ms() > 0 {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(options.delay_ms())) => {}
                    _ = cancellation.cancelled() => {}
                }
            }
            first_step = false;
            if cancellation.is_cancelled() {
                summary.cancelled = true;
                break 'iterations;
            }

            sink.request_started(index, position, request_id);
            let (report, response) = run_step(
                plan,
                request_id,
                position,
                &iteration,
                RunVariables {
                    environment: &environment,
                    scoped_changes: &scoped_changes,
                },
                step,
                cancellation,
            )
            .await;

            if let Some(step_changes) = &response.changes {
                for (name, value) in step_changes {
                    apply_change(&mut environment, name, value.as_deref());
                    match changes.iter_mut().find(|(n, _)| n == name) {
                        Some(existing) => existing.1 = value.clone(),
                        None => changes.push((name.clone(), value.clone())),
                    }
                }
            }
            for change in response.scoped_changes {
                record_scoped_change(&mut scoped_changes, change);
            }
            sink.request_finished(&report, response.response.as_ref());

            if report.outcome == RunStepOutcome::Cancelled {
                summary.cancelled = true;
                break 'iterations;
            }
            if options.stop_on_error && report.outcome != RunStepOutcome::Passed {
                summary.stopped_on_error = true;
                break 'iterations;
            }
        }
    }

    summary.environment_changes = changes;
    summary.scoped_changes = scoped_changes;
    summary
}

struct StepEffects {
    response: Option<Response>,
    changes: Option<Vec<(String, Option<String>)>>,
    scoped_changes: Vec<ScopedVariableChange>,
}

/// Estado acumulado das variáveis no momento de um passo.
struct RunVariables<'v> {
    environment: &'v [EnvironmentVariable],
    /// Gravações de script em variáveis de coleção/pasta até aqui.
    scoped_changes: &'v [ScopedVariableChange],
}

async fn run_step<S, C>(
    plan: &CollectionRunPlan<'_>,
    request_id: &str,
    position: usize,
    iteration: &RunIteration,
    current: RunVariables<'_>,
    step: &S,
    cancellation: &C,
) -> (RunStepReport, StepEffects)
where
    S: CollectionRunStep,
    C: FlowCancellation,
{
    let mut report = RunStepReport {
        iteration: iteration.index,
        position,
        request_id: request_id.to_string(),
        name: String::new(),
        protocol: None,
        method: String::new(),
        resolved_url: String::new(),
        outcome: RunStepOutcome::Error,
        status_code: None,
        duration_ms: None,
        size_bytes: None,
        error_message: None,
        tests: Vec::new(),
        logs: Vec::new(),
    };
    let no_effects = StepEffects {
        response: None,
        changes: None,
        scoped_changes: Vec::new(),
    };

    let collections = plan.collections;
    let Some(saved) = find_saved_request(collections, request_id) else {
        report.error_message = Some("requisição não encontrada".to_string());
        return (report, no_effects);
    };
    report.name = saved.name().to_string();
    report.protocol = Some(saved.request.document.protocol);

    let mut request = saved.request.clone();
    request.authentication = effective_authentication(collections, request_id);
    let variables = with_iteration_data(current.environment, &iteration.data);
    let mut scopes = variable_scopes(collections, request_id);
    apply_scoped_changes(&mut scopes, current.scoped_changes);

    let result = tokio::select! {
        result = step.run(&request, &variables, &scopes, iteration) => Some(result),
        _ = cancellation.cancelled() => None,
    };
    let Some(result) = result else {
        report.outcome = RunStepOutcome::Cancelled;
        return (report, no_effects);
    };

    report.method = result.method;
    report.resolved_url = result.resolved_url;
    report.tests = result.tests;
    report.logs = result.logs;
    let changes = Some(result.environment_changes);
    let scoped_changes = result.scoped_changes;

    let response = match result.response {
        Ok(response) => response,
        Err(ExecutionError::Cancelled) => {
            report.outcome = RunStepOutcome::Cancelled;
            return (
                report,
                StepEffects {
                    response: None,
                    changes,
                    scoped_changes,
                },
            );
        }
        Err(error) => {
            report.error_message = Some(error.to_string());
            return (
                report,
                StepEffects {
                    response: None,
                    changes,
                    scoped_changes,
                },
            );
        }
    };

    report.status_code = Some(response.status_code);
    report.duration_ms = Some(response.duration_ms);
    report.size_bytes = Some(response.size_bytes);
    let failed_test = report.tests.iter().any(|test| !test.passed);
    let http_error = plan.options.http_errors_fail && response.status_code >= 400;
    report.outcome = if result.post_script_error.is_some() || failed_test || http_error {
        RunStepOutcome::Failed
    } else {
        RunStepOutcome::Passed
    };
    report.error_message = result.post_script_error;

    (
        report,
        StepEffects {
            response: Some(response),
            changes,
            scoped_changes,
        },
    )
}

/// Ambiente sobreposto pelos dados da iteração: uma coluna com o mesmo nome
/// de uma variável substitui o valor dela (mantendo `sensitive`).
fn with_iteration_data(
    environment: &[EnvironmentVariable],
    data: &[(String, String)],
) -> Vec<EnvironmentVariable> {
    let mut variables = environment.to_vec();
    for (name, value) in data {
        apply_change(&mut variables, name, Some(value));
    }
    variables
}

fn apply_change(variables: &mut Vec<EnvironmentVariable>, name: &str, value: Option<&str>) {
    let Some(value) = value else {
        variables.retain(|variable| variable.name() != name);
        return;
    };
    let sensitive = variables
        .iter()
        .find(|variable| variable.name() == name)
        .is_some_and(|variable| variable.sensitive);
    // Nomes inválidos (vazios, com chaves) não entram no ambiente.
    let Ok(updated) = EnvironmentVariable::new(name, value, sensitive) else {
        return;
    };
    match variables
        .iter_mut()
        .find(|variable| variable.name() == name)
    {
        Some(existing) => *existing = updated,
        None => variables.push(updated),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use alcy_domain::{
        Authentication, Endpoint, Folder, HttpMethod, Request, RequestDocument, ResponseMetadata,
        SavedRequest,
    };

    use super::*;

    struct FakeStep {
        /// status por URL de endpoint (depois de resolver `{{var}}`).
        statuses: Vec<(&'static str, u16)>,
        calls: Mutex<Vec<String>>,
        /// Script que roda no primeiro passo e grava `token`.
        sets_token: bool,
        /// Grava `id` nesta pasta ao rodar uma URL com `/first`.
        sets_folder_id: Option<&'static str>,
        failing_test_on: Option<&'static str>,
    }

    impl FakeStep {
        fn new(statuses: Vec<(&'static str, u16)>) -> Self {
            Self {
                statuses,
                calls: Mutex::new(Vec::new()),
                sets_token: false,
                sets_folder_id: None,
                failing_test_on: None,
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn resolve(template: &str, variables: &[EnvironmentVariable]) -> String {
        let mut out = template.to_string();
        for variable in variables {
            out = out.replace(&format!("{{{{{}}}}}", variable.name()), variable.value());
        }
        out
    }

    impl CollectionRunStep for FakeStep {
        async fn run(
            &self,
            request: &Request,
            variables: &[EnvironmentVariable],
            scopes: &[VariableScope],
            iteration: &RunIteration,
        ) -> StepResult {
            let url = resolve(
                request.endpoint.url(),
                &step_variables(variables, scopes, &iteration.data),
            );
            self.calls.lock().unwrap().push(url.clone());
            let status = self
                .statuses
                .iter()
                .find(|(prefix, _)| url.starts_with(prefix))
                .map(|(_, status)| *status);
            let response = match status {
                Some(0) => Err(ExecutionError::network("recusada")),
                Some(status) => Ok(Response::new(
                    status,
                    5,
                    "{}".to_string(),
                    Vec::new(),
                    ResponseMetadata::default(),
                )),
                None => Ok(Response::new(
                    200,
                    5,
                    "{}".to_string(),
                    Vec::new(),
                    ResponseMetadata::default(),
                )),
            };
            let tests = match self.failing_test_on {
                Some(prefix) if url.starts_with(prefix) => vec![RunTestResult {
                    name: "ok".to_string(),
                    passed: false,
                    message: Some("esperado 1, recebido 2".to_string()),
                }],
                _ => Vec::new(),
            };
            let scoped_changes = match self.sets_folder_id {
                Some(folder) if url.contains("/first") => vec![ScopedVariableChange {
                    node_id: folder.to_string(),
                    name: "id".to_string(),
                    value: Some("from-script".to_string()),
                }],
                _ => Vec::new(),
            };
            StepResult {
                method: "get".to_string(),
                resolved_url: url,
                response,
                environment_changes: if self.sets_token {
                    vec![("token".to_string(), Some("t1".to_string()))]
                } else {
                    Vec::new()
                },
                scoped_changes,
                logs: Vec::new(),
                tests,
                post_script_error: None,
            }
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<String>>,
        reports: Mutex<Vec<RunStepReport>>,
    }

    impl CollectionRunSink for RecordingSink {
        fn run_started(&self, iterations: u32, requests: usize) {
            self.events
                .lock()
                .unwrap()
                .push(format!("run {iterations}x{requests}"));
        }
        fn iteration_started(&self, iteration: u32) {
            self.events.lock().unwrap().push(format!("it {iteration}"));
        }
        fn request_started(&self, iteration: u32, position: usize, request_id: &str) {
            self.events
                .lock()
                .unwrap()
                .push(format!("start {iteration}.{position} {request_id}"));
        }
        fn request_finished(&self, report: &RunStepReport, _response: Option<&Response>) {
            self.reports.lock().unwrap().push(report.clone());
        }
    }

    impl RecordingSink {
        fn outcomes(&self) -> Vec<(String, RunStepOutcome)> {
            self.reports
                .lock()
                .unwrap()
                .iter()
                .map(|r| (r.request_id.clone(), r.outcome))
                .collect()
        }
    }

    #[derive(Default)]
    struct Cancel(AtomicBool);

    impl FlowCancellation for Cancel {
        fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
        async fn cancelled(&self) {
            loop {
                if self.0.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }

    fn saved(id: &str, url: &str) -> SavedRequest {
        let mut request = Request::new(
            Endpoint::new(url).unwrap(),
            RequestDocument::new(ProtocolId::Rest, String::new()),
            String::new(),
            Vec::new(),
            Authentication::None,
        );
        request.method = HttpMethod::Get;
        SavedRequest::new(id, id, request).unwrap()
    }

    fn collections() -> Vec<Collection> {
        let requests = vec![
            saved("a", "https://a.test/{{token}}"),
            saved("b", "https://b.test/{{user}}"),
            saved("c", "https://c.test/"),
        ];
        vec![Collection::new("c", "Coleção", Vec::new(), requests).unwrap()]
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<EnvironmentVariable> {
        pairs
            .iter()
            .map(|(n, v)| EnvironmentVariable::new(*n, *v, false).unwrap())
            .collect()
    }

    fn plan(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn options(iterations: u32) -> CollectionRunOptions {
        CollectionRunOptions::new(iterations, 0).unwrap()
    }

    #[tokio::test]
    async fn runs_the_plan_in_order_for_each_iteration() {
        let step = FakeStep::new(Vec::new());
        let sink = RecordingSink::default();

        let summary = run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["c", "a"]),
                collections: &collections(),
                options: &options(2),
                environment: &env(&[("token", "x")]),
                data: &IterationData::default(),
            },
            &step,
            &sink,
            &Cancel::default(),
        )
        .await;

        assert!(!summary.cancelled && !summary.stopped_on_error);
        assert_eq!(
            *sink.events.lock().unwrap(),
            vec![
                "run 2x2",
                "it 0",
                "start 0.0 c",
                "start 0.1 a",
                "it 1",
                "start 1.0 c",
                "start 1.1 a",
            ]
        );
        assert_eq!(step.calls()[1], "https://a.test/x");
        let report = &sink.reports.lock().unwrap()[1];
        assert_eq!(report.name, "a");
        assert_eq!(report.status_code, Some(200));
        assert_eq!(report.outcome, RunStepOutcome::Passed);
    }

    #[tokio::test]
    async fn iteration_data_sets_the_count_and_overrides_the_environment() {
        let step = FakeStep::new(Vec::new());
        let sink = RecordingSink::default();
        let data = IterationData {
            columns: vec!["user".to_string()],
            rows: vec![
                vec![("user".to_string(), "ana".to_string())],
                vec![("user".to_string(), "bia".to_string())],
            ],
        };

        run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["b"]),
                collections: &collections(),
                options: &options(5),
                environment: &env(&[("user", "env")]),
                data: &data,
            },
            &step,
            &sink,
            &Cancel::default(),
        )
        .await;

        assert_eq!(
            step.calls(),
            vec!["https://b.test/ana", "https://b.test/bia"]
        );
    }

    #[tokio::test]
    async fn script_changes_reach_the_next_steps_and_the_summary() {
        let mut step = FakeStep::new(Vec::new());
        step.sets_token = true;
        let sink = RecordingSink::default();

        let summary = run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["c", "a"]),
                collections: &collections(),
                options: &options(1),
                environment: &env(&[("token", "old")]),
                data: &IterationData::default(),
            },
            &step,
            &sink,
            &Cancel::default(),
        )
        .await;

        assert_eq!(step.calls()[1], "https://a.test/t1");
        assert_eq!(
            summary.environment_changes,
            vec![("token".to_string(), Some("t1".to_string()))]
        );
    }

    /// Pasta `f` (id=folder) com `first` e `second` numa coleção `c`
    /// (id=collection).
    fn scoped_collections() -> Vec<Collection> {
        let folder = Folder::new(
            "f",
            "Pasta",
            Vec::new(),
            vec![
                saved("first", "https://f.test/first/{{id}}"),
                saved("second", "https://f.test/second/{{id}}"),
            ],
        )
        .unwrap()
        .with_variables(env(&[("id", "folder")]))
        .unwrap();
        vec![
            Collection::new("c", "Coleção", vec![folder], Vec::new())
                .unwrap()
                .with_variables(env(&[("id", "collection")]))
                .unwrap(),
        ]
    }

    #[tokio::test]
    async fn folder_variables_win_and_script_changes_reach_the_next_steps() {
        let mut step = FakeStep::new(Vec::new());
        step.sets_folder_id = Some("f");

        let summary = run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["first", "second"]),
                collections: &scoped_collections(),
                options: &options(1),
                environment: &env(&[("id", "env")]),
                data: &IterationData::default(),
            },
            &step,
            &RecordingSink::default(),
            &Cancel::default(),
        )
        .await;

        assert_eq!(
            step.calls(),
            vec![
                "https://f.test/first/folder",
                "https://f.test/second/from-script"
            ]
        );
        assert_eq!(
            summary.scoped_changes,
            vec![ScopedVariableChange {
                node_id: "f".to_string(),
                name: "id".to_string(),
                value: Some("from-script".to_string()),
            }]
        );
    }

    #[tokio::test]
    async fn iteration_data_wins_over_local_variables() {
        let step = FakeStep::new(Vec::new());

        run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["first"]),
                collections: &scoped_collections(),
                options: &options(1),
                environment: &[],
                data: &IterationData {
                    columns: vec!["id".to_string()],
                    rows: vec![vec![("id".to_string(), "row".to_string())]],
                },
            },
            &step,
            &RecordingSink::default(),
            &Cancel::default(),
        )
        .await;

        assert_eq!(step.calls(), vec!["https://f.test/first/row"]);
    }

    #[tokio::test]
    async fn http_errors_fail_only_when_enabled() {
        let step = FakeStep::new(vec![("https://c.test", 404)]);
        let sink = RecordingSink::default();
        let mut lenient = options(1);
        lenient.http_errors_fail = false;

        run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["c"]),
                collections: &collections(),
                options: &options(1),
                environment: &[],
                data: &IterationData::default(),
            },
            &step,
            &sink,
            &Cancel::default(),
        )
        .await;
        run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["c"]),
                collections: &collections(),
                options: &lenient,
                environment: &[],
                data: &IterationData::default(),
            },
            &step,
            &sink,
            &Cancel::default(),
        )
        .await;

        assert_eq!(
            sink.outcomes(),
            vec![
                ("c".to_string(), RunStepOutcome::Failed),
                ("c".to_string(), RunStepOutcome::Passed)
            ]
        );
    }

    #[tokio::test]
    async fn failing_tests_fail_the_step_and_stop_the_run_when_asked() {
        let mut step = FakeStep::new(Vec::new());
        step.failing_test_on = Some("https://c.test");
        let sink = RecordingSink::default();
        let mut stop = options(3);
        stop.stop_on_error = true;

        let summary = run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["c", "b"]),
                collections: &collections(),
                options: &stop,
                environment: &env(&[("user", "u")]),
                data: &IterationData::default(),
            },
            &step,
            &sink,
            &Cancel::default(),
        )
        .await;

        assert!(summary.stopped_on_error);
        assert_eq!(
            sink.outcomes(),
            vec![("c".to_string(), RunStepOutcome::Failed)]
        );
    }

    #[tokio::test]
    async fn network_errors_and_missing_requests_are_errors_without_aborting() {
        let step = FakeStep::new(vec![("https://c.test", 0)]);
        let sink = RecordingSink::default();

        run_collection(
            &CollectionRunPlan {
                request_ids: &plan(&["gone", "c", "b"]),
                collections: &collections(),
                options: &options(1),
                environment: &env(&[("user", "u")]),
                data: &IterationData::default(),
            },
            &step,
            &sink,
            &Cancel::default(),
        )
        .await;

        let reports = sink.reports.lock().unwrap().clone();
        assert_eq!(reports[0].outcome, RunStepOutcome::Error);
        assert_eq!(
            reports[0].error_message.as_deref(),
            Some("requisição não encontrada")
        );
        assert_eq!(reports[1].outcome, RunStepOutcome::Error);
        assert_eq!(
            reports[1].error_message.as_deref(),
            Some("falha de rede: recusada")
        );
        assert_eq!(reports[2].outcome, RunStepOutcome::Passed);
    }

    #[tokio::test]
    async fn cancelling_during_the_delay_stops_before_the_next_step() {
        let step = FakeStep::new(Vec::new());
        let sink = RecordingSink::default();
        let cancel = Cancel::default();
        let slow = CollectionRunOptions::new(1, 60_000).unwrap();
        let (plan, collections, environment) =
            (plan(&["c", "b"]), collections(), env(&[("user", "u")]));
        let data = IterationData::default();

        let run_plan = CollectionRunPlan {
            request_ids: &plan,
            collections: &collections,
            options: &slow,
            environment: &environment,
            data: &data,
        };
        let run = run_collection(&run_plan, &step, &sink, &cancel);
        let trigger = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.0.store(true, Ordering::SeqCst);
        };
        let (summary, ()) = tokio::join!(run, trigger);

        assert!(summary.cancelled);
        assert_eq!(step.calls(), vec!["https://c.test/"]);
    }
}
