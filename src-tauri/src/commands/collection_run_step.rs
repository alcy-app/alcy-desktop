//! Match interactive ordering: pre-script on templates, resolution with updated variables, run cookies, transport and post-script (spec 0073).

use std::collections::HashSet;
use std::sync::Mutex;

use alcy_app::{
    CollectionRunStep, NodeRunHistory, RequestExecutor, RunIteration, StepResult,
    resolve_request_variables, resolve_template_for_display, step_variables,
};
use alcy_domain::{
    EnvironmentVariable, ExecutionError, Request, RunTestResult, ScopedVariableChange,
    VariableScope,
};
use alcy_scripting::{ScriptIteration, ScriptVariable};

use crate::commands::cookie_jar::CookieJar;
use crate::commands::environments::EnvironmentVariableDto;
use crate::commands::protocol_dispatching_executor::ProtocolDispatchingExecutor;
use crate::commands::scripting::{
    ScriptEffects, ScriptedRequest, run_post_response_in, run_pre_request_in, script_failure,
};

pub(crate) struct CollectionRunStepExecutor<'a> {
    pub(crate) inner: ProtocolDispatchingExecutor<'a>,
    /// Some when cookies are shared between run requests.
    pub(crate) cookies: Option<CookieJar>,
    /// Ephemeral values shared only within this runner.
    pub(crate) runtime_variables: Mutex<Vec<ScriptVariable>>,
}

impl CollectionRunStepExecutor<'_> {
    fn runtime_snapshot(&self) -> Vec<ScriptVariable> {
        self.runtime_variables
            .lock()
            .map(|runtime| runtime.clone())
            .unwrap_or_default()
    }

    fn commit_runtime(&self, effects: &ScriptEffects) {
        if let Ok(mut runtime) = self.runtime_variables.lock() {
            *runtime = effects.runtime_variables.clone();
        }
    }
}

impl CollectionRunStep for CollectionRunStepExecutor<'_> {
    async fn run(
        &self,
        request: &Request,
        variables: &[EnvironmentVariable],
        scopes: &[VariableScope],
        iteration: &RunIteration,
    ) -> StepResult {
        let script_iteration = ScriptIteration {
            index: iteration.index,
            count: iteration.count,
            data: iteration
                .data
                .iter()
                .map(|(name, value)| ScriptVariable {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
        };
        let mut environment: Vec<EnvironmentVariableDto> = variables
            .iter()
            .map(|variable| EnvironmentVariableDto {
                name: variable.name().to_string(),
                value: variable.value().to_string(),
                sensitive: variable.sensitive,
            })
            .collect();
        let mut scopes = scopes.to_vec();
        let mut effects = ScriptEffects {
            runtime_variables: self.runtime_snapshot(),
            ..ScriptEffects::default()
        };
        let mut scripted = ScriptedRequest::from_request(request);

        if let Err(error) = run_pre_request_in(
            &request.pre_request_script,
            &mut scripted,
            &mut environment,
            &mut scopes,
            &script_iteration,
            &mut effects,
        )
        .await
        {
            self.commit_runtime(&effects);
            return failed(
                scripted.method,
                String::new(),
                script_failure(error),
                effects,
            );
        }

        let effective = match scripted.apply_to(request) {
            Ok(effective) => effective,
            Err(error) => {
                self.commit_runtime(&effects);
                return failed(scripted.method, String::new(), error, effects);
            }
        };
        // Iteration data overrides locals except names just written to environment by the current pre-script.
        let data: Vec<(String, String)> = iteration
            .data
            .iter()
            .filter(|(name, _)| {
                !effects
                    .environment_changes
                    .iter()
                    .any(|change| &change.name == name)
            })
            .cloned()
            .collect();
        let current_variables = step_variables(&domain_variables(&environment), &scopes, &data);
        let resolved_url =
            resolve_template_for_display(effective.endpoint.url(), &current_variables);
        let mut resolved = match resolve_request_variables(
            &effective,
            &current_variables,
            &NodeRunHistory::new(),
            &HashSet::new(),
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                self.commit_runtime(&effects);
                return failed(
                    scripted.method,
                    resolved_url,
                    ExecutionError::InvalidRequest(error.to_string()),
                    effects,
                );
            }
        };

        if request.document.protocol != alcy_domain::ProtocolId::Grpc
            && let Some(jar) = &self.cookies
        {
            jar.apply_to(&mut resolved);
        }

        let response = match self.inner.execute(&resolved).await {
            Ok(response) => response,
            Err(error) => {
                self.commit_runtime(&effects);
                return failed(scripted.method, resolved_url, error, effects);
            }
        };
        if request.document.protocol != alcy_domain::ProtocolId::Grpc
            && let Some(jar) = &self.cookies
        {
            jar.remember(resolved.endpoint.url(), &response);
        }

        let post_script_error = run_post_response_in(
            &request.post_response_script,
            &scripted,
            &response,
            &environment,
            &scopes,
            &script_iteration,
            &mut effects,
        )
        .await
        .err()
        .map(|error| script_failure(error).to_string());

        self.commit_runtime(&effects);
        let (environment_changes, scoped_changes, logs, tests) = split_effects(effects);
        StepResult {
            method: scripted.method,
            resolved_url,
            response: Ok(response),
            environment_changes,
            scoped_changes,
            logs,
            tests,
            post_script_error,
        }
    }
}

fn failed(
    method: String,
    resolved_url: String,
    error: ExecutionError,
    effects: ScriptEffects,
) -> StepResult {
    let (environment_changes, scoped_changes, logs, tests) = split_effects(effects);
    StepResult {
        method,
        resolved_url,
        response: Err(error),
        environment_changes,
        scoped_changes,
        logs,
        tests,
        post_script_error: None,
    }
}

type SplitEffects = (
    Vec<(String, Option<String>)>,
    Vec<ScopedVariableChange>,
    Vec<String>,
    Vec<RunTestResult>,
);

fn split_effects(effects: ScriptEffects) -> SplitEffects {
    (
        effects
            .environment_changes
            .into_iter()
            .map(|change| (change.name, change.value))
            .collect(),
        effects.scoped_changes,
        effects.logs,
        effects
            .tests
            .into_iter()
            .map(|test| RunTestResult {
                name: test.name,
                passed: test.passed,
                message: test.message,
            })
            .collect(),
    )
}

/// Convert environment values to domain variables; exclude invalid names that cannot be referenced in templates.
fn domain_variables(environment: &[EnvironmentVariableDto]) -> Vec<EnvironmentVariable> {
    environment
        .iter()
        .filter_map(|variable| {
            EnvironmentVariable::new(
                variable.name.clone(),
                variable.value.clone(),
                variable.sensitive,
            )
            .ok()
        })
        .collect()
}
