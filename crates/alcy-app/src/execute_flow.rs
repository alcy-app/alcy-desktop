use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::time::Duration;

use alcy_domain::{
    Authentication, Collection, Condition, EnvironmentVariable, ExecutionError, Flow, FlowNodeKind,
    MockCallCountOperator, Request, Response, effective_authentication, find_saved_request,
    merge_variables, variable_scopes,
};
use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use thiserror::Error;

use crate::evaluate_condition::evaluate_condition;
use crate::flow_graph::{FlowGraph, Successor, build_flow_graph};
use crate::mock_control::{
    CapturedRequest, MockControlError, MockRouteSummary, MockRunHandle, MockServerControl,
};
use crate::node_reference::NodeRunHistory;
use crate::resolve_number_setting::resolve_integer_setting;
use crate::resolve_variables::{
    MAX_OUTPUT_VALUE_CHARS, resolve_for_display_with_limit, resolve_request_for_display,
};
use crate::run_variables::{apply_assignments, with_run_variables};
use crate::{RequestExecutor, Substitution, resolve_request_variables};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FlowRunError {
    #[error("invalid initial form: {0}")]
    InvalidForm(String),
    #[error("flow não tem um node Start")]
    MissingStartNode,
    #[error("flow contém um ciclo alcançável a partir do Start")]
    CyclicGraph,
    /// A While body must be closed: no exiting edges or entries outside its loop output (ADR 0033).
    #[error("o corpo do While '{while_node_id}' precisa ser fechado")]
    InvalidLoopBody { while_node_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowNodeSkipReason {
    /// Generic Block without executable behavior.
    NotRunnable,
    /// No path from Start; never dispatched.
    Unreachable,
    /// Cancelled before this node started.
    Cancelled,
    /// Reachable only through an untaken branch. Successor degrees still decrement so they cannot remain pending forever (specs 0047/0048).
    BranchNotTaken,
    /// Break/Continue ended the enclosing iteration before this node started (spec 0085).
    LoopInterrupted,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FlowNodeOutcome {
    Success {
        status_code: u16,
        duration_ms: u64,
    },
    /// If follows the matching true/false output. Mock wait/assert blocks also provide a message; If does not.
    Branched {
        result: bool,
        message: Option<String>,
    },
    Failed {
        message: String,
    },
    /// Completed non-request node: Log/Display carry redacted text, SetVariables an assignment summary, Sleep no message.
    Completed {
        message: Option<String>,
    },
    /// One-based While iteration. Finish its complete body before reevaluating the condition.
    LoopIteration {
        iteration: u32,
    },
    /// While took done after this number of iterations.
    LoopFinished {
        iterations: u32,
    },
    Cancelled,
    Skipped(FlowNodeSkipReason),
}

/// Maximum Sleep duration (10 minutes).
pub const MAX_SLEEP_MS: u64 = 10 * 60 * 1000;

/// Maximum accepted While iteration limit (ADR 0033).
pub const MAX_WHILE_ITERATIONS: u32 = 10_000;

/// Recorded call: saved URL template, actual URL with secrets redacted, and URL variables used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestCallDetails {
    pub request_url: String,
    pub resolved_url: String,
    pub variables: Vec<Substitution>,
    /// URL actually sent, route parameters applied and secrets revealed. Only for
    /// live consumers such as the HAR recorder: never persist it.
    pub sent_url: String,
}

/// Progress port keeping application use cases independent of concrete IPC implementations.
pub trait FlowRunSink: Sync {
    fn node_waiting_for_human(&self, _node_id: &str, _wait_id: &str) {}
    fn node_form_submitted(&self, _node_id: &str) {}
    fn node_started(&self, node_id: &str);
    fn node_finished(&self, node_id: &str, outcome: FlowNodeOutcome);
    /// Deliver responses before node_finished, separately from small progress events; optional for consumers that need no output.
    fn node_output(&self, _node_id: &str, _response: &Response) {}
    /// Deliver request URL details after node_started; optional like node_output.
    fn node_call(&self, _node_id: &str, _details: &RequestCallDetails) {}
    /// Captured MockWaitRequest input delivered before node_finished; optional like node_output.
    fn node_request(&self, _node_id: &str, _request: &CapturedRequest) {}
}

/// Cancellation creates a fresh future per call so concurrent nodes can race against one run signal.
pub trait FlowCancellation: Sync {
    fn is_cancelled(&self) -> bool;
    fn cancelled(&self) -> impl Future<Output = ()> + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowRunSummary {
    pub cancelled: bool,
}

pub struct FlowInteraction<'a, H> {
    pub human: &'a H,
    pub initial_answers: &'a crate::FormAnswers,
}

/// Dispatch each node when its actual dependencies finish, without whole-layer barriers. While reenters closed bodies without graph cycles. Blocks/unreachable nodes resolve immediately; notes are excluded. Run variables override environment/scopes. Stop owned mocks on every exit.
pub async fn execute_flow<E, S, C, M>(
    flow: &Flow,
    collections: &[Collection],
    executor: &E,
    environment_variables: &[EnvironmentVariable],
    sink: &S,
    cancellation: &C,
    mocks: &M,
) -> Result<FlowRunSummary, FlowRunError>
where
    E: RequestExecutor,
    S: FlowRunSink,
    C: FlowCancellation,
    M: MockServerControl,
{
    execute_flow_interactive(
        flow,
        collections,
        executor,
        environment_variables,
        sink,
        cancellation,
        mocks,
        FlowInteraction {
            human: &crate::NoHumanInteraction,
            initial_answers: &crate::FormAnswers::new(),
        },
    )
    .await
}

/// Interactive execution shares the standard scheduler and cancellation path.
#[allow(clippy::too_many_arguments)]
pub async fn execute_flow_interactive<E, S, C, M, H>(
    flow: &Flow,
    collections: &[Collection],
    executor: &E,
    environment_variables: &[EnvironmentVariable],
    sink: &S,
    cancellation: &C,
    mocks: &M,
    interaction: FlowInteraction<'_, H>,
) -> Result<FlowRunSummary, FlowRunError>
where
    E: RequestExecutor,
    S: FlowRunSink,
    C: FlowCancellation,
    M: MockServerControl,
    H: crate::FlowHumanInteraction,
{
    let graph = build_flow_graph(flow)?;

    let mut history = NodeRunHistory::new();
    for node in flow.nodes() {
        if let FlowNodeKind::StartForm { form } = &node.kind {
            crate::validate_form_definition(form, false).map_err(FlowRunError::InvalidForm)?;
            let prepared = crate::PreparedFlowForm {
                form: form.clone(),
                sources: HashMap::new(),
            };
            let values = prepared
                .validate_answers(interaction.initial_answers)
                .map_err(FlowRunError::InvalidForm)?;
            history.record_form(node.id.clone(), values);
        }
    }

    for node_id in &graph.unreachable {
        sink.node_finished(
            node_id,
            FlowNodeOutcome::Skipped(FlowNodeSkipReason::Unreachable),
        );
    }

    let node_kind_by_id = |node_id: &str| {
        flow.nodes()
            .iter()
            .find(|node| node.id == node_id)
            .map(|node| &node.kind)
    };

    // Run variables are accessed only during synchronous dispatch; dispatch order resolves writes without parallel-branch races.
    let mut run_variables: Vec<EnvironmentVariable> = Vec::new();
    let mut scheduler = Scheduler::new(&graph);
    let mut in_flight = FuturesUnordered::new();
    let no_ancestors = HashSet::new();
    let mut mock_session = MockSession::default();

    loop {
        while let Some(work) = scheduler.next_work() {
            let node_id = match work {
                Work::Node(node_id) => node_id,
                Work::LoopCheck(while_id) => {
                    // Break/Continue from an outer While also ends this active inner loop.
                    if scheduler.is_interrupted(&while_id) {
                        sink.node_finished(
                            &while_id,
                            FlowNodeOutcome::Skipped(FlowNodeSkipReason::LoopInterrupted),
                        );
                        scheduler.complete(&while_id, false, None);
                        continue;
                    }
                    if scheduler.take_exit(&while_id) == Some(LoopExit::Break) {
                        let iterations = scheduler.iterations(&while_id);
                        sink.node_finished(&while_id, FlowNodeOutcome::LoopFinished { iterations });
                        scheduler.complete(&while_id, true, Some(LOOP_DONE_HANDLE));
                        continue;
                    }
                    if let Some(FlowNodeKind::While {
                        condition,
                        max_iterations,
                    }) = node_kind_by_id(&while_id)
                    {
                        let variables = with_run_variables(environment_variables, &run_variables);
                        step_loop(
                            &while_id,
                            condition,
                            max_iterations,
                            &mut scheduler,
                            &variables,
                            &history,
                            sink,
                            cancellation,
                        );
                    }
                    continue;
                }
            };
            let node_flowed_in = scheduler.flowed_in(&node_id);

            if cancellation.is_cancelled() {
                sink.node_finished(
                    &node_id,
                    FlowNodeOutcome::Skipped(FlowNodeSkipReason::Cancelled),
                );
                skip_loop_body(&graph, &node_id, FlowNodeSkipReason::Cancelled, sink);
                scheduler.complete(&node_id, node_flowed_in, None);
                continue;
            }

            if scheduler.is_interrupted(&node_id) {
                sink.node_finished(
                    &node_id,
                    FlowNodeOutcome::Skipped(FlowNodeSkipReason::LoopInterrupted),
                );
                skip_loop_body(&graph, &node_id, FlowNodeSkipReason::LoopInterrupted, sink);
                scheduler.complete(&node_id, false, None);
                continue;
            }

            if !node_flowed_in {
                sink.node_finished(
                    &node_id,
                    FlowNodeOutcome::Skipped(FlowNodeSkipReason::BranchNotTaken),
                );
                skip_loop_body(&graph, &node_id, FlowNodeSkipReason::BranchNotTaken, sink);
                scheduler.complete(&node_id, false, None);
                continue;
            }

            match node_kind_by_id(&node_id) {
                Some(FlowNodeKind::Start | FlowNodeKind::StartForm { .. })
                | Some(FlowNodeKind::Block { .. })
                | Some(FlowNodeKind::Note { .. })
                | None => {
                    sink.node_finished(
                        &node_id,
                        FlowNodeOutcome::Skipped(FlowNodeSkipReason::NotRunnable),
                    );
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::Load { .. }) => {
                    sink.node_finished(
                        &node_id,
                        FlowNodeOutcome::Failed {
                            message: "blocos de carga exigem o executor de carga".to_string(),
                        },
                    );
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::HumanAction { form }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    sink.node_started(&node_id);
                    in_flight.push(run_in_flight(
                        node_id.clone(),
                        InFlightWork::Human(Box::new(HumanPreparation {
                            form: form.clone(),
                            history: history.clone(),
                            ancestors: ancestors.clone(),
                        })),
                        executor,
                        cancellation,
                        mocks,
                        interaction.human,
                    ));
                }
                Some(FlowNodeKind::If { condition }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let variables = with_run_variables(environment_variables, &run_variables);
                    match evaluate_condition(condition, &variables, &history, ancestors) {
                        Ok(result) => {
                            sink.node_finished(
                                &node_id,
                                FlowNodeOutcome::Branched {
                                    result,
                                    message: None,
                                },
                            );
                            let taken_handle = if result { "true" } else { "false" };
                            scheduler.complete(&node_id, true, Some(taken_handle));
                        }
                        Err(error) => {
                            sink.node_finished(
                                &node_id,
                                FlowNodeOutcome::Failed {
                                    message: error.to_string(),
                                },
                            );
                            // An unevaluated condition takes no branch; successors need another incoming path.
                            scheduler.complete(&node_id, true, None);
                        }
                    }
                }
                Some(FlowNodeKind::Request { request_id }) => {
                    let Some(saved_request) = find_saved_request(collections, request_id) else {
                        sink.node_finished(
                            &node_id,
                            FlowNodeOutcome::Failed {
                                message: "referência de requisição não encontrada".to_string(),
                            },
                        );
                        scheduler.complete(&node_id, true, Some(REQUEST_FAILURE_HANDLE));
                        continue;
                    };

                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let mut request_to_run = saved_request.request.clone();
                    request_to_run.authentication =
                        effective_authentication(collections, request_id);
                    // Overlay environment with this request collection/folder variables (ADR 0031).
                    let variables = with_run_variables(
                        &merge_variables(
                            environment_variables,
                            &variable_scopes(collections, request_id),
                        ),
                        &run_variables,
                    );
                    let Some(resolved) = prepare_request(
                        &node_id,
                        &request_to_run,
                        &variables,
                        &history,
                        ancestors,
                        sink,
                    ) else {
                        scheduler.complete(&node_id, true, Some(REQUEST_FAILURE_HANDLE));
                        continue;
                    };
                    in_flight.push(run_in_flight(
                        node_id.clone(),
                        InFlightWork::Request {
                            request_id: Some(request_id.clone()),
                            request: Box::new(resolved),
                        },
                        executor,
                        cancellation,
                        mocks,
                        interaction.human,
                    ));
                }
                Some(FlowNodeKind::InlineRequest { request: inline }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let mut request_to_run = inline.request.clone();
                    // Inline requests have no collection ancestor; inherited authentication becomes None.
                    if matches!(request_to_run.authentication, Authentication::Inherit) {
                        request_to_run.authentication = Authentication::None;
                    }
                    let variables = with_run_variables(environment_variables, &run_variables);
                    let Some(resolved) = prepare_request(
                        &node_id,
                        &request_to_run,
                        &variables,
                        &history,
                        ancestors,
                        sink,
                    ) else {
                        scheduler.complete(&node_id, true, Some(REQUEST_FAILURE_HANDLE));
                        continue;
                    };
                    in_flight.push(run_in_flight(
                        node_id.clone(),
                        InFlightWork::Request {
                            request_id: None,
                            request: Box::new(resolved),
                        },
                        executor,
                        cancellation,
                        mocks,
                        interaction.human,
                    ));
                }
                Some(FlowNodeKind::Log { message: template })
                | Some(FlowNodeKind::Display { template }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let variables = with_run_variables(environment_variables, &run_variables);
                    let outcome = match resolve_for_display_with_limit(
                        template,
                        &variables,
                        &history,
                        ancestors,
                        MAX_OUTPUT_VALUE_CHARS,
                    ) {
                        Ok(resolved) => FlowNodeOutcome::Completed {
                            message: Some(resolved.text),
                        },
                        Err(error) => FlowNodeOutcome::Failed {
                            message: error.to_string(),
                        },
                    };
                    sink.node_finished(&node_id, outcome);
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::SetVariables { assignments }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let outcome = match apply_assignments(
                        assignments,
                        environment_variables,
                        &run_variables,
                        &history,
                        ancestors,
                    ) {
                        Ok((next, summary)) => {
                            run_variables = next;
                            FlowNodeOutcome::Completed {
                                message: Some(summary),
                            }
                        }
                        Err(error) => FlowNodeOutcome::Failed {
                            message: error.to_string(),
                        },
                    };
                    sink.node_finished(&node_id, outcome);
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::Sleep { duration_ms }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let variables = with_run_variables(environment_variables, &run_variables);
                    let duration_ms =
                        match resolve_integer_setting(duration_ms, &variables, &history, ancestors)
                        {
                            Ok(duration_ms) if duration_ms > MAX_SLEEP_MS => Err(format!(
                                "espera de {duration_ms} ms acima do limite de {MAX_SLEEP_MS} ms"
                            )),
                            Ok(duration_ms) => Ok(duration_ms),
                            Err(error) => Err(format!("duração da espera: {error}")),
                        };
                    let duration_ms = match duration_ms {
                        Ok(duration_ms) => duration_ms,
                        Err(message) => {
                            sink.node_finished(&node_id, FlowNodeOutcome::Failed { message });
                            scheduler.complete(&node_id, true, None);
                            continue;
                        }
                    };
                    sink.node_started(&node_id);
                    in_flight.push(run_in_flight(
                        node_id.clone(),
                        InFlightWork::Sleep(Duration::from_millis(duration_ms)),
                        executor,
                        cancellation,
                        mocks,
                        interaction.human,
                    ));
                }
                Some(FlowNodeKind::MockStart { source }) => {
                    let started = match mock_session.handles.get(&node_id) {
                        // A mock inside While stays running between iterations.
                        Some(handle) => Ok(handle.clone()),
                        None => mocks.start(&node_id, source),
                    };
                    let outcome = match started {
                        Ok(handle) => {
                            let reused = if handle.owned {
                                ""
                            } else {
                                " (já estava ligado)"
                            };
                            let message = format!("{} em {}{reused}", handle.name, handle.url());
                            history.record_server_url(node_id.clone(), handle.url());
                            mock_session.handles.insert(node_id.clone(), handle);
                            FlowNodeOutcome::Completed {
                                message: Some(message),
                            }
                        }
                        Err(error) => FlowNodeOutcome::Failed {
                            message: error.to_string(),
                        },
                    };
                    sink.node_finished(&node_id, outcome);
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::MockStop { start_node_id }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let outcome = match mock_session.handle(start_node_id, ancestors) {
                        Ok(handle) => {
                            let message = format!("{} desligado", handle.name);
                            mocks.stop(&handle.key);
                            mock_session.remove(start_node_id);
                            FlowNodeOutcome::Completed {
                                message: Some(message),
                            }
                        }
                        Err(message) => FlowNodeOutcome::Failed { message },
                    };
                    sink.node_finished(&node_id, outcome);
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::MockWaitRequest {
                    start_node_id,
                    route_id,
                    timeout_ms,
                }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let variables = with_run_variables(environment_variables, &run_variables);
                    let timeout_ms =
                        resolve_integer_setting(timeout_ms, &variables, &history, ancestors)
                            .map_err(|error| format!("tempo de espera: {error}"));
                    let work = match timeout_ms {
                        Err(message) => Err(message),
                        Ok(timeout_ms) if timeout_ms == 0 || timeout_ms > MAX_SLEEP_MS => {
                            Err(format!(
                                "tempo de espera de {timeout_ms} ms fora do intervalo de 1 a {MAX_SLEEP_MS} ms"
                            ))
                        }
                        Ok(timeout_ms) => mock_session
                            .route(start_node_id, route_id, ancestors)
                            .map(|(handle, route)| InFlightWork::MockWait {
                                start_node_id: start_node_id.clone(),
                                key: handle.key.clone(),
                                route_id: route_id.clone(),
                                route_label: route.label.clone(),
                                after_seq: mock_session.cursor(start_node_id, route_id),
                                timeout: Duration::from_millis(timeout_ms),
                            }),
                    };
                    match work {
                        Ok(work) => {
                            sink.node_started(&node_id);
                            in_flight.push(run_in_flight(
                                node_id.clone(),
                                work,
                                executor,
                                cancellation,
                                mocks,
                                interaction.human,
                            ));
                        }
                        Err(message) => {
                            sink.node_finished(&node_id, FlowNodeOutcome::Failed { message });
                            scheduler.complete(&node_id, true, None);
                        }
                    }
                }
                Some(FlowNodeKind::MockSetResponse {
                    start_node_id,
                    route_id,
                    response_id,
                }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let outcome = match set_mock_response(
                        &mock_session,
                        mocks,
                        start_node_id,
                        route_id,
                        response_id.as_deref(),
                        ancestors,
                    ) {
                        Ok(message) => FlowNodeOutcome::Completed {
                            message: Some(message),
                        },
                        Err(message) => FlowNodeOutcome::Failed { message },
                    };
                    sink.node_finished(&node_id, outcome);
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::MockAssertCalls {
                    start_node_id,
                    route_id,
                    operator,
                    count,
                }) => {
                    let ancestors = graph.ancestors.get(&node_id).unwrap_or(&no_ancestors);
                    let variables = with_run_variables(environment_variables, &run_variables);
                    let checked = resolve_integer_setting(count, &variables, &history, ancestors)
                        .map_err(|error| format!("chamadas esperadas: {error}"))
                        .and_then(|count| {
                            u32::try_from(count).map_err(|_| {
                                format!(
                                    "chamadas esperadas: {count} acima do limite de {}",
                                    u32::MAX
                                )
                            })
                        })
                        .and_then(|count| {
                            assert_mock_calls(
                                &mock_session,
                                mocks,
                                start_node_id,
                                route_id,
                                *operator,
                                count,
                                ancestors,
                            )
                        });
                    match checked {
                        Ok((result, message)) => {
                            sink.node_finished(
                                &node_id,
                                FlowNodeOutcome::Branched {
                                    result,
                                    message: Some(message),
                                },
                            );
                            let taken_handle = if result { "true" } else { "false" };
                            scheduler.complete(&node_id, true, Some(taken_handle));
                        }
                        Err(message) => {
                            sink.node_finished(&node_id, FlowNodeOutcome::Failed { message });
                            scheduler.complete(&node_id, true, None);
                        }
                    }
                }
                Some(kind @ (FlowNodeKind::Break | FlowNodeKind::Continue)) => {
                    let exit = if matches!(kind, FlowNodeKind::Break) {
                        LoopExit::Break
                    } else {
                        LoopExit::Continue
                    };
                    let outcome = match graph.loop_owners.get(&node_id) {
                        Some(owner) => {
                            scheduler.request_exit(owner, exit);
                            FlowNodeOutcome::Completed { message: None }
                        }
                        None => FlowNodeOutcome::Failed {
                            message: "Break/Continue só funciona dentro do corpo de um While"
                                .to_string(),
                        },
                    };
                    sink.node_finished(&node_id, outcome);
                    scheduler.complete(&node_id, true, None);
                }
                Some(FlowNodeKind::While {
                    condition,
                    max_iterations,
                }) => {
                    let variables = with_run_variables(environment_variables, &run_variables);
                    step_loop(
                        &node_id,
                        condition,
                        max_iterations,
                        &mut scheduler,
                        &variables,
                        &history,
                        sink,
                        cancellation,
                    );
                }
            }
        }

        let Some(completion) = in_flight.next().await else {
            break;
        };
        let NodeCompletion {
            node_id,
            outcome,
            response,
            captured,
            taken_handle,
            form_answers,
        } = completion;
        if let Some(values) = form_answers {
            history.record_form(node_id.clone(), values);
        }
        if let Some(response) = response {
            sink.node_output(&node_id, &response);
            history.record(node_id.clone(), response);
        }
        if let Some((start_node_id, request)) = captured {
            mock_session.advance_cursor(&start_node_id, &request.route_id, request.seq);
            sink.node_request(&node_id, &request);
            history.record_request(node_id.clone(), request);
        }
        let releases_successors = !matches!(
            node_kind_by_id(&node_id),
            Some(FlowNodeKind::HumanAction { .. })
        ) || matches!(outcome, FlowNodeOutcome::Completed { .. });
        sink.node_finished(&node_id, outcome);
        scheduler.complete(&node_id, releases_successors, taken_handle);
    }

    mock_session.cleanup(mocks);

    Ok(FlowRunSummary {
        cancelled: cancellation.is_cancelled(),
    })
}

/// Next synchronous scheduler action.
enum Work {
    /// Node ready to dispatch after its incoming degree reaches zero.
    Node(String),
    /// While whose body completed; reevaluate its condition.
    LoopCheck(String),
}

/// Break/Continue request to leave the current While iteration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoopExit {
    Break,
    Continue,
}

/// Mutable state over a fixed graph: incoming degrees, reached flags, ready queue, and per-While iteration/body counters (ADR 0033).
struct Scheduler<'g> {
    graph: &'g FlowGraph,
    in_degree: HashMap<String, usize>,
    // Zero-degree entries always flow. Others become reached only through taken edges. Dispatch needs both reached state and zero degree; otherwise report BranchNotTaken.
    flowed_in: HashMap<String, bool>,
    ready: VecDeque<String>,
    pending_in_loop: HashMap<String, usize>,
    iterations: HashMap<String, u32>,
    loops_to_check: VecDeque<String>,
    /// While-to-Break/Continue requests for this iteration.
    loop_exits: HashMap<String, LoopExit>,
}

impl<'g> Scheduler<'g> {
    /// Initially ready top-level nodes outside loop bodies with zero incoming degree.
    fn new(graph: &'g FlowGraph) -> Self {
        let in_degree = graph.initial_in_degree.clone();
        let mut flowed_in: HashMap<String, bool> = in_degree
            .keys()
            .map(|node_id| (node_id.clone(), false))
            .collect();
        let ready: VecDeque<String> = in_degree
            .iter()
            .filter(|&(node_id, &degree)| degree == 0 && !graph.loop_owners.contains_key(node_id))
            .map(|(node_id, _)| node_id.clone())
            .collect();
        for node_id in &ready {
            flowed_in.insert(node_id.clone(), true);
        }
        Self {
            graph,
            in_degree,
            flowed_in,
            ready,
            pending_in_loop: HashMap::new(),
            iterations: HashMap::new(),
            loops_to_check: VecDeque::new(),
            loop_exits: HashMap::new(),
        }
    }

    fn next_work(&mut self) -> Option<Work> {
        if let Some(node_id) = self.ready.pop_front() {
            return Some(Work::Node(node_id));
        }
        self.loops_to_check.pop_front().map(Work::LoopCheck)
    }

    fn flowed_in(&self, node_id: &str) -> bool {
        self.flowed_in.get(node_id).copied().unwrap_or(false)
    }

    fn iterations(&self, while_id: &str) -> u32 {
        self.iterations.get(while_id).copied().unwrap_or(0)
    }

    /// Break wins over Continue when both arrive in one iteration.
    fn request_exit(&mut self, while_id: &str, exit: LoopExit) {
        let entry = self.loop_exits.entry(while_id.to_string()).or_insert(exit);
        if exit == LoopExit::Break {
            *entry = LoopExit::Break;
        }
    }

    fn take_exit(&mut self, while_id: &str) -> Option<LoopExit> {
        self.loop_exits.remove(while_id)
    }

    /// An enclosing While received Break/Continue; do not start this node.
    fn is_interrupted(&self, node_id: &str) -> bool {
        let mut current = self.graph.loop_owners.get(node_id);
        while let Some(owner) = current {
            if self.loop_exits.contains_key(owner) {
                return true;
            }
            current = self.graph.loop_owners.get(owner);
        }
        false
    }

    /// Propagate completion/failure/skip to successors. Body nodes decrement the owning While count; reevaluate after the entire body finishes.
    fn complete(&mut self, node_id: &str, flowed_in: bool, taken_handle: Option<&str>) {
        advance_after_completion(
            node_id,
            flowed_in,
            taken_handle,
            &self.graph.successors,
            &mut self.in_degree,
            &mut self.flowed_in,
            &mut self.ready,
        );
        if let Some(owner) = self.graph.loop_owners.get(node_id)
            && let Some(pending) = self.pending_in_loop.get_mut(owner)
        {
            *pending = pending.saturating_sub(1);
            if *pending == 0 {
                self.loops_to_check.push_back(owner.clone());
            }
        }
    }

    /// Reset the complete body, including nested bodies, and enqueue its entries. Return the one-based iteration number.
    fn start_iteration(&mut self, while_id: &str) -> u32 {
        let iteration = self.iterations(while_id) + 1;
        self.iterations.insert(while_id.to_string(), iteration);

        for node_id in self.graph.loop_bodies.get(while_id).into_iter().flatten() {
            let initial = self
                .graph
                .initial_in_degree
                .get(node_id)
                .copied()
                .unwrap_or(0);
            self.in_degree.insert(node_id.clone(), initial);
            self.flowed_in.insert(node_id.clone(), false);
        }
        // Nested While counters restart for every outer iteration.
        for (node_id, owner) in &self.graph.loop_owners {
            if owner == while_id && self.graph.loop_bodies.contains_key(node_id) {
                self.iterations.remove(node_id);
                self.loop_exits.remove(node_id);
            }
        }
        self.loop_exits.remove(while_id);

        let members = self
            .graph
            .loop_members
            .get(while_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        self.pending_in_loop
            .insert(while_id.to_string(), members.len());
        if members.is_empty() {
            self.loops_to_check.push_back(while_id.to_string());
        }
        for node_id in members {
            if self.in_degree.get(node_id) == Some(&0) {
                self.flowed_in.insert(node_id.clone(), true);
                self.ready.push_back(node_id.clone());
            }
        }
        iteration
    }
}

const LOOP_DONE_HANDLE: &str = "done";

/// Evaluate While on arrival and after body completion, then iterate, take done or fail.
#[allow(clippy::too_many_arguments)]
fn step_loop<S: FlowRunSink, C: FlowCancellation>(
    while_id: &str,
    condition: &Condition,
    max_iterations: &str,
    scheduler: &mut Scheduler,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    sink: &S,
    cancellation: &C,
) {
    let graph = scheduler.graph;
    let done_iterations = scheduler.iterations(while_id);
    // Report the body even when the loop exits before its first iteration.
    let finish = |scheduler: &mut Scheduler, outcome: FlowNodeOutcome, handle: Option<&str>| {
        sink.node_finished(while_id, outcome);
        if done_iterations == 0 {
            skip_loop_body(graph, while_id, FlowNodeSkipReason::BranchNotTaken, sink);
        }
        scheduler.complete(while_id, true, handle);
    };

    // Initial cancellation is handled before dispatch; here only between-iteration cancellation remains.
    if cancellation.is_cancelled() {
        sink.node_finished(while_id, FlowNodeOutcome::Cancelled);
        scheduler.complete(while_id, true, None);
        return;
    }

    // Use only While ancestors. Initially the body has not run; body results reach conditions through run variables.
    let ancestors = graph.ancestors.get(while_id).cloned().unwrap_or_default();

    // A template limit is read at every check, like the condition.
    let max_iterations = match resolve_integer_setting(
        max_iterations,
        variables,
        history,
        &ancestors,
    ) {
        Ok(limit) => u32::try_from(limit)
            .ok()
            .filter(|limit| (1..=MAX_WHILE_ITERATIONS).contains(limit))
            .ok_or_else(|| {
                format!(
                    "limite de iterações {limit} fora do intervalo de 1 a {MAX_WHILE_ITERATIONS}"
                )
            }),
        Err(error) => Err(format!("limite de iterações: {error}")),
    };
    let max_iterations = match max_iterations {
        Ok(limit) => limit,
        Err(message) => {
            finish(scheduler, FlowNodeOutcome::Failed { message }, None);
            return;
        }
    };

    match evaluate_condition(condition, variables, history, &ancestors) {
        Err(error) => finish(
            scheduler,
            FlowNodeOutcome::Failed {
                message: error.to_string(),
            },
            None,
        ),
        Ok(false) => finish(
            scheduler,
            FlowNodeOutcome::LoopFinished {
                iterations: done_iterations,
            },
            Some(LOOP_DONE_HANDLE),
        ),
        Ok(true) if done_iterations >= max_iterations => finish(
            scheduler,
            FlowNodeOutcome::Failed {
                message: format!("limite de {max_iterations} iterações atingido"),
            },
            None,
        ),
        Ok(true) => {
            sink.node_finished(
                while_id,
                FlowNodeOutcome::LoopIteration {
                    iteration: done_iterations + 1,
                },
            );
            scheduler.start_iteration(while_id);
        }
    }
}

/// Report skipped/unentered While bodies as skipped in stable order.
fn skip_loop_body<S: FlowRunSink>(
    graph: &FlowGraph,
    node_id: &str,
    reason: FlowNodeSkipReason,
    sink: &S,
) {
    let Some(body) = graph.loop_bodies.get(node_id) else {
        return;
    };
    let mut body: Vec<&String> = body.iter().collect();
    body.sort();
    for body_node_id in body {
        sink.node_finished(body_node_id, FlowNodeOutcome::Skipped(reason));
    }
}

/// Decrement successor degrees for synchronous/asynchronous completions, including failures. Unnamed edges always propagate reached state; named edges require the taken handle. Run a successor after all predecessors finish if at least one taken path reaches it; otherwise report BranchNotTaken.
fn advance_after_completion(
    node_id: &str,
    predecessor_flowed_in: bool,
    taken_handle: Option<&str>,
    successors: &HashMap<String, Vec<Successor>>,
    in_degree: &mut HashMap<String, usize>,
    flowed_in: &mut HashMap<String, bool>,
    ready: &mut VecDeque<String>,
) {
    for successor in successors.get(node_id).into_iter().flatten() {
        let Some(degree) = in_degree.get_mut(&successor.target_node_id) else {
            continue;
        };

        let edge_is_taken = predecessor_flowed_in
            && match successor.source_handle.as_deref() {
                None => true,
                Some(handle) => taken_handle == Some(handle),
            };
        if edge_is_taken {
            flowed_in.insert(successor.target_node_id.clone(), true);
        }

        *degree -= 1;
        if *degree == 0 {
            ready.push_back(successor.target_node_id.clone());
        }
    }
}

const REQUEST_SUCCESS_HANDLE: &str = "success";
const REQUEST_FAILURE_HANDLE: &str = "failure";

/// Choose request outputs: protocol/transport failures and cancellation take failure; ordinary HTTP uses the 400 boundary. HTTP responses still report status/duration through Success. Keep frontend flow-run-trail decisions aligned.
fn request_taken_handle(outcome: &FlowNodeOutcome) -> Option<&'static str> {
    match outcome {
        FlowNodeOutcome::Success { status_code, .. } if *status_code < 400 => {
            Some(REQUEST_SUCCESS_HANDLE)
        }
        FlowNodeOutcome::Success { .. }
        | FlowNodeOutcome::Failed { .. }
        | FlowNodeOutcome::Cancelled => Some(REQUEST_FAILURE_HANDLE),
        FlowNodeOutcome::Branched { .. }
        | FlowNodeOutcome::Completed { .. }
        | FlowNodeOutcome::LoopIteration { .. }
        | FlowNodeOutcome::LoopFinished { .. }
        | FlowNodeOutcome::Skipped(_) => None,
    }
}

/// Asynchronous work raced against cancellation while independent branches run concurrently.
enum InFlightWork {
    Human(Box<HumanPreparation>),
    /// Inline requests have no request_id.
    Request {
        request_id: Option<String>,
        request: Box<Request>,
    },
    Sleep(Duration),
    MockWait {
        start_node_id: String,
        key: String,
        route_id: String,
        route_label: String,
        after_seq: u64,
        timeout: Duration,
    },
}

struct HumanPreparation {
    form: alcy_domain::FlowForm,
    history: NodeRunHistory,
    ancestors: HashSet<String>,
}

struct CancelPreparation(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for CancelPreparation {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// In-flight completion with its taken output; None for a single-output node.
struct NodeCompletion {
    form_answers: Option<crate::FormAnswers>,
    node_id: String,
    outcome: FlowNodeOutcome,
    response: Option<Response>,
    /// Captured request together with its owning MockStart node.
    captured: Option<(String, CapturedRequest)>,
    taken_handle: Option<&'static str>,
}

async fn run_in_flight<E, C, M, H>(
    node_id: String,
    work: InFlightWork,
    executor: &E,
    cancellation: &C,
    mocks: &M,
    human: &H,
) -> NodeCompletion
where
    E: RequestExecutor,
    C: FlowCancellation,
    M: MockServerControl,
    H: crate::FlowHumanInteraction,
{
    match work {
        InFlightWork::Human(form) => {
            let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _guard = CancelPreparation(cancelled.clone());
            let prepared = tokio::task::spawn_blocking(move || {
                crate::prepare_flow_form(&form.form, &form.history, &form.ancestors, &cancelled)
            });
            let result = tokio::select! {
                result = async {
                    let form = prepared.await.map_err(|_| "Form preparation failed".to_string())??;
                    human.request_input(&node_id, form).await
                } => Some(result),
                _ = cancellation.cancelled() => None,
            };
            let result = if cancellation.is_cancelled() {
                None
            } else {
                result
            };
            let (outcome, form_answers) = match result {
                Some(Ok(values)) => (FlowNodeOutcome::Completed { message: None }, Some(values)),
                Some(Err(message)) => (FlowNodeOutcome::Failed { message }, None),
                None => (FlowNodeOutcome::Cancelled, None),
            };
            NodeCompletion {
                node_id,
                outcome,
                form_answers,
                response: None,
                captured: None,
                taken_handle: None,
            }
        }
        InFlightWork::Request {
            request_id,
            request,
        } => {
            let (node_id, outcome, response) =
                run_request_node(node_id, request_id, *request, executor, cancellation).await;
            NodeCompletion {
                form_answers: None,
                node_id,
                taken_handle: request_taken_handle(&outcome),
                outcome,
                response,
                captured: None,
            }
        }
        InFlightWork::Sleep(duration) => {
            let outcome = tokio::select! {
                _ = tokio::time::sleep(duration) => FlowNodeOutcome::Completed { message: None },
                _ = cancellation.cancelled() => FlowNodeOutcome::Cancelled,
            };
            NodeCompletion {
                form_answers: None,
                node_id,
                outcome,
                response: None,
                captured: None,
                taken_handle: None,
            }
        }
        InFlightWork::MockWait {
            start_node_id,
            key,
            route_id,
            route_label,
            after_seq,
            timeout,
        } => {
            let result = tokio::select! {
                result = mocks.wait_request(key, route_id, after_seq) => Some(result),
                _ = tokio::time::sleep(timeout) => None,
                _ = cancellation.cancelled() => {
                    return NodeCompletion {
                        form_answers: None,
                        node_id,
                        outcome: FlowNodeOutcome::Cancelled,
                        response: None,
                        captured: None,
                        taken_handle: None,
                    };
                }
            };
            let (outcome, captured, taken_handle) = match result {
                Some(Ok(request)) => (
                    FlowNodeOutcome::Branched {
                        result: true,
                        message: Some(format!(
                            "{} {} recebida em {route_label}",
                            request.method, request.path
                        )),
                    },
                    Some((start_node_id, request)),
                    Some("true"),
                ),
                None => (
                    FlowNodeOutcome::Branched {
                        result: false,
                        message: Some(format!(
                            "nenhuma chamada em {route_label} em {} ms",
                            timeout.as_millis()
                        )),
                    },
                    None,
                    Some("false"),
                ),
                Some(Err(error)) => (
                    FlowNodeOutcome::Failed {
                        message: error.to_string(),
                    },
                    None,
                    None,
                ),
            };
            NodeCompletion {
                form_answers: None,
                node_id,
                outcome,
                response: None,
                captured,
                taken_handle,
            }
        }
    }
}

/// Run-owned mocks keyed by MockStart, with consumed-call cursors per route.
#[derive(Default)]
struct MockSession {
    handles: HashMap<String, MockRunHandle>,
    cursors: HashMap<(String, String), u64>,
}

impl MockSession {
    /// Resolve a running mock handle only for a real ancestor MockStart node.
    fn handle(
        &self,
        start_node_id: &str,
        ancestors: &HashSet<String>,
    ) -> Result<&MockRunHandle, String> {
        if start_node_id.trim().is_empty() {
            return Err("selecione o bloco 'Ligar mock' deste node".to_string());
        }
        if !ancestors.contains(start_node_id) {
            return Err(format!(
                "o bloco 'Ligar mock' '{start_node_id}' precisa vir antes deste node no flow"
            ));
        }
        self.handles
            .get(start_node_id)
            .ok_or_else(|| format!("o mock do bloco '{start_node_id}' não está ligado"))
    }

    fn route(
        &self,
        start_node_id: &str,
        route_id: &str,
        ancestors: &HashSet<String>,
    ) -> Result<(&MockRunHandle, &MockRouteSummary), String> {
        let handle = self.handle(start_node_id, ancestors)?;
        if route_id.trim().is_empty() {
            return Err("selecione a rota do mock".to_string());
        }
        let route = handle
            .route(route_id)
            .ok_or_else(|| format!("rota '{route_id}' não encontrada no mock {}", handle.name))?;
        Ok((handle, route))
    }

    fn cursor(&self, start_node_id: &str, route_id: &str) -> u64 {
        self.cursors
            .get(&(start_node_id.to_string(), route_id.to_string()))
            .copied()
            .or_else(|| {
                self.handles
                    .get(start_node_id)
                    .map(|handle| handle.start_seq)
            })
            .unwrap_or(0)
    }

    fn advance_cursor(&mut self, start_node_id: &str, route_id: &str, seq: u64) {
        let cursor = self
            .cursors
            .entry((start_node_id.to_string(), route_id.to_string()))
            .or_insert(seq);
        *cursor = (*cursor).max(seq);
    }

    fn remove(&mut self, start_node_id: &str) {
        self.handles.remove(start_node_id);
        self.cursors.retain(|(owner, _), _| owner != start_node_id);
    }

    /// Stop mocks this run started and undo overrides on previously running mocks.
    fn cleanup<M: MockServerControl>(self, mocks: &M) {
        for handle in self.handles.values() {
            if handle.owned {
                mocks.stop(&handle.key);
            } else {
                mocks.clear_overrides(&handle.key);
            }
        }
    }
}

fn set_mock_response<M: MockServerControl>(
    session: &MockSession,
    mocks: &M,
    start_node_id: &str,
    route_id: &str,
    response_id: Option<&str>,
    ancestors: &HashSet<String>,
) -> Result<String, String> {
    let (handle, route) = session.route(start_node_id, route_id, ancestors)?;
    let response_name = match response_id {
        None => None,
        Some(response_id) => Some(
            route
                .responses
                .iter()
                .find(|(id, _)| id == response_id)
                .map(|(_, name)| name.clone())
                .ok_or_else(|| {
                    format!("resposta '{response_id}' não encontrada em {}", route.label)
                })?,
        ),
    };
    mocks
        .set_response(&handle.key, route_id, response_id)
        .map_err(|error: MockControlError| error.to_string())?;
    Ok(match response_name {
        Some(name) => format!("{} responde com '{name}'", route.label),
        None => format!("{} volta às regras normais", route.label),
    })
}

/// Pass flag and explanation for calls received since this run started or reused the mock.
fn assert_mock_calls<M: MockServerControl>(
    session: &MockSession,
    mocks: &M,
    start_node_id: &str,
    route_id: &str,
    operator: MockCallCountOperator,
    count: u32,
    ancestors: &HashSet<String>,
) -> Result<(bool, String), String> {
    let (handle, route) = session.route(start_node_id, route_id, ancestors)?;
    let total = mocks
        .call_count(&handle.key, route_id)
        .map_err(|error| error.to_string())?;
    let baseline = handle.baseline_counts.get(route_id).copied().unwrap_or(0);
    let calls = total.saturating_sub(baseline);
    let expected = u64::from(count);
    let (passed, symbol) = match operator {
        MockCallCountOperator::Equals => (calls == expected, "="),
        MockCallCountOperator::AtLeast => (calls >= expected, "≥"),
        MockCallCountOperator::AtMost => (calls <= expected, "≤"),
    };
    let noun = if calls == 1 { "chamada" } else { "chamadas" };
    Ok((
        passed,
        format!(
            "{}: {calls} {noun} (esperado {symbol} {count})",
            route.label
        ),
    ))
}

/// Resolve saved/inline request variables and report the call. Resolution errors are already Failed; callers follow failure.
fn prepare_request<S: FlowRunSink>(
    node_id: &str,
    request_to_run: &Request,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
    sink: &S,
) -> Option<Request> {
    let resolved = match resolve_request_variables(request_to_run, variables, history, ancestors) {
        Ok(resolved) => resolved,
        Err(error) => {
            sink.node_finished(
                node_id,
                FlowNodeOutcome::Failed {
                    message: error.to_string(),
                },
            );
            return None;
        }
    };

    sink.node_started(node_id);
    // Execution resolution already succeeded; display resolution should too, otherwise omit only optional details.
    let template = request_to_run.endpoint.url();
    if let Ok(display) = resolve_request_for_display(template, variables, history, ancestors) {
        sink.node_call(
            node_id,
            &RequestCallDetails {
                request_url: template.to_string(),
                resolved_url: display.text,
                variables: display.substitutions,
                sent_url: resolved.endpoint.url().to_string(),
            },
        );
    }
    Some(resolved)
}

async fn run_request_node<E, C>(
    node_id: String,
    request_id: Option<String>,
    request: Request,
    executor: &E,
    cancellation: &C,
) -> (String, FlowNodeOutcome, Option<Response>)
where
    E: RequestExecutor,
    C: FlowCancellation,
{
    let execution = async {
        match request_id.as_deref() {
            Some(request_id) => executor.execute_saved(request_id, &request).await,
            None => executor.execute(&request).await,
        }
    };
    let outcome = tokio::select! {
        result = execution => result,
        _ = cancellation.cancelled() => Err(ExecutionError::Cancelled),
    };
    match outcome {
        Ok(response) => {
            let flow_outcome = match response.protocol_failure() {
                Some(message) => FlowNodeOutcome::Failed { message },
                None => FlowNodeOutcome::Success {
                    status_code: response.status_code,
                    duration_ms: response.duration_ms,
                },
            };
            (node_id, flow_outcome, Some(response))
        }
        Err(ExecutionError::Cancelled) => (node_id, FlowNodeOutcome::Cancelled, None),
        Err(other) => (
            node_id,
            FlowNodeOutcome::Failed {
                message: other.to_string(),
            },
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_control::NoMockServers;
    use alcy_domain::{
        Authentication, ComparisonOperator, Condition, Endpoint, FlowEdge, FlowNode, FlowPosition,
        HttpMethod, ProtocolId, Request, RequestDocument, Response, ResponseMetadata, SavedRequest,
    };
    use std::future::pending;
    use std::sync::Mutex;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, SystemTime};
    use tokio::time::sleep;

    struct RecordingSink {
        events: Mutex<Vec<(String, String)>>,
    }

    impl RecordingSink {
        fn new() -> Self {
            Self {
                events: Mutex::new(Vec::new()),
            }
        }

        fn events(&self) -> Vec<(String, String)> {
            self.events.lock().unwrap().clone()
        }
    }

    impl FlowRunSink for RecordingSink {
        fn node_started(&self, node_id: &str) {
            self.events
                .lock()
                .unwrap()
                .push((node_id.to_string(), "started".to_string()));
        }

        fn node_finished(&self, node_id: &str, outcome: FlowNodeOutcome) {
            self.events
                .lock()
                .unwrap()
                .push((node_id.to_string(), format!("{outcome:?}")));
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

    struct AlreadyCancelled;

    impl FlowCancellation for AlreadyCancelled {
        fn is_cancelled(&self) -> bool {
            true
        }

        async fn cancelled(&self) {}
    }

    /// Delayed test executor recording peak in-flight concurrency to verify independent nodes overlap.
    struct DelayedExecutor {
        delay: Duration,
        in_flight: std::sync::atomic::AtomicUsize,
        max_observed_in_flight: std::sync::atomic::AtomicUsize,
    }

    impl DelayedExecutor {
        fn new(delay: Duration) -> Self {
            Self {
                delay,
                in_flight: std::sync::atomic::AtomicUsize::new(0),
                max_observed_in_flight: std::sync::atomic::AtomicUsize::new(0),
            }
        }
    }

    impl RequestExecutor for DelayedExecutor {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            let current = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_observed_in_flight
                .fetch_max(current, Ordering::SeqCst);
            sleep(self.delay).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(Response::new(
                200,
                0,
                "{}",
                vec![],
                ResponseMetadata::default(),
            ))
        }
    }

    struct FailingExecutor;

    impl RequestExecutor for FailingExecutor {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            Err(alcy_domain::ExecutionError::Timeout)
        }
    }

    fn sample_request() -> Request {
        Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Post)
    }

    fn collections_with_request(id: &str) -> Vec<Collection> {
        let saved = SavedRequest::new(id, "Ping", sample_request()).unwrap();
        vec![Collection::new("collection-1", "Customer API", vec![], vec![saved]).unwrap()]
    }

    fn node(id: &str, kind: FlowNodeKind) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind,
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    fn edge(id: &str, source: &str, target: &str) -> FlowEdge {
        FlowEdge {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: None,
        }
    }

    fn handled_edge(id: &str, source: &str, target: &str, source_handle: &str) -> FlowEdge {
        FlowEdge {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: Some(source_handle.to_string()),
        }
    }

    fn if_node(id: &str, left: &str, operator: ComparisonOperator, right: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::If {
                condition: Condition {
                    left: left.to_string(),
                    operator,
                    right: right.to_string(),
                },
            },
        )
    }

    fn block_node(id: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::Block {
                label: id.to_string(),
            },
        )
    }

    fn build_flow(nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) -> Flow {
        let now = SystemTime::now();
        Flow::new("flow-1", "My flow", nodes, edges, now, now).unwrap()
    }

    #[tokio::test]
    async fn initial_form_values_are_available_before_any_effects() {
        let form = alcy_domain::FlowForm {
            sections: vec![alcy_domain::FlowFormSection {
                id: "main".into(),
                fields: vec![alcy_domain::FlowFormField {
                    id: "quantity".into(),
                    label: "Quantity".into(),
                    kind: alcy_domain::FlowFormFieldKind::Number,
                    required: true,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::StartForm { form }),
                log_node("result", "{{nodes.start.form.quantity}}"),
            ],
            vec![edge("a", "start", "result")],
        );
        let sink = RecordingSink::new();
        let empty = crate::FormAnswers::new();
        let result = execute_flow_interactive(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
            FlowInteraction {
                human: &crate::NoHumanInteraction,
                initial_answers: &empty,
            },
        )
        .await;
        assert!(matches!(result, Err(FlowRunError::InvalidForm(_))));
        assert!(sink.events().is_empty());
        let values = serde_json::Map::from_iter([("quantity".into(), serde_json::json!(3))]);
        execute_flow_interactive(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
            FlowInteraction {
                human: &crate::NoHumanInteraction,
                initial_answers: &values,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            outcome_of(&sink.events(), "result"),
            vec!["Completed { message: Some(\"3\") }"]
        );
    }

    struct DelayedHuman<'a>(&'a RecordingSink);
    impl crate::FlowHumanInteraction for DelayedHuman<'_> {
        async fn request_input(
            &self,
            _node_id: &str,
            _form: crate::PreparedFlowForm,
        ) -> Result<crate::FormAnswers, String> {
            tokio::time::timeout(Duration::from_secs(1), async {
                while outcome_of(&self.0.events(), "parallel").is_empty() {
                    sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            assert!(outcome_of(&self.0.events(), "after").is_empty());
            Ok(serde_json::Map::from_iter([(
                "approved".into(),
                serde_json::json!(true),
            )]))
        }
    }

    #[tokio::test]
    async fn human_input_pauses_only_its_branch_and_supplies_typed_references() {
        let sink = RecordingSink::new();
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "human",
                    FlowNodeKind::HumanAction {
                        form: alcy_domain::FlowForm::default(),
                    },
                ),
                log_node("parallel", "independent"),
                log_node("after", "{{nodes.human.form.approved}}"),
            ],
            vec![
                edge("a", "start", "human"),
                edge("b", "start", "parallel"),
                edge("c", "human", "after"),
            ],
        );
        execute_flow_interactive(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
            FlowInteraction {
                human: &DelayedHuman(&sink),
                initial_answers: &crate::FormAnswers::new(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            outcome_of(&sink.events(), "after"),
            vec!["Completed { message: Some(\"true\") }"]
        );
    }

    struct NeverHuman;
    impl crate::FlowHumanInteraction for NeverHuman {
        async fn request_input(
            &self,
            _node_id: &str,
            _form: crate::PreparedFlowForm,
        ) -> Result<crate::FormAnswers, String> {
            pending().await
        }
    }

    #[tokio::test]
    async fn cancellation_ends_human_wait_and_skips_its_successors() {
        let sink = RecordingSink::new();
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "human",
                    FlowNodeKind::HumanAction {
                        form: alcy_domain::FlowForm::default(),
                    },
                ),
                log_node("after", "must not run"),
            ],
            vec![edge("a", "start", "human"), edge("b", "human", "after")],
        );
        let summary = execute_flow_interactive(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &CancelAfter::new(Duration::from_millis(20)),
            &NoMockServers,
            FlowInteraction {
                human: &NeverHuman,
                initial_answers: &crate::FormAnswers::new(),
            },
        )
        .await
        .unwrap();
        assert!(summary.cancelled);
        assert_eq!(
            outcome_of(&sink.events(), "human"),
            vec!["started", "Cancelled"]
        );
        assert_eq!(
            outcome_of(&sink.events(), "after"),
            vec!["Skipped(Cancelled)"]
        );
    }

    struct CountingHuman(std::sync::atomic::AtomicUsize);
    impl crate::FlowHumanInteraction for CountingHuman {
        async fn request_input(
            &self,
            _node_id: &str,
            _form: crate::PreparedFlowForm,
        ) -> Result<crate::FormAnswers, String> {
            let value = self.0.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(serde_json::Map::from_iter([(
                "value".into(),
                serde_json::json!(value),
            )]))
        }
    }

    #[tokio::test]
    async fn each_loop_iteration_requests_new_input_and_replaces_the_previous_answer() {
        let sink = RecordingSink::new();
        let human = CountingHuman(std::sync::atomic::AtomicUsize::new(0));
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("i", "0")]),
                while_node("loop", "{{i}}", ComparisonOperator::LessThan, "3", 5),
                node(
                    "human",
                    FlowNodeKind::HumanAction {
                        form: alcy_domain::FlowForm::default(),
                    },
                ),
                increment_node("increment", "i"),
                log_node("after", "{{nodes.human.form.value}}"),
            ],
            vec![
                edge("a", "start", "init"),
                edge("b", "init", "loop"),
                handled_edge("c", "loop", "human", "loop"),
                edge("d", "human", "after"),
                edge("e", "after", "increment"),
            ],
        );
        execute_flow_interactive(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
            FlowInteraction {
                human: &human,
                initial_answers: &crate::FormAnswers::new(),
            },
        )
        .await
        .unwrap();
        assert_eq!(human.0.load(Ordering::SeqCst), 3);
        assert_eq!(
            outcome_of(&sink.events(), "after"),
            vec![
                "Completed { message: Some(\"1\") }",
                "Completed { message: Some(\"2\") }",
                "Completed { message: Some(\"3\") }"
            ]
        );
    }

    #[tokio::test]
    async fn two_independent_request_nodes_run_concurrently() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
                node(
                    "req-b",
                    FlowNodeKind::Request {
                        request_id: "request-b".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "req-a"),
                edge("edge-2", "start", "req-b"),
            ],
        );
        let saved_a = SavedRequest::new("request-a", "A", sample_request()).unwrap();
        let saved_b = SavedRequest::new("request-b", "B", sample_request()).unwrap();
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![saved_a, saved_b],
            )
            .unwrap(),
        ];
        let executor = DelayedExecutor::new(Duration::from_millis(80));
        let sink = RecordingSink::new();

        let started = std::time::Instant::now();
        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();
        let elapsed = started.elapsed();

        assert_eq!(
            executor.max_observed_in_flight.load(Ordering::SeqCst),
            2,
            "as duas requisições independentes deveriam estar em voo ao mesmo tempo"
        );
        assert!(
            elapsed < Duration::from_millis(150),
            "execução concorrente deveria levar bem menos que a soma dos delays, levou {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn a_cycle_reachable_from_start_aborts_the_run_without_dispatching_any_node() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
                node(
                    "req-b",
                    FlowNodeKind::Request {
                        request_id: "request-b".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "req-a"),
                handled_edge("edge-2", "req-a", "req-b", "success"),
                handled_edge("edge-3", "req-b", "req-a", "success"),
            ],
        );
        let collections = collections_with_request("request-a");
        let executor = FailingExecutor;
        let sink = RecordingSink::new();

        let error = execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap_err();

        assert_eq!(error, FlowRunError::CyclicGraph);
        assert!(
            sink.events().is_empty(),
            "nenhum node deveria ter sido reportado"
        );
    }

    #[tokio::test]
    async fn a_cycle_unreachable_from_start_does_not_affect_the_rest_of_the_run() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
                node(
                    "island-1",
                    FlowNodeKind::Block {
                        label: "x".to_string(),
                    },
                ),
                node(
                    "island-2",
                    FlowNodeKind::Block {
                        label: "y".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "req-a"),
                edge("edge-2", "island-1", "island-2"),
                edge("edge-3", "island-2", "island-1"),
            ],
        );
        let collections = collections_with_request("request-a");
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        let summary = execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(!summary.cancelled);
        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req-a" && outcome.starts_with("Success"))
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "island-1" && outcome.contains("Unreachable"))
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "island-2" && outcome.contains("Unreachable"))
        );
    }

    #[tokio::test]
    async fn a_block_node_resolves_as_not_runnable_without_blocking_its_successor() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "block-1",
                    FlowNodeKind::Block {
                        label: "x".to_string(),
                    },
                ),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "block-1"),
                edge("edge-2", "block-1", "req-a"),
            ],
        );
        let collections = collections_with_request("request-a");
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "block-1" && outcome.contains("NotRunnable"))
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req-a" && outcome.starts_with("Success"))
        );
    }

    #[tokio::test]
    async fn a_missing_request_reference_fails_instead_of_being_skipped() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "does-not-exist".to_string(),
                    },
                ),
            ],
            vec![edge("edge-1", "start", "req-a")],
        );
        let collections: Vec<Collection> = vec![];
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req-a" && outcome.starts_with("Failed"))
        );
    }

    struct CallRecordingSink {
        calls: Mutex<Vec<(String, RequestCallDetails)>>,
    }

    impl FlowRunSink for CallRecordingSink {
        fn node_started(&self, _node_id: &str) {}

        fn node_finished(&self, _node_id: &str, _outcome: FlowNodeOutcome) {}

        fn node_call(&self, node_id: &str, details: &RequestCallDetails) {
            self.calls
                .lock()
                .unwrap()
                .push((node_id.to_string(), details.clone()));
        }
    }

    #[test]
    fn request_details_preserve_unknown_variables_without_losing_masked_substitutions() {
        let template = "{{baseUrl}}/users/{{ missing }}?key={{apiKey}}";
        let request = Request::new(
            Endpoint::new(template).unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        );
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("apiKey", "secret", true).unwrap(),
        ];
        let sink = CallRecordingSink {
            calls: Mutex::new(Vec::new()),
        };

        let resolved = prepare_request(
            "req-a",
            &request,
            &variables,
            &NodeRunHistory::new(),
            &HashSet::new(),
            &sink,
        )
        .unwrap();

        assert_eq!(
            resolved.endpoint.url(),
            "https://api.example.com/users/{{ missing }}?key=secret"
        );
        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (node_id, details) = &calls[0];
        assert_eq!(node_id, "req-a");
        assert_eq!(details.request_url, template);
        assert_eq!(
            details.resolved_url,
            "https://api.example.com/users/{{ missing }}?key=••••••••"
        );
        assert_eq!(details.sent_url, resolved.endpoint.url());
        assert_eq!(details.variables.len(), 2);
        assert!(details.variables[1].sensitive);
        assert_eq!(details.variables[1].value, "••••••••");
    }

    #[tokio::test]
    async fn a_request_node_reports_its_template_url_resolved_url_and_variables() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users?key={{apiKey}}").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Post);
        let saved = SavedRequest::new("req-1", "Ping", request).unwrap();
        let collections =
            vec![Collection::new("collection-1", "Customer API", vec![], vec![saved]).unwrap()];
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "req-1".to_string(),
                    },
                ),
            ],
            vec![edge("edge-1", "start", "req-a")],
        );
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("apiKey", "secret", true).unwrap(),
        ];
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = CallRecordingSink {
            calls: Mutex::new(Vec::new()),
        };

        execute_flow(
            &flow,
            &collections,
            &executor,
            &variables,
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (node_id, details) = &calls[0];
        assert_eq!(node_id, "req-a");
        assert_eq!(details.request_url, "{{baseUrl}}/users?key={{apiKey}}");
        assert_eq!(
            details.resolved_url,
            "https://api.example.com/users?key=••••••••"
        );
        assert_eq!(details.variables.len(), 2);
        assert!(details.variables[1].sensitive);
        assert_eq!(details.sent_url, "https://api.example.com/users?key=secret");
    }

    #[tokio::test]
    async fn a_request_node_resolves_folder_and_collection_variables() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/{{segment}}").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        );
        let saved = SavedRequest::new("req-1", "Ping", request).unwrap();
        let folder = alcy_domain::Folder::new("folder-1", "Pasta", vec![], vec![saved])
            .unwrap()
            .with_variables(vec![
                EnvironmentVariable::new("segment", "folder", false).unwrap(),
            ])
            .unwrap();
        let collections = vec![
            Collection::new("collection-1", "API", vec![folder], vec![])
                .unwrap()
                .with_variables(vec![
                    EnvironmentVariable::new("baseUrl", "https://collection.test", false).unwrap(),
                    EnvironmentVariable::new("segment", "collection", false).unwrap(),
                ])
                .unwrap(),
        ];
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "req-1".to_string(),
                    },
                ),
            ],
            vec![edge("edge-1", "start", "req-a")],
        );
        let variables =
            vec![EnvironmentVariable::new("baseUrl", "https://env.test", false).unwrap()];
        let sink = CallRecordingSink {
            calls: Mutex::new(Vec::new()),
        };

        execute_flow(
            &flow,
            &collections,
            &DelayedExecutor::new(Duration::from_millis(1)),
            &variables,
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls[0].1.resolved_url, "https://collection.test/folder");
    }

    /// Record requests and return endpoint-specific responses to verify actual predecessor value propagation.
    struct ChainRecordingExecutor {
        received: Mutex<Vec<Request>>,
    }

    impl ChainRecordingExecutor {
        fn new() -> Self {
            Self {
                received: Mutex::new(Vec::new()),
            }
        }
    }

    impl RequestExecutor for ChainRecordingExecutor {
        async fn execute(
            &self,
            request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            self.received.lock().unwrap().push(request.clone());
            let body = if request.endpoint.url() == "https://api.example.com/a" {
                "{\"token\":\"abc123\"}"
            } else {
                "{}"
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

    #[tokio::test]
    async fn a_node_can_reference_an_upstream_nodes_response_in_its_own_request() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
                node(
                    "req-b",
                    FlowNodeKind::Request {
                        request_id: "request-b".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "req-a"),
                handled_edge("edge-2", "req-a", "req-b", "success"),
            ],
        );

        let request_a = Request::new(
            Endpoint::new("https://api.example.com/a").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        );
        let request_b = Request::new(
            Endpoint::new("https://api.example.com/b").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![
                alcy_domain::HeaderEntry::new(
                    "Authorization",
                    "Bearer {{nodes.req-a.response.body.token}}",
                    true,
                )
                .unwrap(),
            ],
            Authentication::None,
        );
        let saved_a = SavedRequest::new("request-a", "A", request_a).unwrap();
        let saved_b = SavedRequest::new("request-b", "B", request_b).unwrap();
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![saved_a, saved_b],
            )
            .unwrap(),
        ];
        let executor = ChainRecordingExecutor::new();
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let received = executor.received.lock().unwrap();
        let request_b_sent = received
            .iter()
            .find(|request| request.endpoint.url() == "https://api.example.com/b")
            .expect("req-b deveria ter sido despachado");
        assert_eq!(
            request_b_sent.headers[0].value(),
            "Bearer abc123",
            "req-b deveria ter recebido o token extraído da resposta de req-a"
        );
    }

    #[tokio::test]
    async fn referencing_a_node_with_no_dependency_edge_fails_clearly() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
                node(
                    "req-b",
                    FlowNodeKind::Request {
                        request_id: "request-b".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "req-a"),
                edge("edge-2", "start", "req-b"),
            ],
        );

        let request_a = sample_request();
        let request_b = Request::new(
            Endpoint::new("https://api.example.com/b").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![
                alcy_domain::HeaderEntry::new(
                    "Authorization",
                    "Bearer {{nodes.req-a.response.body.token}}",
                    true,
                )
                .unwrap(),
            ],
            Authentication::None,
        );
        let saved_a = SavedRequest::new("request-a", "A", request_a).unwrap();
        let saved_b = SavedRequest::new("request-b", "B", request_b).unwrap();
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![saved_a, saved_b],
            )
            .unwrap(),
        ];
        let executor = ChainRecordingExecutor::new();
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req-b" && outcome.starts_with("Failed")),
            "req-b deveria falhar por referenciar um node sem edge de dependência real: {events:?}"
        );
    }

    #[tokio::test]
    async fn a_request_that_inherits_runs_with_the_authentication_of_its_folder() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
            ],
            vec![edge("edge-1", "start", "req-a")],
        );
        let mut request = sample_request();
        request.authentication = Authentication::Inherit;
        let saved = SavedRequest::new("request-a", "A", request).unwrap();
        let folder = alcy_domain::Folder::new("folder-1", "Auth", vec![], vec![saved])
            .unwrap()
            .with_authentication(Authentication::Bearer {
                token: "folder-token".to_string(),
            });
        let collections =
            vec![Collection::new("collection-1", "Customer API", vec![folder], vec![]).unwrap()];
        let executor = ChainRecordingExecutor::new();
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let received = executor.received.lock().unwrap();
        assert_eq!(
            received[0].authentication,
            Authentication::Bearer {
                token: "folder-token".to_string()
            }
        );
    }

    /// Endpoint-specific test delays/bodies verify timing-sensitive ancestry and disconnected-subgraph concurrency.
    struct ScriptedExecutor {
        entries: HashMap<String, (Duration, &'static str)>,
    }

    impl ScriptedExecutor {
        fn new(entries: Vec<(&str, Duration, &'static str)>) -> Self {
            Self {
                entries: entries
                    .into_iter()
                    .map(|(url, delay, body)| (url.to_string(), (delay, body)))
                    .collect(),
            }
        }
    }

    impl RequestExecutor for ScriptedExecutor {
        async fn execute(
            &self,
            request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            let (delay, body) = self
                .entries
                .get(request.endpoint.url())
                .copied()
                .unwrap_or((Duration::ZERO, "{}"));
            sleep(delay).await;
            Ok(Response::new(
                200,
                0,
                body,
                vec![],
                ResponseMetadata::default(),
            ))
        }
    }

    fn request_to(url: &str) -> Request {
        Request::new(
            Endpoint::new(url).unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
    }

    #[tokio::test]
    async fn referencing_a_node_that_already_finished_via_an_unrelated_path_still_fails_without_an_edge()
     {
        // req-a finishes before slower req-x releases req-b. Its available response must still be rejected without an ancestor edge.
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
                node(
                    "req-x",
                    FlowNodeKind::Request {
                        request_id: "request-x".to_string(),
                    },
                ),
                node(
                    "req-b",
                    FlowNodeKind::Request {
                        request_id: "request-b".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "req-a"),
                edge("edge-2", "start", "req-x"),
                handled_edge("edge-3", "req-x", "req-b", "success"),
            ],
        );

        let request_b = Request::new(
            Endpoint::new("https://api.example.com/b").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![
                alcy_domain::HeaderEntry::new(
                    "Authorization",
                    "Bearer {{nodes.req-a.response.body.token}}",
                    true,
                )
                .unwrap(),
            ],
            Authentication::None,
        );
        let saved_a =
            SavedRequest::new("request-a", "A", request_to("https://api.example.com/a")).unwrap();
        let saved_x =
            SavedRequest::new("request-x", "X", request_to("https://api.example.com/x")).unwrap();
        let saved_b = SavedRequest::new("request-b", "B", request_b).unwrap();
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![saved_a, saved_x, saved_b],
            )
            .unwrap(),
        ];
        let executor = ScriptedExecutor::new(vec![
            (
                "https://api.example.com/a",
                Duration::from_millis(5),
                "{\"token\":\"abc123\"}",
            ),
            ("https://api.example.com/x", Duration::from_millis(40), "{}"),
        ]);
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req-b" && outcome.starts_with("Failed")),
            "req-b deveria falhar mesmo com req-a já concluído no histórico: {events:?}"
        );
    }

    #[tokio::test]
    async fn a_short_chain_does_not_wait_for_an_unrelated_longer_chain_to_finish() {
        // A slow leaf and fast deeper chain are independent; do not synchronize them into artificial waves.
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
                node(
                    "x",
                    FlowNodeKind::Request {
                        request_id: "request-x".to_string(),
                    },
                ),
                node(
                    "y",
                    FlowNodeKind::Request {
                        request_id: "request-y".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "a"),
                edge("edge-2", "start", "x"),
                handled_edge("edge-3", "x", "y", "success"),
            ],
        );

        let saved_a =
            SavedRequest::new("request-a", "A", request_to("https://api.example.com/a")).unwrap();
        let saved_x =
            SavedRequest::new("request-x", "X", request_to("https://api.example.com/x")).unwrap();
        let saved_y =
            SavedRequest::new("request-y", "Y", request_to("https://api.example.com/y")).unwrap();
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![saved_a, saved_x, saved_y],
            )
            .unwrap(),
        ];
        let executor = ScriptedExecutor::new(vec![
            (
                "https://api.example.com/a",
                Duration::from_millis(150),
                "{}",
            ),
            ("https://api.example.com/x", Duration::from_millis(5), "{}"),
            ("https://api.example.com/y", Duration::from_millis(5), "{}"),
        ]);
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        let position_of = |node_id: &str| {
            events
                .iter()
                .position(|(id, outcome)| id == node_id && outcome.starts_with("Success"))
                .unwrap_or_else(|| panic!("node '{node_id}' não terminou com sucesso: {events:?}"))
        };

        assert!(
            position_of("y") < position_of("a"),
            "a cadeia curta (x->y) não deveria esperar a cadeia longa e desconectada (a) terminar: {events:?}"
        );
    }

    #[tokio::test]
    async fn cancelling_before_the_run_starts_skips_every_node() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req-a",
                    FlowNodeKind::Request {
                        request_id: "request-a".to_string(),
                    },
                ),
            ],
            vec![edge("edge-1", "start", "req-a")],
        );
        let collections = collections_with_request("request-a");
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        let summary = execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &AlreadyCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(summary.cancelled);
        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req-a" && outcome.contains("Cancelled"))
        );
        assert_eq!(executor.in_flight.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_if_node_with_a_true_condition_only_runs_the_true_branch() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                if_node("if-1", "1", ComparisonOperator::Equals, "1"),
                node(
                    "on-true",
                    FlowNodeKind::Request {
                        request_id: "request-true".to_string(),
                    },
                ),
                node(
                    "on-false",
                    FlowNodeKind::Request {
                        request_id: "request-false".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "if-1"),
                handled_edge("edge-2", "if-1", "on-true", "true"),
                handled_edge("edge-3", "if-1", "on-false", "false"),
            ],
        );
        let saved_true = SavedRequest::new("request-true", "True", sample_request()).unwrap();
        let saved_false = SavedRequest::new("request-false", "False", sample_request()).unwrap();
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![saved_true, saved_false],
            )
            .unwrap(),
        ];
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events.iter().any(|(id, outcome)| id == "if-1"
                && outcome == "Branched { result: true, message: None }")
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "on-true" && outcome.starts_with("Success"))
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "on-false" && outcome.contains("BranchNotTaken"))
        );
    }

    #[tokio::test]
    async fn an_if_node_with_a_false_condition_only_runs_the_false_branch() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                if_node("if-1", "1", ComparisonOperator::Equals, "2"),
                node(
                    "on-true",
                    FlowNodeKind::Request {
                        request_id: "request-true".to_string(),
                    },
                ),
                node(
                    "on-false",
                    FlowNodeKind::Request {
                        request_id: "request-false".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "if-1"),
                handled_edge("edge-2", "if-1", "on-true", "true"),
                handled_edge("edge-3", "if-1", "on-false", "false"),
            ],
        );
        let saved_true = SavedRequest::new("request-true", "True", sample_request()).unwrap();
        let saved_false = SavedRequest::new("request-false", "False", sample_request()).unwrap();
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![saved_true, saved_false],
            )
            .unwrap(),
        ];
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events.iter().any(|(id, outcome)| id == "if-1"
                && outcome == "Branched { result: false, message: None }")
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "on-false" && outcome.starts_with("Success"))
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "on-true" && outcome.contains("BranchNotTaken"))
        );
    }

    #[tokio::test]
    async fn a_node_reachable_from_both_branches_still_runs_when_fed_by_the_taken_branch() {
        // True runs, false is skipped, and their join still runs after structural completion of both.
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                if_node("if-1", "1", ComparisonOperator::Equals, "1"),
                block_node("a"),
                block_node("b"),
                node(
                    "join",
                    FlowNodeKind::Request {
                        request_id: "request-join".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "if-1"),
                handled_edge("edge-2", "if-1", "a", "true"),
                handled_edge("edge-3", "if-1", "b", "false"),
                edge("edge-4", "a", "join"),
                edge("edge-5", "b", "join"),
            ],
        );
        let collections = collections_with_request("request-join");
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "a" && outcome.contains("NotRunnable")),
            "a (ramo verdadeiro) deveria rodar normalmente (Block resolve como NotRunnable, não Skipped/BranchNotTaken): {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "b" && outcome.contains("BranchNotTaken")),
            "b (ramo falso) deveria ser pulado: {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "join" && outcome.starts_with("Success")),
            "join deveria rodar, alimentado pelo ramo verdadeiro mesmo com o ramo falso pulado: {events:?}"
        );
    }

    #[tokio::test]
    async fn an_if_node_whose_condition_fails_to_evaluate_fails_and_skips_both_branches() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                if_node("if-1", "abc", ComparisonOperator::GreaterThan, "def"),
                block_node("on-true"),
                block_node("on-false"),
            ],
            vec![
                edge("edge-1", "start", "if-1"),
                handled_edge("edge-2", "if-1", "on-true", "true"),
                handled_edge("edge-3", "if-1", "on-false", "false"),
            ],
        );
        let executor = DelayedExecutor::new(Duration::from_millis(1));
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &[],
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "if-1" && outcome.starts_with("Failed"))
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "on-true" && outcome.contains("BranchNotTaken"))
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "on-false" && outcome.contains("BranchNotTaken"))
        );
    }

    struct StatusExecutor {
        status_code: u16,
    }

    impl RequestExecutor for StatusExecutor {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            Ok(Response::new(
                self.status_code,
                0,
                "{}",
                vec![],
                ResponseMetadata::default(),
            ))
        }
    }

    /// `start -> req -(success)-> on-success` e `req -(failure)-> on-failure`.
    fn request_with_two_outcomes() -> Flow {
        build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req",
                    FlowNodeKind::Request {
                        request_id: "request-1".to_string(),
                    },
                ),
                block_node("on-success"),
                block_node("on-failure"),
            ],
            vec![
                edge("edge-1", "start", "req"),
                handled_edge("edge-2", "req", "on-success", "success"),
                handled_edge("edge-3", "req", "on-failure", "failure"),
            ],
        )
    }

    fn assert_only_taken(events: &[(String, String)], taken: &str, skipped: &str) {
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == taken && outcome.contains("NotRunnable")),
            "{taken} deveria rodar: {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == skipped && outcome.contains("BranchNotTaken")),
            "{skipped} deveria ser pulado: {events:?}"
        );
    }

    #[tokio::test]
    async fn a_request_with_a_2xx_response_only_runs_the_success_branch() {
        let flow = request_with_two_outcomes();
        let collections = collections_with_request("request-1");
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &StatusExecutor { status_code: 200 },
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert_only_taken(&sink.events(), "on-success", "on-failure");
    }

    #[tokio::test]
    async fn a_request_with_a_4xx_response_only_runs_the_failure_branch_and_still_reports_success()
    {
        let flow = request_with_two_outcomes();
        let collections = collections_with_request("request-1");
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &StatusExecutor { status_code: 404 },
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert_only_taken(&events, "on-failure", "on-success");
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req" && outcome.starts_with("Success")),
            "a resposta recebida continua sendo reportada como Success: {events:?}"
        );
    }

    #[tokio::test]
    async fn a_request_with_a_transport_error_only_runs_the_failure_branch() {
        let flow = request_with_two_outcomes();
        let collections = collections_with_request("request-1");
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert_only_taken(&events, "on-failure", "on-success");
        assert!(
            events
                .iter()
                .any(|(id, outcome)| id == "req" && outcome.starts_with("Failed"))
        );
    }

    #[tokio::test]
    async fn a_missing_request_reference_only_runs_the_failure_branch() {
        let flow = request_with_two_outcomes();
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &[],
            &StatusExecutor { status_code: 200 },
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert_only_taken(&sink.events(), "on-failure", "on-success");
    }

    #[tokio::test]
    async fn a_node_fed_by_both_request_outcomes_runs_when_either_is_taken() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "req",
                    FlowNodeKind::Request {
                        request_id: "request-1".to_string(),
                    },
                ),
                node(
                    "join",
                    FlowNodeKind::Request {
                        request_id: "request-1".to_string(),
                    },
                ),
            ],
            vec![
                edge("edge-1", "start", "req"),
                handled_edge("edge-2", "req", "join", "success"),
                handled_edge("edge-3", "req", "join", "failure"),
            ],
        );
        let collections = collections_with_request("request-1");
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &StatusExecutor { status_code: 500 },
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(
            sink.events()
                .iter()
                .any(|(id, outcome)| id == "join" && outcome.starts_with("Success"))
        );
    }

    /// Cancel after an interval to exercise cancellation during an active node.
    struct CancelAfter {
        at: tokio::time::Instant,
    }

    impl CancelAfter {
        fn new(after: Duration) -> Self {
            Self {
                at: tokio::time::Instant::now() + after,
            }
        }
    }

    impl FlowCancellation for CancelAfter {
        fn is_cancelled(&self) -> bool {
            tokio::time::Instant::now() >= self.at
        }

        async fn cancelled(&self) {
            tokio::time::sleep_until(self.at).await
        }
    }

    fn set_variables_node(id: &str, assignments: &[(&str, &str)]) -> FlowNode {
        node(
            id,
            FlowNodeKind::SetVariables {
                assignments: assignments
                    .iter()
                    .map(|(name, value)| alcy_domain::VariableAssignment {
                        name: name.to_string(),
                        operation: alcy_domain::VariableOperation::Set {
                            value: value.to_string(),
                        },
                    })
                    .collect(),
            },
        )
    }

    fn log_node(id: &str, message: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::Log {
                message: message.to_string(),
            },
        )
    }

    fn outcome_of(events: &[(String, String)], node_id: &str) -> Vec<String> {
        events
            .iter()
            .filter(|(id, _)| id == node_id)
            .map(|(_, event)| event.clone())
            .collect()
    }

    #[tokio::test]
    async fn local_variables_are_seen_by_later_request_if_and_log_nodes_and_win_over_the_environment()
     {
        let request = Request::new(
            Endpoint::new("{{host}}/a").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        );
        let saved = SavedRequest::new("request-1", "A", request).unwrap();
        let collections =
            vec![Collection::new("collection-1", "API", vec![], vec![saved]).unwrap()];
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node(
                    "vars",
                    &[("host", "https://api.example.com"), ("flag", "yes")],
                ),
                node(
                    "req",
                    FlowNodeKind::Request {
                        request_id: "request-1".to_string(),
                    },
                ),
                if_node("if", "{{flag}}", ComparisonOperator::Equals, "yes"),
                log_node("log", "{{flag}} {{nodes.req.response.status}}"),
            ],
            vec![
                edge("edge-1", "start", "vars"),
                edge("edge-2", "vars", "req"),
                handled_edge("edge-3", "req", "if", "success"),
                handled_edge("edge-4", "if", "log", "true"),
            ],
        );
        let environment =
            vec![EnvironmentVariable::new("host", "https://env.test", false).unwrap()];
        let executor = ChainRecordingExecutor::new();
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &collections,
            &executor,
            &environment,
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let received = executor.received.lock().unwrap();
        assert_eq!(received[0].endpoint.url(), "https://api.example.com/a");
        let events = sink.events();
        assert_eq!(
            outcome_of(&events, "vars"),
            vec![
                "Completed { message: Some(\"host = https://api.example.com, flag = yes\") }"
                    .to_string()
            ]
        );
        assert_eq!(
            outcome_of(&events, "if"),
            vec!["Branched { result: true, message: None }".to_string()]
        );
        assert_eq!(
            outcome_of(&events, "log"),
            vec!["Completed { message: Some(\"yes 200\") }".to_string()]
        );
    }

    #[tokio::test]
    async fn a_display_node_masks_sensitive_variables() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "display",
                    FlowNodeKind::Display {
                        template: "token: {{token}}".to_string(),
                    },
                ),
            ],
            vec![edge("edge-1", "start", "display")],
        );
        let environment = vec![EnvironmentVariable::new("token", "s3cr3t", true).unwrap()];
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &[],
            &FailingExecutor,
            &environment,
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert_eq!(
            outcome_of(&sink.events(), "display"),
            vec!["Completed { message: Some(\"token: ••••••••\") }".to_string()]
        );
    }

    #[tokio::test]
    async fn a_log_with_an_unresolved_variable_fails_and_its_successor_still_runs() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                log_node("log", "{{missing}}"),
                log_node("after", "ok"),
            ],
            vec![
                edge("edge-1", "start", "log"),
                edge("edge-2", "log", "after"),
            ],
        );
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        let events = sink.events();
        assert!(outcome_of(&events, "log")[0].starts_with("Failed"));
        assert_eq!(
            outcome_of(&events, "after"),
            vec!["Completed { message: Some(\"ok\") }".to_string()]
        );
    }

    #[tokio::test]
    async fn a_note_node_produces_no_event() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "note",
                    FlowNodeKind::Note {
                        text: "lembrete".to_string(),
                        width: 200.0,
                        height: 100.0,
                    },
                ),
                log_node("log", "ok"),
            ],
            vec![edge("edge-1", "start", "log")],
        );
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(outcome_of(&sink.events(), "note").is_empty());
    }

    #[tokio::test]
    async fn a_sleep_node_does_not_delay_a_parallel_branch() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "sleep",
                    FlowNodeKind::Sleep {
                        duration_ms: "150".to_string(),
                    },
                ),
                log_node("log", "ok"),
            ],
            vec![
                edge("edge-1", "start", "sleep"),
                edge("edge-2", "start", "log"),
            ],
        );
        let sink = RecordingSink::new();

        let started = std::time::Instant::now();
        execute_flow(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(started.elapsed() >= Duration::from_millis(150));
        let events = sink.events();
        let log_index = events.iter().position(|(id, _)| id == "log").unwrap();
        let sleep_finished_index = events
            .iter()
            .position(|(id, event)| id == "sleep" && event != "started")
            .unwrap();
        assert!(log_index < sleep_finished_index);
        assert_eq!(
            outcome_of(&events, "sleep"),
            vec![
                "started".to_string(),
                "Completed { message: None }".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn cancelling_during_a_sleep_stops_it_and_skips_what_follows() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "sleep",
                    FlowNodeKind::Sleep {
                        duration_ms: "5000".to_string(),
                    },
                ),
                log_node("log", "ok"),
            ],
            vec![
                edge("edge-1", "start", "sleep"),
                edge("edge-2", "sleep", "log"),
            ],
        );
        let sink = RecordingSink::new();

        let started = std::time::Instant::now();
        let summary = execute_flow(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &CancelAfter::new(Duration::from_millis(40)),
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(summary.cancelled);
        let events = sink.events();
        assert_eq!(
            outcome_of(&events, "sleep"),
            vec!["started".to_string(), "Cancelled".to_string()]
        );
        assert_eq!(
            outcome_of(&events, "log"),
            vec!["Skipped(Cancelled)".to_string()]
        );
    }

    #[tokio::test]
    async fn a_sleep_above_the_limit_fails_without_waiting() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node(
                    "sleep",
                    FlowNodeKind::Sleep {
                        duration_ms: (MAX_SLEEP_MS + 1).to_string(),
                    },
                ),
            ],
            vec![edge("edge-1", "start", "sleep")],
        );
        let sink = RecordingSink::new();

        execute_flow(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(outcome_of(&sink.events(), "sleep")[0].starts_with("Failed"));
    }

    fn while_node(
        id: &str,
        left: &str,
        operator: ComparisonOperator,
        right: &str,
        max: u32,
    ) -> FlowNode {
        node(
            id,
            FlowNodeKind::While {
                condition: Condition {
                    left: left.to_string(),
                    operator,
                    right: right.to_string(),
                },
                max_iterations: max.to_string(),
            },
        )
    }

    fn increment_node(id: &str, name: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::SetVariables {
                assignments: vec![alcy_domain::VariableAssignment {
                    name: name.to_string(),
                    operation: alcy_domain::VariableOperation::Increment {
                        by: "1".to_string(),
                    },
                }],
            },
        )
    }

    async fn run(
        flow: &Flow,
        collections: &[Collection],
        executor: &impl RequestExecutor,
    ) -> Vec<(String, String)> {
        let sink = RecordingSink::new();
        execute_flow(
            flow,
            collections,
            executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();
        sink.events()
    }

    #[tokio::test]
    async fn a_while_repeats_its_body_until_the_condition_is_false_then_follows_done() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("i", "0")]),
                while_node("while", "{{i}}", ComparisonOperator::LessThan, "3", 10),
                increment_node("inc", "i"),
                log_node("log", "{{i}}"),
                log_node("after", "fim {{i}}"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "while"),
                handled_edge("e3", "while", "inc", "loop"),
                edge("e4", "inc", "log"),
                handled_edge("e5", "while", "after", "done"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert_eq!(
            outcome_of(&events, "while"),
            vec![
                "LoopIteration { iteration: 1 }",
                "LoopIteration { iteration: 2 }",
                "LoopIteration { iteration: 3 }",
                "LoopFinished { iterations: 3 }",
            ]
        );
        assert_eq!(
            outcome_of(&events, "log"),
            vec![
                "Completed { message: Some(\"1\") }",
                "Completed { message: Some(\"2\") }",
                "Completed { message: Some(\"3\") }",
            ]
        );
        assert_eq!(
            outcome_of(&events, "after"),
            vec!["Completed { message: Some(\"fim 3\") }"]
        );
    }

    #[tokio::test]
    async fn a_while_false_from_the_start_skips_its_body_once_and_follows_done() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                while_node("while", "1", ComparisonOperator::LessThan, "0", 10),
                log_node("body", "x"),
                log_node("after", "ok"),
            ],
            vec![
                edge("e1", "start", "while"),
                handled_edge("e2", "while", "body", "loop"),
                handled_edge("e3", "while", "after", "done"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert_eq!(
            outcome_of(&events, "while"),
            vec!["LoopFinished { iterations: 0 }"]
        );
        assert_eq!(outcome_of(&events, "body"), vec!["Skipped(BranchNotTaken)"]);
        assert_eq!(
            outcome_of(&events, "after"),
            vec!["Completed { message: Some(\"ok\") }"]
        );
    }

    #[tokio::test]
    async fn a_while_that_reaches_its_limit_fails_and_takes_no_output() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                while_node("while", "1", ComparisonOperator::Equals, "1", 2),
                log_node("body", "x"),
                log_node("after", "ok"),
            ],
            vec![
                edge("e1", "start", "while"),
                handled_edge("e2", "while", "body", "loop"),
                handled_edge("e3", "while", "after", "done"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        let while_events = outcome_of(&events, "while");
        assert_eq!(
            &while_events[..2],
            [
                "LoopIteration { iteration: 1 }",
                "LoopIteration { iteration: 2 }"
            ]
        );
        assert!(while_events[2].starts_with("Failed"));
        assert_eq!(outcome_of(&events, "body").len(), 2);
        assert_eq!(
            outcome_of(&events, "after"),
            vec!["Skipped(BranchNotTaken)"]
        );
    }

    fn while_limited_by(id: &str, max_iterations: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::While {
                condition: Condition {
                    left: "1".to_string(),
                    operator: ComparisonOperator::Equals,
                    right: "1".to_string(),
                },
                max_iterations: max_iterations.to_string(),
            },
        )
    }

    #[tokio::test]
    async fn a_while_limit_can_come_from_a_variable() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("loop-count", "2")]),
                while_limited_by("while", "{{loop-count}}"),
                log_node("body", "x"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "while"),
                handled_edge("e3", "while", "body", "loop"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        let while_events = outcome_of(&events, "while");
        assert_eq!(while_events.len(), 3, "{while_events:?}");
        assert!(
            while_events[2].contains("limite de 2 iterações atingido"),
            "{while_events:?}"
        );
        assert_eq!(outcome_of(&events, "body").len(), 2);
    }

    #[tokio::test]
    async fn a_while_limit_that_is_not_a_number_fails_before_the_body() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("loop-count", "many")]),
                while_limited_by("while", "{{loop-count}}"),
                log_node("body", "x"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "while"),
                handled_edge("e3", "while", "body", "loop"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        let while_events = outcome_of(&events, "while");
        assert_eq!(while_events.len(), 1, "{while_events:?}");
        assert!(
            while_events[0].contains("limite de iterações: 'many' não é um número inteiro"),
            "{while_events:?}"
        );
        assert_eq!(outcome_of(&events, "body"), vec!["Skipped(BranchNotTaken)"]);
    }

    #[tokio::test]
    async fn a_sleep_duration_can_come_from_a_variable() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("delay", "5")]),
                node(
                    "sleep",
                    FlowNodeKind::Sleep {
                        duration_ms: "{{delay}}".to_string(),
                    },
                ),
            ],
            vec![edge("e1", "start", "init"), edge("e2", "init", "sleep")],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert_eq!(
            outcome_of(&events, "sleep"),
            vec!["started", "Completed { message: None }"]
        );
    }

    #[tokio::test]
    async fn nested_whiles_restart_the_inner_loop_on_every_outer_iteration() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("i", "0")]),
                while_node("outer", "{{i}}", ComparisonOperator::LessThan, "2", 10),
                set_variables_node("reset-j", &[("j", "0")]),
                while_node("inner", "{{j}}", ComparisonOperator::LessThan, "2", 10),
                increment_node("inc-j", "j"),
                log_node("log", "{{i}}-{{j}}"),
                increment_node("inc-i", "i"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "outer"),
                handled_edge("e3", "outer", "reset-j", "loop"),
                edge("e4", "reset-j", "inner"),
                handled_edge("e5", "inner", "inc-j", "loop"),
                edge("e6", "inc-j", "log"),
                handled_edge("e7", "inner", "inc-i", "done"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert_eq!(
            outcome_of(&events, "log"),
            vec![
                "Completed { message: Some(\"0-1\") }",
                "Completed { message: Some(\"0-2\") }",
                "Completed { message: Some(\"1-1\") }",
                "Completed { message: Some(\"1-2\") }",
            ]
        );
        assert_eq!(
            outcome_of(&events, "outer").last().map(String::as_str),
            Some("LoopFinished { iterations: 2 }")
        );
    }

    /// Return configured statuses in order, repeating the last.
    struct SequenceExecutor {
        statuses: Vec<u16>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl RequestExecutor for SequenceExecutor {
        async fn execute(
            &self,
            _request: &Request,
        ) -> Result<Response, alcy_domain::ExecutionError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let status = self.statuses[call.min(self.statuses.len() - 1)];
            Ok(Response::new(
                status,
                0,
                "{}",
                vec![],
                ResponseMetadata::default(),
            ))
        }
    }

    #[tokio::test]
    async fn a_while_can_poll_a_request_through_a_local_variable() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("status", "0")]),
                while_node(
                    "while",
                    "{{status}}",
                    ComparisonOperator::NotEquals,
                    "200",
                    10,
                ),
                node(
                    "req",
                    FlowNodeKind::Request {
                        request_id: "request-1".to_string(),
                    },
                ),
                set_variables_node("save", &[("status", "{{nodes.req.response.status}}")]),
                log_node("after", "status {{status}}"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "while"),
                handled_edge("e3", "while", "req", "loop"),
                handled_edge("e4", "req", "save", "success"),
                handled_edge("e5", "while", "after", "done"),
            ],
        );
        let executor = SequenceExecutor {
            statuses: vec![503, 503, 200],
            calls: std::sync::atomic::AtomicUsize::new(0),
        };

        let events = run(&flow, &collections_with_request("request-1"), &executor).await;

        // 503 takes failure, leaving save untaken; repeat until 200.
        assert_eq!(
            outcome_of(&events, "save"),
            vec![
                "Skipped(BranchNotTaken)",
                "Skipped(BranchNotTaken)",
                "Completed { message: Some(\"status = 200\") }",
            ]
        );
        assert_eq!(
            outcome_of(&events, "while").last().map(String::as_str),
            Some("LoopFinished { iterations: 3 }")
        );
        assert_eq!(
            outcome_of(&events, "after"),
            vec!["Completed { message: Some(\"status 200\") }"]
        );
    }

    #[tokio::test]
    async fn cancelling_during_an_iteration_stops_the_loop_and_skips_what_follows() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                while_node("while", "1", ComparisonOperator::Equals, "1", 100),
                node(
                    "sleep",
                    FlowNodeKind::Sleep {
                        duration_ms: "5000".to_string(),
                    },
                ),
                log_node("after", "ok"),
            ],
            vec![
                edge("e1", "start", "while"),
                handled_edge("e2", "while", "sleep", "loop"),
                handled_edge("e3", "while", "after", "done"),
            ],
        );
        let sink = RecordingSink::new();

        let summary = execute_flow(
            &flow,
            &[],
            &FailingExecutor,
            &[],
            &sink,
            &CancelAfter::new(Duration::from_millis(40)),
            &NoMockServers,
        )
        .await
        .unwrap();

        assert!(summary.cancelled);
        let events = sink.events();
        assert_eq!(
            outcome_of(&events, "while"),
            vec!["LoopIteration { iteration: 1 }", "Cancelled"]
        );
        assert_eq!(outcome_of(&events, "sleep"), vec!["started", "Cancelled"]);
        assert_eq!(outcome_of(&events, "after"), vec!["Skipped(Cancelled)"]);
    }

    #[tokio::test]
    async fn a_break_ends_the_loop_and_follows_done() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("i", "0")]),
                while_node("while", "1", ComparisonOperator::Equals, "1", 10),
                increment_node("inc", "i"),
                if_node("if", "{{i}}", ComparisonOperator::Equals, "3"),
                node("break", FlowNodeKind::Break),
                log_node("log", "{{i}}"),
                log_node("after", "fim {{i}}"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "while"),
                handled_edge("e3", "while", "inc", "loop"),
                edge("e4", "inc", "if"),
                handled_edge("e5", "if", "break", "true"),
                handled_edge("e6", "if", "log", "false"),
                handled_edge("e7", "while", "after", "done"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert_eq!(
            outcome_of(&events, "while").last().map(String::as_str),
            Some("LoopFinished { iterations: 3 }")
        );
        let logged: Vec<String> = outcome_of(&events, "log")
            .into_iter()
            .filter(|event| event.starts_with("Completed"))
            .collect();
        assert_eq!(
            logged,
            vec![
                "Completed { message: Some(\"1\") }",
                "Completed { message: Some(\"2\") }",
            ]
        );
        assert_eq!(
            outcome_of(&events, "after"),
            vec!["Completed { message: Some(\"fim 3\") }"]
        );
    }

    #[tokio::test]
    async fn a_continue_skips_what_has_not_started_but_lets_in_flight_nodes_finish() {
        // Corpo: inc -> if(i == 2) -true-> continue ; inc -> sleep -> log
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("i", "0")]),
                while_node("while", "{{i}}", ComparisonOperator::LessThan, "3", 10),
                increment_node("inc", "i"),
                if_node("if", "{{i}}", ComparisonOperator::Equals, "2"),
                node("continue", FlowNodeKind::Continue),
                node(
                    "sleep",
                    FlowNodeKind::Sleep {
                        duration_ms: "20".to_string(),
                    },
                ),
                log_node("log", "{{i}}"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "while"),
                handled_edge("e3", "while", "inc", "loop"),
                edge("e4", "inc", "if"),
                handled_edge("e5", "if", "continue", "true"),
                edge("e6", "inc", "sleep"),
                edge("e7", "sleep", "log"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert_eq!(
            outcome_of(&events, "log"),
            vec![
                "Completed { message: Some(\"1\") }",
                "Skipped(LoopInterrupted)",
                "Completed { message: Some(\"3\") }",
            ]
        );
        // The second-iteration sleep is already in flight and finishes normally.
        assert_eq!(
            outcome_of(&events, "sleep")
                .iter()
                .filter(|event| event.starts_with("Completed"))
                .count(),
            3
        );
        assert_eq!(
            outcome_of(&events, "while").last().map(String::as_str),
            Some("LoopFinished { iterations: 3 }")
        );
    }

    #[tokio::test]
    async fn a_break_in_an_inner_loop_only_ends_the_inner_loop() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("init", &[("i", "0")]),
                while_node("outer", "{{i}}", ComparisonOperator::LessThan, "2", 10),
                increment_node("inc-i", "i"),
                while_node("inner", "1", ComparisonOperator::Equals, "1", 10),
                node("break", FlowNodeKind::Break),
                log_node("log", "{{i}}"),
            ],
            vec![
                edge("e1", "start", "init"),
                edge("e2", "init", "outer"),
                handled_edge("e3", "outer", "inc-i", "loop"),
                edge("e4", "inc-i", "inner"),
                handled_edge("e5", "inner", "break", "loop"),
                handled_edge("e6", "inner", "log", "done"),
            ],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert_eq!(
            outcome_of(&events, "log"),
            vec![
                "Completed { message: Some(\"1\") }",
                "Completed { message: Some(\"2\") }",
            ]
        );
        assert_eq!(
            outcome_of(&events, "outer").last().map(String::as_str),
            Some("LoopFinished { iterations: 2 }")
        );
    }

    #[tokio::test]
    async fn a_break_outside_a_while_fails() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                node("break", FlowNodeKind::Break),
            ],
            vec![edge("e1", "start", "break")],
        );

        let events = run(&flow, &[], &FailingExecutor).await;

        assert!(outcome_of(&events, "break")[0].starts_with("Failed"));
    }

    fn inline_request_node(id: &str, url: &str, authentication: Authentication) -> FlowNode {
        let request = Request::new(
            Endpoint::saved(url),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            authentication,
        );
        node(
            id,
            FlowNodeKind::InlineRequest {
                request: Box::new(SavedRequest::new(id, "Avulsa", request).unwrap()),
            },
        )
    }

    /// A new inline request without a URL fails resolution, never reaches transport and takes failure (spec 0089).
    #[tokio::test]
    async fn an_inline_request_without_url_fails_without_calling_the_network() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                inline_request_node("inline", "", Authentication::Inherit),
                log_node("log", "falhou"),
            ],
            vec![
                edge("e1", "start", "inline"),
                handled_edge("e2", "inline", "log", "failure"),
            ],
        );
        let executor = ChainRecordingExecutor::new();

        let events = run(&flow, &[], &executor).await;

        assert!(executor.received.lock().unwrap().is_empty());
        let outcome = outcome_of(&events, "inline");
        assert_eq!(outcome.len(), 1);
        assert!(outcome[0].starts_with("Failed"), "{outcome:?}");
        assert_eq!(
            outcome_of(&events, "log"),
            vec!["Completed { message: Some(\"falhou\") }"]
        );
    }

    #[tokio::test]
    async fn an_inline_request_runs_without_collections_using_local_variables() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                set_variables_node("vars", &[("host", "https://api.example.com")]),
                inline_request_node("inline", "{{host}}/a", Authentication::Inherit),
                log_node("log", "{{nodes.inline.response.body.token}}"),
            ],
            vec![
                edge("e1", "start", "vars"),
                edge("e2", "vars", "inline"),
                handled_edge("e3", "inline", "log", "success"),
            ],
        );
        let executor = ChainRecordingExecutor::new();

        let events = run(&flow, &[], &executor).await;

        let received = executor.received.lock().unwrap();
        assert_eq!(received[0].endpoint.url(), "https://api.example.com/a");
        // Inheritance without a collection means no authentication.
        assert_eq!(received[0].authentication, Authentication::None);
        assert_eq!(
            outcome_of(&events, "log"),
            vec!["Completed { message: Some(\"abc123\") }"]
        );
    }

    #[tokio::test]
    async fn an_inline_request_with_a_5xx_response_takes_the_failure_output() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                inline_request_node("inline", "https://api.example.com", Authentication::None),
                log_node("on-success", "ok"),
                log_node("on-failure", "falhou"),
            ],
            vec![
                edge("e1", "start", "inline"),
                handled_edge("e2", "inline", "on-success", "success"),
                handled_edge("e3", "inline", "on-failure", "failure"),
            ],
        );

        let events = run(&flow, &[], &StatusExecutor { status_code: 500 }).await;

        assert_eq!(
            outcome_of(&events, "on-success"),
            vec!["Skipped(BranchNotTaken)"]
        );
        assert_eq!(
            outcome_of(&events, "on-failure"),
            vec!["Completed { message: Some(\"falhou\") }"]
        );
    }

    /// Mock control fixture with recorded calls, fixed counts and an operation log.
    struct FakeMocks {
        already_running: bool,
        baseline: u64,
        captures: Vec<CapturedRequest>,
        counts: HashMap<String, u64>,
        stopped: Mutex<Vec<String>>,
        cleared: Mutex<Vec<String>>,
        overrides: Mutex<Vec<(String, Option<String>)>>,
    }

    impl FakeMocks {
        fn new() -> Self {
            Self {
                already_running: false,
                baseline: 0,
                captures: Vec::new(),
                counts: HashMap::new(),
                stopped: Mutex::new(Vec::new()),
                cleared: Mutex::new(Vec::new()),
                overrides: Mutex::new(Vec::new()),
            }
        }

        fn with_capture(mut self, seq: u64, body: &str) -> Self {
            self.captures.push(CapturedRequest {
                seq,
                route_id: "route-1".to_string(),
                method: "POST".to_string(),
                path: "/users".to_string(),
                query: vec![],
                headers: vec![],
                path_params: vec![],
                body: body.to_string(),
            });
            self
        }
    }

    impl MockServerControl for FakeMocks {
        fn start(
            &self,
            node_id: &str,
            _source: &alcy_domain::MockServerSource,
        ) -> Result<MockRunHandle, MockControlError> {
            Ok(MockRunHandle {
                key: format!("mock:{node_id}"),
                name: "Users".to_string(),
                port: 4010,
                owned: !self.already_running,
                start_seq: 0,
                baseline_counts: HashMap::from([("route-1".to_string(), self.baseline)]),
                routes: vec![MockRouteSummary {
                    id: "route-1".to_string(),
                    label: "POST /users".to_string(),
                    responses: vec![
                        ("default".to_string(), "Criado".to_string()),
                        ("error".to_string(), "Erro".to_string()),
                    ],
                }],
            })
        }

        fn stop(&self, key: &str) {
            self.stopped.lock().unwrap().push(key.to_string());
        }

        async fn wait_request(
            &self,
            _key: String,
            route_id: String,
            after_seq: u64,
        ) -> Result<CapturedRequest, MockControlError> {
            match self
                .captures
                .iter()
                .find(|request| request.route_id == route_id && request.seq > after_seq)
            {
                Some(request) => Ok(request.clone()),
                None => pending().await,
            }
        }

        fn set_response(
            &self,
            key: &str,
            _route_id: &str,
            response_id: Option<&str>,
        ) -> Result<(), MockControlError> {
            self.overrides
                .lock()
                .unwrap()
                .push((key.to_string(), response_id.map(str::to_string)));
            Ok(())
        }

        fn call_count(&self, _key: &str, route_id: &str) -> Result<u64, MockControlError> {
            Ok(self.counts.get(route_id).copied().unwrap_or(0))
        }

        fn clear_overrides(&self, key: &str) {
            self.cleared.lock().unwrap().push(key.to_string());
        }
    }

    fn mock_start_node(id: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::MockStart {
                source: alcy_domain::MockServerSource::Saved {
                    server_id: "server-1".to_string(),
                },
            },
        )
    }

    fn mock_wait_node(id: &str, timeout_ms: u64) -> FlowNode {
        node(
            id,
            FlowNodeKind::MockWaitRequest {
                start_node_id: "mock".to_string(),
                route_id: "route-1".to_string(),
                timeout_ms: timeout_ms.to_string(),
            },
        )
    }

    async fn run_with_mocks(
        flow: &Flow,
        mocks: &FakeMocks,
        cancellation: &impl FlowCancellation,
    ) -> Vec<(String, String)> {
        let sink = RecordingSink::new();
        execute_flow(flow, &[], &FailingExecutor, &[], &sink, cancellation, mocks)
            .await
            .unwrap();
        sink.events()
    }

    #[tokio::test]
    async fn sequential_waits_consume_calls_in_order_and_the_run_stops_the_mock_it_started() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                mock_start_node("mock"),
                mock_wait_node("wait-1", 1_000),
                mock_wait_node("wait-2", 1_000),
                log_node(
                    "log",
                    "{{nodes.mock.server.url}} {{nodes.wait-1.request.body.n}} {{nodes.wait-2.request.body.n}}",
                ),
            ],
            vec![
                edge("e1", "start", "mock"),
                edge("e2", "mock", "wait-1"),
                handled_edge("e3", "wait-1", "wait-2", "true"),
                handled_edge("e4", "wait-2", "log", "true"),
            ],
        );
        // The first call arrived before any wait began.
        let mocks = FakeMocks::new()
            .with_capture(1, r#"{"n":1}"#)
            .with_capture(2, r#"{"n":2}"#);

        let events = run_with_mocks(&flow, &mocks, &NeverCancelled).await;

        assert_eq!(
            outcome_of(&events, "mock"),
            vec!["Completed { message: Some(\"Users em http://127.0.0.1:4010\") }"]
        );
        assert_eq!(
            outcome_of(&events, "log"),
            vec!["Completed { message: Some(\"http://127.0.0.1:4010 1 2\") }"]
        );
        assert_eq!(*mocks.stopped.lock().unwrap(), vec!["mock:mock"]);
    }

    #[tokio::test]
    async fn a_wait_without_calls_takes_the_false_output_after_the_timeout() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                mock_start_node("mock"),
                mock_wait_node("wait", 30),
                log_node("received", "ok"),
                log_node("timeout", "sem chamada"),
            ],
            vec![
                edge("e1", "start", "mock"),
                edge("e2", "mock", "wait"),
                handled_edge("e3", "wait", "received", "true"),
                handled_edge("e4", "wait", "timeout", "false"),
            ],
        );

        let events = run_with_mocks(&flow, &FakeMocks::new(), &NeverCancelled).await;

        assert_eq!(
            outcome_of(&events, "wait"),
            vec![
                "started".to_string(),
                "Branched { result: false, message: Some(\"nenhuma chamada em POST /users em 30 ms\") }"
                    .to_string()
            ]
        );
        assert_eq!(
            outcome_of(&events, "received"),
            vec!["Skipped(BranchNotTaken)"]
        );
        assert_eq!(
            outcome_of(&events, "timeout"),
            vec!["Completed { message: Some(\"sem chamada\") }"]
        );
    }

    #[tokio::test]
    async fn cancelling_during_a_wait_cancels_it_and_still_stops_the_mock() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                mock_start_node("mock"),
                mock_wait_node("wait", 60_000),
            ],
            vec![edge("e1", "start", "mock"), edge("e2", "mock", "wait")],
        );
        let mocks = FakeMocks::new();

        let events =
            run_with_mocks(&flow, &mocks, &CancelAfter::new(Duration::from_millis(30))).await;

        assert_eq!(outcome_of(&events, "wait"), vec!["started", "Cancelled"]);
        assert_eq!(*mocks.stopped.lock().unwrap(), vec!["mock:mock"]);
    }

    #[tokio::test]
    async fn assert_calls_counts_only_calls_since_the_run_started_the_mock() {
        let assert_node = |id: &str, operator: MockCallCountOperator, count: u32| {
            node(
                id,
                FlowNodeKind::MockAssertCalls {
                    start_node_id: "mock".to_string(),
                    route_id: "route-1".to_string(),
                    operator,
                    count: count.to_string(),
                },
            )
        };
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                mock_start_node("mock"),
                assert_node("equals", MockCallCountOperator::Equals, 3),
                assert_node("at-least", MockCallCountOperator::AtLeast, 2),
                assert_node("at-most", MockCallCountOperator::AtMost, 1),
            ],
            vec![
                edge("e1", "start", "mock"),
                edge("e2", "mock", "equals"),
                edge("e3", "mock", "at-least"),
                edge("e4", "mock", "at-most"),
            ],
        );
        let mut mocks = FakeMocks::new();
        mocks.baseline = 1;
        mocks.counts.insert("route-1".to_string(), 3);

        let events = run_with_mocks(&flow, &mocks, &NeverCancelled).await;

        assert_eq!(
            outcome_of(&events, "equals"),
            vec![
                "Branched { result: false, message: Some(\"POST /users: 2 chamadas (esperado = 3)\") }"
            ]
        );
        assert!(outcome_of(&events, "at-least")[0].starts_with("Branched { result: true"));
        assert!(outcome_of(&events, "at-most")[0].starts_with("Branched { result: false"));
    }

    #[tokio::test]
    async fn a_mock_already_running_is_reused_and_only_has_its_overrides_cleared() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                mock_start_node("mock"),
                node(
                    "force",
                    FlowNodeKind::MockSetResponse {
                        start_node_id: "mock".to_string(),
                        route_id: "route-1".to_string(),
                        response_id: Some("error".to_string()),
                    },
                ),
            ],
            vec![edge("e1", "start", "mock"), edge("e2", "mock", "force")],
        );
        let mut mocks = FakeMocks::new();
        mocks.already_running = true;

        let events = run_with_mocks(&flow, &mocks, &NeverCancelled).await;

        assert_eq!(
            outcome_of(&events, "force"),
            vec!["Completed { message: Some(\"POST /users responde com 'Erro'\") }"]
        );
        assert_eq!(
            *mocks.overrides.lock().unwrap(),
            vec![("mock:mock".to_string(), Some("error".to_string()))]
        );
        assert!(mocks.stopped.lock().unwrap().is_empty());
        assert_eq!(*mocks.cleared.lock().unwrap(), vec!["mock:mock"]);
    }

    #[tokio::test]
    async fn a_mock_node_whose_start_is_not_an_ancestor_fails() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                mock_start_node("mock"),
                node(
                    "stop",
                    FlowNodeKind::MockStop {
                        start_node_id: "mock".to_string(),
                    },
                ),
            ],
            vec![edge("e1", "start", "mock"), edge("e2", "start", "stop")],
        );
        let mocks = FakeMocks::new();

        let events = run_with_mocks(&flow, &mocks, &NeverCancelled).await;

        assert_eq!(
            outcome_of(&events, "stop"),
            vec![
                "Failed { message: \"o bloco 'Ligar mock' 'mock' precisa vir antes deste node no flow\" }"
            ]
        );
        // The run still stops the mock it started.
        assert_eq!(*mocks.stopped.lock().unwrap(), vec!["mock:mock"]);
    }
}
