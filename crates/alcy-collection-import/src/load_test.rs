//! Strict load-source analysis before any persistence.
//!
//! This layer only produces the canonical flow model. It does not open
//! connections, execute JavaScript or save assets: errors are collected and
//! returned to the caller so the commit remains atomic.

use std::collections::BTreeMap;
use std::time::SystemTime;

use alcy_domain::{
    Flow, FlowEdge, FlowExecutionKind, FlowNode, FlowNodeKind, FlowPosition, LoadNode, LoadNodeKind,
};
use serde_json::json;
use thiserror::Error;

mod jmeter_syntax;
mod k6_syntax;
use jmeter_syntax::{JmeterHttpSampler, JmeterThreadGroup, JmeterThreadGroupKind, parse_jmeter};
use k6_syntax::{K6StaticCall, parse_k6_syntax};

const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUESTS: usize = 10_000;
const MAX_JMETER_XML_DEPTH: usize = 128;
const MAX_JMETER_XML_NODES: usize = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadImportFormat {
    K6,
    Jmeter,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadImportDiagnostic {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadImportRequest {
    pub method: String,
    pub url: String,
    pub body: Option<String>,
    /// Source HTTP properties preserved for later execution. The importer
    /// retains them even when a property has no corresponding native block.
    pub source_properties: Vec<(String, String)>,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct LoadImportAnalysis {
    pub format: LoadImportFormat,
    pub flow: Flow,
    pub requests: Vec<LoadImportRequest>,
    pub assets: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LoadTestImportError {
    #[error("arquivo de teste de carga não reconhecido")]
    NotRecognized,
    #[error("arquivo excede o limite de {MAX_SOURCE_BYTES} bytes")]
    TooLarge,
    #[error("importação incompatível: {diagnostics:?}")]
    Incompatible {
        diagnostics: Vec<LoadImportDiagnostic>,
    },
    #[error("flow importado inválido: {0}")]
    InvalidFlow(String),
}

/// Analyzes content in memory. Detection does not require an extension: `.js`
/// and `.ts` can be k6; XML containing `jmeterTestPlan` is JMeter. An
/// incompatibility never returns a partial conversion.
pub fn analyze_load_test(
    name: &str,
    source: &str,
    now: SystemTime,
) -> Result<LoadImportAnalysis, LoadTestImportError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(LoadTestImportError::TooLarge);
    }
    if source.contains("<jmeterTestPlan") || name.to_ascii_lowercase().ends_with(".jmx") {
        analyze_jmeter(source, now)
    } else if name.to_ascii_lowercase().ends_with(".js")
        || name.to_ascii_lowercase().ends_with(".ts")
        || source.contains("k6")
    {
        analyze_k6(name, source, now)
    } else {
        Err(LoadTestImportError::NotRecognized)
    }
}

fn analyze_k6(
    name: &str,
    source: &str,
    now: SystemTime,
) -> Result<LoadImportAnalysis, LoadTestImportError> {
    let syntax = parse_k6_syntax(name, source)?;
    let mut diagnostics = forbidden_k6_constructs(source, &syntax.imports);
    let scenarios = parse_k6_scenario_options(source, syntax.options.as_ref(), &mut diagnostics);
    let scenario_scopes = scenarios
        .iter()
        .map(|scenario| {
            if matches!(scenario.exec.as_str(), "setup" | "teardown") {
                diagnostics.push(diag(
                    source,
                    0,
                    "exec do cenário k6 não pode usar uma função de lifecycle",
                ));
                return None;
            }
            let scope = syntax.functions.get(&scenario.exec).cloned();
            if scope.is_none() {
                diagnostics.push(diag(
                    source,
                    0,
                    format!(
                        "exec '{}' precisa apontar para uma função exportada",
                        scenario.exec
                    ),
                ));
            }
            scope
        })
        .collect::<Vec<_>>();
    let setup_scope = syntax.functions.get("setup");
    let teardown_scope = syntax.functions.get("teardown");
    for (name, scope) in &syntax.functions {
        if !matches!(name.as_str(), "setup" | "teardown")
            && !scenarios.iter().any(|scenario| &scenario.exec == name)
        {
            diagnostics.push(diag(
                source,
                scope.start,
                "função auxiliar k6 sem cenário associado ainda não é traduzida",
            ));
        }
    }
    let requests = parse_k6_requests(source, &syntax.calls, &mut diagnostics);
    let timers = parse_k6_timers(source, &syntax.calls, &mut diagnostics);
    let checks = parse_k6_checks(source, &syntax.calls, &requests, &timers, &mut diagnostics);
    let metrics = parse_k6_metrics(source, &syntax.calls, &syntax.metrics, &mut diagnostics);
    validate_k6_effect_scopes(
        source,
        scenario_scopes
            .iter()
            .filter_map(Option::as_ref)
            .chain(setup_scope)
            .chain(teardown_scope),
        &requests,
        &timers,
        &checks,
        &metrics,
        &mut diagnostics,
    );
    let scenario_effects = scenario_scopes
        .iter()
        .map(|scope| {
            k6_effects_in_scope(
                source,
                scope.as_ref(),
                &requests,
                &timers,
                &checks,
                &metrics,
                &mut diagnostics,
            )
        })
        .collect::<Vec<_>>();
    let setup_effects = k6_effects_in_scope(
        source,
        setup_scope,
        &requests,
        &timers,
        &checks,
        &metrics,
        &mut diagnostics,
    );
    let teardown_effects = k6_effects_in_scope(
        source,
        teardown_scope,
        &requests,
        &timers,
        &checks,
        &metrics,
        &mut diagnostics,
    );
    let thresholds = parse_k6_thresholds(source, syntax.options.as_ref(), &mut diagnostics);
    if requests.len() > MAX_REQUESTS {
        diagnostics.push(diag(
            source,
            0,
            format!("mais de {MAX_REQUESTS} requisições estáticas"),
        ));
    }
    for (scenario, effects) in scenarios.iter().zip(&scenario_effects) {
        if effects.requests.is_empty() && diagnostics.is_empty() {
            diagnostics.push(diag(
                source,
                0,
                format!(
                    "nenhuma chamada HTTP estática na função '{}' do cenário '{}'",
                    scenario.exec, scenario.name
                ),
            ));
        }
    }
    if !diagnostics.is_empty() {
        return Err(LoadTestImportError::Incompatible { diagnostics });
    }
    Ok(LoadImportAnalysis {
        format: LoadImportFormat::K6,
        flow: build_k6_flow(
            scenarios.into_iter().zip(scenario_effects).collect(),
            (!setup_effects.is_empty()).then_some(&setup_effects),
            (!teardown_effects.is_empty()).then_some(&teardown_effects),
            &thresholds,
            now,
        )?,
        requests: requests
            .iter()
            .map(|request| request.request.clone())
            .collect(),
        assets: vec!["source".to_string()],
    })
}

#[derive(Debug, Clone, Default)]
struct K6Effects {
    requests: Vec<K6Request>,
    timers: Vec<K6Timer>,
    checks: Vec<K6Check>,
    metrics: Vec<K6Metric>,
}

impl K6Effects {
    fn is_empty(&self) -> bool {
        self.requests.is_empty()
            && self.timers.is_empty()
            && self.checks.is_empty()
            && self.metrics.is_empty()
    }
}

fn validate_k6_effect_scopes<'a>(
    source: &str,
    scopes: impl IntoIterator<Item = &'a std::ops::Range<usize>>,
    requests: &[K6Request],
    timers: &[K6Timer],
    checks: &[K6Check],
    metrics: &[K6Metric],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) {
    let scopes = scopes.into_iter().collect::<Vec<_>>();
    let mut outside = requests
        .iter()
        .map(|request| request.offset)
        .chain(timers.iter().map(|timer| timer.offset))
        .chain(checks.iter().map(|check| check.offset))
        .chain(metrics.iter().map(|metric| metric.offset))
        .filter(|offset| !scopes.iter().any(|scope| scope.contains(offset)))
        .collect::<Vec<_>>();
    outside.sort_unstable();
    outside.dedup();
    for offset in outside {
        diagnostics.push(diag(
            source,
            offset,
            "efeitos do k6 fora de uma função de cenário ou lifecycle ainda não são traduzidos; funções auxiliares exigem corpo próprio no flow",
        ));
    }
}

fn k6_effects_in_scope(
    source: &str,
    scope: Option<&std::ops::Range<usize>>,
    requests: &[K6Request],
    timers: &[K6Timer],
    checks: &[K6Check],
    metrics: &[K6Metric],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> K6Effects {
    let Some(scope) = scope else {
        return K6Effects::default();
    };
    let requests = requests
        .iter()
        .filter(|request| scope.contains(&request.offset))
        .cloned()
        .collect::<Vec<_>>();
    let timers = timers
        .iter()
        .filter(|timer| scope.contains(&timer.offset))
        .copied()
        .collect::<Vec<_>>();
    let metrics = metrics
        .iter()
        .filter(|metric| scope.contains(&metric.offset))
        .cloned()
        .collect::<Vec<_>>();
    let checks = checks
        .iter()
        .filter(|check| scope.contains(&check.offset))
        .filter_map(|check| {
            if scope.contains(&check.request_offset) {
                Some(check.clone())
            } else {
                diagnostics.push(diag(
                    source,
                    check.offset,
                    "check do k6 não pode referenciar uma request de outra fase",
                ));
                None
            }
        })
        .collect::<Vec<_>>();
    K6Effects {
        requests,
        timers,
        checks,
        metrics,
    }
}

fn default_k6_scenario_config() -> serde_json::Value {
    json!({
        "sourceFormat": "k6",
        "executor": "sharedIterations",
        "vus": 1,
        "iterations": 1,
    })
}

/// Validates the file grammar before static lowering. The AST is never
/// executed or evaluated: subsequent conversion only accepts expressions
/// that the flow can represent unambiguously.
///
/// `SourceType` selects TypeScript syntax from the extension. Content-based
/// analysis without a known extension assumes a JavaScript module, the
/// default k6 input format.
#[derive(Debug, Clone)]
struct K6StaticImport {
    specifier: String,
    offset: usize,
}

#[derive(Debug, Clone)]
struct K6Scenario {
    name: String,
    config: serde_json::Value,
    exec: String,
}

fn default_k6_scenarios() -> Vec<K6Scenario> {
    vec![K6Scenario {
        name: "default".to_string(),
        config: default_k6_scenario_config(),
        exec: "default".to_string(),
    }]
}

/// Accepts a deliberately static `options` matrix: default executors and
/// named scenarios. A named scenario can select one exported function with a
/// literal `exec`; dynamic options and expressions remain incompatible.
fn parse_k6_scenario_options(
    source: &str,
    options: Option<&std::ops::Range<usize>>,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Scenario> {
    let Some(options) = options else {
        return default_k6_scenarios();
    };
    let offset = options.start;
    let object_offset = options.start;
    let after_equal = &source[options.clone()];
    let Some((object, _)) = nested_js_object(source, object_offset) else {
        diagnostics.push(diag(
            source,
            offset,
            "options do k6 precisa ser um objeto estático",
        ));
        return default_k6_scenarios();
    };
    let Some(fields) = static_object_fields(object) else {
        diagnostics.push(diag(
            source,
            object_offset,
            "options do k6 tem propriedades inválidas",
        ));
        return default_k6_scenarios();
    };
    if fields.iter().any(|(key, _)| *key == "scenarios") {
        return parse_k6_named_scenario(after_equal, source, offset, diagnostics);
    }

    let mut vus = None;
    let mut iterations = None;
    let mut duration_ms = None;
    let mut max_duration_ms = None;
    for (key, value) in fields {
        match key {
            "vus" => vus = value.parse::<u32>().ok(),
            "iterations" => iterations = value.parse::<u64>().ok(),
            "duration" => duration_ms = parse_k6_duration(value),
            "maxDuration" => max_duration_ms = parse_k6_duration(value),
            "thresholds" => {}
            _ => diagnostics.push(diag(
                source,
                object_offset,
                format!("opção k6 '{key}' ainda não é traduzida"),
            )),
        }
        if matches!(key, "vus" | "iterations") && value.parse::<u64>().is_err()
            || matches!(key, "duration" | "maxDuration") && parse_k6_duration(value).is_none()
        {
            diagnostics.push(diag(
                source,
                object_offset,
                format!("opção k6 '{key}' precisa ser literal"),
            ));
        }
    }

    match (vus, iterations, duration_ms, max_duration_ms) {
        (Some(vus), Some(iterations), None, max_duration) => vec![K6Scenario {
            name: "default".to_string(),
            config: json!({
                "sourceFormat": "k6",
                "executor": "sharedIterations",
                "vus": vus,
                "iterations": iterations,
                "maxDurationMs": max_duration,
            }),
            exec: "default".to_string(),
        }],
        (Some(vus), None, Some(duration_ms), None) => vec![K6Scenario {
            name: "default".to_string(),
            config: json!({
                "sourceFormat": "k6",
                "executor": "constantVus",
                "vus": vus,
                "durationMs": duration_ms,
            }),
            exec: "default".to_string(),
        }],
        _ => {
            diagnostics.push(diag(
                source,
                offset,
                "options do k6 exige vus+iterations (com maxDuration opcional) ou vus+duration",
            ));
            default_k6_scenarios()
        }
    }
}

fn parse_k6_named_scenario(
    options: &str,
    source: &str,
    offset: usize,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Scenario> {
    let Some(outer_start) = options.find('{') else {
        diagnostics.push(diag(
            source,
            offset,
            "options.scenarios precisa ser um objeto",
        ));
        return default_k6_scenarios();
    };
    let Some((outer, _)) = nested_js_object(options, outer_start) else {
        diagnostics.push(diag(source, offset, "options do k6 tem objeto inválido"));
        return default_k6_scenarios();
    };
    let Some(outer_fields) = static_object_fields(outer) else {
        diagnostics.push(diag(
            source,
            offset,
            "options do k6 tem propriedades inválidas",
        ));
        return default_k6_scenarios();
    };
    if outer_fields
        .iter()
        .any(|(key, _)| !matches!(*key, "scenarios" | "thresholds"))
        || !outer_fields.iter().any(|(key, _)| *key == "scenarios")
    {
        diagnostics.push(diag(
            source,
            offset,
            "options.scenarios só pode ser combinado com thresholds nesta etapa",
        ));
        return default_k6_scenarios();
    }
    let Some(scenarios_value) = outer_fields
        .iter()
        .find_map(|(key, value)| (*key == "scenarios").then_some(*value))
    else {
        return default_k6_scenarios();
    };
    let scenarios_value = scenarios_value.trim();
    let Some((scenarios, after_scenarios)) = nested_js_object(scenarios_value, 0) else {
        diagnostics.push(diag(
            source,
            offset,
            "options.scenarios precisa ser um objeto",
        ));
        return default_k6_scenarios();
    };
    if !scenarios_value
        .get(after_scenarios..)
        .is_some_and(|tail| tail.trim().is_empty())
    {
        diagnostics.push(diag(
            source,
            offset,
            "options.scenarios exige um objeto literal sem expressões adicionais",
        ));
        return default_k6_scenarios();
    }
    let Some(scenarios) = static_object_fields(scenarios) else {
        diagnostics.push(diag(
            source,
            offset,
            "cenário nomeado tem propriedades inválidas",
        ));
        return default_k6_scenarios();
    };
    if scenarios.is_empty() {
        diagnostics.push(diag(
            source,
            offset,
            "options.scenarios precisa ter ao menos um cenário",
        ));
        return default_k6_scenarios();
    }
    let mut imported = Vec::with_capacity(scenarios.len());
    for (raw_name, scenario_value) in scenarios {
        let Some(name) = k6_scenario_name(raw_name) else {
            diagnostics.push(diag(
                source,
                offset,
                "nome de cenário k6 precisa ser um identificador ou string literal",
            ));
            continue;
        };
        if imported
            .iter()
            .any(|scenario: &K6Scenario| scenario.name == name)
        {
            diagnostics.push(diag(
                source,
                offset,
                format!("cenário k6 '{name}' foi definido mais de uma vez"),
            ));
            continue;
        }
        let Some((config, exec)) =
            parse_k6_named_scenario_config(scenario_value, source, offset, diagnostics)
        else {
            continue;
        };
        imported.push(K6Scenario {
            name: name.to_string(),
            config,
            exec,
        });
    }
    if imported.is_empty() {
        default_k6_scenarios()
    } else {
        imported
    }
}

fn k6_scenario_name(value: &str) -> Option<&str> {
    let value = value.trim();
    js_string_literal(value).or_else(|| is_js_identifier(value).then_some(value))
}

fn parse_k6_named_scenario_config(
    scenario_value: &str,
    source: &str,
    offset: usize,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Option<(serde_json::Value, String)> {
    let Some((scenario, after_scenario)) = nested_js_object(scenario_value.trim(), 0) else {
        diagnostics.push(diag(
            source,
            offset,
            "configuração do cenário precisa ser um objeto",
        ));
        return None;
    };
    if !scenario_value.get(after_scenario..)?.trim().is_empty() {
        diagnostics.push(diag(source, offset, "configuração do cenário é inválida"));
        return None;
    }
    let Some(fields) = static_object_fields(scenario) else {
        diagnostics.push(diag(source, offset, "configuração do cenário é inválida"));
        return None;
    };
    let field = |name| {
        fields
            .iter()
            .find_map(|(key, value)| (*key == name).then_some(*value))
    };
    let exec = match field("exec") {
        Some(value) => match js_string_literal(value).filter(|name| is_js_identifier(name)) {
            Some(name) => name.to_string(),
            None => {
                diagnostics.push(diag(
                    source,
                    offset,
                    "exec do cenário k6 precisa ser o nome literal de uma função exportada",
                ));
                return None;
            }
        },
        None => "default".to_string(),
    };
    let executor = field("executor").and_then(js_string_literal);
    let allows = |allowed: &[&str]| {
        fields
            .iter()
            .all(|(key, _)| *key == "exec" || allowed.contains(key))
    };
    for (key, value) in &fields {
        let valid = match *key {
            "vus" | "startVUs" | "rate" | "startRate" | "preAllocatedVUs" | "maxVUs" => {
                value.parse::<u32>().is_ok()
            }
            "iterations" => value.parse::<u64>().is_ok(),
            "maxDuration" | "duration" | "timeUnit" | "gracefulRampDown" => {
                parse_k6_duration(value).is_some()
            }
            _ => true,
        };
        if !valid {
            diagnostics.push(diag(
                source,
                offset,
                format!("opção de cenário k6 '{key}' precisa ter valor literal válido"),
            ));
            return None;
        }
    }
    match executor {
        Some("shared-iterations") => {
            let vus = field("vus").and_then(|value| value.trim().parse::<u32>().ok());
            let iterations = field("iterations").and_then(|value| value.trim().parse::<u64>().ok());
            let max_duration =
                field("maxDuration").and_then(|value| parse_k6_duration(value.trim()));
            if !allows(&["executor", "vus", "iterations", "maxDuration"])
                || vus.is_none()
                || iterations.is_none()
                || field("maxDuration").is_some() && max_duration.is_none()
            {
                diagnostics.push(diag(
                    source,
                    offset,
                    "shared-iterations exige vus e iterations literais e maxDuration válido",
                ));
                return None;
            }
            Some((
                json!({
                    "sourceFormat": "k6", "executor": "sharedIterations",
                    "vus": vus, "iterations": iterations, "maxDurationMs": max_duration,
                }),
                exec,
            ))
        }
        Some("constant-vus") => {
            let vus = field("vus").and_then(|value| value.trim().parse::<u32>().ok());
            let duration = field("duration").and_then(|value| parse_k6_duration(value.trim()));
            if !allows(&["executor", "vus", "duration"]) || vus.is_none() || duration.is_none() {
                diagnostics.push(diag(
                    source,
                    offset,
                    "constant-vus exige vus e duration literais",
                ));
                return None;
            }
            Some((
                json!({
                    "sourceFormat": "k6", "executor": "constantVus", "vus": vus, "durationMs": duration,
                }),
                exec,
            ))
        }
        Some("per-vu-iterations") => {
            let vus = field("vus").and_then(|value| value.trim().parse::<u32>().ok());
            let iterations = field("iterations").and_then(|value| value.trim().parse::<u64>().ok());
            let max_duration =
                field("maxDuration").and_then(|value| parse_k6_duration(value.trim()));
            let allowed = ["executor", "vus", "iterations", "maxDuration"];
            if !allows(&allowed) || vus.is_none() || iterations.is_none() {
                diagnostics.push(diag(
                    source,
                    offset,
                    "per-vu-iterations exige executor, vus e iterations literais; outras opções ainda não são traduzidas",
                ));
                return None;
            }
            Some((
                json!({
                    "sourceFormat": "k6",
                    "executor": "perVuIterations",
                    "vus": vus,
                    "iterationsPerVu": iterations,
                    "maxDurationMs": max_duration,
                }),
                exec,
            ))
        }
        Some("constant-arrival-rate") => {
            let rate = field("rate").and_then(|value| value.trim().parse::<u32>().ok());
            let time_unit = field("timeUnit").and_then(|value| parse_k6_duration(value.trim()));
            let duration = field("duration").and_then(|value| parse_k6_duration(value.trim()));
            let pre_allocated_vus =
                field("preAllocatedVUs").and_then(|value| value.trim().parse::<u32>().ok());
            let max_vus = field("maxVUs").and_then(|value| value.trim().parse::<u32>().ok());
            let allowed = [
                "executor",
                "rate",
                "timeUnit",
                "duration",
                "preAllocatedVUs",
                "maxVUs",
            ];
            if !allows(&allowed)
                || rate.is_none()
                || time_unit.is_none()
                || duration.is_none()
                || pre_allocated_vus.is_none()
            {
                diagnostics.push(diag(
                    source,
                    offset,
                    "constant-arrival-rate exige rate, timeUnit, duration e preAllocatedVUs literais",
                ));
                return None;
            }
            Some((
                json!({
                    "sourceFormat": "k6",
                    "executor": "constantArrivalRate",
                    "rate": rate,
                    "timeUnitMs": time_unit,
                    "durationMs": duration,
                    "preAllocatedVus": pre_allocated_vus,
                    "maxVus": max_vus,
                }),
                exec,
            ))
        }
        Some("ramping-vus") => {
            let start_vus = field("startVUs").and_then(|value| value.trim().parse::<u32>().ok());
            let stages = field("stages").and_then(parse_k6_stages);
            let graceful_ramp_down =
                field("gracefulRampDown").and_then(|value| parse_k6_duration(value.trim()));
            let allowed = ["executor", "startVUs", "stages", "gracefulRampDown"];
            if !allows(&allowed) || start_vus.is_none() || stages.is_none() {
                diagnostics.push(diag(
                    source,
                    offset,
                    "ramping-vus exige startVUs e stages estáticos; cada estágio exige duration e target literais",
                ));
                return None;
            }
            Some((
                json!({
                    "sourceFormat": "k6",
                    "executor": "rampingVus",
                    "startVus": start_vus,
                    "stages": stages,
                    "gracefulRampDownMs": graceful_ramp_down,
                }),
                exec,
            ))
        }
        Some("ramping-arrival-rate") => {
            let start_rate = field("startRate").and_then(|value| value.trim().parse::<u32>().ok());
            let time_unit = field("timeUnit").and_then(|value| parse_k6_duration(value.trim()));
            let stages = field("stages").and_then(parse_k6_stages);
            let pre_allocated_vus =
                field("preAllocatedVUs").and_then(|value| value.trim().parse::<u32>().ok());
            let max_vus = field("maxVUs").and_then(|value| value.trim().parse::<u32>().ok());
            let allowed = [
                "executor",
                "startRate",
                "timeUnit",
                "stages",
                "preAllocatedVUs",
                "maxVUs",
            ];
            if !allows(&allowed)
                || start_rate.is_none()
                || time_unit.is_none()
                || stages.is_none()
                || pre_allocated_vus.is_none()
            {
                diagnostics.push(diag(
                    source,
                    offset,
                    "ramping-arrival-rate exige startRate, timeUnit, stages e preAllocatedVUs literais",
                ));
                return None;
            }
            Some((
                json!({
                    "sourceFormat": "k6",
                    "executor": "rampingArrivalRate",
                    "startRate": start_rate,
                    "timeUnitMs": time_unit,
                    "stages": stages,
                    "preAllocatedVus": pre_allocated_vus,
                    "maxVus": max_vus,
                }),
                exec,
            ))
        }
        _ => {
            diagnostics.push(diag(
                source,
                offset,
                "executor nomeado do k6 ainda não é traduzido",
            ));
            None
        }
    }
}

/// Converts declarative `options.thresholds`. Each expression becomes an
/// independent Threshold block because the runtime evaluates all thresholds
/// at the end of the run without sending individual samples over IPC.
fn parse_k6_thresholds(
    source: &str,
    options: Option<&std::ops::Range<usize>>,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Threshold> {
    let Some(options) = options else {
        return Vec::new();
    };
    let object_offset = options.start;
    let Some((options, _)) = nested_js_object(source, object_offset) else {
        return Vec::new();
    };
    let Some(options) = static_object_fields(options) else {
        return Vec::new();
    };
    let Some(raw_thresholds) = options
        .iter()
        .find_map(|(key, value)| (*key == "thresholds").then_some(*value))
    else {
        return Vec::new();
    };
    let Some((thresholds, after_thresholds)) = nested_js_object(raw_thresholds.trim(), 0) else {
        diagnostics.push(diag(
            source,
            object_offset,
            "options.thresholds precisa ser um objeto estático",
        ));
        return Vec::new();
    };
    if !raw_thresholds
        .get(after_thresholds..)
        .is_some_and(|tail| tail.trim().is_empty())
    {
        diagnostics.push(diag(
            source,
            object_offset,
            "options.thresholds tem sintaxe inválida",
        ));
        return Vec::new();
    }
    let Some(thresholds) = static_object_fields(thresholds) else {
        diagnostics.push(diag(
            source,
            object_offset,
            "options.thresholds tem propriedades inválidas",
        ));
        return Vec::new();
    };

    let mut imported = Vec::new();
    for (raw_selector, raw_expressions) in thresholds {
        let Some(selector) = js_string_literal(raw_selector)
            .or_else(|| is_js_identifier(raw_selector).then_some(raw_selector))
        else {
            diagnostics.push(diag(
                source,
                object_offset,
                "o nome da métrica em options.thresholds precisa ser literal",
            ));
            continue;
        };
        let Some((metric, tags)) = parse_k6_metric_selector(selector) else {
            diagnostics.push(diag(
                source,
                object_offset,
                "seletor de threshold k6 inválido",
            ));
            continue;
        };
        let expressions = raw_expressions.trim();
        let Some((expressions, after_expressions)) = nested_js_array(expressions, 0) else {
            diagnostics.push(diag(
                source,
                object_offset,
                "threshold k6 precisa ser um array de expressões literais",
            ));
            continue;
        };
        if !raw_expressions
            .get(after_expressions..)
            .is_some_and(|tail| tail.trim().is_empty())
        {
            diagnostics.push(diag(
                source,
                object_offset,
                "threshold k6 tem sintaxe inválida",
            ));
            continue;
        }
        let Some(expressions) = static_js_array_items(expressions) else {
            diagnostics.push(diag(
                source,
                object_offset,
                "threshold k6 precisa ter expressões estáticas",
            ));
            continue;
        };
        for raw_expression in expressions {
            let Some(expression) = js_string_literal(raw_expression) else {
                diagnostics.push(diag(
                    source,
                    object_offset,
                    "expressão de threshold k6 precisa ser uma string literal",
                ));
                continue;
            };
            let Some((statistic, comparison, target)) = parse_k6_threshold_expression(expression)
            else {
                diagnostics.push(diag(
                    source,
                    object_offset,
                    "expressão de threshold k6 não é suportada",
                ));
                continue;
            };
            imported.push(K6Threshold {
                metric: native_k6_metric_name(metric).to_string(),
                tags: tags.clone(),
                statistic,
                comparison,
                target,
                label: format!("{selector} {expression}"),
            });
        }
    }
    imported
}

fn parse_k6_metric_selector(selector: &str) -> Option<(&str, BTreeMap<String, String>)> {
    let Some((name, raw_tags)) = selector.split_once('{') else {
        return (!selector.trim().is_empty()).then(|| (selector.trim(), BTreeMap::new()));
    };
    let raw_tags = raw_tags.strip_suffix('}')?;
    if name.trim().is_empty() || raw_tags.contains('{') || raw_tags.contains('}') {
        return None;
    }
    let mut tags = BTreeMap::new();
    for raw_tag in raw_tags.split(',') {
        let (key, value) = raw_tag.split_once(':')?;
        let key = key.trim();
        let value = key_value_literal(value)?;
        if !is_js_identifier(key) || tags.insert(key.to_string(), value).is_some() {
            return None;
        }
    }
    Some((name.trim(), tags))
}

fn native_k6_metric_name(name: &str) -> &str {
    match name {
        "http_reqs" => "http_requests",
        "http_req_failed" => "http_req_failed",
        "http_req_duration" => "http_req_duration",
        "checks" => "checks",
        other => other,
    }
}

fn parse_k6_threshold_expression(expression: &str) -> Option<(&'static str, &'static str, f64)> {
    let (left, comparison, right) = [
        ("<=", "lte"),
        (">=", "gte"),
        ("==", "eq"),
        ("!=", "ne"),
        ("<", "lt"),
        (">", "gt"),
    ]
    .into_iter()
    .find_map(|(operator, comparison)| {
        expression
            .split_once(operator)
            .map(|(left, right)| (left.trim(), comparison, right.trim()))
    })?;
    let statistic = match left {
        "count" => "count",
        "value" => "value",
        "rate" => "rate",
        "avg" => "avg",
        "min" => "min",
        "max" => "max",
        "p(90)" => "p90",
        "p(95)" => "p95",
        "p(99)" => "p99",
        _ => return None,
    };
    let target = right.parse::<f64>().ok()?;
    if !target.is_finite() {
        return None;
    }
    Some((statistic, comparison, target))
}

fn parse_k6_metrics(
    source: &str,
    calls: &[K6StaticCall],
    definitions: &[K6MetricDefinition],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Metric> {
    let mut metrics = Vec::new();
    for call in calls {
        let Some(definition) = definitions
            .iter()
            .find(|definition| call.callee == format!("{}.add", definition.variable))
        else {
            continue;
        };
        if let Some((value, tags)) =
            parse_k6_metric_add(source, call.argument_offset, definition.kind)
        {
            metrics.push(K6Metric {
                offset: call.offset,
                name: definition.name.clone(),
                kind: definition.kind,
                value,
                tags,
            });
        } else {
            diagnostics.push(diag(
                source,
                call.offset,
                "metric.add do k6 exige valor e tags literais",
            ));
        }
    }
    metrics
}

fn parse_k6_metric_add(
    source: &str,
    argument_offset: usize,
    kind: &str,
) -> Option<(f64, BTreeMap<String, String>)> {
    let remaining = source.get(argument_offset..)?.trim_start();
    let value_end = remaining.find([',', ')'])?;
    let value = parse_k6_metric_value(remaining.get(..value_end)?.trim(), kind)?;
    let tail = remaining.get(value_end..)?.trim_start();
    if tail.starts_with(')') {
        return Some((value, BTreeMap::new()));
    }
    let tags_source = tail.strip_prefix(',')?.trim_start();
    let (tags, after_tags) = nested_js_object(tags_source, 0)?;
    if !tags_source
        .get(after_tags..)
        .is_some_and(|tail| tail.trim_start().starts_with(')'))
    {
        return None;
    }
    Some((value, parse_k6_tags(tags)?))
}

fn parse_k6_metric_value(raw: &str, kind: &str) -> Option<f64> {
    match (kind, raw) {
        ("rate", "true") | ("rate", "1") => Some(1.0),
        ("rate", "false") | ("rate", "0") => Some(0.0),
        ("rate", _) => None,
        ("counter", _) => raw
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0),
        _ => raw.parse::<f64>().ok().filter(|value| value.is_finite()),
    }
}

fn parse_k6_tags(raw: &str) -> Option<BTreeMap<String, String>> {
    let fields = static_object_fields(raw)?;
    let mut tags = BTreeMap::new();
    for (raw_key, raw_value) in fields {
        let key =
            js_string_literal(raw_key).or_else(|| is_js_identifier(raw_key).then_some(raw_key))?;
        let value = key_value_literal(raw_value)?;
        if tags.insert(key.to_string(), value).is_some() {
            return None;
        }
    }
    Some(tags)
}

fn key_value_literal(raw: &str) -> Option<String> {
    if let Some(value) = js_string_literal(raw) {
        return Some(value.to_string());
    }
    let value = raw.trim();
    (!value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')))
    .then(|| value.to_string())
}

/// Converts literal stages for ramping executors. The parser deliberately
/// accepts only the declarative k6 form so a JavaScript expression cannot be
/// mistaken for an equivalent workload.
fn parse_k6_stages(value: &str) -> Option<Vec<serde_json::Value>> {
    let value = value.trim();
    let (array, after_array) = nested_js_array(value, 0)?;
    if !value.get(after_array..)?.trim().is_empty() {
        return None;
    }
    let stages = static_js_array_items(array)?;
    if stages.is_empty() {
        return None;
    }

    stages
        .into_iter()
        .map(|stage| {
            let stage = stage.trim();
            let (object, after_object) = nested_js_object(stage, 0)?;
            if !stage.get(after_object..)?.trim().is_empty() {
                return None;
            }
            let fields = static_object_fields(object)?;
            if fields.len() != 2
                || fields
                    .iter()
                    .any(|(key, _)| !matches!(*key, "duration" | "target"))
            {
                return None;
            }
            let duration_ms = fields
                .iter()
                .find_map(|(key, value)| (*key == "duration").then_some(*value))
                .and_then(parse_k6_duration)?;
            let target = fields
                .iter()
                .find_map(|(key, value)| (*key == "target").then_some(*value))
                .and_then(|value| value.trim().parse::<u32>().ok())?;
            Some(json!({ "target": target, "durationMs": duration_ms }))
        })
        .collect()
}

fn nested_js_object(source: &str, start: usize) -> Option<(&str, usize)> {
    if source.as_bytes().get(start) != Some(&b'{') {
        return None;
    }
    let bytes = source.as_bytes();
    let mut quote = None;
    let mut depth = 1_u32;
    let mut index = start + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if byte == b'\\' {
                index = index.saturating_add(2);
                continue;
            }
            if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if byte == b'{' {
            depth = depth.saturating_add(1);
        } else if byte == b'}' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return source
                    .get(start + 1..index)
                    .map(|content| (content, index + 1));
            }
        }
        index += 1;
    }
    None
}

fn nested_js_array(source: &str, start: usize) -> Option<(&str, usize)> {
    if source.as_bytes().get(start) != Some(&b'[') {
        return None;
    }
    let bytes = source.as_bytes();
    let mut quote = None;
    let mut depth = 1_u32;
    let mut index = start + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if byte == b'\\' {
                index = index.saturating_add(2);
                continue;
            }
            if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if byte == b'[' {
            depth = depth.saturating_add(1);
        } else if byte == b']' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return source
                    .get(start + 1..index)
                    .map(|content| (content, index + 1));
            }
        }
        index += 1;
    }
    None
}

fn static_js_array_items(array: &str) -> Option<Vec<&str>> {
    let mut items = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut depth = 0_u32;
    for (index, byte) in array.bytes().enumerate() {
        if let Some(delimiter) = quote {
            if byte == b'\\' {
                continue;
            }
            if byte == delimiter {
                quote = None;
            }
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if matches!(byte, b'{' | b'[') {
            depth = depth.saturating_add(1);
        } else if matches!(byte, b'}' | b']') {
            depth = depth.checked_sub(1)?;
        } else if byte == b',' && depth == 0 {
            let item = array.get(start..index)?.trim();
            if item.is_empty() {
                return None;
            }
            items.push(item);
            start = index + 1;
        }
    }
    if quote.is_some() || depth != 0 {
        return None;
    }
    let item = array.get(start..)?.trim();
    if item.is_empty() {
        return None;
    }
    items.push(item);
    Some(items)
}

fn static_object_fields(object: &str) -> Option<Vec<(&str, &str)>> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut depth = 0_u32;
    for (index, byte) in object.bytes().enumerate() {
        if let Some(delimiter) = quote {
            if byte == b'\\' {
                continue;
            }
            if byte == delimiter {
                quote = None;
            }
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if matches!(byte, b'{' | b'[') {
            depth = depth.saturating_add(1);
        } else if matches!(byte, b'}' | b']') {
            depth = depth.checked_sub(1)?;
        } else if byte == b',' && depth == 0 {
            fields.push(object.get(start..index)?);
            start = index + 1;
        }
    }
    fields.push(object.get(start..)?);
    fields
        .into_iter()
        .filter(|field| !field.trim().is_empty())
        .map(|field| {
            let mut quote = None;
            let mut depth = 0_u32;
            for (index, byte) in field.bytes().enumerate() {
                if let Some(delimiter) = quote {
                    if byte == delimiter {
                        quote = None;
                    }
                    continue;
                }
                if matches!(byte, b'\'' | b'"') {
                    quote = Some(byte);
                } else if matches!(byte, b'{' | b'[') {
                    depth = depth.saturating_add(1);
                } else if matches!(byte, b'}' | b']') {
                    depth = depth.checked_sub(1)?;
                } else if byte == b':' && depth == 0 {
                    return Some((field.get(..index)?.trim(), field.get(index + 1..)?.trim()));
                }
            }
            None
        })
        .collect()
}

fn js_string_literal(value: &str) -> Option<&str> {
    let value = value.trim();
    value
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .or_else(|| {
            value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
        })
}

fn parse_k6_duration(value: &str) -> Option<u64> {
    let value = js_string_literal(value)?;
    let (raw, multiplier) = {
        if let Some(raw) = value.strip_suffix("ms") {
            (raw, 1_u64)
        } else if let Some(raw) = value.strip_suffix('s') {
            (raw, 1_000)
        } else if let Some(raw) = value.strip_suffix('m') {
            (raw, 60_000)
        } else if let Some(raw) = value.strip_suffix('h') {
            (raw, 3_600_000)
        } else {
            return None;
        }
    };
    raw.parse::<u64>().ok()?.checked_mul(multiplier)
}

fn forbidden_k6_constructs(source: &str, imports: &[K6StaticImport]) -> Vec<LoadImportDiagnostic> {
    let forbidden = [
        ("eval(", "eval não é suportado"),
        ("import(", "import dinâmico não é suportado"),
        ("require(", "Node/npm não é suportado"),
        ("http.batch(", "http.batch ainda não é suportado"),
        ("ws.", "WebSocket não é suportado"),
        ("grpc.", "gRPC não é suportado"),
        ("browser.", "browser do k6 não é suportado"),
        ("handleSummary", "custom summary não é suportado"),
        (
            "__ENV",
            "variáveis de execução do k6 exigem configuração explícita no flow",
        ),
        ("group(", "group ainda não é traduzido para um bloco Group"),
        ("if (", "controle condicional ainda não é traduzido"),
        ("for (", "laços ainda não são traduzidos"),
        ("while (", "laços ainda não são traduzidos"),
        ("switch (", "controle condicional ainda não é traduzido"),
    ];
    let mut diagnostics = Vec::new();
    for (needle, message) in forbidden {
        if let Some(offset) = find_code(source, needle) {
            diagnostics.push(diag(source, offset, message));
        }
    }
    for import in imports {
        if import.specifier.starts_with("http://") || import.specifier.starts_with("https://") {
            diagnostics.push(diag(
                source,
                import.offset,
                "módulos remotos não são permitidos",
            ));
        } else if import.specifier.starts_with("./") || import.specifier.starts_with("../") {
            diagnostics.push(diag(
                source,
                import.offset,
                "módulos locais ainda não são resolvidos por este importador",
            ));
        } else if !matches!(
            import.specifier.as_str(),
            "k6" | "k6/http" | "k6/metrics" | "k6/encoding" | "k6/html"
        ) {
            diagnostics.push(diag(
                source,
                import.offset,
                "somente módulos locais e módulos oficiais do k6 são permitidos",
            ));
        }
    }
    diagnostics
}

#[derive(Debug, Clone)]
struct K6Request {
    request: LoadImportRequest,
    offset: usize,
    response_name: Option<String>,
    options: K6RequestOptions,
}

#[derive(Debug, Clone, Default)]
struct K6RequestOptions {
    headers: Vec<(String, String)>,
    tags: BTreeMap<String, String>,
    cookies: BTreeMap<String, String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
struct K6Timer {
    offset: usize,
    duration_ms: u64,
}

#[derive(Debug, Clone)]
struct K6Check {
    offset: usize,
    request_offset: usize,
    name: String,
    expected_status: u16,
}

#[derive(Debug, Clone)]
struct K6Metric {
    offset: usize,
    name: String,
    kind: &'static str,
    value: f64,
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct K6MetricDefinition {
    variable: String,
    name: String,
    kind: &'static str,
}

#[derive(Debug, Clone)]
struct K6Threshold {
    metric: String,
    tags: BTreeMap<String, String>,
    statistic: &'static str,
    comparison: &'static str,
    target: f64,
    label: String,
}

fn parse_k6_requests(
    source: &str,
    calls: &[K6StaticCall],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Request> {
    let mut requests = Vec::new();
    for call in calls.iter().filter(|call| call.callee.starts_with("http.")) {
        let method = match call.callee.as_str() {
            "http.get" => "GET",
            "http.post" => "POST",
            "http.put" => "PUT",
            "http.patch" => "PATCH",
            "http.del" => "DELETE",
            "http.head" => "HEAD",
            "http.options" => "OPTIONS",
            _ => "",
        };
        let result = if call.callee == "http.request" {
            parse_k6_generic_request(source, call.argument_offset, diagnostics)
        } else {
            parse_k6_call(source, call.argument_offset, method, diagnostics)
                .map(|(url, body, options)| (method.to_string(), url, body, options))
        };
        if let Some((method, url, body, options)) = result {
            requests.push(K6Request {
                request: LoadImportRequest {
                    method,
                    url,
                    body,
                    source_properties: Vec::new(),
                    line: line_at(source, call.offset),
                },
                offset: call.offset,
                response_name: call.response_name.clone(),
                options,
            });
        } else {
            diagnostics.push(diag(
                source,
                call.offset,
                "a chamada HTTP do k6 exige método, URL, corpo e opções estáticos compatíveis",
            ));
        }
    }
    requests
}

/// Converts `sleep(<literal seconds>)` into the runtime's fixed Timer. Only
/// durations exactly representable in milliseconds are accepted, since
/// rounding would change the imported test's observable pacing.
fn parse_k6_timers(
    source: &str,
    calls: &[K6StaticCall],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Timer> {
    let mut timers = Vec::new();
    for call in calls.iter().filter(|call| call.callee == "sleep") {
        let offset = call.offset;
        let argument_offset = call.argument_offset;
        let Some(remaining) = source.get(argument_offset..) else {
            break;
        };
        let trimmed = remaining.trim_start();
        let whitespace = remaining.len().saturating_sub(trimmed.len());
        let number_offset = argument_offset + whitespace;
        let length = trimmed
            .bytes()
            .take_while(|byte| byte.is_ascii_digit() || *byte == b'.')
            .count();
        let Some(raw_seconds) = trimmed.get(..length) else {
            diagnostics.push(diag(source, number_offset, "sleep exige segundos literais"));
            continue;
        };
        let Some(after_argument) = trimmed.get(length..) else {
            diagnostics.push(diag(source, number_offset, "sleep tem sintaxe inválida"));
            continue;
        };
        let milliseconds = literal_seconds_to_millis(raw_seconds);
        if !after_argument.trim_start().starts_with(')') || milliseconds.is_none() {
            diagnostics.push(diag(
                source,
                number_offset,
                "sleep exige uma duração não negativa, literal e representável em milissegundos",
            ));
        } else if let Some(duration_ms) = milliseconds {
            timers.push(K6Timer {
                offset,
                duration_ms,
            });
        }
    }
    timers
}

/// Converts decimal seconds without floating-point arithmetic. Precision
/// beyond milliseconds is accepted only when the extra digits are zero;
/// otherwise rounding would change the imported pacing.
fn literal_seconds_to_millis(raw: &str) -> Option<u64> {
    let (whole, fraction) = match raw.split_once('.') {
        Some((whole, fraction)) if !fraction.contains('.') => (whole, fraction),
        Some(_) => return None,
        None => (raw, ""),
    };
    if whole.is_empty() && fraction.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || fraction
            .get(3..)
            .is_some_and(|extra| extra.bytes().any(|byte| byte != b'0'))
    {
        return None;
    }
    let seconds = if whole.is_empty() {
        0
    } else {
        whole.parse::<u64>().ok()?
    };
    let milliseconds = if fraction.is_empty() {
        0
    } else {
        fraction
            .get(..fraction.len().min(3))
            .unwrap_or_default()
            .parse::<u64>()
            .ok()?
    };
    let padding = 3_u32.saturating_sub(fraction.len().min(3) as u32);
    seconds
        .checked_mul(1_000)?
        .checked_add(milliseconds.checked_mul(10_u64.pow(padding))?)
}

fn is_js_identifier(value: &str) -> bool {
    let mut characters = value.bytes();
    matches!(characters.next(), Some(byte) if byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$')
        && characters.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
}

/// Accepts only the canonical form without arbitrary logic:
/// `check(response, { 'name': (r) => r.status === 200 })`.
fn parse_k6_checks(
    source: &str,
    calls: &[K6StaticCall],
    requests: &[K6Request],
    timers: &[K6Timer],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Check> {
    let mut checks = Vec::new();
    for call in calls.iter().filter(|call| call.callee == "check") {
        let offset = call.offset;
        match parse_k6_status_check(source, call.argument_offset) {
            Some((response_name, name, expected_status)) => {
                let request = requests
                    .iter()
                    .rev()
                    .find(|request| request.offset < offset);
                if let Some(request) = request.filter(|request| {
                    request.response_name.as_deref() == Some(response_name.as_str())
                        && !timers
                            .iter()
                            .any(|timer| timer.offset > request.offset && timer.offset < offset)
                }) {
                    checks.push(K6Check {
                        offset,
                        request_offset: request.offset,
                        name,
                        expected_status,
                    });
                } else {
                    diagnostics.push(diag(
                        source,
                        offset,
                        "check precisa seguir imediatamente uma request atribuída à mesma variável, sem sleep intermediário",
                    ));
                }
            }
            None => diagnostics.push(diag(
                source,
                offset,
                "somente check estático de status HTTP é suportado",
            )),
        }
    }
    checks
}

fn parse_k6_status_check(source: &str, offset: usize) -> Option<(String, String, u16)> {
    let after_open = source.get(offset..)?.trim_start();
    let (response_name, after_response) = parse_js_identifier(after_open)?;
    let after_comma = after_response.trim_start().strip_prefix(',')?.trim_start();
    let after_object = after_comma.strip_prefix('{')?.trim_start();
    let (name, after_name) = parse_js_string(after_object, 0)?;
    let after_colon = after_object
        .get(after_name..)?
        .trim_start()
        .strip_prefix(':')?
        .trim_start();
    let (callback_name, after_callback) = parse_callback_argument(after_colon)?;
    let status_expression = after_callback.trim_start();
    let status_expression = status_expression.strip_prefix(&callback_name)?;
    let status_expression = status_expression
        .trim_start()
        .strip_prefix('.')?
        .trim_start();
    let status_expression = status_expression.strip_prefix("status")?.trim_start();
    let status_expression = status_expression.strip_prefix("===")?.trim_start();
    let digits = status_expression
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let expected_status = status_expression.get(..digits)?.parse::<u16>().ok()?;
    let rest = status_expression.get(digits..)?.trim_start();
    rest.strip_prefix('}')?.trim_start().strip_prefix(')')?;
    Some((response_name, name, expected_status))
}

fn parse_js_identifier(source: &str) -> Option<(String, &str)> {
    let length = source
        .bytes()
        .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'$')
        .count();
    let identifier = source.get(..length)?;
    is_js_identifier(identifier).then(|| {
        (
            identifier.to_string(),
            source.get(length..).unwrap_or_default(),
        )
    })
}

fn parse_callback_argument(source: &str) -> Option<(String, &str)> {
    let source = source.trim_start();
    let (argument, after_argument) = if let Some(source) = source.strip_prefix('(') {
        let (argument, after_argument) = parse_js_identifier(source)?;
        (argument, after_argument.trim_start().strip_prefix(')')?)
    } else {
        parse_js_identifier(source)?
    };
    let after_arrow = after_argument.trim_start().strip_prefix("=>")?;
    Some((argument, after_arrow))
}

/// Reads only the linear form the importer can preserve without executing
/// JavaScript: a literal URL and, for methods with bodies, a literal body.
/// Request options (headers, tags, redirects, etc.) need explicit AST
/// conversion; rejecting unsupported options prevents silent partial imports.
fn parse_k6_call(
    source: &str,
    offset: usize,
    method: &str,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Option<(String, Option<String>, K6RequestOptions)> {
    let (url, after_url) = parse_js_string(source, offset)?;
    let remaining = source.get(after_url..)?.trim_start();
    if remaining.starts_with(')') {
        return Some((url, None, K6RequestOptions::default()));
    }
    if !remaining.starts_with(',') {
        diagnostics.push(diag(
            source,
            after_url,
            "a chamada HTTP do k6 tem sintaxe não suportada",
        ));
        return None;
    }

    let body_offset = k6_next_argument_offset(source, after_url)?;
    if matches!(method, "GET" | "DELETE" | "HEAD" | "OPTIONS") {
        let (options, after_options) = parse_k6_request_options(source, body_offset, diagnostics)?;
        if !source
            .get(after_options..)
            .is_some_and(|remaining| remaining.trim_start().starts_with(')'))
        {
            diagnostics.push(diag(
                source,
                after_options,
                "a chamada HTTP do k6 tem argumentos extras não suportados",
            ));
            return None;
        }
        return Some((url, None, options));
    }

    let (body, after_body) = match parse_js_string(source, body_offset) {
        Some(value) => value,
        None => {
            diagnostics.push(diag(
                source,
                body_offset,
                "o corpo da requisição k6 precisa ser uma string literal",
            ));
            return None;
        }
    };
    let after_body_source = source.get(after_body..)?;
    let tail = after_body_source.trim_start();
    if tail.starts_with(')') {
        return Some((url, Some(body), K6RequestOptions::default()));
    }
    if !tail.starts_with(',') {
        diagnostics.push(diag(
            source,
            after_body,
            "a chamada HTTP do k6 tem sintaxe não suportada",
        ));
        return None;
    }
    let comma_offset = after_body + after_body_source.len().saturating_sub(tail.len());
    let options_offset = comma_offset + 1;
    let (options, after_options) = parse_k6_request_options(source, options_offset, diagnostics)?;
    if !source
        .get(after_options..)
        .is_some_and(|remaining| remaining.trim_start().starts_with(')'))
    {
        diagnostics.push(diag(
            source,
            after_options,
            "a chamada HTTP do k6 tem argumentos extras não suportados",
        ));
        return None;
    }
    Some((url, Some(body), options))
}

fn parse_k6_generic_request(
    source: &str,
    offset: usize,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Option<(String, String, Option<String>, K6RequestOptions)> {
    let (raw_method, after_method) = parse_js_string(source, offset)?;
    let method = raw_method.to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
    ) {
        diagnostics.push(diag(
            source,
            offset,
            "http.request usa método HTTP não suportado",
        ));
        return None;
    }
    let url_offset = k6_next_argument_offset(source, after_method)?;
    let (url, after_url) = parse_js_string(source, url_offset)?;
    let remaining = source.get(after_url..)?.trim_start();
    if remaining.starts_with(')') {
        return Some((method, url, None, K6RequestOptions::default()));
    }
    let argument_offset = k6_next_argument_offset(source, after_url)?;
    let raw_argument = source.get(argument_offset..)?;
    let argument = raw_argument.trim_start();
    let argument_start = argument_offset + raw_argument.len().saturating_sub(argument.len());
    let allows_body = !matches!(method.as_str(), "GET" | "DELETE" | "HEAD" | "OPTIONS");

    if argument.starts_with('{') {
        let (options, after_options) =
            parse_k6_request_options(source, argument_offset, diagnostics)?;
        return k6_request_options_end(source, after_options, diagnostics)
            .then_some((method, url, None, options));
    }
    if argument.starts_with("null") {
        let after_null = argument_start + "null".len();
        let options = parse_k6_options_after_argument(source, after_null, diagnostics)?;
        return Some((method, url, None, options));
    }
    if !allows_body {
        diagnostics.push(diag(
            source,
            argument_offset,
            "http.request com este método aceita somente null ou opções no terceiro argumento",
        ));
        return None;
    }
    let (body, after_body) = parse_js_string(source, argument_offset)?;
    let options = parse_k6_options_after_argument(source, after_body, diagnostics)?;
    Some((method, url, Some(body), options))
}

fn k6_next_argument_offset(source: &str, after_argument: usize) -> Option<usize> {
    let remaining = source.get(after_argument..)?;
    let trimmed = remaining.trim_start();
    trimmed.strip_prefix(',')?;
    Some(after_argument + remaining.len().saturating_sub(trimmed.len()) + 1)
}

fn parse_k6_options_after_argument(
    source: &str,
    after_argument: usize,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Option<K6RequestOptions> {
    let remaining = source.get(after_argument..)?;
    let trimmed = remaining.trim_start();
    if trimmed.starts_with(')') {
        return Some(K6RequestOptions::default());
    }
    let options_offset = k6_next_argument_offset(source, after_argument)?;
    let (options, after_options) = parse_k6_request_options(source, options_offset, diagnostics)?;
    k6_request_options_end(source, after_options, diagnostics).then_some(options)
}

fn k6_request_options_end(
    source: &str,
    after_options: usize,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> bool {
    if source
        .get(after_options..)
        .is_some_and(|remaining| remaining.trim_start().starts_with(')'))
    {
        true
    } else {
        diagnostics.push(diag(
            source,
            after_options,
            "a chamada HTTP do k6 tem argumentos extras não suportados",
        ));
        false
    }
}

fn parse_k6_request_options(
    source: &str,
    offset: usize,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Option<(K6RequestOptions, usize)> {
    let remaining = source.get(offset..)?;
    let trimmed = remaining.trim_start();
    let object_offset = offset + remaining.len().saturating_sub(trimmed.len());
    let Some((object, after_object)) = nested_js_object(source, object_offset) else {
        diagnostics.push(diag(
            source,
            object_offset,
            "opções de request do k6 precisam ser um objeto literal",
        ));
        return None;
    };
    let Some(fields) = static_object_fields(object) else {
        diagnostics.push(diag(
            source,
            object_offset,
            "opções de request do k6 são inválidas",
        ));
        return None;
    };
    let mut options = K6RequestOptions::default();
    for (key, value) in fields {
        match key {
            "headers" => match parse_k6_string_map(value) {
                Some(headers) => options.headers = headers.into_iter().collect(),
                None => diagnostics.push(diag(
                    source,
                    object_offset,
                    "headers da request k6 precisam ter chaves e valores literais",
                )),
            },
            "tags" => match parse_k6_string_map(value) {
                Some(tags) => options.tags = tags,
                None => diagnostics.push(diag(
                    source,
                    object_offset,
                    "tags da request k6 precisam ter chaves e valores literais",
                )),
            },
            "cookies" => match parse_k6_string_map(value) {
                Some(cookies) => options.cookies = cookies,
                None => diagnostics.push(diag(
                    source,
                    object_offset,
                    "cookies da request k6 precisam ser strings literais nesta etapa",
                )),
            },
            "timeout" => match parse_k6_duration(value).filter(|duration| *duration > 0) {
                Some(timeout_ms) => options.timeout_ms = Some(timeout_ms),
                None => diagnostics.push(diag(
                    source,
                    object_offset,
                    "timeout da request k6 precisa ser uma duração literal positiva",
                )),
            },
            "redirects" => diagnostics.push(diag(
                source,
                object_offset,
                format!("opção k6 '{key}' ainda não é executável pelo runtime de carga"),
            )),
            _ => diagnostics.push(diag(
                source,
                object_offset,
                format!("opção de request k6 '{key}' ainda não é traduzida"),
            )),
        }
    }
    if !options.cookies.is_empty()
        && options
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("cookie"))
    {
        diagnostics.push(diag(
            source,
            object_offset,
            "headers.Cookie e cookies da request k6 não podem ser combinados nesta etapa",
        ));
    }
    Some((options, after_object))
}

fn parse_k6_string_map(value: &str) -> Option<BTreeMap<String, String>> {
    let value = value.trim();
    let (object, after_object) = nested_js_object(value, 0)?;
    if !value.get(after_object..)?.trim().is_empty() {
        return None;
    }
    let fields = static_object_fields(object)?;
    let mut values = BTreeMap::new();
    for (raw_key, raw_value) in fields {
        let key =
            js_string_literal(raw_key).or_else(|| is_js_identifier(raw_key).then_some(raw_key))?;
        let value = key_value_literal(raw_value)?;
        if values.insert(key.to_string(), value).is_some() {
            return None;
        }
    }
    Some(values)
}

fn analyze_jmeter(
    source: &str,
    now: SystemTime,
) -> Result<LoadImportAnalysis, LoadTestImportError> {
    let groups = parse_jmeter(source)?;
    let mut diagnostics = Vec::new();
    if groups.is_empty() {
        diagnostics.push(diag(source, 0, "nenhum Thread Group JMeter foi encontrado"));
    }
    if groups
        .iter()
        .any(|group| group.kind != JmeterThreadGroupKind::Standard)
        && let Some(group) = groups
            .iter()
            .find(|group| group.kind != JmeterThreadGroupKind::Standard)
    {
        diagnostics.push(diag(
            source,
            group.offset,
            "grupos setUp/tearDown ainda não são traduzidos para lanes de lifecycle",
        ));
    }
    let scenarios = groups
        .iter()
        .filter(|group| group.kind == JmeterThreadGroupKind::Standard)
        .filter_map(|group| {
            let config = jmeter_scenario_config(source, group, &mut diagnostics)?;
            Some(JmeterImportedScenario {
                name: group.name.clone(),
                config,
                requests: requests_from_jmeter_group(source, group, &mut diagnostics),
            })
        })
        .collect::<Vec<_>>();
    if !diagnostics.is_empty() {
        return Err(LoadTestImportError::Incompatible { diagnostics });
    }
    let requests = scenarios
        .iter()
        .flat_map(|scenario| scenario.requests.iter().cloned())
        .collect::<Vec<_>>();
    Ok(LoadImportAnalysis {
        format: LoadImportFormat::Jmeter,
        flow: build_jmeter_flow(&scenarios, now)?,
        requests,
        assets: vec!["source".to_string()],
    })
}

/// The `perVuIterations` executor preserves a closed Thread Group when each
/// thread executes a finite number of loops without ramp-up or a scheduler.
/// Other combinations require a JMeter-specific schedule to preserve thread
/// start times and avoid turning a bounded workload into a fixed duration.
fn jmeter_scenario_config(
    source: &str,
    group: &JmeterThreadGroup,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Option<serde_json::Value> {
    let diagnostic_count = diagnostics.len();
    let parse_positive = |key: &str, label: &str| {
        group
            .properties
            .get(key)
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                diag(
                    source,
                    group.offset,
                    format!("{label} do Thread Group precisa ser inteiro positivo"),
                )
            })
    };
    let threads = match parse_positive("ThreadGroup.num_threads", "número de threads") {
        Ok(value) => value,
        Err(diagnostic) => {
            diagnostics.push(diagnostic);
            return None;
        }
    };
    let loops = match group.properties.get("LoopController.loops") {
        Some(_) => match parse_positive("LoopController.loops", "número de loops") {
            Ok(value) => value,
            Err(diagnostic) => {
                diagnostics.push(diagnostic);
                return None;
            }
        },
        None => 1,
    };
    for key in ["ThreadGroup.scheduler", "LoopController.continue_forever"] {
        if group.properties.get(key).is_some_and(|value| {
            !value.eq_ignore_ascii_case("true") && !value.eq_ignore_ascii_case("false")
        }) {
            diagnostics.push(diag(
                source,
                group.offset,
                format!("{key} precisa ser true ou false"),
            ));
        }
    }
    for key in [
        "ThreadGroup.ramp_time",
        "ThreadGroup.duration",
        "ThreadGroup.delay",
    ] {
        if group
            .properties
            .get(key)
            .is_some_and(|value| !value.is_empty() && value.parse::<u64>().is_err())
        {
            diagnostics.push(diag(
                source,
                group.offset,
                format!("{key} precisa ser inteiro não negativo"),
            ));
        }
    }
    if group
        .properties
        .get("ThreadGroup.on_sample_error")
        .is_some_and(|value| value != "continue")
    {
        diagnostics.push(diag(
            source,
            group.offset,
            "política de erro do Thread Group ainda não é traduzida",
        ));
    }
    let is_true = |key: &str| {
        group
            .properties
            .get(key)
            .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    };
    let has_positive_seconds = |key: &str| {
        group
            .properties
            .get(key)
            .is_some_and(|value| value.parse::<u64>().is_ok_and(|value| value > 0))
    };
    if has_positive_seconds("ThreadGroup.ramp_time") {
        diagnostics.push(diag(
            source,
            group.offset,
            "ramp-up do Thread Group ainda não é traduzido para o scheduler de carga",
        ));
    }
    if is_true("ThreadGroup.scheduler")
        || has_positive_seconds("ThreadGroup.duration")
        || has_positive_seconds("ThreadGroup.delay")
    {
        diagnostics.push(diag(
            source,
            group.offset,
            "scheduler, duração ou atraso do Thread Group ainda não são traduzidos",
        ));
    }
    if is_true("LoopController.continue_forever") {
        diagnostics.push(diag(
            source,
            group.offset,
            "LoopController infinito ainda não é traduzido",
        ));
    }
    if diagnostics.len() == diagnostic_count {
        Some(json!({
            "sourceFormat": "jmeter",
            "executor": "perVuIterations",
            "name": group.name,
            "vus": threads,
            "iterationsPerVu": loops,
            "sourceProperties": group.properties,
        }))
    } else {
        None
    }
}

/// Preserves linear ordering between requests and pauses in the source.
/// `Timer` connects to the following request, matching the runtime's canonical
/// semantics for a pause between two requests within one iteration.
fn build_k6_flow(
    scenarios: Vec<(K6Scenario, K6Effects)>,
    setup_effects: Option<&K6Effects>,
    teardown_effects: Option<&K6Effects>,
    thresholds: &[K6Threshold],
    now: SystemTime,
) -> Result<Flow, LoadTestImportError> {
    let mut nodes = vec![FlowNode {
        id: "start".to_string(),
        kind: FlowNodeKind::Start,
        position: FlowPosition { x: 0.0, y: 0.0 },
    }];
    let mut edges = Vec::new();
    if let Some(effects) = setup_effects {
        add_k6_lifecycle(&mut nodes, &mut edges, "setup", effects, -180.0);
    }
    let mut bodies: Vec<(String, K6Effects, Vec<String>, usize)> = Vec::new();
    for (index, (scenario, effects)) in scenarios.iter().enumerate() {
        let id = format!("scenario-{}", index + 1);
        nodes.push(load_node(
            &id,
            LoadNodeKind::Scenario,
            &scenario.name,
            scenario.config.clone(),
            300.0,
            180.0 * index as f64,
        ));
        edges.push(edge(
            &format!("start-scenario-{}", index + 1),
            "start",
            &id,
            None,
        ));
        if let Some((_, _, roots, _)) = bodies
            .iter_mut()
            .find(|(exec, _, _, _)| *exec == scenario.exec)
        {
            roots.push(id);
        } else {
            bodies.push((scenario.exec.clone(), effects.clone(), vec![id], index));
        }
    }
    for (exec, effects, roots, first_index) in &bodies {
        let prefix = if exec == "default" {
            String::new()
        } else {
            format!("scenario-{}-", first_index + 1)
        };
        append_k6_effects(
            &mut nodes,
            &mut edges,
            roots,
            effects,
            &prefix,
            180.0 * *first_index as f64,
        );
    }
    if let Some(effects) = teardown_effects {
        let y = 180.0 * scenarios.len() as f64;
        add_k6_lifecycle(&mut nodes, &mut edges, "teardown", effects, y);
    }
    for (index, threshold) in thresholds.iter().enumerate() {
        nodes.push(load_node(
            &format!("threshold-{}", index + 1),
            LoadNodeKind::Threshold,
            &threshold.label,
            json!({
                "metric": threshold.metric,
                "tags": threshold.tags,
                "statistic": threshold.statistic,
                "comparison": threshold.comparison,
                "target": threshold.target,
            }),
            600.0,
            180.0 * (scenarios.len() + index) as f64,
        ));
    }
    Flow::new_with_execution_kind(
        "",
        "Importado de k6",
        FlowExecutionKind::Load,
        nodes,
        edges,
        now,
        now,
    )
    .map_err(|error| LoadTestImportError::InvalidFlow(error.to_string()))
}

enum K6FlowStep<'a> {
    Request(&'a K6Request),
    Timer(&'a K6Timer),
    Check(&'a K6Check),
    Metric(&'a K6Metric),
}

fn sorted_k6_steps(effects: &K6Effects) -> Vec<K6FlowStep<'_>> {
    let mut steps = effects
        .requests
        .iter()
        .map(K6FlowStep::Request)
        .chain(effects.timers.iter().map(K6FlowStep::Timer))
        .chain(effects.checks.iter().map(K6FlowStep::Check))
        .chain(effects.metrics.iter().map(K6FlowStep::Metric))
        .collect::<Vec<_>>();
    steps.sort_by_key(|step| match step {
        K6FlowStep::Request(request) => request.offset,
        K6FlowStep::Timer(timer) => timer.offset,
        K6FlowStep::Check(check) => check.offset,
        K6FlowStep::Metric(metric) => metric.offset,
    });
    steps
}

fn add_k6_lifecycle(
    nodes: &mut Vec<FlowNode>,
    edges: &mut Vec<FlowEdge>,
    phase: &str,
    effects: &K6Effects,
    y: f64,
) {
    nodes.push(load_node(
        phase,
        LoadNodeKind::Scenario,
        phase,
        json!({ "phase": phase }),
        300.0,
        y,
    ));
    edges.push(edge(&format!("start-{phase}"), "start", phase, None));
    append_k6_effects(
        nodes,
        edges,
        &[phase.to_string()],
        effects,
        &format!("{phase}-"),
        y,
    );
}

fn append_k6_effects(
    nodes: &mut Vec<FlowNode>,
    edges: &mut Vec<FlowEdge>,
    roots: &[String],
    effects: &K6Effects,
    prefix: &str,
    y: f64,
) {
    let mut previous: Option<String> = None;
    let mut previous_handle = None;
    let mut request_index = 0;
    let mut timer_index = 0;
    let mut check_index = 0;
    let mut metric_index = 0;

    for (position, step) in sorted_k6_steps(effects).into_iter().enumerate() {
        let (id, kind, label, config) = match step {
            K6FlowStep::Request(request) => {
                request_index += 1;
                let mut headers = request
                    .options
                    .headers
                    .iter()
                    .map(|(name, value)| json!({ "name": name, "value": value, "enabled": true }))
                    .collect::<Vec<_>>();
                if !request.options.cookies.is_empty() {
                    let value = request
                        .options
                        .cookies
                        .iter()
                        .map(|(name, value)| format!("{name}={value}"))
                        .collect::<Vec<_>>()
                        .join("; ");
                    headers.push(json!({ "name": "Cookie", "value": value, "enabled": true }));
                }
                let mut config = json!({
                    "method": request.request.method,
                    "url": request.request.url,
                    "body": request.request.body.as_deref().unwrap_or_default(),
                    "headers": headers,
                    "tags": request.options.tags,
                    "sourceProperties": request.request.source_properties,
                    "source": { "line": request.request.line },
                });
                if let Some(timeout_ms) = request.options.timeout_ms {
                    config["timeoutMs"] = json!(timeout_ms);
                }
                (
                    format!("{prefix}request-{request_index}"),
                    LoadNodeKind::Request,
                    format!("{} {}", request.request.method, request.request.url),
                    config,
                )
            }
            K6FlowStep::Timer(timer) => {
                timer_index += 1;
                (
                    format!("{prefix}timer-{timer_index}"),
                    LoadNodeKind::Timer,
                    format!("Pausa de {} ms", timer.duration_ms),
                    json!({ "kind": "fixed", "durationMs": timer.duration_ms }),
                )
            }
            K6FlowStep::Check(check) => {
                check_index += 1;
                (
                    format!("{prefix}check-{check_index}"),
                    LoadNodeKind::Check,
                    check.name.clone(),
                    json!({ "name": check.name, "status": check.expected_status }),
                )
            }
            K6FlowStep::Metric(metric) => {
                metric_index += 1;
                (
                    format!("{prefix}metric-{metric_index}"),
                    LoadNodeKind::Metric,
                    metric.name.clone(),
                    json!({
                        "name": metric.name,
                        "kind": metric.kind,
                        "value": metric.value,
                        "tags": metric.tags,
                    }),
                )
            }
        };
        let next_handle = (kind == LoadNodeKind::Request).then_some("success");
        nodes.push(load_node(
            &id,
            kind,
            &label,
            config,
            600.0 + 280.0 * position as f64,
            y,
        ));
        if let Some(previous) = previous {
            edges.push(edge(
                &format!("{prefix}edge-{}", position + 1),
                &previous,
                &id,
                previous_handle,
            ));
        } else {
            for root in roots {
                edges.push(edge(&format!("{root}-body"), root, &id, Some("iteration")));
            }
        }
        previous = Some(id);
        previous_handle = next_handle;
    }
}

struct JmeterImportedScenario {
    name: String,
    config: serde_json::Value,
    requests: Vec<LoadImportRequest>,
}

fn build_jmeter_flow(
    scenarios: &[JmeterImportedScenario],
    now: SystemTime,
) -> Result<Flow, LoadTestImportError> {
    let mut nodes = vec![FlowNode {
        id: "start".to_string(),
        kind: FlowNodeKind::Start,
        position: FlowPosition { x: 0.0, y: 0.0 },
    }];
    let mut edges = Vec::new();
    for (scenario_index, scenario) in scenarios.iter().enumerate() {
        let scenario_id = format!("scenario-{}", scenario_index + 1);
        let y = 220.0 * scenario_index as f64;
        nodes.push(load_node(
            &scenario_id,
            LoadNodeKind::Scenario,
            &scenario.name,
            scenario.config.clone(),
            300.0,
            y,
        ));
        edges.push(edge(
            &format!("start-scenario-{}", scenario_index + 1),
            "start",
            &scenario_id,
            None,
        ));
        let mut previous = scenario_id;
        let mut previous_handle = Some("iteration");
        for (request_index, request) in scenario.requests.iter().enumerate() {
            let id = format!(
                "scenario-{}-request-{}",
                scenario_index + 1,
                request_index + 1
            );
            nodes.push(load_node(
                &id,
                LoadNodeKind::Request,
                &format!("{} {}", request.method, request.url),
                json!({
                    "method": request.method,
                    "url": request.url,
                    "body": request.body.as_deref().unwrap_or_default(),
                    "sourceProperties": request.source_properties,
                    "source": { "line": request.line },
                }),
                600.0 + 280.0 * request_index as f64,
                y,
            ));
            edges.push(edge(
                &format!("scenario-{}-edge-{}", scenario_index + 1, request_index + 1),
                &previous,
                &id,
                previous_handle,
            ));
            previous = id;
            previous_handle = Some("success");
        }
    }
    Flow::new_with_execution_kind(
        "",
        "Importado de JMeter",
        FlowExecutionKind::Load,
        nodes,
        edges,
        now,
        now,
    )
    .map_err(|error| LoadTestImportError::InvalidFlow(error.to_string()))
}

fn load_node(
    id: &str,
    kind: LoadNodeKind,
    label: &str,
    config: serde_json::Value,
    x: f64,
    y: f64,
) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        kind: FlowNodeKind::Load {
            node: LoadNode {
                kind,
                label: label.to_string(),
                config: config.to_string(),
            },
        },
        position: FlowPosition { x, y },
    }
}

fn edge(id: &str, source: &str, target: &str, source_handle: Option<&str>) -> FlowEdge {
    FlowEdge {
        id: id.to_string(),
        source_node_id: source.to_string(),
        target_node_id: target.to_string(),
        source_handle: source_handle.map(str::to_string),
    }
}

fn requests_from_jmeter_group(
    source: &str,
    group: &JmeterThreadGroup,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<LoadImportRequest> {
    group
        .samplers
        .iter()
        .filter_map(|sampler| {
            let Some(domain) = sampler.properties.get("HTTPSampler.domain") else {
                diagnostics.push(diag(
                    source,
                    sampler.offset,
                    format!("HTTP Sampler '{}' não tem domínio", sampler.name),
                ));
                return None;
            };
            let protocol = sampler
                .properties
                .get("HTTPSampler.protocol")
                .filter(|value| !value.is_empty())
                .map(String::as_str)
                .unwrap_or("http");
            if !matches!(protocol, "http" | "https") {
                diagnostics.push(diag(
                    source,
                    sampler.offset,
                    format!("protocolo HTTP não suportado: {protocol}"),
                ));
                return None;
            }
            let port = sampler
                .properties
                .get("HTTPSampler.port")
                .filter(|value| !value.is_empty())
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            let path = sampler
                .properties
                .get("HTTPSampler.path")
                .map(String::as_str)
                .unwrap_or("/");
            let path = if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            };
            let method = sampler
                .properties
                .get("HTTPSampler.method")
                .cloned()
                .unwrap_or_else(|| "GET".to_string());
            if !matches!(
                method.as_str(),
                "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
            ) {
                diagnostics.push(diag(
                    source,
                    sampler.offset,
                    format!("método HTTP não suportado: {method}"),
                ));
                return None;
            }
            let body = raw_jmeter_request_body(source, sampler, diagnostics)?;
            let mut source_properties = sampler
                .properties
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>();
            source_properties.sort_unstable();
            let url = if domain.starts_with("http://") || domain.starts_with("https://") {
                format!("{domain}{path}")
            } else {
                format!("{protocol}://{domain}{port}{path}")
            };
            Some(LoadImportRequest {
                method,
                url,
                body,
                source_properties,
                line: line_at(source, sampler.offset),
            })
        })
        .collect()
}

/// JMeter uses an `HTTPArgument` list for both encoded parameters and raw
/// bodies. Only the latter serializes identically to a `LoadRequest`:
/// `postBodyRaw=true` with exactly one argument and its literal value. Other
/// forms remain incompatible to preserve parameter encoding, order and
/// destination during import.
fn raw_jmeter_request_body(
    source: &str,
    sampler: &JmeterHttpSampler,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Option<Option<String>> {
    if sampler.arguments.is_empty() {
        return Some(None);
    }
    if !sampler
        .properties
        .get("HTTPSampler.postBodyRaw")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        diagnostics.push(diag(
            source,
            sampler.offset,
            "argumentos HTTP do JMeter exigem HTTPSampler.postBodyRaw=true; parâmetros codificados ainda não são traduzidos",
        ));
        return None;
    }
    if sampler.arguments.len() != 1 {
        diagnostics.push(diag(
            source,
            sampler.offset,
            "corpo bruto do JMeter precisa ter exatamente um HTTPArgument",
        ));
        return None;
    }
    let Some(value) = sampler.arguments[0].properties.get("Argument.value") else {
        diagnostics.push(diag(
            source,
            sampler.offset,
            "corpo bruto do JMeter não tem Argument.value",
        ));
        return None;
    };
    Some(Some(value.clone()))
}

fn parse_js_string(source: &str, offset: usize) -> Option<(String, usize)> {
    let text = source.get(offset..)?.trim_start();
    let skipped = source[offset..].len() - text.len();
    let quote = text.chars().next()?;
    if quote != '\'' && quote != '\"' && quote != '`' {
        return None;
    }
    let mut escaped = false;
    let mut value = String::new();
    for (index, character) in text[quote.len_utf8()..].char_indices() {
        if escaped {
            value.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == quote {
            return Some((
                value,
                offset + skipped + quote.len_utf8() + index + character.len_utf8(),
            ));
        }
        value.push(character);
    }
    None
}

/// Searches outside quotes and comments so words in descriptions do not
/// trigger rejection. This is neither a JavaScript executor nor transformer.
fn find_code(source: &str, needle: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut quote = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'\"' | b'`') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index = source[index..]
                .find('\n')
                .map(|next| index + next + 1)
                .unwrap_or(bytes.len());
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index = source[index + 2..]
                .find("*/")
                .map(|next| index + next + 4)
                .unwrap_or(bytes.len());
            continue;
        }
        if source[index..].starts_with(needle) {
            return Some(index);
        }
        // Outside strings/comments, advance by complete UTF-8 characters;
        // slicing inside a description's character must not panic during
        // analysis that should only return diagnostics.
        index += source[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    }
    None
}

fn line_at(source: &str, offset: usize) -> usize {
    source[..offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
}
fn diag(source: &str, offset: usize, message: impl Into<String>) -> LoadImportDiagnostic {
    let line = line_at(source, offset.min(source.len()));
    let start = source[..offset.min(source.len())]
        .rfind('\n')
        .map(|value| value + 1)
        .unwrap_or(0);
    LoadImportDiagnostic {
        line,
        column: offset.saturating_sub(start) + 1,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn rejects_untranslated_statements_regardless_of_formatting() {
        for statement in [
            "if(false){http.get('https://api.example.test/never');}",
            "if/*comment*/(true){http.get('https://api.example.test/conditional');}",
            "for(let i=0;i<2;i++){http.get('https://api.example.test/repeated');}",
            "while(false){http.get('https://api.example.test/never');}",
            "do{http.get('https://api.example.test/repeated');}while(false);",
            "false && http.get('https://api.example.test/never');",
            "true ? http.get('https://api.example.test/conditional') : null;",
            "function nested(){http.get('https://api.example.test/unused');}",
            "return; http.get('https://api.example.test/unreachable');",
            "const callback=()=>http.get('https://api.example.test/unused');",
            "helper();",
        ] {
            let source = format!(
                "import http from 'k6/http';\nexport default function(){{\n{statement}\nhttp.get('https://api.example.test/work');\n}}"
            );
            let Err(LoadTestImportError::Incompatible { diagnostics }) =
                analyze_load_test("control.js", &source, UNIX_EPOCH)
            else {
                panic!("untranslated statement was accepted: {statement}");
            };
            assert!(
                diagnostics.iter().any(|diagnostic| diagnostic.line == 3),
                "missing source location for {statement}: {diagnostics:?}"
            );
        }
    }

    #[test]
    fn rejects_shadowed_clients_metrics_and_duplicate_response_bindings() {
        for source in [
            "import http from 'k6/http'; export default function http(){http.get('https://api.example.test/work');}",
            "import http from 'k6/http'; export default function(){const http=http.get('https://api.example.test/work');}",
            "import http from 'k6/http'; import {Counter} from 'k6/metrics'; const count=new Counter('count'); export default function count(){http.get('https://api.example.test/work'); count.add(1);}",
            "import http from 'k6/http'; export default function(){var response=http.get('https://api.example.test/first'); var response=http.get('https://api.example.test/second');}",
            "import client from 'k6/http'; export default function(){client.get('https://api.example.test/work');}",
        ] {
            assert!(
                matches!(
                    analyze_load_test("shadow.js", source, UNIX_EPOCH),
                    Err(LoadTestImportError::Incompatible { .. })
                ),
                "shadowing or alias was accepted: {source}"
            );
        }
    }

    #[test]
    fn imports_ast_call_boundaries_with_whitespace_and_typescript_response_bindings() {
        let source = "import http from 'k6/http'; import {check, sleep} from 'k6'; export default () => { const response: unknown = http . get ( 'https://api.example.test/work' ); check (response, { 'healthy': r => r.status === 200 }); http . post ('https://api.example.test/work' , '{}' , {headers: {Accept: 'application/json'}}); sleep (0.001); };";
        let analysis = analyze_load_test("formatted.ts", source, UNIX_EPOCH).unwrap();
        assert_eq!(analysis.requests.len(), 2);
        assert_eq!(analysis.requests[1].body.as_deref(), Some("{}"));
        let kinds = analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|node| match &node.kind {
                FlowNodeKind::Load { node } => Some(node.kind),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                LoadNodeKind::Scenario,
                LoadNodeKind::Request,
                LoadNodeKind::Check,
                LoadNodeKind::Request,
                LoadNodeKind::Timer
            ]
        );
    }

    #[test]
    fn checks_cannot_read_a_request_from_another_function() {
        let source = "import http from 'k6/http'; import {check} from 'k6'; export function setup(){ const response=http.get('https://api.example.test/setup'); } export default function(){ check(response, {'setup is healthy': r=>r.status===200}); http.get('https://api.example.test/work'); }";
        assert!(
            matches!(analyze_load_test("check-scope.js", source, UNIX_EPOCH), Err(LoadTestImportError::Incompatible { diagnostics }) if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("outra fase")))
        );
    }

    #[test]
    fn rejects_values_that_textual_lowering_would_silently_change() {
        for source in [
            "import http from 'k6/http'; const id='abc'; export default function(){http.get(`https://api.example.test/${id}`);}",
            "import http from 'k6/http'; const token='value'; export default function(){http.get('https://api.example.test/work',{headers:{'X-Test':token}});}",
            "import http from 'k6/http'; export default function(){http.post('https://api.example.test/work','a'+'b');}",
            "import http from 'k6/http'; export default function(){http.post('https://api.example.test/work','a\\nb');}",
            "import http from 'k6/http'; export const options={scenarios:{a:{executor:'per-vu-iterations',vus:1,iterations:1}}&&dynamicScenarios()}; export default function(){http.get('https://api.example.test/work');}",
            "import http from 'k6/http'; export const options={vus:1,vus:2,iterations:1}; export default function(){http.get('https://api.example.test/work');}",
        ] {
            assert!(
                matches!(
                    analyze_load_test("dynamic.js", source, UNIX_EPOCH),
                    Err(LoadTestImportError::Incompatible { .. })
                ),
                "nonliteral or ambiguous value was accepted: {source}"
            );
        }
    }

    #[test]
    fn repeated_exec_shares_only_the_complete_body_and_keeps_lifecycle_separate() {
        let source = "import http from 'k6/http'; export const options={scenarios:{first:{executor:'shared-iterations',exec:'work',vus:1,iterations:1},second:{executor:'constant-vus',exec:'work',vus:2,duration:'1s'}}}; export function setup(){http.get('https://api.example.test/setup');} export function work(){http.get('https://api.example.test/work');} export function teardown(){http.get('https://api.example.test/teardown');}";
        let analysis = analyze_load_test("shared-exec.js", source, UNIX_EPOCH).unwrap();
        assert_eq!(analysis.requests.len(), 3);
        let entries = analysis
            .flow
            .edges()
            .iter()
            .filter(|edge| {
                edge.source_node_id.starts_with("scenario-")
                    && edge.source_handle.as_deref() == Some("iteration")
            })
            .map(|edge| &edge.target_node_id)
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], entries[1]);
        assert_ne!(entries[0], "setup-request-1");
    }

    #[test]
    fn imports_static_k6_requests_as_a_single_load_flow() {
        let source = "import http from 'k6/http'; export default function () { http.get('https://api.example.test/a'); http.post('https://api.example.test/b', '{}'); }";
        let analysis = analyze_load_test("smoke.js", source, UNIX_EPOCH).unwrap();
        assert_eq!(analysis.format, LoadImportFormat::K6);
        assert_eq!(analysis.requests.len(), 2);
        assert_eq!(analysis.requests[1].body.as_deref(), Some("{}"));
        assert_eq!(analysis.flow.execution_kind(), FlowExecutionKind::Load);
    }

    #[test]
    fn validates_typescript_before_lowering_static_k6_requests() {
        let source = "import http from 'k6/http'; type ScenarioName = string; const name: ScenarioName = 'smoke'; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("smoke.ts", source, UNIX_EPOCH).unwrap();

        assert_eq!(analysis.format, LoadImportFormat::K6);
        assert_eq!(analysis.requests.len(), 1);
    }

    #[test]
    fn rejects_invalid_k6_syntax_with_its_source_location() {
        let source = "import http from 'k6/http';\nexport default function () {\n  http.get('https://api.example.test/a');";

        let Err(LoadTestImportError::Incompatible { diagnostics }) =
            analyze_load_test("broken.ts", source, UNIX_EPOCH)
        else {
            panic!("fonte inválida deveria ser rejeitada");
        };

        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.line >= 2
                && diagnostic.column >= 1
                && diagnostic
                    .message
                    .contains("sintaxe JavaScript/TypeScript inválida")
        }));
    }

    #[test]
    fn imports_static_k6_request_headers_tags_and_cookies() {
        let source = "import http from 'k6/http'; export default function () { http.get('https://api.example.test/a', { headers: { Accept: 'application/json', 'X-Trace': 'trace-1' }, tags: { operation: 'health' }, cookies: { session: 'abc' } }); }";
        let analysis = analyze_load_test("request-options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[2].kind else {
            panic!("terceiro node deveria ser Request");
        };

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({
                "method":"GET",
                "url":"https://api.example.test/a",
                "body":"",
                "headers":[
                    {"name":"Accept","value":"application/json","enabled":true},
                    {"name":"X-Trace","value":"trace-1","enabled":true},
                    {"name":"Cookie","value":"session=abc","enabled":true},
                ],
                "tags":{"operation":"health"},
                "sourceProperties":[],
                "source":{"line":1},
            })
        );
    }

    #[test]
    fn imports_k6_head_options_and_static_http_request() {
        let source = "import http from 'k6/http'; export default function () { http.head('https://api.example.test/health', { tags: { operation: 'health' } }); http.options('https://api.example.test/cors'); http.request('PATCH', 'https://api.example.test/job/1', '{\"state\":\"ready\"}', { headers: { 'X-Run': 'load' } }); http.request('GET', 'https://api.example.test/items', null, { tags: { operation: 'list' } }); }";
        let analysis = analyze_load_test("methods.js", source, UNIX_EPOCH).unwrap();
        let requests = analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|flow_node| match &flow_node.kind {
                FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Request => {
                    Some(serde_json::from_str::<serde_json::Value>(&node.config).unwrap())
                }
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0]["method"], "HEAD");
        assert_eq!(requests[0]["tags"], json!({"operation":"health"}));
        assert_eq!(requests[1]["method"], "OPTIONS");
        assert_eq!(requests[2]["method"], "PATCH");
        assert_eq!(requests[2]["body"], "{\"state\":\"ready\"}");
        assert_eq!(requests[2]["headers"][0]["name"], "X-Run");
        assert_eq!(requests[3]["method"], "GET");
        assert_eq!(requests[3]["tags"], json!({"operation":"list"}));
    }

    #[test]
    fn imports_a_literal_k6_request_timeout() {
        let source = "import http from 'k6/http'; export default function () { http.get('https://api.example.test/a', { timeout: '1s' }); }";
        let analysis = analyze_load_test("request-options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[2].kind else {
            panic!("terceiro node deveria ser Request");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap()["timeoutMs"],
            1_000
        );
    }

    #[test]
    fn rejects_a_dynamic_or_zero_k6_request_timeout_without_a_partial_flow() {
        for timeout in ["variable", "'invalid'", "'0s'"] {
            let source = format!(
                "import http from 'k6/http'; export default function () {{ http.get('https://api.example.test/a', {{ timeout: {timeout} }}); }}"
            );
            assert!(matches!(
                analyze_load_test("request-options.js", &source, UNIX_EPOCH),
                Err(LoadTestImportError::Incompatible { .. })
            ));
        }
    }

    #[test]
    fn imports_static_k6_options_for_shared_iterations() {
        let source = "import http from 'k6/http'; export const options = { vus: 3, iterations: 12, maxDuration: '5s' }; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[1].kind else {
            panic!("segundo node deveria ser Scenario");
        };

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({"sourceFormat":"k6", "executor":"sharedIterations", "vus":3, "iterations":12, "maxDurationMs":5000})
        );
    }

    #[test]
    fn imports_static_k6_options_for_constant_vus() {
        let source = "import http from 'k6/http'; export const options = { vus: 2, duration: '250ms' }; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[1].kind else {
            panic!("segundo node deveria ser Scenario");
        };

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({"sourceFormat":"k6", "executor":"constantVus", "vus":2, "durationMs":250})
        );
    }

    #[test]
    fn imports_static_k6_metrics_and_thresholds() {
        let source = "import http from 'k6/http'; import { Counter, Rate } from 'k6/metrics'; const businessEvents = new Counter('business_events'); const conversion = new Rate('conversion'); export const options = { vus: 1, iterations: 1, thresholds: { business_events: ['count>=2'], http_reqs: ['count>0'], 'http_req_duration{method:GET}': ['p(95)<200'], checks: ['rate>0.9'] } }; export default function () { http.get('https://api.example.test/a'); businessEvents.add(2, { source: 'catalog' }); conversion.add(true); }";
        let analysis = analyze_load_test("metrics.js", source, UNIX_EPOCH).unwrap();
        let metrics = analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|flow_node| match &flow_node.kind {
                FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Metric => {
                    Some(serde_json::from_str::<serde_json::Value>(&node.config).unwrap())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let thresholds = analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|flow_node| match &flow_node.kind {
                FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Threshold => {
                    Some(serde_json::from_str::<serde_json::Value>(&node.config).unwrap())
                }
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(
            metrics,
            vec![
                json!({"name":"business_events","kind":"counter","value":2.0,"tags":{"source":"catalog"}}),
                json!({"name":"conversion","kind":"rate","value":1.0,"tags":{}}),
            ]
        );
        assert_eq!(
            thresholds,
            vec![
                json!({"metric":"business_events","tags":{},"statistic":"count","comparison":"gte","target":2.0}),
                json!({"metric":"http_requests","tags":{},"statistic":"count","comparison":"gt","target":0.0}),
                json!({"metric":"http_req_duration","tags":{"method":"GET"},"statistic":"p95","comparison":"lt","target":200.0}),
                json!({"metric":"checks","tags":{},"statistic":"rate","comparison":"gt","target":0.9}),
            ]
        );
    }

    #[test]
    fn rejects_dynamic_k6_metric_values_without_a_partial_flow() {
        let source = "import http from 'k6/http'; import { Counter } from 'k6/metrics'; const events = new Counter('events'); export default function () { http.get('https://api.example.test/a'); events.add(Math.random()); }";
        assert!(matches!(
            analyze_load_test("metrics.js", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn imports_one_named_k6_per_vu_iterations_scenario() {
        let source = "import http from 'k6/http'; export const options = { scenarios: { smoke: { executor: 'per-vu-iterations', vus: 2, iterations: 4, maxDuration: '3s' } } }; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[1].kind else {
            panic!("segundo node deveria ser Scenario");
        };

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({"sourceFormat":"k6", "executor":"perVuIterations", "vus":2, "iterationsPerVu":4, "maxDurationMs":3000})
        );
    }

    #[test]
    fn imports_one_named_k6_constant_arrival_rate_scenario() {
        let source = "import http from 'k6/http'; export const options = { scenarios: { arrivals: { executor: 'constant-arrival-rate', rate: 10, timeUnit: '1s', duration: '5s', preAllocatedVUs: 2, maxVUs: 4 } } }; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[1].kind else {
            panic!("segundo node deveria ser Scenario");
        };

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({"sourceFormat":"k6", "executor":"constantArrivalRate", "rate":10, "timeUnitMs":1000, "durationMs":5000, "preAllocatedVus":2, "maxVus":4})
        );
    }

    #[test]
    fn imports_multiple_named_k6_scenarios_with_a_shared_default_function() {
        let source = "import http from 'k6/http'; export const options = { scenarios: { smoke: { executor: 'per-vu-iterations', vus: 2, iterations: 3 }, ramp: { executor: 'ramping-vus', exec: 'default', startVUs: 1, stages: [{ duration: '1s', target: 4 }] } } }; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("scenarios.js", source, UNIX_EPOCH).unwrap();
        let scenarios = analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|flow_node| match &flow_node.kind {
                FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Scenario => Some((
                    flow_node.id.as_str(),
                    node.label.as_str(),
                    node.config.as_str(),
                )),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(
            scenarios
                .iter()
                .map(|(id, label, _)| (*id, *label))
                .collect::<Vec<_>>(),
            vec![("scenario-1", "smoke"), ("scenario-2", "ramp"),]
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(scenarios[0].2).unwrap(),
            json!({
                "sourceFormat":"k6",
                "executor":"perVuIterations",
                "vus":2,
                "iterationsPerVu":3,
                "maxDurationMs":null,
            })
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(scenarios[1].2).unwrap(),
            json!({
                "sourceFormat":"k6",
                "executor":"rampingVus",
                "startVus":1,
                "stages":[{"target":4,"durationMs":1000}],
                "gracefulRampDownMs":null,
            })
        );
        assert!(analysis.flow.edges().iter().any(|edge| {
            edge.source_node_id == "scenario-1"
                && edge.target_node_id == "request-1"
                && edge.source_handle.as_deref() == Some("iteration")
        }));
        assert!(analysis.flow.edges().iter().any(|edge| {
            edge.source_node_id == "scenario-2"
                && edge.target_node_id == "request-1"
                && edge.source_handle.as_deref() == Some("iteration")
        }));
    }

    #[test]
    fn rejects_a_named_k6_scenario_with_a_non_default_exec() {
        let source = "import http from 'k6/http'; export const options = { scenarios: { smoke: { executor: 'per-vu-iterations', exec: 'other', vus: 2, iterations: 3 } } }; export default function () { http.get('https://api.example.test/a'); }";
        assert!(matches!(
            analyze_load_test("scenarios.js", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn imports_one_named_k6_ramping_vus_scenario() {
        let source = "import http from 'k6/http'; export const options = { scenarios: { ramp: { executor: 'ramping-vus', startVUs: 1, stages: [{ duration: '1s', target: 4 }, { duration: \"250ms\", target: 0 }], gracefulRampDown: '2s' } } }; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[1].kind else {
            panic!("segundo node deveria ser Scenario");
        };

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({
                "sourceFormat":"k6",
                "executor":"rampingVus",
                "startVus":1,
                "stages":[{"target":4,"durationMs":1000},{"target":0,"durationMs":250}],
                "gracefulRampDownMs":2000,
            })
        );
    }

    #[test]
    fn imports_one_named_k6_ramping_arrival_rate_scenario() {
        let source = "import http from 'k6/http'; export const options = { scenarios: { arrivals: { executor: 'ramping-arrival-rate', startRate: 2, timeUnit: '1s', stages: [{ duration: '1s', target: 8 }, { duration: '2s', target: 1 }], preAllocatedVUs: 3, maxVUs: 6 } } }; export default function () { http.get('https://api.example.test/a'); }";
        let analysis = analyze_load_test("options.js", source, UNIX_EPOCH).unwrap();
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[1].kind else {
            panic!("segundo node deveria ser Scenario");
        };

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({
                "sourceFormat":"k6",
                "executor":"rampingArrivalRate",
                "startRate":2,
                "timeUnitMs":1000,
                "stages":[{"target":8,"durationMs":1000},{"target":1,"durationMs":2000}],
                "preAllocatedVus":3,
                "maxVus":6,
            })
        );
    }

    #[test]
    fn rejects_k6_ramping_scenarios_with_dynamic_stages() {
        let source = "import http from 'k6/http'; const stages = [{ duration: '1s', target: 4 }]; export const options = { scenarios: { ramp: { executor: 'ramping-vus', startVUs: 1, stages } } }; export default function () { http.get('https://api.example.test/a'); }";
        assert!(matches!(
            analyze_load_test("options.js", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn rejects_unsupported_k6_named_scenario_executors() {
        let source = "import http from 'k6/http'; export const options = { scenarios: { smoke: {} } }; export default function () { http.get('https://api.example.test/a'); }";
        assert!(matches!(
            analyze_load_test("options.js", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn imports_literal_k6_sleeps_as_timers_in_request_order() {
        let source = "import http from 'k6/http'; import { sleep } from 'k6'; export default function () { sleep(0.1); http.get('https://api.example.test/a'); sleep(0.25); http.get('https://api.example.test/b'); }";
        let analysis = analyze_load_test("paced.js", source, UNIX_EPOCH).unwrap();
        let nodes = analysis.flow.nodes();

        assert!(matches!(
            &nodes[2].kind,
            FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Timer
        ));
        assert!(matches!(
            &nodes[3].kind,
            FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Request
        ));
        assert!(matches!(
            &nodes[4].kind,
            FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Timer
        ));
        let FlowNodeKind::Load { node } = &nodes[4].kind else {
            panic!("o quarto bloco executável deveria ser um Timer");
        };
        assert_eq!(node.label, "Pausa de 250 ms");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({"kind":"fixed", "durationMs":250})
        );
    }

    #[test]
    fn imports_a_static_k6_status_check_after_its_request() {
        let source = "import http from 'k6/http'; import { check } from 'k6'; export default function () { const response = http.get('https://api.example.test/health'); check(response, { 'status is healthy': (result) => result.status === 200 }); }";
        let analysis = analyze_load_test("check.js", source, UNIX_EPOCH).unwrap();
        let nodes = analysis.flow.nodes();

        let FlowNodeKind::Load { node } = &nodes[3].kind else {
            panic!("o último bloco deveria ser um Check");
        };
        assert_eq!(node.kind, LoadNodeKind::Check);
        assert_eq!(node.label, "status is healthy");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({"name":"status is healthy", "status":200})
        );
    }

    #[test]
    fn rejects_a_k6_check_that_is_not_bound_to_the_last_request() {
        let source = "import http from 'k6/http'; import { check } from 'k6'; export default function () { const response = http.get('https://api.example.test/health'); http.get('https://api.example.test/other'); check(response, { 'status is healthy': (result) => result.status === 200 }); }";
        assert!(matches!(
            analyze_load_test("check.js", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("mesma variável"))
        ));
    }

    #[test]
    fn rejects_invalid_optional_scenario_values_instead_of_defaulting_them() {
        for scenario in [
            "executor:'per-vu-iterations',vus:1,iterations:1,maxDuration:'invalid'",
            "executor:'shared-iterations',vus:1,iterations:1,maxDuration:1",
            "executor:'ramping-vus',startVUs:1,stages:[{duration:'1s',target:1}],gracefulRampDown:'invalid'",
            "executor:'constant-arrival-rate',rate:1,timeUnit:'1s',duration:'1s',preAllocatedVUs:1,maxVUs:'invalid'",
            "executor:'ramping-arrival-rate',startRate:1,timeUnit:'1s',stages:[{duration:'1s',target:1}],preAllocatedVUs:1,maxVUs:'invalid'",
        ] {
            let source = format!(
                "import http from 'k6/http';export const options={{scenarios:{{a:{{{scenario}}}}}}};export default function(){{http.get('https://api.example.test/work');}}"
            );
            assert!(
                matches!(
                    analyze_load_test("invalid-option.js", &source, UNIX_EPOCH),
                    Err(LoadTestImportError::Incompatible { .. })
                ),
                "invalid optional value was accepted: {scenario}"
            );
        }
    }

    #[test]
    fn preserves_only_sleep_durations_exactly_representable_in_milliseconds() {
        assert_eq!(literal_seconds_to_millis("1"), Some(1_000));
        assert_eq!(literal_seconds_to_millis(".25"), Some(250));
        assert_eq!(literal_seconds_to_millis("0.1000"), Some(100));
        assert_eq!(literal_seconds_to_millis("0.0001"), None);
        assert_eq!(literal_seconds_to_millis("1e2"), None);
    }

    #[test]
    fn preserves_trailing_k6_sleep_in_the_iteration_body() {
        let source = "import http from 'k6/http'; import { sleep } from 'k6'; export default function () { http.get('https://api.example.test/a'); sleep(1); }";
        let analysis = analyze_load_test("paced.js", source, UNIX_EPOCH).unwrap();
        assert!(matches!(&analysis.flow.nodes().last().unwrap().kind,
            FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Timer
                && serde_json::from_str::<serde_json::Value>(&node.config).unwrap()["durationMs"] == 1000
        ));
        assert!(
            analysis
                .flow
                .edges()
                .iter()
                .any(|edge| edge.source_node_id == "request-1"
                    && edge.target_node_id == "timer-1"
                    && edge.source_handle.as_deref() == Some("success"))
        );
    }

    #[test]
    fn rejects_remote_import_without_returning_a_partial_flow() {
        let source = "import http from 'https://example.test/http.js'; export default function () { http.get('https://api.example.test/a'); }";
        assert!(matches!(
            analyze_load_test("smoke.js", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn rejects_multiline_remote_import_at_the_ast_source_span() {
        let source = "import {\n  http\n} from 'https://example.test/http.js';\nexport default function () { http.get('https://api.example.test/a'); }";
        let Err(LoadTestImportError::Incompatible { diagnostics }) =
            analyze_load_test("smoke.ts", source, UNIX_EPOCH)
        else {
            panic!("import remoto deveria ser rejeitado");
        };

        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.line == 3
                && diagnostic.column > 1
                && diagnostic.message == "módulos remotos não são permitidos"
        }));
    }

    #[test]
    fn rejects_jmeter_external_entities() {
        let source = "<!DOCTYPE x [<!ENTITY boom SYSTEM 'file:///etc/passwd'>]><jmeterTestPlan/>";
        assert!(matches!(
            analyze_load_test("test.jmx", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn rejects_jmeter_dtds_and_unknown_entities_without_expanding_them() {
        for source in [
            "<!DOCTYPE jmeterTestPlan><jmeterTestPlan><hashTree><TestPlan/><hashTree/></hashTree></jmeterTestPlan>",
            "<jmeterTestPlan><hashTree><TestPlan><stringProp name='TestPlan.comments'>&unknown;</stringProp></TestPlan><hashTree/></hashTree></jmeterTestPlan>",
            "<jmeterTestPlan><hashTree><TestPlan testname='&unknown;'/><hashTree/></hashTree></jmeterTestPlan>",
        ] {
            assert!(matches!(
                analyze_load_test("entities.jmx", source, UNIX_EPOCH),
                Err(LoadTestImportError::Incompatible { .. })
            ));
        }
    }

    #[test]
    fn rejects_a_jmeter_source_that_exceeds_the_size_limit() {
        let source = format!(
            "<jmeterTestPlan>{}</jmeterTestPlan>",
            " ".repeat(MAX_SOURCE_BYTES)
        );
        assert_eq!(
            analyze_load_test("large.jmx", &source, UNIX_EPOCH).unwrap_err(),
            LoadTestImportError::TooLarge
        );
    }

    #[test]
    fn rejects_a_jmeter_xml_document_that_exceeds_the_depth_limit() {
        let nested = "<hashTree>".repeat(MAX_JMETER_XML_DEPTH);
        let closing = "</hashTree>".repeat(MAX_JMETER_XML_DEPTH);
        let source = format!("<jmeterTestPlan>{nested}{closing}</jmeterTestPlan>");

        assert!(matches!(
            analyze_load_test("deep.jmx", &source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("profundidade"))
        ));
    }

    #[test]
    fn rejects_a_jmeter_xml_document_that_exceeds_the_element_limit() {
        let elements = "<hashTree/>".repeat(MAX_JMETER_XML_NODES);
        let source = format!("<jmeterTestPlan>{elements}</jmeterTestPlan>");

        assert!(matches!(
            analyze_load_test("many-elements.jmx", &source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("elementos"))
        ));
    }

    #[test]
    fn imports_a_real_jmeter_tree_in_source_order_with_disabled_subtrees_excluded() {
        let source = include_str!("../tests/fixtures/load/finite-http.jmx");
        let analysis = analyze_load_test("finite-http.jmx", source, UNIX_EPOCH).unwrap();
        assert_eq!(
            analysis
                .requests
                .iter()
                .map(|request| (request.method.as_str(), request.url.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("GET", "https://catalog.example.test/items"),
                ("POST", "https://catalog.example.test/items/body"),
                ("GET", "https://checkout.example.test/cart"),
            ]
        );
        assert_eq!(analysis.requests[0].body, None);
        assert_eq!(
            analysis.requests[1].body.as_deref(),
            Some(r#"{"name":"coffee"}"#)
        );
        assert_eq!(analysis.requests[2].body, None);

        let scenarios = analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|node| match &node.kind {
                FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Scenario => {
                    Some(serde_json::from_str::<serde_json::Value>(&node.config).unwrap())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(scenarios.len(), 2);
        assert_eq!(scenarios[0]["name"], "Catalog");
        assert_eq!(scenarios[0]["vus"], 2);
        assert_eq!(scenarios[0]["iterationsPerVu"], 3);
        assert_eq!(scenarios[1]["name"], "Checkout");
        assert_eq!(scenarios[1]["vus"], 1);
        assert_eq!(scenarios[1]["iterationsPerVu"], 2);
        assert!(analysis.flow.edges().iter().any(|edge| {
            edge.source_node_id == "scenario-1-request-1"
                && edge.target_node_id == "scenario-1-request-2"
        }));
        assert!(!analysis.flow.edges().iter().any(|edge| {
            edge.source_node_id.starts_with("scenario-1-request-")
                && edge.target_node_id.starts_with("scenario-2-request-")
        }));
    }

    #[test]
    fn rejects_missing_or_orphan_jmeter_hash_trees_and_nested_declarations() {
        for tree in [
            "<ThreadGroup/>",
            "<hashTree/>",
            "<ThreadGroup/><hashTree/><hashTree/>",
            "<ThreadGroup/><HTTPSamplerProxy/><hashTree/>",
            "<ThreadGroup><HTTPSamplerProxy/></ThreadGroup><hashTree/>",
            "<ThreadGroup/><hashTree><HTTPSamplerProxy/></hashTree>",
            "<ThreadGroup/><hashTree><HTTPSamplerProxy/><HTTPSamplerProxy/><hashTree/></hashTree>",
            "<ThreadGroup/><hashTree><HTTPSamplerProxy><HTTPSamplerProxy/></HTTPSamplerProxy><hashTree/></hashTree>",
        ] {
            let source = format!(
                "<jmeterTestPlan><hashTree><TestPlan/><hashTree>{tree}</hashTree></hashTree></jmeterTestPlan>"
            );
            assert!(
                matches!(
                    analyze_load_test("malformed.jmx", &source, UNIX_EPOCH),
                    Err(LoadTestImportError::Incompatible { .. })
                ),
                "malformed JMeter tree was accepted: {tree}"
            );
        }
    }

    #[test]
    fn rejects_active_unsupported_jmeter_elements_with_source_locations() {
        for element in [
            "<JSR223Sampler/>",
            "<ConstantTimer/>",
            "<LoopController/>",
            "<HeaderManager/>",
        ] {
            let source = format!(
                "<jmeterTestPlan><hashTree><TestPlan/><hashTree><ThreadGroup/><hashTree>\n  {element}<hashTree/>\n</hashTree></hashTree></hashTree></jmeterTestPlan>"
            );
            let Err(LoadTestImportError::Incompatible { diagnostics }) =
                analyze_load_test("unsupported.jmx", &source, UNIX_EPOCH)
            else {
                panic!("unsupported JMeter element was accepted: {element}");
            };
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| { diagnostic.line == 2 && diagnostic.column > 1 })
            );
        }
    }

    #[test]
    fn ignores_the_entire_hash_tree_of_a_disabled_jmeter_sampler() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree>
              <ThreadGroup testname="Smoke">
                <stringProp name="ThreadGroup.num_threads">1</stringProp>
              </ThreadGroup><hashTree>
                <HTTPSamplerProxy testname="Disabled" enabled="false">
                  <stringProp name="HTTPSampler.domain">excluded.example.test</stringProp>
                </HTTPSamplerProxy><hashTree>
                  <JSR223Sampler enabled="true"/><hashTree/>
                </hashTree>
                <HTTPSamplerProxy testname="Active">
                  <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                </HTTPSamplerProxy><hashTree/>
              </hashTree>
            </hashTree></hashTree></jmeterTestPlan>
        "#;
        let analysis = analyze_load_test("disabled-child.jmx", source, UNIX_EPOCH).unwrap();
        assert_eq!(analysis.requests.len(), 1);
        assert!(
            analysis
                .requests
                .iter()
                .all(|request| !request.url.contains("excluded"))
        );
    }

    #[test]
    fn imports_a_jmeter_http_sampler_from_its_own_xml_scope() {
        let source = r#"
            <jmeterTestPlan>
              <hashTree>
                <TestPlan testname="Smoke plan"/><hashTree>
                <ThreadGroup testname="Smoke">
                  <stringProp name="ThreadGroup.num_threads">2</stringProp>
                  <stringProp name="ThreadGroup.ramp_time">0</stringProp>
                  <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
                    <intProp name="LoopController.loops">2</intProp>
                  </elementProp>
                </ThreadGroup><hashTree>
                  <HTTPSamplerProxy testname="Get health">
                    <stringProp name="HTTPSampler.protocol">https</stringProp>
                    <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                    <stringProp name="HTTPSampler.path">health</stringProp>
                    <stringProp name="HTTPSampler.method">GET</stringProp>
                    <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
                  </HTTPSamplerProxy><hashTree/>
                </hashTree></hashTree>
              </hashTree>
            </jmeterTestPlan>
        "#;

        let analysis = analyze_load_test("smoke.jmx", source, UNIX_EPOCH).unwrap();
        assert_eq!(analysis.format, LoadImportFormat::Jmeter);
        assert_eq!(analysis.requests.len(), 1);
        assert_eq!(analysis.requests[0].url, "https://api.example.test/health");
        assert!(
            analysis.requests[0]
                .source_properties
                .iter()
                .any(|(name, value)| name == "HTTPSampler.follow_redirects" && value == "true")
        );
        let FlowNodeKind::Load { node } = &analysis.flow.nodes()[1].kind else {
            panic!("second node should be a scenario");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
            json!({
                "sourceFormat": "jmeter",
                "executor": "perVuIterations",
                "name": "Smoke",
                "vus": 2,
                "iterationsPerVu": 2,
                "sourceProperties": {
                    "ThreadGroup.num_threads": "2",
                    "ThreadGroup.ramp_time": "0",
                    "LoopController.loops": "2",
                },
            })
        );
    }

    #[test]
    fn imports_jmeter_head_and_options_http_samplers() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
            </ThreadGroup><hashTree>
              <HTTPSamplerProxy testname="health">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <stringProp name="HTTPSampler.method">HEAD</stringProp>
              </HTTPSamplerProxy><hashTree/>
              <HTTPSamplerProxy testname="cors">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <stringProp name="HTTPSampler.method">OPTIONS</stringProp>
              </HTTPSamplerProxy><hashTree/>
            </hashTree></hashTree></hashTree></jmeterTestPlan>
        "#;

        let analysis = analyze_load_test("methods.jmx", source, UNIX_EPOCH).unwrap();
        assert_eq!(
            analysis
                .requests
                .iter()
                .map(|request| request.method.as_str())
                .collect::<Vec<_>>(),
            vec!["HEAD", "OPTIONS"]
        );
    }

    #[test]
    fn imports_a_jmeter_raw_http_body_without_reencoding_it() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree><ThreadGroup testname="Create">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
            </ThreadGroup><hashTree>
              <HTTPSamplerProxy testname="create">
                <stringProp name="HTTPSampler.protocol">https</stringProp>
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <stringProp name="HTTPSampler.path">items</stringProp>
                <stringProp name="HTTPSampler.method">POST</stringProp>
                <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
                <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
                  <collectionProp name="Arguments.arguments">
                    <elementProp name="" elementType="HTTPArgument">
                      <stringProp name="Argument.value">{&quot;name&quot;:&quot;coffee&quot;}</stringProp>
                    </elementProp>
                  </collectionProp>
                </elementProp>
              </HTTPSamplerProxy><hashTree/>
            </hashTree></hashTree></hashTree></jmeterTestPlan>
        "#;

        let analysis = analyze_load_test("raw-body.jmx", source, UNIX_EPOCH).unwrap();
        assert_eq!(
            analysis.requests[0].body.as_deref(),
            Some(r#"{"name":"coffee"}"#)
        );
        let request = analysis
            .flow
            .nodes()
            .iter()
            .find_map(|flow_node| match &flow_node.kind {
                FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Request => {
                    Some(serde_json::from_str::<serde_json::Value>(&node.config).unwrap())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(request["body"], r#"{"name":"coffee"}"#);
    }

    #[test]
    fn preserves_raw_jmeter_body_whitespace_cdata_and_xml_character_references() {
        let source = include_str!("../tests/fixtures/load/finite-http.jmx");
        for (encoded, expected) in [
            (
                "  &lt;item&gt;&amp;&#xE9;&#10;&lt;/item&gt;  ",
                "  <item>&é\n</item>  ",
            ),
            (
                "<![CDATA[ \n <item>&literal;</item>\t ]]>",
                " \n <item>&literal;</item>\t ",
            ),
            (
                "first\r\nsecond\rthird&#13;fourth",
                "first\nsecond\nthird\rfourth",
            ),
            ("<![CDATA[first\r\nsecond\rthird]]>", "first\nsecond\nthird"),
        ] {
            let source = source.replace("{&quot;name&quot;:&quot;coffee&quot;}", encoded);
            let analysis = analyze_load_test("raw-whitespace.jmx", &source, UNIX_EPOCH).unwrap();
            assert_eq!(analysis.requests[1].body.as_deref(), Some(expected));
        }
    }

    #[test]
    fn rejects_jmeter_test_plan_modes_that_change_execution_semantics() {
        let source = include_str!("../tests/fixtures/load/finite-http.jmx");
        for name in [
            "TestPlan.serialize_threadgroups",
            "TestPlan.functional_mode",
        ] {
            let source = source.replace(
                &format!("<boolProp name=\"{name}\">false</boolProp>"),
                &format!("<boolProp name=\"{name}\">true</boolProp>"),
            );
            let Err(LoadTestImportError::Incompatible { diagnostics }) =
                analyze_load_test("test-plan-mode.jmx", &source, UNIX_EPOCH)
            else {
                panic!("unsupported TestPlan mode was accepted: {name}");
            };
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.message.contains(name))
            );
        }
    }

    #[test]
    fn rejects_malformed_or_untranslated_jmeter_scheduling_properties() {
        let fixture = include_str!("../tests/fixtures/load/finite-http.jmx");
        for (name, value, expected_diagnostic) in [
            ("ThreadGroup.scheduler", "", "ThreadGroup.scheduler"),
            ("ThreadGroup.scheduler", "1", "ThreadGroup.scheduler"),
            (
                "LoopController.continue_forever",
                "maybe",
                "LoopController.continue_forever",
            ),
            ("ThreadGroup.ramp_time", "-1", "ThreadGroup.ramp_time"),
            ("ThreadGroup.ramp_time", "abc", "ThreadGroup.ramp_time"),
            ("ThreadGroup.duration", "1.5", "ThreadGroup.duration"),
            (
                "ThreadGroup.delay",
                "18446744073709551616",
                "ThreadGroup.delay",
            ),
            (
                "ThreadGroup.on_sample_error",
                "stopthread",
                "política de erro",
            ),
            (
                "ThreadGroup.on_sample_error",
                "stoptest",
                "política de erro",
            ),
        ] {
            let source = fixture
                .lines()
                .filter(|line| !line.contains(&format!("name=\"{name}\"")))
                .collect::<Vec<_>>()
                .join("\n")
                .replacen(
                    "<stringProp name=\"ThreadGroup.num_threads\">2</stringProp>",
                    &format!("<stringProp name=\"ThreadGroup.num_threads\">2</stringProp><stringProp name=\"{name}\">{value}</stringProp>"),
                    1,
                );
            let Err(LoadTestImportError::Incompatible { diagnostics }) =
                analyze_load_test("invalid-scheduling.jmx", &source, UNIX_EPOCH)
            else {
                panic!("unsupported scheduling property was accepted: {name}={value}");
            };
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.message.contains(expected_diagnostic)),
                "missing scheduling diagnostic for {name}={value}: {diagnostics:?}"
            );
        }
    }

    #[test]
    fn imports_multiple_finite_jmeter_thread_groups_as_independent_scenarios() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree>
              <ThreadGroup testname="Catalog">
                <stringProp name="ThreadGroup.num_threads">2</stringProp>
                <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
                  <intProp name="LoopController.loops">3</intProp>
                </elementProp>
              </ThreadGroup><hashTree>
                <HTTPSamplerProxy testname="list">
                  <stringProp name="HTTPSampler.protocol">https</stringProp>
                  <stringProp name="HTTPSampler.domain">catalog.example.test</stringProp>
                  <stringProp name="HTTPSampler.path">items</stringProp>
                </HTTPSamplerProxy><hashTree/>
              </hashTree>
              <ThreadGroup testname="Checkout">
                <stringProp name="ThreadGroup.num_threads">1</stringProp>
                <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
                  <intProp name="LoopController.loops">2</intProp>
                </elementProp>
              </ThreadGroup><hashTree>
                <HTTPSamplerProxy testname="cart">
                  <stringProp name="HTTPSampler.protocol">https</stringProp>
                  <stringProp name="HTTPSampler.domain">checkout.example.test</stringProp>
                  <stringProp name="HTTPSampler.path">cart</stringProp>
                </HTTPSamplerProxy><hashTree/>
              </hashTree>
            </hashTree></hashTree></jmeterTestPlan>
        "#;

        let analysis = analyze_load_test("multiple.jmx", source, UNIX_EPOCH).unwrap();
        assert_eq!(analysis.requests.len(), 2);
        assert_eq!(
            analysis
                .flow
                .nodes()
                .iter()
                .filter(|node| {
                    matches!(&node.kind, FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Scenario)
                })
                .count(),
            2
        );
        assert!(
            analysis
                .flow
                .edges()
                .iter()
                .any(|edge| edge.source_node_id == "scenario-1"
                    && edge.target_node_id == "scenario-1-request-1")
        );
        assert!(
            analysis
                .flow
                .edges()
                .iter()
                .any(|edge| edge.source_node_id == "scenario-2"
                    && edge.target_node_id == "scenario-2-request-1")
        );
    }

    #[test]
    fn rejects_jmeter_ramp_up_without_returning_a_partial_flow() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">2</stringProp>
              <stringProp name="ThreadGroup.ramp_time">1</stringProp>
            </ThreadGroup><hashTree>
              <HTTPSamplerProxy testname="request">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
              </HTTPSamplerProxy><hashTree/>
            </hashTree></hashTree></hashTree></jmeterTestPlan>
        "#;

        assert!(matches!(
            analyze_load_test("ramp.jmx", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("ramp-up"))
        ));
    }

    #[test]
    fn rejects_unsupported_jmeter_test_elements_without_partial_import() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree>
              <ThreadGroup testname="Smoke"/><hashTree>
                <HeaderManager testclass="HeaderManager" testname="headers"/><hashTree/>
              </hashTree>
            </hashTree></hashTree></jmeterTestPlan>
        "#;
        assert!(matches!(
            analyze_load_test("smoke.jmx", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn rejects_jmeter_encoded_arguments_without_a_partial_import() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
            </ThreadGroup><hashTree>
              <HTTPSamplerProxy testname="request">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <elementProp name="argument" elementType="HTTPArgument">
                  <stringProp name="Argument.value">payload</stringProp>
                </elementProp>
              </HTTPSamplerProxy><hashTree/>
            </hashTree></hashTree></hashTree></jmeterTestPlan>
        "#;
        assert!(matches!(
            analyze_load_test("smoke.jmx", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("postBodyRaw"))
        ));
    }

    #[test]
    fn rejects_multiple_jmeter_raw_body_arguments_without_a_partial_import() {
        let source = r#"
            <jmeterTestPlan><hashTree><TestPlan/><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
            </ThreadGroup><hashTree>
              <HTTPSamplerProxy testname="request">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
                <elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments">
                  <elementProp name="one" elementType="HTTPArgument"><stringProp name="Argument.value">first</stringProp></elementProp>
                  <elementProp name="two" elementType="HTTPArgument"><stringProp name="Argument.value">second</stringProp></elementProp>
                </collectionProp></elementProp>
              </HTTPSamplerProxy><hashTree/>
            </hashTree></hashTree></hashTree></jmeterTestPlan>
        "#;

        assert!(matches!(
            analyze_load_test("multiple-arguments.jmx", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("exatamente um HTTPArgument"))
        ));
    }
}
