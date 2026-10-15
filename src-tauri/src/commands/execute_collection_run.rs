//! Runner de coleções (spec 0073, ADR 0027): executa um plano ordenado de
//! requisições salvas e transmite o progresso por um `Channel`, como os
//! runs de flow (ADR 0014). Cancelável por `cancel_collection_run`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alcy_app::{
    CollectionRunPlan, CollectionRunSink, IterationData, MAX_ITERATION_DATA_BYTES, RunStepReport,
    parse_iteration_data, run_collection,
};
use alcy_domain::{
    Collection, CollectionRunOptions, EnvironmentVariable, HistoryRetention, ProtocolId, Response,
    RunStepOutcome, find_saved_request,
};
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{
    CollectionRunHistoryStore, CollectionRunRecord, CollectionsStore, RecordedPlanItem,
    RecordedRunOptions, RecordedRunStep, RecordedStepOutcome, RecordedStepOutput, RecordedTest,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::commands::collection_run_step::CollectionRunStepExecutor;
use crate::commands::cookie_jar::CookieJar;
use crate::commands::environments::EnvironmentVariableDto;
use crate::commands::execute_graphql_request::{ResponseBodyEncodingOutput, ResponseHeaderOutput};
use crate::commands::execute_rest_request::HttpMethodInput;
use crate::commands::flow_execution_registry::{FlowExecutionRegistry, WatchCancellation};
use crate::commands::flow_run_outputs::FlowNodeOutput;
use crate::commands::general_settings::{HistoryPreferences, HistoryPreferencesState};
use crate::commands::protocol_dispatching_executor::ProtocolDispatchingExecutor;
use crate::commands::scripting::{EnvironmentChangeOutput, ScopedChangeOutput, ScriptTestOutput};

/// Teto do total de corpos guardados por run (memória e histórico): cada
/// corpo já é limitado a 256 KB, mas um run com muitas iterações somaria
/// demais. Passando disso, as respostas seguintes não são guardadas.
pub const MAX_RUN_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRunOptionsInput {
    pub iterations: u32,
    pub delay_ms: u64,
    pub stop_on_error: bool,
    pub http_errors_fail: bool,
    pub keep_variable_values: bool,
    pub share_cookies: bool,
    pub persist_responses: bool,
    pub save_to_history: bool,
    /// Só apresentação: omite os logs de script dos eventos e do histórico.
    pub disable_logs: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteCollectionRunInput {
    pub run_id: String,
    pub root_path: String,
    /// Nome da coleção/pasta, para rotular o run no histórico.
    pub scope_name: String,
    /// Requisições selecionadas, na ordem de execução.
    pub request_ids: Vec<String>,
    pub options: CollectionRunOptionsInput,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    #[serde(default)]
    pub data_file_path: Option<String>,
    /// Ambiente ativo, só para rotular o run (histórico e relatórios).
    #[serde(default)]
    pub environment_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunStepOutcomeDto {
    Passed,
    Failed,
    Error,
    Cancelled,
}

impl From<RunStepOutcome> for RunStepOutcomeDto {
    fn from(outcome: RunStepOutcome) -> Self {
        match outcome {
            RunStepOutcome::Passed => Self::Passed,
            RunStepOutcome::Failed => Self::Failed,
            RunStepOutcome::Error => Self::Error,
            RunStepOutcome::Cancelled => Self::Cancelled,
        }
    }
}

impl From<RecordedStepOutcome> for RunStepOutcomeDto {
    fn from(outcome: RecordedStepOutcome) -> Self {
        match outcome {
            RecordedStepOutcome::Passed => Self::Passed,
            RecordedStepOutcome::Failed => Self::Failed,
            RecordedStepOutcome::Error => Self::Error,
            RecordedStepOutcome::Cancelled => Self::Cancelled,
        }
    }
}

impl From<RunStepOutcomeDto> for RecordedStepOutcome {
    fn from(outcome: RunStepOutcomeDto) -> Self {
        match outcome {
            RunStepOutcomeDto::Passed => Self::Passed,
            RunStepOutcomeDto::Failed => Self::Failed,
            RunStepOutcomeDto::Error => Self::Error,
            RunStepOutcomeDto::Cancelled => Self::Cancelled,
        }
    }
}

/// Uma requisição terminada — igual no canal ao vivo e no histórico.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunStepDto {
    pub iteration: u32,
    pub position: usize,
    pub request_id: String,
    pub name: String,
    /// `"rest"` ou `"graphql"`; `None` quando a requisição não existe mais.
    pub protocol: Option<String>,
    pub method: String,
    pub resolved_url: String,
    pub outcome: RunStepOutcomeDto,
    pub status_code: Option<u16>,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<usize>,
    pub error_message: Option<String>,
    pub tests: Vec<ScriptTestOutput>,
    pub logs: Vec<String>,
    /// `true` quando a resposta foi guardada e pode ser buscada.
    pub has_output: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CollectionRunEventDto {
    RunStarted {
        iterations: u32,
        requests_per_iteration: usize,
    },
    IterationStarted {
        iteration: u32,
    },
    RequestStarted {
        iteration: u32,
        position: usize,
        request_id: String,
    },
    RequestFinished {
        step: Box<RunStepDto>,
    },
    RunFinished {
        cancelled: bool,
        stopped_on_error: bool,
        /// Vazio quando o run não mantém os valores das variáveis.
        environment_changes: Vec<EnvironmentChangeOutput>,
        /// Variáveis de coleção/pasta gravadas (ADR 0031); vazio quando o
        /// run não mantém os valores das variáveis.
        scoped_changes: Vec<ScopedChangeOutput>,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecuteCollectionRunError {
    InvalidOptions { message: String },
    EmptyPlan,
    DataFile { message: String },
    Storage { message: String },
}

pub(crate) fn protocol_label(protocol: ProtocolId) -> &'static str {
    match protocol {
        ProtocolId::Rest => "rest",
        ProtocolId::GraphQl => "graphql",
        ProtocolId::Grpc => "grpc",
    }
}

/// Saídas do **último** run, em memória, por `(iteração, posição)`.
#[derive(Default)]
pub struct CollectionRunOutputs {
    state: Mutex<OutputsState>,
}

#[derive(Default)]
struct OutputsState {
    run_id: Option<String>,
    outputs: HashMap<(u32, usize), FlowNodeOutput>,
    stored_bytes: usize,
    /// Registro do último run terminado, sem as respostas (que ficam em
    /// `outputs`), para gerar relatórios mesmo sem salvar no histórico.
    record: Option<CollectionRunRecord>,
}

impl CollectionRunOutputs {
    pub fn begin(&self, run_id: &str) {
        let mut state = self.lock();
        state.run_id = Some(run_id.to_string());
        state.outputs.clear();
        state.stored_bytes = 0;
        state.record = None;
    }

    fn set_record(&self, record: CollectionRunRecord) {
        let mut state = self.lock();
        if state.run_id.as_deref() == Some(record.id.as_str()) {
            state.record = Some(CollectionRunRecord {
                outputs: Vec::new(),
                ..record
            });
        }
    }

    /// Registro completo (com as respostas) do último run, se for `run_id`.
    pub fn record(&self, run_id: &str) -> Option<CollectionRunRecord> {
        let record = {
            let state = self.lock();
            state.record.clone().filter(|record| record.id == run_id)?
        };
        let outputs = self
            .all(run_id)
            .into_iter()
            .map(|(key, output)| recorded_output(key, output))
            .collect();
        Some(CollectionRunRecord { outputs, ..record })
    }

    /// `false` quando a resposta não foi guardada (outro run ou teto atingido).
    pub fn store(
        &self,
        run_id: &str,
        iteration: u32,
        position: usize,
        response: &Response,
    ) -> bool {
        let mut state = self.lock();
        if state.run_id.as_deref() != Some(run_id) {
            return false;
        }
        let output = FlowNodeOutput::from_response(response);
        if state.stored_bytes + output.body.len() > MAX_RUN_OUTPUT_BYTES {
            return false;
        }
        state.stored_bytes += output.body.len();
        state.outputs.insert((iteration, position), output);
        true
    }

    pub fn get(&self, run_id: &str, iteration: u32, position: usize) -> Option<FlowNodeOutput> {
        let state = self.lock();
        if state.run_id.as_deref() != Some(run_id) {
            return None;
        }
        state.outputs.get(&(iteration, position)).cloned()
    }

    fn all(&self, run_id: &str) -> Vec<((u32, usize), FlowNodeOutput)> {
        let state = self.lock();
        if state.run_id.as_deref() != Some(run_id) {
            return Vec::new();
        }
        let mut outputs: Vec<_> = state
            .outputs
            .iter()
            .map(|(key, output)| (*key, output.clone()))
            .collect();
        outputs.sort_by_key(|(key, _)| *key);
        outputs
    }

    fn lock(&self) -> MutexGuard<'_, OutputsState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

struct ChannelSink<'a> {
    channel: &'a Channel<CollectionRunEventDto>,
    outputs: &'a CollectionRunOutputs,
    run_id: &'a str,
    options: CollectionRunOptionsInput,
    iterations: Mutex<u32>,
    /// Requisições terminadas com o instante, gravadas no histórico ao fim.
    steps: Mutex<Vec<RecordedRunStep>>,
}

impl ChannelSink<'_> {
    fn take_steps(&self) -> Vec<RecordedRunStep> {
        std::mem::take(
            &mut *self
                .steps
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    fn iterations(&self) -> u32 {
        *self
            .iterations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl CollectionRunSink for ChannelSink<'_> {
    fn run_started(&self, iterations: u32, requests_per_iteration: usize) {
        *self
            .iterations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = iterations;
        let _ = self.channel.send(CollectionRunEventDto::RunStarted {
            iterations,
            requests_per_iteration,
        });
    }

    fn iteration_started(&self, iteration: u32) {
        let _ = self
            .channel
            .send(CollectionRunEventDto::IterationStarted { iteration });
    }

    fn request_started(&self, iteration: u32, position: usize, request_id: &str) {
        let _ = self.channel.send(CollectionRunEventDto::RequestStarted {
            iteration,
            position,
            request_id: request_id.to_string(),
        });
    }

    fn request_finished(&self, report: &RunStepReport, response: Option<&Response>) {
        let has_output = match response {
            Some(response) if self.options.persist_responses => {
                self.outputs
                    .store(self.run_id, report.iteration, report.position, response)
            }
            _ => false,
        };
        let step = step_dto(report, self.options.disable_logs, has_output);
        self.steps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(recorded_step(&step, millis(SystemTime::now())));
        let _ = self.channel.send(CollectionRunEventDto::RequestFinished {
            step: Box::new(step),
        });
    }
}

fn step_dto(report: &RunStepReport, disable_logs: bool, has_output: bool) -> RunStepDto {
    RunStepDto {
        iteration: report.iteration,
        position: report.position,
        request_id: report.request_id.clone(),
        name: report.name.clone(),
        protocol: report.protocol.map(|p| protocol_label(p).to_string()),
        method: report.method.clone(),
        resolved_url: report.resolved_url.clone(),
        outcome: report.outcome.into(),
        status_code: report.status_code,
        duration_ms: report.duration_ms,
        size_bytes: report.size_bytes,
        error_message: report.error_message.clone(),
        tests: report
            .tests
            .iter()
            .map(|test| ScriptTestOutput {
                name: test.name.clone(),
                passed: test.passed,
                message: test.message.clone(),
            })
            .collect(),
        logs: if disable_logs {
            Vec::new()
        } else {
            report.logs.clone()
        },
        has_output,
    }
}

fn recorded_step(step: &RunStepDto, at_ms: u64) -> RecordedRunStep {
    RecordedRunStep {
        at_ms,
        iteration: step.iteration,
        position: step.position,
        request_id: step.request_id.clone(),
        name: step.name.clone(),
        protocol: step.protocol.clone(),
        method: step.method.clone(),
        resolved_url: step.resolved_url.clone(),
        outcome: step.outcome.into(),
        status_code: step.status_code,
        duration_ms: step.duration_ms,
        size_bytes: step.size_bytes,
        error_message: step.error_message.clone(),
        tests: step
            .tests
            .iter()
            .map(|test| RecordedTest {
                name: test.name.clone(),
                passed: test.passed,
                message: test.message.clone(),
            })
            .collect(),
        logs: step.logs.clone(),
    }
}

/// Requisição gravada de volta ao formato do evento ao vivo.
pub(crate) fn step_dto_from_recorded(step: RecordedRunStep, has_output: bool) -> RunStepDto {
    RunStepDto {
        iteration: step.iteration,
        position: step.position,
        request_id: step.request_id,
        name: step.name,
        protocol: step.protocol,
        method: step.method,
        resolved_url: step.resolved_url,
        outcome: step.outcome.into(),
        status_code: step.status_code,
        duration_ms: step.duration_ms,
        size_bytes: step.size_bytes,
        error_message: step.error_message,
        tests: step
            .tests
            .into_iter()
            .map(|test| ScriptTestOutput {
                name: test.name,
                passed: test.passed,
                message: test.message,
            })
            .collect(),
        logs: step.logs,
        has_output,
    }
}

pub(crate) fn node_output_from_recorded(output: &RecordedStepOutput) -> FlowNodeOutput {
    FlowNodeOutput {
        request: None,
        status_code: output.status_code,
        duration_ms: output.duration_ms,
        size_bytes: output.size_bytes,
        headers: output
            .headers
            .iter()
            .map(|(name, value)| ResponseHeaderOutput {
                name: name.clone(),
                value: value.clone(),
            })
            .collect(),
        body: output.body.clone(),
        body_encoding: if output.base64 {
            ResponseBodyEncodingOutput::Base64
        } else {
            ResponseBodyEncodingOutput::Text
        },
        truncated: output.truncated,
    }
}

fn recorded_output(
    (iteration, position): (u32, usize),
    output: FlowNodeOutput,
) -> RecordedStepOutput {
    RecordedStepOutput {
        iteration,
        position,
        status_code: output.status_code,
        duration_ms: output.duration_ms,
        size_bytes: output.size_bytes,
        headers: output
            .headers
            .into_iter()
            .map(|header| (header.name, header.value))
            .collect(),
        body: output.body,
        base64: output.body_encoding == ResponseBodyEncodingOutput::Base64,
        truncated: output.truncated,
    }
}

fn plan_items(collections: &[Collection], request_ids: &[String]) -> Vec<RecordedPlanItem> {
    request_ids
        .iter()
        .map(|id| match find_saved_request(collections, id) {
            Some(saved) => RecordedPlanItem {
                request_id: id.clone(),
                name: saved.name().to_string(),
                protocol: protocol_label(saved.request.document.protocol).to_string(),
                method: match saved.request.document.protocol {
                    ProtocolId::Rest => HttpMethodInput::from(saved.request.method)
                        .as_str()
                        .to_string(),
                    ProtocolId::GraphQl => "post".to_string(),
                    // Shown as the step's label: a gRPC call has no HTTP method.
                    ProtocolId::Grpc => "grpc".to_string(),
                },
            },
            None => RecordedPlanItem {
                request_id: id.clone(),
                name: String::new(),
                protocol: String::new(),
                method: String::new(),
            },
        })
        .collect()
}

fn millis(instant: SystemTime) -> u64 {
    instant
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

async fn load_iteration_data(path: &str) -> Result<IterationData, ExecuteCollectionRunError> {
    let data_error = |message: String| ExecuteCollectionRunError::DataFile { message };
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| data_error(error.to_string()))?;
    if metadata.len() as usize > MAX_ITERATION_DATA_BYTES {
        return Err(data_error("o arquivo de dados passa de 10 MB".to_string()));
    }
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|error| data_error(error.to_string()))?;
    parse_iteration_data(&text).map_err(|error| data_error(error.to_string()))
}

fn record_run(
    root_path: &str,
    record: CollectionRunRecord,
    retention: HistoryRetention,
) -> tauri::async_runtime::JoinHandle<()> {
    let store = CollectionRunHistoryStore::new(PathBuf::from(root_path), retention.duration());
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = store.record(&record) {
            log::warn!("falha ao gravar histórico do runner: {error}");
        }
    })
}

/// Executa um run de coleção. Erros antes do run começar voltam como
/// rejeição sem nenhum evento; depois disso o run só termina com
/// `runFinished`.
#[tauri::command]
pub async fn execute_collection_run(
    input: ExecuteCollectionRunInput,
    on_event: Channel<CollectionRunEventDto>,
    registry: tauri::State<'_, FlowExecutionRegistry>,
    outputs: tauri::State<'_, CollectionRunOutputs>,
    graphql_executor: tauri::State<'_, ReqwestGraphqlExecutor>,
    rest_executor: tauri::State<'_, ReqwestRestExecutor>,
    history: tauri::State<'_, HistoryPreferencesState>,
) -> Result<(), ExecuteCollectionRunError> {
    let run_id = input.run_id.clone();
    let started = std::time::Instant::now();
    log::info!(
        target: "alcy::runner",
        "{run_id}: iniciando execução de coleção ({} requisições, arquivo de dados: {})",
        input.request_ids.len(),
        if input.data_file_path.is_some() { "sim" } else { "não" }
    );
    let result = execute_collection_run_inner(
        input,
        &on_event,
        &registry,
        &outputs,
        &graphql_executor,
        &rest_executor,
        history.get(),
    )
    .await;
    match &result {
        Ok(()) => log::info!(
            target: "alcy::runner",
            "{run_id}: execução terminou em {} ms",
            started.elapsed().as_millis()
        ),
        Err(error) => log::warn!(
            target: "alcy::runner",
            "{run_id}: execução falhou ({})",
            crate::logging::error_kind(error)
        ),
    }
    result
}

async fn execute_collection_run_inner(
    input: ExecuteCollectionRunInput,
    on_event: &Channel<CollectionRunEventDto>,
    registry: &FlowExecutionRegistry,
    outputs: &CollectionRunOutputs,
    graphql_executor: &ReqwestGraphqlExecutor,
    rest_executor: &ReqwestRestExecutor,
    history: HistoryPreferences,
) -> Result<(), ExecuteCollectionRunError> {
    if input.request_ids.is_empty() {
        return Err(ExecuteCollectionRunError::EmptyPlan);
    }
    let invalid = |message: String| ExecuteCollectionRunError::InvalidOptions { message };
    let raw = input.options;
    let mut options = CollectionRunOptions::new(raw.iterations, raw.delay_ms)
        .map_err(|error| invalid(error.to_string()))?;
    options.stop_on_error = raw.stop_on_error;
    options.http_errors_fail = raw.http_errors_fail;
    options.keep_variable_values = raw.keep_variable_values;
    options.share_cookies = raw.share_cookies;
    options.persist_responses = raw.persist_responses;
    options.save_to_history = raw.save_to_history;

    let environment = input
        .environment_variables
        .iter()
        .map(|variable| {
            EnvironmentVariable::new(
                variable.name.clone(),
                variable.value.clone(),
                variable.sensitive,
            )
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| invalid(error.to_string()))?;

    let data = match input.data_file_path.as_deref().filter(|p| !p.is_empty()) {
        Some(path) => load_iteration_data(path).await?,
        None => IterationData::default(),
    };

    let root_path = input.root_path.clone();
    let collections = tauri::async_runtime::spawn_blocking(move || {
        CollectionsStore::new(PathBuf::from(root_path)).load()
    })
    .await
    .map_err(|error| ExecuteCollectionRunError::Storage {
        message: error.to_string(),
    })?
    .map_err(|error| ExecuteCollectionRunError::Storage {
        message: error.to_string(),
    })?;

    let (sender, receiver) = watch::channel(false);
    registry.register(input.run_id.clone(), sender);
    let cancellation = WatchCancellation(receiver);

    let step = CollectionRunStepExecutor {
        inner: ProtocolDispatchingExecutor {
            graphql: graphql_executor,
            rest: rest_executor,
            workspace_root: Path::new(&input.root_path),
        },
        cookies: options.share_cookies.then(CookieJar::default),
        runtime_variables: Mutex::new(Vec::new()),
    };
    outputs.begin(&input.run_id);
    let sink = ChannelSink {
        channel: on_event,
        outputs,
        run_id: &input.run_id,
        options: raw,
        iterations: Mutex::new(0),
        steps: Mutex::new(Vec::new()),
    };

    let started_at = SystemTime::now();
    let summary = run_collection(
        &CollectionRunPlan {
            request_ids: &input.request_ids,
            collections: &collections,
            options: &options,
            environment: &environment,
            data: &data,
        },
        &step,
        &sink,
        &cancellation,
    )
    .await;
    registry.remove(&input.run_id);

    let steps = sink.take_steps();
    if !steps.is_empty() {
        let record = CollectionRunRecord {
            id: input.run_id.clone(),
            scope_name: input.scope_name.clone(),
            environment_name: input
                .environment_name
                .clone()
                .filter(|name| !name.is_empty()),
            started_at,
            finished_at: SystemTime::now(),
            cancelled: summary.cancelled,
            stopped_on_error: summary.stopped_on_error,
            iterations: sink.iterations(),
            options: RecordedRunOptions {
                iterations: raw.iterations,
                delay_ms: raw.delay_ms,
                stop_on_error: raw.stop_on_error,
                http_errors_fail: raw.http_errors_fail,
                keep_variable_values: raw.keep_variable_values,
                share_cookies: raw.share_cookies,
                persist_responses: raw.persist_responses,
                disable_logs: raw.disable_logs,
                data_file_name: input.data_file_path.as_deref().and_then(|path| {
                    Path::new(path)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                }),
            },
            plan: plan_items(&collections, &input.request_ids),
            steps,
            outputs: Vec::new(),
        };
        outputs.set_record(record);
        if options.save_to_history && !history.retention.is_disabled() {
            if let Some(mut record) = outputs.record(&input.run_id) {
                // Sem "Salvar respostas", o run fica no histórico com o status,
                // o tempo e o tamanho de cada passo, mas sem as respostas.
                if !history.save_responses {
                    record.outputs.clear();
                }
                // Aguarda a escrita para o histórico já estar em disco quando
                // o frontend receber `runFinished` e recarregar a lista.
                let _ = record_run(&input.root_path, record, history.retention).await;
            }
        }
    }

    let (environment_changes, scoped_changes) = if options.keep_variable_values {
        (
            summary
                .environment_changes
                .into_iter()
                .map(|(name, value)| EnvironmentChangeOutput { name, value })
                .collect(),
            summary
                .scoped_changes
                .into_iter()
                .map(ScopedChangeOutput::from)
                .collect(),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    let _ = on_event.send(CollectionRunEventDto::RunFinished {
        cancelled: summary.cancelled,
        stopped_on_error: summary.stopped_on_error,
        environment_changes,
        scoped_changes,
    });

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelCollectionRunInput {
    pub run_id: String,
}

/// Idempotente: cancelar um run que já terminou não faz nada.
#[tauri::command]
pub fn cancel_collection_run(
    input: CancelCollectionRunInput,
    registry: tauri::State<'_, FlowExecutionRegistry>,
) {
    log::info!(target: "alcy::runner", "{}: cancelamento pedido", input.run_id);
    registry.cancel(&input.run_id);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCollectionRunOutputInput {
    pub run_id: String,
    pub iteration: u32,
    pub position: usize,
}

/// Resposta guardada de uma requisição do último run, buscada sob demanda
/// para que os corpos não trafeguem nos eventos de progresso.
#[tauri::command]
pub fn get_collection_run_output(
    input: GetCollectionRunOutputInput,
    outputs: tauri::State<'_, CollectionRunOutputs>,
) -> Option<FlowNodeOutput> {
    outputs.get(&input.run_id, input.iteration, input.position)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewIterationDataInput {
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IterationDataPreviewDto {
    pub file_name: String,
    pub columns: Vec<String>,
    pub row_count: usize,
    /// Primeiras linhas, na ordem das colunas.
    pub sample: Vec<Vec<String>>,
}

const PREVIEW_ROWS: usize = 5;

/// Valida o arquivo de dados e devolve um resumo pequeno (colunas, total e
/// algumas linhas); o conteúdo inteiro não atravessa o IPC.
#[tauri::command]
pub async fn preview_iteration_data(
    input: PreviewIterationDataInput,
) -> Result<IterationDataPreviewDto, ExecuteCollectionRunError> {
    let data = load_iteration_data(&input.path).await?;
    Ok(preview_from(&input.path, &data))
}

fn preview_from(path: &str, data: &IterationData) -> IterationDataPreviewDto {
    IterationDataPreviewDto {
        file_name: Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string()),
        columns: data.columns.clone(),
        row_count: data.len(),
        sample: data
            .rows
            .iter()
            .take(PREVIEW_ROWS)
            .map(|row| {
                data.columns
                    .iter()
                    .map(|column| {
                        row.iter()
                            .find(|(name, _)| name == column)
                            .map(|(_, value)| value.clone())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::ResponseMetadata;

    fn response(body: &str) -> Response {
        Response::new(200, 5, body, Vec::new(), ResponseMetadata::default())
    }

    #[test]
    fn outputs_belong_to_the_current_run_only() {
        let outputs = CollectionRunOutputs::default();
        outputs.begin("run-1");
        assert!(outputs.store("run-1", 0, 1, &response("{}")));
        assert!(!outputs.store("other", 0, 2, &response("{}")));

        assert_eq!(
            outputs.get("run-1", 0, 1).map(|o| o.body),
            Some("{}".to_string())
        );
        assert!(outputs.get("run-1", 0, 2).is_none());

        outputs.begin("run-2");
        assert!(outputs.get("run-1", 0, 1).is_none());
    }

    #[test]
    fn outputs_stop_being_stored_past_the_run_budget() {
        let outputs = CollectionRunOutputs::default();
        outputs.begin("run");
        let body = "x".repeat(256 * 1024);
        let fits = MAX_RUN_OUTPUT_BYTES / body.len();
        for position in 0..fits {
            assert!(outputs.store("run", 0, position, &response(&body)));
        }
        assert!(!outputs.store("run", 0, fits, &response(&body)));
    }

    #[test]
    fn step_events_serialize_in_camel_case() {
        let report = RunStepReport {
            iteration: 1,
            position: 2,
            request_id: "r".to_string(),
            name: "Login".to_string(),
            protocol: Some(ProtocolId::Rest),
            method: "post".to_string(),
            resolved_url: "https://api.test/login".to_string(),
            outcome: RunStepOutcome::Failed,
            status_code: Some(401),
            duration_ms: Some(12),
            size_bytes: Some(2),
            error_message: None,
            tests: Vec::new(),
            logs: vec!["log".to_string()],
        };
        let event = CollectionRunEventDto::RequestFinished {
            step: Box::new(step_dto(&report, true, false)),
        };

        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "requestFinished");
        assert_eq!(json["step"]["requestId"], "r");
        assert_eq!(json["step"]["statusCode"], 401);
        assert_eq!(json["step"]["outcome"], "failed");
        assert_eq!(json["step"]["protocol"], "rest");
        // `disable_logs` tira os logs do evento.
        assert_eq!(json["step"]["logs"], serde_json::json!([]));
    }

    #[test]
    fn recorded_steps_roundtrip_to_the_live_shape() {
        let report = RunStepReport {
            iteration: 0,
            position: 0,
            request_id: "r".to_string(),
            name: "Me".to_string(),
            protocol: Some(ProtocolId::GraphQl),
            method: "post".to_string(),
            resolved_url: "https://api.test/graphql".to_string(),
            outcome: RunStepOutcome::Passed,
            status_code: Some(200),
            duration_ms: Some(3),
            size_bytes: Some(10),
            error_message: None,
            tests: vec![alcy_domain::RunTestResult {
                name: "ok".to_string(),
                passed: true,
                message: None,
            }],
            logs: Vec::new(),
        };
        let live = step_dto(&report, false, true);

        let restored = step_dto_from_recorded(recorded_step(&live, 5), true);

        assert_eq!(restored, live);
    }

    #[test]
    fn preview_lists_columns_and_the_first_rows() {
        let data = parse_iteration_data("a,b\n1,2\n3,4").unwrap();

        let preview = preview_from("/tmp/dados.csv", &data);

        assert_eq!(preview.file_name, "dados.csv");
        assert_eq!(preview.columns, vec!["a", "b"]);
        assert_eq!(preview.row_count, 2);
        assert_eq!(preview.sample, vec![vec!["1", "2"], vec!["3", "4"]]);
    }
}
