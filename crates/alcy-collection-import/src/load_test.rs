//! Leitura estrita de fontes de carga antes de qualquer persistência.
//!
//! Esta camada só produz o modelo canônico de flow. Ela não abre conexões,
//! não executa JavaScript e não grava assets: erros são acumulados e devolvidos
//! ao chamador para que o commit seja atômico.

use std::collections::{BTreeMap, HashMap};
use std::time::SystemTime;

use alcy_domain::{
    Flow, FlowEdge, FlowExecutionKind, FlowNode, FlowNodeKind, FlowPosition, LoadNode, LoadNodeKind,
};
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use serde_json::json;
use thiserror::Error;

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
    /// Propriedades HTTP de origem preservadas para execução posterior. O
    /// importador não as descarta quando ainda não há bloco nativo para uma
    /// delas.
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

/// Analisa conteúdo em memória. A detecção não depende de extensão: `.js` e
/// `.ts` podem ser k6; XML com `jmeterTestPlan` é JMeter. Nenhuma conversão
/// parcial é retornada quando há uma incompatibilidade.
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
    let imports = parse_k6_syntax(name, source)?;
    let mut diagnostics = forbidden_k6_constructs(source, &imports);
    let requests = parse_k6_requests(source, &mut diagnostics);
    let timers = parse_k6_timers(source, &mut diagnostics);
    let checks = parse_k6_checks(source, &requests, &timers, &mut diagnostics);
    let metrics = parse_k6_metrics(source, &requests, &timers, &mut diagnostics);
    let scenarios = parse_k6_scenario_options(source, &mut diagnostics);
    let thresholds = parse_k6_thresholds(source, &mut diagnostics);
    if requests.len() > MAX_REQUESTS {
        diagnostics.push(diag(
            source,
            0,
            format!("mais de {MAX_REQUESTS} requisições estáticas"),
        ));
    }
    if requests.is_empty() && diagnostics.is_empty() {
        diagnostics.push(diag(
            source,
            0,
            "nenhuma chamada HTTP estática do k6 foi encontrada",
        ));
    }
    if timers.last().is_some_and(|timer| {
        requests
            .last()
            .is_none_or(|request| timer.offset > request.offset)
    }) {
        diagnostics.push(diag(
            source,
            timers.last().map_or(0, |timer| timer.offset),
            "sleep após a última request ainda não é representável sem alterar o pacing da iteração",
        ));
    }
    if !diagnostics.is_empty() {
        return Err(LoadTestImportError::Incompatible { diagnostics });
    }
    let imported_requests = requests
        .iter()
        .map(|request| request.request.clone())
        .collect::<Vec<_>>();
    Ok(LoadImportAnalysis {
        format: LoadImportFormat::K6,
        flow: build_k6_flow(
            &requests,
            &timers,
            &checks,
            &metrics,
            scenarios,
            &thresholds,
            now,
        )?,
        requests: imported_requests,
        assets: vec!["source".to_string()],
    })
}

fn default_k6_scenario_config() -> serde_json::Value {
    json!({
        "sourceFormat": "k6",
        "executor": "sharedIterations",
        "vus": 1,
        "iterations": 1,
    })
}

/// Valida a gramática do arquivo antes de aplicar o lowering estático. O AST
/// ainda não é executado nem avaliado: a etapa seguinte continua aceitando
/// apenas expressões que possam ser representadas sem ambiguidade no flow.
///
/// `SourceType` deriva a sintaxe de TypeScript da extensão. Quando a análise
/// acontece pelo conteúdo sem uma extensão conhecida, assumimos um módulo
/// JavaScript, que é o formato de entrada padrão do k6.
#[derive(Debug, Clone)]
struct K6StaticImport {
    specifier: String,
    offset: usize,
}

fn parse_k6_syntax(name: &str, source: &str) -> Result<Vec<K6StaticImport>, LoadTestImportError> {
    let source_type =
        SourceType::from_path(name.to_ascii_lowercase()).unwrap_or_else(|_| SourceType::mjs());
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    let imports = parsed
        .program
        .body
        .iter()
        .filter_map(|statement| statement.as_module_declaration())
        .filter(|declaration| declaration.is_import())
        .filter_map(|declaration| declaration.source())
        .map(|source| K6StaticImport {
            specifier: source.value.to_string(),
            offset: source.span.start as usize,
        })
        .collect::<Vec<_>>();
    let mut diagnostics = parsed
        .errors
        .into_iter()
        .map(|error| {
            let offset = error
                .labels
                .as_ref()
                .and_then(|labels| labels.first())
                .map_or(0, |label| label.offset());
            diag(
                source,
                offset,
                format!("sintaxe JavaScript/TypeScript inválida: {error}"),
            )
        })
        .collect::<Vec<_>>();
    if parsed.panicked {
        diagnostics.push(diag(
            source,
            0,
            "o parser JavaScript/TypeScript não conseguiu recuperar a análise",
        ));
    }
    if diagnostics.is_empty() {
        Ok(imports)
    } else {
        Err(LoadTestImportError::Incompatible { diagnostics })
    }
}

#[derive(Debug, Clone)]
struct K6Scenario {
    name: String,
    config: serde_json::Value,
}

fn default_k6_scenarios() -> Vec<K6Scenario> {
    vec![K6Scenario {
        name: "default".to_string(),
        config: default_k6_scenario_config(),
    }]
}

/// Aceita uma matriz deliberadamente estática de `options`: os executores
/// padrão e cenários nomeados. Todos os cenários aceitos usam a função padrão;
/// objetos dinâmicos e `exec` que aponta para outra função continuam
/// incompatíveis até que cada função possa virar uma lane independente.
fn parse_k6_scenario_options(
    source: &str,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Scenario> {
    let Some(offset) = find_code(source, "export const options") else {
        if let Some(offset) = find_code(source, "options =") {
            diagnostics.push(diag(
                source,
                offset,
                "options do k6 precisa ser export const estático",
            ));
        }
        return default_k6_scenarios();
    };
    let Some(after_export) = source.get(offset + "export const options".len()..) else {
        diagnostics.push(diag(source, offset, "options do k6 está incompleto"));
        return default_k6_scenarios();
    };
    let Some(after_equal) = after_export.trim_start().strip_prefix('=') else {
        diagnostics.push(diag(source, offset, "options do k6 precisa usar '='"));
        return default_k6_scenarios();
    };
    let Some(object_start) = after_equal.find('{') else {
        diagnostics.push(diag(source, offset, "options do k6 precisa ser um objeto"));
        return default_k6_scenarios();
    };
    let object_offset = source.len() - after_equal.len() + object_start;
    let Some((object, _)) = nested_js_object(source, object_offset) else {
        diagnostics.push(diag(
            source,
            object_offset,
            "options do k6 tem objeto inválido",
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
        }],
        (Some(vus), None, Some(duration_ms), None) => vec![K6Scenario {
            name: "default".to_string(),
            config: json!({
                "sourceFormat": "k6",
                "executor": "constantVus",
                "vus": vus,
                "durationMs": duration_ms,
            }),
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
    let Some((scenarios, _)) = nested_js_object(scenarios_value, 0) else {
        diagnostics.push(diag(
            source,
            offset,
            "options.scenarios precisa ser um objeto",
        ));
        return default_k6_scenarios();
    };
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
        let Some(config) =
            parse_k6_named_scenario_config(scenario_value, source, offset, diagnostics)
        else {
            continue;
        };
        imported.push(K6Scenario {
            name: name.to_string(),
            config,
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
) -> Option<serde_json::Value> {
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
    if let Some(exec) = field("exec")
        && js_string_literal(exec) != Some("default")
    {
        diagnostics.push(diag(
            source,
            offset,
            "exec do cenário k6 precisa usar a função default nesta etapa",
        ));
        return None;
    }
    let executor = field("executor").and_then(js_string_literal);
    let allows = |allowed: &[&str]| {
        fields
            .iter()
            .all(|(key, _)| *key == "exec" || allowed.contains(key))
    };
    match executor {
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
            Some(json!({
                "sourceFormat": "k6",
                "executor": "perVuIterations",
                "vus": vus,
                "iterationsPerVu": iterations,
                "maxDurationMs": max_duration,
            }))
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
            Some(json!({
                "sourceFormat": "k6",
                "executor": "constantArrivalRate",
                "rate": rate,
                "timeUnitMs": time_unit,
                "durationMs": duration,
                "preAllocatedVus": pre_allocated_vus,
                "maxVus": max_vus,
            }))
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
            Some(json!({
                "sourceFormat": "k6",
                "executor": "rampingVus",
                "startVus": start_vus,
                "stages": stages,
                "gracefulRampDownMs": graceful_ramp_down,
            }))
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
            Some(json!({
                "sourceFormat": "k6",
                "executor": "rampingArrivalRate",
                "startRate": start_rate,
                "timeUnitMs": time_unit,
                "stages": stages,
                "preAllocatedVus": pre_allocated_vus,
                "maxVus": max_vus,
            }))
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

/// Traduz a forma declarativa de `options.thresholds`. Cada expressão vira um
/// bloco Threshold independente, porque o runtime avalia todas ao término da
/// execução, sem transportar amostras individuais pelo IPC.
fn parse_k6_thresholds(
    source: &str,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Threshold> {
    let Some(offset) = find_code(source, "export const options") else {
        return Vec::new();
    };
    let Some(after_export) = source.get(offset + "export const options".len()..) else {
        return Vec::new();
    };
    let Some(after_equal) = after_export.trim_start().strip_prefix('=') else {
        return Vec::new();
    };
    let Some(object_start) = after_equal.find('{') else {
        return Vec::new();
    };
    let object_offset = source.len() - after_equal.len() + object_start;
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
    requests: &[K6Request],
    timers: &[K6Timer],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Metric> {
    let definitions = parse_k6_metric_definitions(source, diagnostics);
    let mut metrics = Vec::new();
    for definition in definitions {
        let needle = format!("{}.add(", definition.variable);
        let mut start = 0;
        while let Some(relative) = find_code(&source[start..], &needle) {
            let offset = start + relative;
            let argument_offset = offset + needle.len();
            let Some((value, tags)) = parse_k6_metric_add(source, argument_offset, definition.kind)
            else {
                diagnostics.push(diag(
                    source,
                    offset,
                    "metric.add do k6 exige valor e tags literais",
                ));
                start = argument_offset;
                continue;
            };
            let request = requests
                .iter()
                .rev()
                .find(|request| request.offset < offset);
            if request.is_none()
                || request.is_some_and(|request| {
                    timers
                        .iter()
                        .any(|timer| timer.offset > request.offset && timer.offset < offset)
                })
            {
                diagnostics.push(diag(
                    source,
                    offset,
                    "metric.add precisa seguir uma request sem sleep intermediário",
                ));
            } else {
                metrics.push(K6Metric {
                    offset,
                    name: definition.name.clone(),
                    kind: definition.kind,
                    value,
                    tags,
                });
            }
            start = argument_offset;
        }
    }
    metrics.sort_by_key(|metric| metric.offset);
    metrics
}

fn parse_k6_metric_definitions(
    source: &str,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6MetricDefinition> {
    let kinds = [
        ("Counter", "counter"),
        ("Gauge", "gauge"),
        ("Rate", "rate"),
        ("Trend", "trend"),
    ];
    let mut definitions = Vec::new();
    for (constructor, kind) in kinds {
        let needle = format!("new {constructor}(");
        let mut start = 0;
        while let Some(relative) = find_code(&source[start..], &needle) {
            let offset = start + relative;
            let variable = response_name_before_call(source, offset);
            let name_offset = offset + needle.len();
            let parsed = parse_js_string(source, name_offset).and_then(|(name, after_name)| {
                source
                    .get(after_name..)?
                    .trim_start()
                    .starts_with(')')
                    .then_some(name)
            });
            match variable.zip(parsed) {
                Some((variable, name))
                    if !definitions
                        .iter()
                        .any(|definition: &K6MetricDefinition| definition.variable == variable) =>
                {
                    definitions.push(K6MetricDefinition {
                        variable,
                        name,
                        kind,
                    });
                }
                _ => diagnostics.push(diag(
                    source,
                    offset,
                    "métrica k6 precisa usar const/let/var, nome literal e construtor sem opções",
                )),
            }
            start = name_offset;
        }
    }
    definitions
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

/// Converte os estágios literais dos executores ramping. O parser deliberadamente
/// aceita somente a forma declarativa do k6, para que uma expressão JavaScript
/// não seja confundida com uma carga equivalente.
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

fn parse_k6_requests(source: &str, diagnostics: &mut Vec<LoadImportDiagnostic>) -> Vec<K6Request> {
    let mut requests = Vec::new();
    let methods = [
        ("http.get(", "GET"),
        ("http.post(", "POST"),
        ("http.put(", "PUT"),
        ("http.patch(", "PATCH"),
        ("http.del(", "DELETE"),
        ("http.head(", "HEAD"),
        ("http.options(", "OPTIONS"),
    ];
    for (needle, method) in methods {
        let mut start = 0;
        while let Some(relative) = find_code(&source[start..], needle) {
            let call_offset = start + relative;
            let offset = call_offset + needle.len();
            match parse_k6_call(source, offset, method, diagnostics) {
                Some((url, body, options)) => requests.push(K6Request {
                    request: LoadImportRequest {
                        method: method.to_string(),
                        url,
                        body,
                        source_properties: Vec::new(),
                        line: line_at(source, offset),
                    },
                    offset,
                    response_name: response_name_before_call(source, call_offset),
                    options,
                }),
                None => diagnostics.push(diag(
                    source,
                    offset,
                    "a URL da requisição k6 precisa ser uma string literal",
                )),
            }
            start = offset;
        }
    }
    let mut start = 0;
    while let Some(relative) = find_code(&source[start..], "http.request(") {
        let call_offset = start + relative;
        let offset = call_offset + "http.request(".len();
        match parse_k6_generic_request(source, offset, diagnostics) {
            Some((method, url, body, options)) => requests.push(K6Request {
                request: LoadImportRequest {
                    method,
                    url,
                    body,
                    source_properties: Vec::new(),
                    line: line_at(source, offset),
                },
                offset,
                response_name: response_name_before_call(source, call_offset),
                options,
            }),
            None => diagnostics.push(diag(
                source,
                offset,
                "http.request exige método, URL, corpo e opções estáticos compatíveis",
            )),
        }
        start = offset;
    }
    requests.sort_by_key(|request| request.offset);
    requests
}

/// Traduz `sleep(<segundos literais>)` para o Timer fixo do runtime. Só aceita
/// duração conversível exatamente para milissegundos, pois arredondar alteraria
/// a cadência observável do teste importado.
fn parse_k6_timers(source: &str, diagnostics: &mut Vec<LoadImportDiagnostic>) -> Vec<K6Timer> {
    let mut timers = Vec::new();
    let mut start = 0;
    while let Some(relative) = find_code(&source[start..], "sleep(") {
        let offset = start + relative;
        let argument_offset = offset + "sleep(".len();
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
            start = argument_offset;
            continue;
        };
        let Some(after_argument) = trimmed.get(length..) else {
            diagnostics.push(diag(source, number_offset, "sleep tem sintaxe inválida"));
            start = argument_offset;
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
        start = argument_offset;
    }
    timers
}

/// Converte segundos decimais sem usar ponto flutuante. Aceita precisão maior
/// que milissegundo somente se os dígitos extras forem zero; qualquer outra
/// precisão exigiria arredondamento e mudaria a cadência importada.
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

/// Nome da resposta na forma simples `const response = http.get(...)`. O
/// importador não tenta inferir aliases, reatribuições ou escopo dinâmico.
fn response_name_before_call(source: &str, call_offset: usize) -> Option<String> {
    let before_call = source.get(..call_offset)?;
    let statement_start = before_call
        .rfind([';', '{', '}'])
        .map(|offset| offset + 1)
        .unwrap_or(0);
    let assignment = before_call.get(statement_start..)?.trim();
    let (declaration, value) = assignment.split_once('=')?;
    if !value.trim().is_empty() {
        return None;
    }
    let mut parts = declaration.split_whitespace();
    let keyword = parts.next()?;
    let name = parts.next()?;
    if !matches!(keyword, "const" | "let" | "var")
        || parts.next().is_some()
        || !is_js_identifier(name)
    {
        return None;
    }
    Some(name.to_string())
}

fn is_js_identifier(value: &str) -> bool {
    let mut characters = value.bytes();
    matches!(characters.next(), Some(byte) if byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$')
        && characters.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
}

/// Aceita somente a forma canônica e sem lógica arbitrária:
/// `check(response, { 'nome': (r) => r.status === 200 })`.
fn parse_k6_checks(
    source: &str,
    requests: &[K6Request],
    timers: &[K6Timer],
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) -> Vec<K6Check> {
    let mut checks = Vec::new();
    let mut start = 0;
    while let Some(relative) = find_code(&source[start..], "check(") {
        let offset = start + relative;
        match parse_k6_status_check(source, offset) {
            Some((response_name, name, expected_status)) => {
                let request = requests
                    .iter()
                    .rev()
                    .find(|request| request.offset < offset);
                let valid_request = request.is_some_and(|request| {
                    request.response_name.as_deref() == Some(response_name.as_str())
                        && !timers
                            .iter()
                            .any(|timer| timer.offset > request.offset && timer.offset < offset)
                });
                if valid_request {
                    checks.push(K6Check {
                        offset,
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
        start = offset + "check(".len();
    }
    checks
}

fn parse_k6_status_check(source: &str, offset: usize) -> Option<(String, String, u16)> {
    let after_open = source.get(offset + "check(".len()..)?.trim_start();
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

/// Lê apenas a forma linear que o importador consegue preservar sem executar
/// JavaScript: URL literal e, para métodos com corpo, um corpo literal. Opções
/// de request (headers, tags, redirects etc.) aguardam o parser AST; rejeitá-
/// las aqui evita uma conversão parcialmente silenciosa.
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

    let body_offset = after_url + remaining.find(',')? + 1;
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

/// O executor `perVuIterations` preserva um Thread Group fechado quando cada
/// thread executa uma quantidade finita de laços sem ramp-up ou scheduler.
/// As outras combinações requerem um scheduler próprio de JMeter para não
/// alterar o instante de início das threads ou transformar uma carga limitada
/// em duração fixa.
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

/// Mantém a ordem linear entre requests e pausas do script de origem. O
/// `Timer` é ligado à request seguinte, que é a semântica canônica do runtime
/// para uma pausa entre duas requests na mesma iteração.
fn build_k6_flow(
    requests: &[K6Request],
    timers: &[K6Timer],
    checks: &[K6Check],
    metrics: &[K6Metric],
    scenarios: Vec<K6Scenario>,
    thresholds: &[K6Threshold],
    now: SystemTime,
) -> Result<Flow, LoadTestImportError> {
    enum Step<'a> {
        Request(&'a K6Request),
        Timer(&'a K6Timer),
        Check(&'a K6Check),
        Metric(&'a K6Metric),
    }

    let mut steps = requests
        .iter()
        .map(Step::Request)
        .chain(timers.iter().map(Step::Timer))
        .chain(checks.iter().map(Step::Check))
        .chain(metrics.iter().map(Step::Metric))
        .collect::<Vec<_>>();
    steps.sort_by_key(|step| match step {
        Step::Request(request) => request.offset,
        Step::Timer(timer) => timer.offset,
        Step::Check(check) => check.offset,
        Step::Metric(metric) => metric.offset,
    });

    let mut nodes = vec![FlowNode {
        id: "start".to_string(),
        kind: FlowNodeKind::Start,
        position: FlowPosition { x: 0.0, y: 0.0 },
    }];
    let mut edges = Vec::new();
    for (index, scenario) in scenarios.iter().enumerate() {
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
    }
    let mut previous: Option<String> = None;
    let mut previous_handle = None;
    let mut request_index = 0;
    let mut timer_index = 0;
    let mut check_index = 0;
    let mut metric_index = 0;

    for (position, step) in steps.into_iter().enumerate() {
        let (id, kind, label, config) = match step {
            Step::Request(request) => {
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
                    format!("request-{request_index}"),
                    LoadNodeKind::Request,
                    format!("{} {}", request.request.method, request.request.url),
                    config,
                )
            }
            Step::Timer(timer) => {
                timer_index += 1;
                (
                    format!("timer-{timer_index}"),
                    LoadNodeKind::Timer,
                    format!("Pausa de {} ms", timer.duration_ms),
                    json!({ "kind": "fixed", "durationMs": timer.duration_ms }),
                )
            }
            Step::Check(check) => {
                check_index += 1;
                (
                    format!("check-{check_index}"),
                    LoadNodeKind::Check,
                    check.name.clone(),
                    json!({ "name": check.name, "status": check.expected_status }),
                )
            }
            Step::Metric(metric) => {
                metric_index += 1;
                (
                    format!("metric-{metric_index}"),
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
            0.0,
        ));
        if let Some(previous) = previous {
            edges.push(edge(
                &format!("edge-{}", position + 1),
                &previous,
                &id,
                previous_handle,
            ));
        } else {
            for index in 0..scenarios.len() {
                edges.push(edge(
                    &format!("scenario-{}-body", index + 1),
                    &format!("scenario-{}", index + 1),
                    &id,
                    Some("iteration"),
                ));
            }
        }
        previous = Some(id);
        previous_handle = next_handle;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JmeterThreadGroupKind {
    Standard,
    Setup,
    Teardown,
}

#[derive(Debug)]
struct JmeterThreadGroup {
    kind: JmeterThreadGroupKind,
    name: String,
    offset: usize,
    properties: HashMap<String, String>,
    samplers: Vec<JmeterHttpSampler>,
}

#[derive(Debug)]
struct JmeterHttpSampler {
    name: String,
    offset: usize,
    properties: HashMap<String, String>,
    arguments: Vec<JmeterHttpArgument>,
}

#[derive(Debug)]
struct JmeterHttpArgument {
    properties: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy)]
enum JmeterPropertyTarget {
    Group(usize),
    Sampler {
        group: usize,
        sampler: usize,
    },
    Argument {
        group: usize,
        sampler: usize,
        argument: usize,
    },
}

#[derive(Debug)]
struct JmeterProperty {
    target: JmeterPropertyTarget,
    name: String,
    value: String,
}

#[derive(Default)]
struct JmeterParseState {
    groups: Vec<JmeterThreadGroup>,
    active_group: Option<usize>,
    active_sampler: Option<usize>,
    active_argument: Option<usize>,
    active_property: Option<JmeterProperty>,
    xml_depth: usize,
    xml_nodes: usize,
    diagnostics: Vec<LoadImportDiagnostic>,
}

impl JmeterParseState {
    fn enter_xml_element(&mut self, source: &str, offset: usize, increases_depth: bool) -> bool {
        self.xml_nodes = self.xml_nodes.saturating_add(1);
        if self.xml_nodes > MAX_JMETER_XML_NODES {
            self.diagnostics.push(diag(
                source,
                offset,
                format!("XML JMeter excede o limite de {MAX_JMETER_XML_NODES} elementos"),
            ));
            return false;
        }
        if increases_depth {
            self.xml_depth = self.xml_depth.saturating_add(1);
            if self.xml_depth > MAX_JMETER_XML_DEPTH {
                self.diagnostics.push(diag(
                    source,
                    offset,
                    format!("XML JMeter excede o limite de profundidade {MAX_JMETER_XML_DEPTH}"),
                ));
                return false;
            }
        }
        true
    }

    fn leave_xml_element(&mut self) {
        self.xml_depth = self.xml_depth.saturating_sub(1);
    }
}

/// Faz uma única passagem pelo XML. DTD nunca é processado: `DocType` é
/// convertido em diagnóstico antes que qualquer elemento seja interpretado.
/// Os elementos de teste que ainda não têm equivalente no flow são recusados
/// integralmente, em vez de serem ignorados.
fn parse_jmeter(source: &str) -> Result<Vec<JmeterThreadGroup>, LoadTestImportError> {
    let mut reader = Reader::from_reader(source.as_bytes());
    reader.config_mut().trim_text(false);

    let mut buffer = Vec::new();
    let mut state = JmeterParseState::default();

    loop {
        let offset = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => state.diagnostics.push(diag(
                source,
                offset,
                "DTD e entidades XML externas não são permitidas",
            )),
            Ok(Event::Start(element)) => {
                if !state.enter_xml_element(source, offset, true) {
                    break;
                }
                handle_jmeter_start(source, offset, &element, &mut state);
            }
            Ok(Event::Empty(element)) => {
                if !state.enter_xml_element(source, offset, false) {
                    break;
                }
                handle_jmeter_empty(source, offset, &element, &mut state);
            }
            Ok(Event::Text(text)) => {
                append_jmeter_text(
                    source,
                    offset,
                    text.as_ref(),
                    &mut state.active_property,
                    &mut state.diagnostics,
                );
            }
            Ok(Event::GeneralRef(reference)) => {
                append_jmeter_reference(
                    source,
                    offset,
                    reference.as_ref(),
                    &mut state.active_property,
                    &mut state.diagnostics,
                );
            }
            Ok(Event::CData(text)) => {
                append_jmeter_cdata(
                    source,
                    offset,
                    text.as_ref(),
                    &mut state.active_property,
                    &mut state.diagnostics,
                );
            }
            Ok(Event::End(element)) => {
                handle_jmeter_end(element.name().as_ref(), &mut state);
                state.leave_xml_element();
            }
            Ok(_) => {}
            Err(error) => {
                state.diagnostics.push(diag(
                    source,
                    offset,
                    format!("XML JMeter inválido: {error}"),
                ));
                break;
            }
        }
        buffer.clear();
    }

    if state.diagnostics.is_empty() {
        Ok(state.groups)
    } else {
        Err(LoadTestImportError::Incompatible {
            diagnostics: state.diagnostics,
        })
    }
}

fn handle_jmeter_start(
    source: &str,
    offset: usize,
    element: &BytesStart<'_>,
    state: &mut JmeterParseState,
) {
    let tag = element_name(element);
    let attributes = match element_attributes(element) {
        Ok(attributes) => attributes,
        Err(message) => {
            state.diagnostics.push(diag(source, offset, message));
            return;
        }
    };
    let test_class = attributes.get("testclass").map(String::as_str);
    match tag.as_str() {
        "ThreadGroup" | "SetupThreadGroup" | "PostThreadGroup" => {
            let kind = match tag.as_str() {
                "ThreadGroup" => JmeterThreadGroupKind::Standard,
                "SetupThreadGroup" => JmeterThreadGroupKind::Setup,
                _ => JmeterThreadGroupKind::Teardown,
            };
            state.groups.push(JmeterThreadGroup {
                kind,
                name: attributes
                    .get("testname")
                    .cloned()
                    .unwrap_or_else(|| tag.clone()),
                offset,
                properties: HashMap::new(),
                samplers: Vec::new(),
            });
            state.active_group = Some(state.groups.len() - 1);
            state.active_sampler = None;
            state.active_argument = None;
        }
        "HTTPSamplerProxy" => match state.active_group {
            Some(group) => {
                state.groups[group].samplers.push(JmeterHttpSampler {
                    name: attributes
                        .get("testname")
                        .cloned()
                        .unwrap_or_else(|| "HTTP Request".to_string()),
                    offset,
                    properties: HashMap::new(),
                    arguments: Vec::new(),
                });
                state.active_sampler = Some(state.groups[group].samplers.len() - 1);
                state.active_argument = None;
            }
            None => state.diagnostics.push(diag(
                source,
                offset,
                "HTTP Sampler precisa estar dentro de um Thread Group",
            )),
        },
        "elementProp"
            if attributes
                .get("elementType")
                .is_some_and(|element_type| element_type == "HTTPArgument") =>
        {
            match (state.active_group, state.active_sampler) {
                (Some(group), Some(sampler)) => {
                    state.groups[group].samplers[sampler]
                        .arguments
                        .push(JmeterHttpArgument {
                            properties: HashMap::new(),
                        });
                    state.active_argument =
                        Some(state.groups[group].samplers[sampler].arguments.len() - 1);
                }
                _ => state.diagnostics.push(diag(
                    source,
                    offset,
                    "argumento HTTP do JMeter precisa estar dentro de um HTTP Sampler",
                )),
            }
        }
        "HTTPArgument" => state.diagnostics.push(diag(
            source,
            offset,
            "argumentos HTTP do JMeter precisam usar elementProp dentro de um HTTP Sampler",
        )),
        "stringProp" | "boolProp" | "intProp" | "longProp" => {
            let Some(name) = attributes.get("name").cloned() else {
                state
                    .diagnostics
                    .push(diag(source, offset, "propriedade JMeter sem nome"));
                return;
            };
            let target = match (
                state.active_group,
                state.active_sampler,
                state.active_argument,
            ) {
                (Some(group), Some(sampler), Some(argument)) => JmeterPropertyTarget::Argument {
                    group,
                    sampler,
                    argument,
                },
                (Some(group), Some(sampler), None) => {
                    JmeterPropertyTarget::Sampler { group, sampler }
                }
                (Some(group), None, None) => JmeterPropertyTarget::Group(group),
                (Some(_), None, Some(_)) => {
                    state.diagnostics.push(diag(
                        source,
                        offset,
                        "argumento HTTP do JMeter fora de um HTTP Sampler",
                    ));
                    return;
                }
                (None, _, _) => {
                    state.diagnostics.push(diag(
                        source,
                        offset,
                        "propriedade JMeter fora de um Thread Group",
                    ));
                    return;
                }
            };
            state.active_property = Some(JmeterProperty {
                target,
                name,
                value: String::new(),
            });
        }
        _ if is_supported_jmeter_structure(&tag, test_class) => {}
        _ => state.diagnostics.push(diag(
            source,
            offset,
            format!("elemento JMeter não suportado: {tag}"),
        )),
    }
}

fn handle_jmeter_empty(
    source: &str,
    offset: usize,
    element: &BytesStart<'_>,
    state: &mut JmeterParseState,
) {
    let tag = element_name(element);
    let attributes = match element_attributes(element) {
        Ok(attributes) => attributes,
        Err(message) => {
            state.diagnostics.push(diag(source, offset, message));
            return;
        }
    };
    if attributes
        .get("elementType")
        .is_some_and(|element_type| element_type == "HTTPArgument")
    {
        state.diagnostics.push(diag(
            source,
            offset,
            "argumento HTTP do JMeter vazio não pode preservar o corpo da request",
        ));
        return;
    }
    if !is_supported_jmeter_structure(&tag, attributes.get("testclass").map(String::as_str)) {
        state.diagnostics.push(diag(
            source,
            offset,
            format!("elemento JMeter não suportado: {tag}"),
        ));
    }
}

fn append_jmeter_text(
    source: &str,
    offset: usize,
    raw: &[u8],
    active_property: &mut Option<JmeterProperty>,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) {
    let Some(property) = active_property.as_mut() else {
        return;
    };
    let Ok(raw) = std::str::from_utf8(raw) else {
        diagnostics.push(diag(source, offset, "texto XML não está em UTF-8"));
        return;
    };
    match quick_xml::escape::unescape(raw) {
        Ok(value) => property.value.push_str(&value),
        Err(error) => diagnostics.push(diag(
            source,
            offset,
            format!("entidade XML inválida: {error}"),
        )),
    }
}

fn append_jmeter_cdata(
    source: &str,
    offset: usize,
    raw: &[u8],
    active_property: &mut Option<JmeterProperty>,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) {
    let Some(property) = active_property.as_mut() else {
        return;
    };
    match std::str::from_utf8(raw) {
        Ok(value) => property.value.push_str(value),
        Err(_) => diagnostics.push(diag(source, offset, "texto XML não está em UTF-8")),
    }
}

/// O reader separa referências de entidade do texto para evitar expandi-las
/// implicitamente. Só as cinco entidades XML predefinidas são aceitas no
/// valor de uma propriedade; qualquer outra continua sendo incompatível.
fn append_jmeter_reference(
    source: &str,
    offset: usize,
    raw: &[u8],
    active_property: &mut Option<JmeterProperty>,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) {
    let Some(property) = active_property.as_mut() else {
        return;
    };
    let value = match raw {
        b"quot" => '"',
        b"apos" => '\'',
        b"amp" => '&',
        b"lt" => '<',
        b"gt" => '>',
        _ => {
            diagnostics.push(diag(
                source,
                offset,
                "entidade XML não permitida em propriedade JMeter",
            ));
            return;
        }
    };
    property.value.push(value);
}

fn handle_jmeter_end(tag: &[u8], state: &mut JmeterParseState) {
    match tag {
        b"stringProp" | b"boolProp" | b"intProp" | b"longProp" => {
            let Some(property) = state.active_property.take() else {
                return;
            };
            match property.target {
                JmeterPropertyTarget::Group(group) => {
                    state.groups[group]
                        .properties
                        .insert(property.name, property.value.trim().to_string());
                }
                JmeterPropertyTarget::Sampler { group, sampler } => {
                    state.groups[group].samplers[sampler]
                        .properties
                        .insert(property.name, property.value.trim().to_string());
                }
                JmeterPropertyTarget::Argument {
                    group,
                    sampler,
                    argument,
                } => {
                    if let Some(argument) = state
                        .groups
                        .get_mut(group)
                        .and_then(|group| group.samplers.get_mut(sampler))
                        .and_then(|sampler| sampler.arguments.get_mut(argument))
                    {
                        argument
                            .properties
                            .insert(property.name, property.value.trim().to_string());
                    }
                }
            }
        }
        b"elementProp" => state.active_argument = None,
        b"HTTPSamplerProxy" => {
            state.active_sampler = None;
            state.active_argument = None;
        }
        b"ThreadGroup" | b"SetupThreadGroup" | b"PostThreadGroup" => {
            state.active_group = None;
            state.active_sampler = None;
            state.active_argument = None;
        }
        _ => {}
    }
}

fn element_name(element: &BytesStart<'_>) -> String {
    String::from_utf8_lossy(element.name().as_ref()).into_owned()
}

fn element_attributes(element: &BytesStart<'_>) -> Result<HashMap<String, String>, String> {
    let mut attributes = HashMap::new();
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| format!("atributo XML inválido: {error}"))?;
        let key = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|_| "nome de atributo XML não está em UTF-8".to_string())?
            .to_string();
        let value = std::str::from_utf8(attribute.value.as_ref())
            .map_err(|_| "valor de atributo XML não está em UTF-8".to_string())?;
        let value = quick_xml::escape::unescape(value)
            .map_err(|error| format!("entidade XML inválida: {error}"))?
            .into_owned();
        attributes.insert(key, value);
    }
    Ok(attributes)
}

fn is_supported_jmeter_structure(tag: &str, test_class: Option<&str>) -> bool {
    matches!(
        tag,
        "jmeterTestPlan"
            | "hashTree"
            | "TestPlan"
            | "ThreadGroup"
            | "SetupThreadGroup"
            | "PostThreadGroup"
            | "HTTPSamplerProxy"
            | "stringProp"
            | "boolProp"
            | "intProp"
            | "longProp"
            | "collectionProp"
            | "elementProp"
            | "objProp"
            | "value"
            | "name"
            | "Arguments"
            | "LoopController"
    ) || matches!(
        test_class,
        Some("TestPlan" | "ThreadGroup" | "HTTPSamplerProxy")
    )
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

/// O JMeter usa uma lista de `HTTPArgument` tanto para parâmetros codificados
/// quanto para um corpo bruto. Somente a segunda forma tem serialização idêntica
/// a um `LoadRequest`: `postBodyRaw=true`, com exatamente um argumento e seu
/// valor literal. As demais formas continuam incompatíveis para não trocar a
/// codificação, a ordem ou o destino dos parâmetros durante a importação.
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

/// Procura fora de aspas e comentários para não rejeitar uma palavra de uma
/// descrição textual. Não é executor nem transformador de JavaScript.
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
        // Fora de strings/comentários, avança por caractere UTF-8 completo;
        // fatiar no meio de um caractere de uma descrição não pode causar
        // panic durante uma análise que deveria apenas devolver diagnóstico.
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
    fn preserves_only_sleep_durations_exactly_representable_in_milliseconds() {
        assert_eq!(literal_seconds_to_millis("1"), Some(1_000));
        assert_eq!(literal_seconds_to_millis(".25"), Some(250));
        assert_eq!(literal_seconds_to_millis("0.1000"), Some(100));
        assert_eq!(literal_seconds_to_millis("0.0001"), None);
        assert_eq!(literal_seconds_to_millis("1e2"), None);
    }

    #[test]
    fn rejects_trailing_k6_sleep_without_partial_import() {
        let source = "import http from 'k6/http'; import { sleep } from 'k6'; export default function () { http.get('https://api.example.test/a'); sleep(1); }";
        let result = analyze_load_test("paced.js", source, UNIX_EPOCH);

        assert!(matches!(
            result,
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("pacing"))
        ));
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
    fn imports_a_jmeter_http_sampler_from_its_own_xml_scope() {
        let source = r#"
            <jmeterTestPlan>
              <hashTree>
                <ThreadGroup testname="Smoke">
                  <stringProp name="ThreadGroup.num_threads">2</stringProp>
                  <stringProp name="ThreadGroup.ramp_time">0</stringProp>
                  <intProp name="LoopController.loops">2</intProp>
                  <HTTPSamplerProxy testname="Get health">
                    <stringProp name="HTTPSampler.protocol">https</stringProp>
                    <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                    <stringProp name="HTTPSampler.path">health</stringProp>
                    <stringProp name="HTTPSampler.method">GET</stringProp>
                    <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
                  </HTTPSamplerProxy>
                </ThreadGroup>
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
            panic!("segundo node deveria ser Scenario");
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
            <jmeterTestPlan><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
              <HTTPSamplerProxy testname="health">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <stringProp name="HTTPSampler.method">HEAD</stringProp>
              </HTTPSamplerProxy>
              <HTTPSamplerProxy testname="cors">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <stringProp name="HTTPSampler.method">OPTIONS</stringProp>
              </HTTPSamplerProxy>
            </ThreadGroup></hashTree></jmeterTestPlan>
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
            <jmeterTestPlan><hashTree><ThreadGroup testname="Create">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
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
              </HTTPSamplerProxy>
            </ThreadGroup></hashTree></jmeterTestPlan>
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
    fn imports_multiple_finite_jmeter_thread_groups_as_independent_scenarios() {
        let source = r#"
            <jmeterTestPlan><hashTree>
              <ThreadGroup testname="Catalog">
                <stringProp name="ThreadGroup.num_threads">2</stringProp>
                <intProp name="LoopController.loops">3</intProp>
                <HTTPSamplerProxy testname="list">
                  <stringProp name="HTTPSampler.protocol">https</stringProp>
                  <stringProp name="HTTPSampler.domain">catalog.example.test</stringProp>
                  <stringProp name="HTTPSampler.path">items</stringProp>
                </HTTPSamplerProxy>
              </ThreadGroup>
              <ThreadGroup testname="Checkout">
                <stringProp name="ThreadGroup.num_threads">1</stringProp>
                <intProp name="LoopController.loops">2</intProp>
                <HTTPSamplerProxy testname="cart">
                  <stringProp name="HTTPSampler.protocol">https</stringProp>
                  <stringProp name="HTTPSampler.domain">checkout.example.test</stringProp>
                  <stringProp name="HTTPSampler.path">cart</stringProp>
                </HTTPSamplerProxy>
              </ThreadGroup>
            </hashTree></jmeterTestPlan>
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
            <jmeterTestPlan><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">2</stringProp>
              <stringProp name="ThreadGroup.ramp_time">1</stringProp>
              <HTTPSamplerProxy testname="request">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
              </HTTPSamplerProxy>
            </ThreadGroup></hashTree></jmeterTestPlan>
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
            <jmeterTestPlan><hashTree>
              <ThreadGroup testname="Smoke">
                <HeaderManager testclass="HeaderManager" testname="headers" />
              </ThreadGroup>
            </hashTree></jmeterTestPlan>
        "#;
        assert!(matches!(
            analyze_load_test("smoke.jmx", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { .. })
        ));
    }

    #[test]
    fn rejects_jmeter_encoded_arguments_without_a_partial_import() {
        let source = r#"
            <jmeterTestPlan><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
              <HTTPSamplerProxy testname="request">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <elementProp name="argument" elementType="HTTPArgument">
                  <stringProp name="Argument.value">payload</stringProp>
                </elementProp>
              </HTTPSamplerProxy>
            </ThreadGroup></hashTree></jmeterTestPlan>
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
            <jmeterTestPlan><hashTree><ThreadGroup testname="Smoke">
              <stringProp name="ThreadGroup.num_threads">1</stringProp>
              <HTTPSamplerProxy testname="request">
                <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
                <elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments">
                  <elementProp name="one" elementType="HTTPArgument"><stringProp name="Argument.value">first</stringProp></elementProp>
                  <elementProp name="two" elementType="HTTPArgument"><stringProp name="Argument.value">second</stringProp></elementProp>
                </collectionProp></elementProp>
              </HTTPSamplerProxy>
            </ThreadGroup></hashTree></jmeterTestPlan>
        "#;

        assert!(matches!(
            analyze_load_test("multiple-arguments.jmx", source, UNIX_EPOCH),
            Err(LoadTestImportError::Incompatible { diagnostics })
                if diagnostics.iter().any(|diagnostic| diagnostic.message.contains("exatamente um HTTPArgument"))
        ));
    }
}
