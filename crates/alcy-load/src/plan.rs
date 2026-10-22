//! Typed load plan independent of graphs, IPC and persistence.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use alcy_domain::{Endpoint, HeaderEntry, HttpMethod, RedirectPolicy};
use regex::Regex;
use scraper::Selector;
use sxd_xpath::Factory as XPathFactory;
use thiserror::Error;

use crate::{LoadMetricKind, LoadMetricStatistic, LoadRunLimits, LoadSchedule, LoadThreshold};

/// Canonical plan independent of Tauri, graphs and persistence. Consumers
/// can build it directly; the runner always validates before execution.
#[derive(Debug, Clone)]
pub struct LoadPlan {
    pub setup: Option<LoadLifecyclePlan>,
    pub teardown: Option<LoadLifecyclePlan>,
    pub scenarios: Vec<LoadScenarioPlan>,
    pub thresholds: Vec<LoadThreshold>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LoadPlanError {
    #[error("limite de {resource} excedido: necessário {required}, permitido {limit}")]
    ResourceLimit {
        resource: &'static str,
        required: u128,
        limit: u128,
    },
    #[error("limites de execução inválidos: {message}")]
    InvalidLimits { message: String },
    #[error("plano de carga não tem cenário")]
    MissingScenario,
    #[error("cenário '{id}' é inválido: {message}")]
    Scenario { id: String, message: String },
    #[error("request '{id}' é inválida: {message}")]
    Request { id: String, message: String },
    #[error("métrica '{id}' é inválida: {message}")]
    Metric { id: String, message: String },
    #[error("threshold {index} é inválido: {message}")]
    Threshold { index: usize, message: String },
}

impl LoadPlan {
    /// Structural compilation permits incomplete user configuration. Check it
    /// separately before previewing an execution or starting any effects.
    pub fn validate_ready(&self) -> Result<(), LoadPlanError> {
        fn session(value: &LoadSessionPlan) -> Result<(), LoadPlanError> {
            for name in &value.required_variables {
                if value
                    .variables
                    .get(name)
                    .is_none_or(|value| value.trim().is_empty())
                {
                    return Err(LoadPlanError::Scenario {
                        id: value.node_id.clone(),
                        message: format!(
                            "fill required variable '{name}' in the session configuration"
                        ),
                    });
                }
            }
            Ok(())
        }
        fn body(steps: &[LoadStep]) -> Result<(), LoadPlanError> {
            for step in steps {
                match step {
                    LoadStep::ConfigureSession(value) => session(value)?,
                    LoadStep::Request(request) => before(request)?,
                    _ => {}
                }
                body(step.body())?;
            }
            Ok(())
        }
        fn before(request: &LoadRequestPlan) -> Result<(), LoadPlanError> {
            for action in &request.before {
                if let LoadIterationAction::ConfigureSession(value) = action {
                    session(value)?;
                }
            }
            Ok(())
        }
        for lifecycle in self.setup.iter().chain(&self.teardown) {
            body(&lifecycle.body)?;
        }
        for scenario in &self.scenarios {
            body(&scenario.body)?;
            for request in &scenario.requests {
                before(request)?;
            }
        }
        Ok(())
    }

    /// Only unconditional leading configuration can be inspected without
    /// executing setup requests or scripts.
    pub fn configured_variables(&self) -> BTreeMap<String, String> {
        let mut variables = BTreeMap::new();
        if let Some(setup) = &self.setup {
            for step in &setup.body {
                let LoadStep::ConfigureSession(session) = step else {
                    break;
                };
                variables.extend(session.variables.clone());
            }
        }
        variables
    }

    /// Validate without I/O. Invalid plans never start transport, timers or
    /// sample writes; compiler-produced plans also pass through this check.
    pub fn validate(&self) -> Result<(), LoadPlanError> {
        self.validate_with_limits(&LoadRunLimits::default())
    }

    pub fn validate_with_limits(&self, limits: &LoadRunLimits) -> Result<(), LoadPlanError> {
        limits.validate_plan(self)?;
        if self.scenarios.is_empty() {
            return Err(LoadPlanError::MissingScenario);
        }
        let mut ids = BTreeSet::new();
        let mut kinds = BTreeMap::from([
            ("http_requests".to_string(), LoadMetricKind::Counter),
            ("http_req_failed".to_string(), LoadMetricKind::Rate),
            ("http_req_duration".to_string(), LoadMetricKind::Trend),
            ("http_req_dns".to_string(), LoadMetricKind::Trend),
            ("http_req_connecting".to_string(), LoadMetricKind::Trend),
            (
                "http_req_tls_handshaking".to_string(),
                LoadMetricKind::Trend,
            ),
            ("http_req_sending".to_string(), LoadMetricKind::Trend),
            ("http_req_waiting".to_string(), LoadMetricKind::Trend),
            ("http_req_receiving".to_string(), LoadMetricKind::Trend),
            ("checks".to_string(), LoadMetricKind::Rate),
            ("group_duration".to_string(), LoadMetricKind::Trend),
        ]);
        for scenario in &self.scenarios {
            if scenario.node_id.trim().is_empty() || !ids.insert(&scenario.node_id) {
                return Err(LoadPlanError::Scenario {
                    id: scenario.node_id.clone(),
                    message: "identificador vazio ou duplicado".into(),
                });
            }
            if scenario.requests.is_empty() && scenario.body.is_empty() {
                return Err(LoadPlanError::Scenario {
                    id: scenario.node_id.clone(),
                    message: "corpo precisa de ao menos um passo".into(),
                });
            }
            if !scenario.requests.is_empty() && !scenario.body.is_empty() {
                return Err(LoadPlanError::Scenario {
                    id: scenario.node_id.clone(),
                    message: "requests legadas e corpo estruturado são mutuamente exclusivos"
                        .into(),
                });
            }
        }
        let mut requests: Vec<_> = self
            .scenarios
            .iter()
            .flat_map(|s| s.request_plans())
            .collect();
        for lifecycle in self.setup.iter().chain(&self.teardown) {
            if lifecycle.body.is_empty()
                || lifecycle.node_id.trim().is_empty()
                || lifecycle.timeout.is_zero()
                || !ids.insert(&lifecycle.node_id)
            {
                return Err(LoadPlanError::Scenario {
                    id: lifecycle.node_id.clone(),
                    message: "lifecycle exige corpo, timeout positivo e identificador exclusivo"
                        .into(),
                });
            }
            collect_requests(&lifecycle.body, &mut requests);
        }
        let mut standalone_metrics = Vec::new();
        for body in self.scenarios.iter().map(|s| s.body.as_slice()).chain(
            self.setup
                .iter()
                .chain(&self.teardown)
                .map(|p| p.body.as_slice()),
        ) {
            validate_body(body, &mut standalone_metrics, false, &mut BTreeSet::new())?;
        }
        for request in &requests {
            for check in &request.checks {
                if check.name.trim().is_empty() || !(100..=599).contains(&check.expected_status) {
                    return Err(LoadPlanError::Request {
                        id: check.node_id.clone(),
                        message: "Check exige nome e status HTTP válido".into(),
                    });
                }
            }
            for action in &request.before {
                if let LoadIterationAction::ConfigureSession(session) = action {
                    validate_session(session)?;
                }
            }
            if request.timeout.is_some_and(|timeout| timeout.is_zero()) {
                return Err(LoadPlanError::Request {
                    id: request.node_id.clone(),
                    message: "timeout precisa ser maior que zero".into(),
                });
            }
            for header in request
                .headers
                .iter()
                .chain(request.before.iter().flat_map(|action| match action {
                    LoadIterationAction::ConfigureSession(session) => session.headers.as_slice(),
                    LoadIterationAction::Timer(_) => &[],
                }))
            {
                header
                    .validate_http()
                    .map_err(|error| LoadPlanError::Request {
                        id: request.node_id.clone(),
                        message: format!("header inválido: {error}"),
                    })?;
            }
        }
        for metric in requests
            .iter()
            .flat_map(|r| &r.metrics)
            .chain(standalone_metrics)
        {
            let invalid = metric.name.trim().is_empty()
                || !metric.value.is_finite()
                || (metric.kind == LoadMetricKind::Counter && metric.value < 0.0)
                || (metric.kind == LoadMetricKind::Rate && !matches!(metric.value, 0.0 | 1.0));
            if invalid {
                return Err(LoadPlanError::Metric {
                    id: metric.node_id.clone(),
                    message: "nome ou valor incompatível com o tipo da métrica".into(),
                });
            }
            if kinds
                .insert(metric.name.clone(), metric.kind)
                .is_some_and(|kind| kind != metric.kind)
            {
                return Err(LoadPlanError::Metric {
                    id: metric.node_id.clone(),
                    message: format!("a métrica '{}' já existe com outro tipo", metric.name),
                });
            }
        }
        for (index, threshold) in self.thresholds.iter().enumerate() {
            let invalid = |message| LoadPlanError::Threshold { index, message };
            if !threshold.target.is_finite() {
                return Err(invalid("alvo precisa ser finito".into()));
            }
            let kind = kinds.get(&threshold.selector.name).ok_or_else(|| {
                invalid(format!(
                    "métrica '{}' não é produzida por este plano",
                    threshold.selector.name
                ))
            })?;
            let supported = match threshold.statistic {
                LoadMetricStatistic::Count | LoadMetricStatistic::Value => true,
                LoadMetricStatistic::Rate => *kind == LoadMetricKind::Rate,
                _ => *kind == LoadMetricKind::Trend,
            };
            if !supported {
                return Err(invalid(format!(
                    "estatística {:?} ainda não é executável para a métrica '{}' do tipo {:?}",
                    threshold.statistic, threshold.selector.name, kind
                )));
            }
        }
        Ok(())
    }
}

fn validate_body<'a>(
    body: &'a [LoadStep],
    metrics: &mut Vec<&'a LoadMetricPlan>,
    mut has_response: bool,
    ids: &mut BTreeSet<&'a str>,
) -> Result<bool, LoadPlanError> {
    for step in body {
        if step.node_id().trim().is_empty() || !ids.insert(step.node_id()) {
            return Err(LoadPlanError::Scenario {
                id: step.node_id().into(),
                message: "identificador de passo vazio ou duplicado".into(),
            });
        }
        if matches!(
            step,
            LoadStep::Repeat { .. }
                | LoadStep::ForEach { .. }
                | LoadStep::Select { .. }
                | LoadStep::OncePerVu { .. }
                | LoadStep::TimeBox { .. }
                | LoadStep::Group { .. }
        ) && step.body().is_empty()
        {
            return Err(LoadPlanError::Scenario {
                id: step.node_id().into(),
                message: "controlador exige corpo".into(),
            });
        }
        match step {
            LoadStep::Request(_) => has_response = true,
            LoadStep::Check(check)
                if !has_response
                    || check.name.trim().is_empty()
                    || !(100..=599).contains(&check.expected_status) =>
            {
                return Err(LoadPlanError::Request {
                    id: check.node_id.clone(),
                    message: "Check exige request anterior, nome e status HTTP válido".into(),
                });
            }
            LoadStep::Extract(extract)
                if !has_response || !is_valid_variable_name(&extract.name) =>
            {
                return Err(LoadPlanError::Scenario {
                    id: extract.node_id.clone(),
                    message: "Extract requires a preceding request and a valid variable name"
                        .into(),
                });
            }
            LoadStep::Extract(extract) => validate_extract_kind(extract)?,
            LoadStep::Script(script)
                if script.code.trim().is_empty()
                    || script.code.len() > 256 * 1024
                    || (script.phase == LoadScriptPhase::PostResponse && !has_response) =>
            {
                return Err(LoadPlanError::Scenario {
                    id: script.node_id.clone(),
                    message:
                        "Script exige código de até 256 KiB; postResponse exige request anterior"
                            .into(),
                });
            }
            LoadStep::Metric(metric) => metrics.push(metric),
            LoadStep::ConfigureSession(session) => {
                validate_session(session)?;
                for header in &session.headers {
                    header
                        .validate_http()
                        .map_err(|error| LoadPlanError::Request {
                            id: session.node_id.clone(),
                            message: format!("header inválido: {error}"),
                        })?;
                }
            }
            LoadStep::Dataset(dataset) => {
                let Some(first) = dataset.rows.first() else {
                    return Err(LoadPlanError::Scenario {
                        id: dataset.node_id.clone(),
                        message: "Dataset precisa de linhas".into(),
                    });
                };
                let keys: Vec<_> = first.keys().collect();
                if keys.is_empty() {
                    return Err(LoadPlanError::Scenario {
                        id: dataset.node_id.clone(),
                        message: "Dataset precisa de colunas".into(),
                    });
                }
                let mut bytes = 0_u128;
                for row in dataset.rows.iter() {
                    validate_variables(row, &dataset.node_id)?;
                    if row.keys().collect::<Vec<_>>() != keys {
                        return Err(LoadPlanError::Scenario {
                            id: dataset.node_id.clone(),
                            message: "linhas do Dataset têm colunas diferentes".into(),
                        });
                    }
                    bytes += row
                        .iter()
                        .map(|(k, v)| (k.len() + v.len()) as u128)
                        .sum::<u128>();
                }
                if bytes > 8 * 1024 * 1024 {
                    return Err(LoadPlanError::ResourceLimit {
                        resource: "bytes de Dataset",
                        required: bytes,
                        limit: 8 * 1024 * 1024,
                    });
                }
            }
            LoadStep::ForEach {
                node_id, variable, ..
            }
            | LoadStep::Select {
                node_id, variable, ..
            } if variable.trim().is_empty()
                || variable.starts_with("__")
                || variable.contains(['{', '}'])
                || variable.trim() != variable =>
            {
                return Err(LoadPlanError::Scenario {
                    id: node_id.clone(),
                    message: "variável vazia ou reservada".into(),
                });
            }
            LoadStep::ForEach {
                node_id,
                items,
                items_variable: Some(items_variable),
                max_items,
                ..
            } if !items.is_empty()
                || !is_valid_variable_name(items_variable)
                || max_items.is_none_or(|limit| limit == 0) =>
            {
                return Err(LoadPlanError::Scenario {
                    id: node_id.clone(),
                    message: "ForEach dinâmico exige uma variável válida, sem items literais e maxItems positivo"
                        .into(),
                });
            }
            LoadStep::ForEach {
                node_id,
                items_variable: None,
                max_items: Some(_),
                ..
            } => {
                return Err(LoadPlanError::Scenario {
                    id: node_id.clone(),
                    message: "maxItems só é permitido com itemsVariable".into(),
                });
            }
            LoadStep::TimeBox {
                node_id,
                duration,
                body,
            } if duration.is_zero() || body.is_empty() => {
                return Err(LoadPlanError::Scenario {
                    id: node_id.clone(),
                    message: "TimeBox exige duração positiva e corpo".into(),
                });
            }
            LoadStep::Group { node_id, name, .. } if name.trim().is_empty() => {
                return Err(LoadPlanError::Scenario {
                    id: node_id.clone(),
                    message: "Group exige nome".into(),
                });
            }
            _ => {}
        }
        let nested_response = validate_body(step.body(), metrics, has_response, ids)?;
        match step {
            LoadStep::Group { .. } => has_response = nested_response,
            LoadStep::Repeat { count, .. } if *count > 0 => has_response = nested_response,
            LoadStep::ForEach {
                items,
                items_variable,
                ..
            } if !items.is_empty() || items_variable.is_some() => has_response = nested_response,
            _ => {}
        }
    }
    Ok(has_response)
}

fn validate_session(session: &LoadSessionPlan) -> Result<(), LoadPlanError> {
    validate_variables(&session.variables, &session.node_id)?;
    let mut names = BTreeSet::new();
    for name in &session.required_variables {
        if !is_valid_variable_name(name)
            || !session.variables.contains_key(name)
            || !names.insert(name)
        {
            return Err(LoadPlanError::Scenario {
                id: session.node_id.clone(),
                message: format!("required variable '{name}' must have a unique session entry"),
            });
        }
    }
    Ok(())
}

fn validate_variables(variables: &BTreeMap<String, String>, id: &str) -> Result<(), LoadPlanError> {
    if variables.keys().any(|key| !is_valid_variable_name(key)) {
        return Err(LoadPlanError::Scenario {
            id: id.into(),
            message: "nome de variável vazio ou reservado".into(),
        });
    }
    let bytes: usize = variables.iter().map(|(k, v)| k.len() + v.len()).sum();
    if bytes > 1024 * 1024 {
        return Err(LoadPlanError::ResourceLimit {
            resource: "bytes de variáveis",
            required: bytes as u128,
            limit: 1024 * 1024,
        });
    }
    Ok(())
}

fn is_valid_variable_name(name: &str) -> bool {
    !name.trim().is_empty()
        && !name.starts_with("__")
        && !name.contains(['{', '}'])
        && name.trim() == name
}

fn is_valid_json_pointer(pointer: &str) -> bool {
    if pointer.is_empty() {
        return true;
    }
    if !pointer.starts_with('/') {
        return false;
    }
    pointer.split('/').skip(1).all(|segment| {
        let bytes = segment.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'~' {
                index += 1;
                if !matches!(bytes.get(index), Some(b'0' | b'1')) {
                    return false;
                }
            }
            index += 1;
        }
        true
    })
}

fn validate_extract_kind(extract: &LoadExtractPlan) -> Result<(), LoadPlanError> {
    let invalid = |message: &str| LoadPlanError::Scenario {
        id: extract.node_id.clone(),
        message: message.into(),
    };
    match &extract.kind {
        LoadExtractKind::JsonPointer { pointer } if is_valid_json_pointer(pointer) => Ok(()),
        LoadExtractKind::JsonPointer { .. } => Err(invalid("Extract has an invalid JSON Pointer")),
        LoadExtractKind::Regex { pattern, group } => {
            if pattern.is_empty() || pattern.len() > 4096 {
                return Err(invalid(
                    "Extract regex must contain at most 4096 characters",
                ));
            }
            let regex = Regex::new(pattern)
                .map_err(|_| invalid("Extract has an invalid regular expression"))?;
            if *group >= regex.captures_len() {
                return Err(invalid("Extract regex capture group is unavailable"));
            }
            Ok(())
        }
        LoadExtractKind::XPath { expression } => {
            if expression.is_empty() || expression.len() > 4096 {
                return Err(invalid(
                    "Extract XPath must contain at most 4096 characters",
                ));
            }
            XPathFactory::new()
                .build(expression)
                .map_err(|_| invalid("Extract has an invalid XPath expression"))?
                .ok_or_else(|| invalid("Extract XPath does not select a value"))?;
            Ok(())
        }
        LoadExtractKind::Css {
            selector,
            attribute,
        } => {
            if selector.is_empty() || selector.len() > 4096 {
                return Err(invalid(
                    "Extract CSS selector must contain at most 4096 characters",
                ));
            }
            Selector::parse(selector)
                .map_err(|_| invalid("Extract has an invalid CSS selector"))?;
            if attribute
                .as_ref()
                .is_some_and(|attribute| attribute.trim().is_empty())
            {
                return Err(invalid("Extract CSS attribute cannot be empty"));
            }
            Ok(())
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoadScenarioPlan {
    /// Source identifier for diagnostics; does not require a graph node.
    /// The field name is retained for compatibility with existing plans.
    pub node_id: String,
    pub label: String,
    pub schedule: LoadSchedule,
    pub requests: Vec<LoadRequestPlan>,
    /// Structured body, mutually exclusive with the legacy `requests` chain.
    pub body: Vec<LoadStep>,
}

#[derive(Debug, Clone)]
pub struct LoadLifecyclePlan {
    pub node_id: String,
    pub body: Vec<LoadStep>,
    pub timeout: Duration,
}

/// Declarative instructions without filesystem, process or network access
/// outside the transport port. Bodies contain no graph edges.
#[derive(Debug, Clone, PartialEq)]
pub enum LoadStep {
    Request(LoadRequestPlan),
    Timer(LoadTimerPlan),
    ConfigureSession(LoadSessionPlan),
    Check(LoadCheckPlan),
    Extract(LoadExtractPlan),
    Script(LoadScriptPlan),
    Metric(LoadMetricPlan),
    Dataset(LoadDatasetPlan),
    Repeat {
        node_id: String,
        count: u64,
        body: Vec<LoadStep>,
    },
    ForEach {
        node_id: String,
        variable: String,
        /// Items declared in the plan. With `items_variable`, this list must
        /// be empty and the source is a JSON array in VU state, typically
        /// produced by setup/Extract.
        items: Vec<String>,
        /// Variable containing a JSON array. The explicit cap prevents dynamic
        /// data from expanding an iteration without a known bound.
        items_variable: Option<String>,
        max_items: Option<usize>,
        body: Vec<LoadStep>,
    },
    Select {
        node_id: String,
        variable: String,
        /// Declarative comparison; `Equals` preserves existing flows that only
        /// provide the `equals` field.
        operator: LoadSelectOperator,
        equals: String,
        body: Vec<LoadStep>,
    },
    OncePerVu {
        node_id: String,
        body: Vec<LoadStep>,
    },
    TimeBox {
        node_id: String,
        duration: Duration,
        body: Vec<LoadStep>,
    },
    Group {
        node_id: String,
        name: String,
        tags: BTreeMap<String, String>,
        /// When false, the parent metric excludes time spent in Timer steps.
        include_timers: bool,
        /// When false, the group only delimits scope/tags and does not emit a
        /// `group_duration` sample.
        emit_parent: bool,
        body: Vec<LoadStep>,
    },
}

/// Safe body decision operators. They neither execute code nor implicitly
/// coerce values: comparisons use canonical strings from isolated VU state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadSelectOperator {
    Equals,
    NotEquals,
    Exists,
    NotExists,
}

impl LoadStep {
    pub fn node_id(&self) -> &str {
        match self {
            Self::Request(p) => &p.node_id,
            Self::Timer(p) => &p.node_id,
            Self::ConfigureSession(p) => &p.node_id,
            Self::Check(p) => &p.node_id,
            Self::Extract(p) => &p.node_id,
            Self::Script(p) => &p.node_id,
            Self::Metric(p) => &p.node_id,
            Self::Dataset(p) => &p.node_id,
            Self::Repeat { node_id, .. }
            | Self::ForEach { node_id, .. }
            | Self::Select { node_id, .. }
            | Self::OncePerVu { node_id, .. }
            | Self::TimeBox { node_id, .. }
            | Self::Group { node_id, .. } => node_id,
        }
    }
    pub fn body(&self) -> &[LoadStep] {
        match self {
            Self::Repeat { body, .. }
            | Self::ForEach { body, .. }
            | Self::Select { body, .. }
            | Self::OncePerVu { body, .. }
            | Self::TimeBox { body, .. }
            | Self::Group { body, .. } => body,
            _ => &[],
        }
    }
}

impl LoadScenarioPlan {
    pub fn request_plans(&self) -> Vec<&LoadRequestPlan> {
        let mut requests: Vec<_> = self.requests.iter().collect();
        collect_requests(&self.body, &mut requests);
        requests
    }
}

pub(crate) fn collect_requests<'a>(body: &'a [LoadStep], requests: &mut Vec<&'a LoadRequestPlan>) {
    for step in body {
        if let LoadStep::Request(request) = step {
            requests.push(request);
        }
        collect_requests(step.body(), requests);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadRequestPlan {
    pub node_id: String,
    pub method: HttpMethod,
    /// Endpoint text; templates are resolved and validated before transport.
    pub endpoint: Endpoint,
    pub body: String,
    /// Per-request limit enforced by the runner in addition to any timeout
    /// configured by the concrete transport.
    pub timeout: Option<Duration>,
    /// Request-specific headers override VU session defaults and are never
    /// discarded by the executor.
    pub headers: Vec<HeaderEntry>,
    /// HTTP redirect policy for this request, independent of the consumer's
    /// global proxy/timeout configuration.
    pub redirect_policy: RedirectPolicy,
    /// Static tags attached to this request's automatic metrics.
    pub tags: BTreeMap<String, String>,
    pub before: Vec<LoadIterationAction>,
    pub checks: Vec<LoadCheckPlan>,
    pub metrics: Vec<LoadMetricPlan>,
}

impl LoadRequestPlan {
    /// Validate the actual destination before constructing the transport request.
    pub fn resolve_endpoint(
        &self,
        variables: &BTreeMap<String, String>,
    ) -> Result<Endpoint, LoadPlanError> {
        let invalid = || LoadPlanError::Request {
            id: self.node_id.clone(),
            message: "URL requires resolved variables and a valid HTTP/HTTPS destination".into(),
        };
        let value =
            crate::runtime::resolve_template(self.endpoint.url(), variables).ok_or_else(invalid)?;
        let url = url::Url::parse(&value).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || value.contains(['{', '}'])
        {
            return Err(invalid());
        }
        Endpoint::new(value).map_err(|_| invalid())
    }
}

/// Declarative actions preceding a request in each VU iteration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadIterationAction {
    Timer(LoadTimerPlan),
    ConfigureSession(LoadSessionPlan),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadTimerPlan {
    pub node_id: String,
    pub kind: LoadTimerKind,
}

/// Declarative delay distribution sampled in the VU worker with its isolated
/// RNG; the plan carries neither randomness nor a clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadTimerKind {
    Fixed(Duration),
    Uniform {
        min: Duration,
        max: Duration,
    },
    Gaussian {
        mean: Duration,
        standard_deviation: Duration,
    },
    Poisson {
        mean: Duration,
    },
    Pacing {
        period: Duration,
    },
}

impl LoadTimerPlan {
    /// Conservative pre-execution budget bound: six deviations for Gaussian
    /// and twenty means for Poisson, without limiting the actual sample.
    pub fn maximum_duration(&self) -> Duration {
        match self.kind {
            LoadTimerKind::Fixed(duration) | LoadTimerKind::Pacing { period: duration } => duration,
            LoadTimerKind::Uniform { max, .. } => max,
            LoadTimerKind::Gaussian {
                mean,
                standard_deviation,
            } => mean.saturating_add(standard_deviation.saturating_mul(6)),
            LoadTimerKind::Poisson { mean } => mean.saturating_mul(20),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadSessionPlan {
    pub node_id: String,
    /// Session headers; their HTTP syntax is validated before execution.
    pub headers: Vec<HeaderEntry>,
    pub cookies_enabled: Option<bool>,
    pub variables: BTreeMap<String, String>,
    /// User-provided values required before any execution effects.
    pub required_variables: Vec<String>,
}

/// Data already resolved by the consumer. The runner never opens workspace
/// files; rows are shared immutably between VUs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadDatasetPlan {
    pub node_id: String,
    pub rows: std::sync::Arc<[BTreeMap<String, String>]>,
    pub recycle: bool,
}

/// Functional assertion on the immediately preceding response. Additional
/// expressions require safe canonical runtime semantics rather than arbitrary
/// JavaScript supplied by an importer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadCheckPlan {
    pub node_id: String,
    pub name: String,
    pub expected_status: u16,
}

/// Extracts one value from the latest HTTP response into the current VU.
/// Response bodies never leave the worker or reach persisted run history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadExtractPlan {
    pub node_id: String,
    pub name: String,
    pub kind: LoadExtractKind,
}

/// Declarative extraction algorithms. A missing match is always an execution
/// error; none of these variants silently writes an empty variable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadExtractKind {
    JsonPointer {
        pointer: String,
    },
    Regex {
        pattern: String,
        group: usize,
    },
    XPath {
        expression: String,
    },
    Css {
        selector: String,
        attribute: Option<String>,
    },
}

/// Explicit safe Script phase; only VU variables can be changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadScriptPhase {
    PreRequest,
    PostResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadScriptPlan {
    pub node_id: String,
    pub phase: LoadScriptPhase,
    pub code: String,
}

/// Declarative custom metric emitted after the preceding request.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadMetricPlan {
    pub node_id: String,
    pub name: String,
    pub kind: LoadMetricKind,
    pub value: f64,
    pub tags: BTreeMap<String, String>,
}
