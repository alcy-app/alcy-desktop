//! Orçamentos do consumidor: exceder um limite é erro, nunca redução de carga.

use std::time::{Duration, Instant};

use crate::{LoadExecutor, LoadIterationAction, LoadPlan, LoadPlanError, LoadStep};

#[derive(Debug, Clone)]
pub struct LoadRunLimits {
    pub max_scenarios: usize,
    /// Soma dos picos, pois os cenários podem executar simultaneamente.
    pub max_total_vus: u32,
    /// Limite de taxa aberta por cenário, normalizada para chegadas/segundo.
    pub max_arrival_rate_per_second: u64,
    /// Requests e efeitos declarativos em cada corpo de iteração.
    pub max_steps_per_iteration: usize,
    /// Quantos scripts Boa uma execução pode interpretar simultaneamente.
    /// O excedente aguarda sem criar workers bloqueantes adicionais.
    pub max_script_workers: usize,
    /// Duração configurada, incluindo ramp-down e timers; não injeta um
    /// deadline em cenários finitos sem maxDuration.
    pub max_configured_duration: Duration,
    /// Bytes de amostras Trend brutas por execução. A ordenação usa espaço
    /// auxiliar temporário, limitado a duas cópias adicionais dessas amostras.
    pub max_trend_sample_bytes: u64,
}

impl Default for LoadRunLimits {
    fn default() -> Self {
        Self {
            max_scenarios: 64,
            max_total_vus: 4_096,
            max_arrival_rate_per_second: 100_000,
            max_steps_per_iteration: 1_024,
            max_script_workers: 16,
            max_configured_duration: Duration::from_secs(24 * 60 * 60),
            max_trend_sample_bytes: 64 * 1024 * 1024,
        }
    }
}

impl LoadRunLimits {
    pub(crate) fn validate_plan(&self, plan: &LoadPlan) -> Result<(), LoadPlanError> {
        if self.max_scenarios == 0
            || self.max_total_vus == 0
            || self.max_arrival_rate_per_second == 0
            || self.max_steps_per_iteration == 0
            || self.max_script_workers == 0
            || self.max_configured_duration.is_zero()
            || self.max_trend_sample_bytes < 8
        {
            return Err(LoadPlanError::InvalidLimits {
                message: "limites devem ser positivos; amostras precisam de ao menos 8 bytes"
                    .into(),
            });
        }
        require(
            "cenários",
            plan.scenarios.len() as u128,
            self.max_scenarios as u128,
        )?;
        let total_vus = plan
            .scenarios
            .iter()
            .map(|s| u128::from(s.schedule.maximum_vus()))
            .sum();
        require("VUs simultâneos", total_vus, u128::from(self.max_total_vus))?;
        for scenario in &plan.scenarios {
            if let Some(rate) = peak_arrival_rate(scenario.schedule.executor()) {
                require(
                    "taxa de chegada por cenário (/s)",
                    rate,
                    u128::from(self.max_arrival_rate_per_second),
                )?;
            }
            let steps: u128 = scenario
                .requests
                .iter()
                .map(|r| {
                    1 + r.before.len() as u128 + r.checks.len() as u128 + r.metrics.len() as u128
                })
                .sum::<u128>()
                + self.validate_body(&scenario.body, 0)?.0;
            require(
                "passos por iteração",
                steps,
                self.max_steps_per_iteration as u128,
            )?;
            if let Some(duration) = scenario.schedule.scheduled_end() {
                self.validate_duration(duration, &scenario.node_id)?;
            }
            let mut timers = Duration::ZERO;
            for timer in scenario
                .requests
                .iter()
                .flat_map(|r| &r.before)
                .filter_map(|action| match action {
                    LoadIterationAction::Timer(timer) => Some(timer),
                    _ => None,
                })
            {
                self.validate_duration(timer.maximum_duration(), &timer.node_id)?;
                timers = timers
                    .checked_add(timer.maximum_duration())
                    .ok_or_else(|| LoadPlanError::Scenario {
                        id: scenario.node_id.clone(),
                        message: "soma de timers excede a duração representável".into(),
                    })?;
            }
            for request in scenario.request_plans() {
                if let Some(timeout) = request.timeout {
                    self.validate_duration(timeout, &request.node_id)?;
                }
            }
            self.validate_duration(timers, &scenario.node_id)?;
        }
        for lifecycle in plan.setup.iter().chain(&plan.teardown) {
            self.validate_duration(lifecycle.timeout, &lifecycle.node_id)?;
            let (steps, _) = self.validate_body(&lifecycle.body, 0)?;
            require(
                "passos por lifecycle",
                steps,
                self.max_steps_per_iteration as u128,
            )?;
        }
        let mut declared = 0_u128;
        let mut dataset_bytes = 0_u128;
        for body in plan.scenarios.iter().map(|s| s.body.as_slice()).chain(
            plan.setup
                .iter()
                .chain(&plan.teardown)
                .map(|p| p.body.as_slice()),
        ) {
            count_declared(body, &mut declared, &mut dataset_bytes);
        }
        require(
            "passos estruturados por plano",
            declared,
            (self.max_steps_per_iteration as u128).saturating_mul(self.max_scenarios as u128),
        )?;
        require(
            "bytes de datasets por plano",
            dataset_bytes,
            8 * 1024 * 1024,
        )?;
        Ok(())
    }

    fn validate_body(
        &self,
        body: &[LoadStep],
        depth: usize,
    ) -> Result<(u128, Duration), LoadPlanError> {
        require("profundidade de corpo", depth as u128, 32)?;
        // Também limita corpos que nunca serão executados (Repeat(0)/Select).
        require(
            "passos declarados por corpo",
            body.len() as u128,
            self.max_steps_per_iteration as u128,
        )?;
        let mut steps = 0_u128;
        let mut timers = Duration::ZERO;
        for step in body {
            let (nested_steps, nested_timers) = if step.body().is_empty() {
                (0, Duration::ZERO)
            } else {
                self.validate_body(step.body(), depth + 1)?
            };
            let multiplier = match step {
                LoadStep::Repeat { count, .. } => u128::from(*count),
                LoadStep::ForEach {
                    items,
                    items_variable,
                    max_items,
                    ..
                } => {
                    if items_variable.is_some() {
                        max_items.unwrap_or(0) as u128
                    } else {
                        items.len() as u128
                    }
                }
                _ => 1,
            };
            let (own_steps, own_time) = match step {
                LoadStep::Request(r) => {
                    if let Some(timeout) = r.timeout {
                        self.validate_duration(timeout, &r.node_id)?;
                    }
                    let mut time = Duration::ZERO;
                    for action in &r.before {
                        if let LoadIterationAction::Timer(t) = action {
                            self.validate_duration(t.maximum_duration(), &t.node_id)?;
                            time = time.saturating_add(t.maximum_duration());
                        }
                    }
                    (1 + r.before.len() + r.checks.len() + r.metrics.len(), time)
                }
                LoadStep::Timer(timer) => {
                    self.validate_duration(timer.maximum_duration(), &timer.node_id)?;
                    (1, timer.maximum_duration())
                }
                LoadStep::TimeBox {
                    node_id, duration, ..
                } => {
                    self.validate_duration(*duration, node_id)?;
                    (1, *duration)
                }
                _ => (1, Duration::ZERO),
            };
            steps = steps
                .saturating_add(own_steps as u128)
                .saturating_add(nested_steps.saturating_mul(multiplier));
            let nested = if matches!(step, LoadStep::TimeBox { .. }) {
                Duration::ZERO
            } else {
                nested_timers.saturating_mul(u32::try_from(multiplier).unwrap_or(u32::MAX))
            };
            timers = timers.saturating_add(own_time).saturating_add(nested);
            require(
                "passos por iteração",
                steps,
                self.max_steps_per_iteration as u128,
            )?;
        }
        self.validate_duration(timers, "body")?;
        Ok((steps, timers))
    }

    fn validate_duration(&self, duration: Duration, id: &str) -> Result<(), LoadPlanError> {
        require(
            "duração configurada (ns)",
            duration.as_nanos(),
            self.max_configured_duration.as_nanos(),
        )?;
        if Instant::now().checked_add(duration).is_none() {
            return Err(LoadPlanError::Scenario {
                id: id.into(),
                message: "duração excede o relógio da plataforma".into(),
            });
        }
        Ok(())
    }
}

fn count_declared(body: &[LoadStep], count: &mut u128, dataset_bytes: &mut u128) {
    for step in body {
        *count += 1;
        if let LoadStep::Dataset(dataset) = step {
            *dataset_bytes += dataset
                .rows
                .iter()
                .flat_map(|r| r.iter())
                .map(|(k, v)| (k.len() + v.len()) as u128)
                .sum::<u128>();
        }
        count_declared(step.body(), count, dataset_bytes);
    }
}

fn peak_arrival_rate(executor: &LoadExecutor) -> Option<u128> {
    let (rate, unit) = match executor {
        LoadExecutor::ConstantArrivalRate {
            rate, time_unit, ..
        } => (*rate, *time_unit),
        LoadExecutor::RampingArrivalRate {
            start_rate,
            time_unit,
            stages,
            ..
        } => (
            stages
                .iter()
                .map(|stage| stage.target)
                .max()
                .unwrap_or(0)
                .max(*start_rate),
            *time_unit,
        ),
        _ => return None,
    };
    Some((u128::from(rate) * 1_000_000_000).div_ceil(unit.as_nanos()))
}

fn require(resource: &'static str, required: u128, limit: u128) -> Result<(), LoadPlanError> {
    if required > limit {
        return Err(LoadPlanError::ResourceLimit {
            resource,
            required,
            limit,
        });
    }
    Ok(())
}
