//! Núcleo reutilizável de execução de carga.
//!
//! O crate não conhece Tauri, grafos, persistência de workspace ou HTTP concreto.
//! O executor pede alvos de VU e chegadas ao scheduler; uma chegada aberta sem VU deve ser
//! contabilizada como descartada, nunca adiada para esconder saturação.

use std::error::Error;
use std::fmt;
use std::time::Duration;

mod limits;
mod metrics;
mod plan;
mod ports;
mod runtime;
mod vu_state;

pub use limits::LoadRunLimits;
pub use metrics::{
    LoadMetricError, LoadMetricKind, LoadMetricRegistry, LoadMetricSelector, LoadMetricSnapshot,
    LoadMetricStatistic, LoadThreshold, LoadThresholdComparison, LoadThresholdResult,
    MAX_LOAD_METRIC_SERIES,
};
pub use plan::{
    LoadCheckPlan, LoadDatasetPlan, LoadExtractPlan, LoadIterationAction, LoadLifecyclePlan,
    LoadMetricPlan, LoadPlan, LoadPlanError, LoadRequestPlan, LoadScenarioPlan, LoadScriptPhase,
    LoadScriptPlan, LoadSelectOperator, LoadSessionPlan, LoadStep, LoadTimerKind, LoadTimerPlan,
};
pub use ports::{LoadCancellation, LoadRequestTimings, LoadTransport, LoadTransportResponse};
pub use runtime::{
    LOAD_PROGRESS_INTERVAL, LoadExecutionError, LoadRequestSample, LoadRunAccumulator,
    LoadRunProgress, LoadRunReport, LoadRunSink, LoadRunSummary, execute_load_plan,
    execute_load_plan_report, execute_load_plan_report_with_limits,
};
pub use vu_state::LoadVuState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadStage {
    pub target: u32,
    pub duration: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadExecutor {
    SharedIterations {
        vus: u32,
        iterations: u64,
        max_duration: Option<Duration>,
    },
    PerVuIterations {
        vus: u32,
        iterations_per_vu: u64,
        max_duration: Option<Duration>,
    },
    ConstantVus {
        vus: u32,
        duration: Duration,
    },
    RampingVus {
        start_vus: u32,
        stages: Vec<LoadStage>,
        graceful_ramp_down: Duration,
    },
    ConstantArrivalRate {
        rate: u32,
        time_unit: Duration,
        duration: Duration,
        pre_allocated_vus: u32,
        max_vus: Option<u32>,
    },
    RampingArrivalRate {
        start_rate: u32,
        time_unit: Duration,
        stages: Vec<LoadStage>,
        pre_allocated_vus: u32,
        max_vus: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadScheduleError {
    ZeroVus,
    ZeroRate,
    ZeroTimeUnit,
    ZeroDuration,
    EmptyStages,
    ZeroStageDuration,
    InvalidMaxVus,
    Overflow,
}

impl fmt::Display for LoadScheduleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ZeroVus => "VUs deve ser maior que zero",
            Self::ZeroRate => "taxa deve ser maior que zero",
            Self::ZeroTimeUnit => "unidade de tempo deve ser maior que zero",
            Self::ZeroDuration => "duração deve ser maior que zero",
            Self::EmptyStages => "o cenário precisa de ao menos um estágio",
            Self::ZeroStageDuration => "a duração de um estágio deve ser maior que zero",
            Self::InvalidMaxVus => "maxVUs não pode ser menor que preAllocatedVUs",
            Self::Overflow => {
                "configuração excede a duração ou quantidade de iterações representável"
            }
        })
    }
}
impl Error for LoadScheduleError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadScheduleMode {
    Finite,
    Closed,
    Open,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Arrival {
    pub ordinal: u64,
    pub at: Duration,
}
#[derive(Debug, Clone)]
pub struct LoadSchedule {
    executor: LoadExecutor,
}

impl LoadSchedule {
    pub fn new(executor: LoadExecutor) -> Result<Self, LoadScheduleError> {
        validate(&executor)?;
        Ok(Self { executor })
    }
    pub fn mode(&self) -> LoadScheduleMode {
        match self.executor {
            LoadExecutor::SharedIterations { .. } | LoadExecutor::PerVuIterations { .. } => {
                LoadScheduleMode::Finite
            }
            LoadExecutor::ConstantVus { .. } | LoadExecutor::RampingVus { .. } => {
                LoadScheduleMode::Closed
            }
            LoadExecutor::ConstantArrivalRate { .. } | LoadExecutor::RampingArrivalRate { .. } => {
                LoadScheduleMode::Open
            }
        }
    }

    /// Configuração canônica que originou este agendamento. O runtime usa
    /// este acesso somente para escolher a estratégia de workers; cálculos de
    /// relógio e limites continuam concentrados neste crate.
    pub fn executor(&self) -> &LoadExecutor {
        &self.executor
    }
    pub fn duration(&self) -> Option<Duration> {
        match &self.executor {
            LoadExecutor::SharedIterations { max_duration, .. }
            | LoadExecutor::PerVuIterations { max_duration, .. } => *max_duration,
            LoadExecutor::ConstantVus { duration, .. }
            | LoadExecutor::ConstantArrivalRate { duration, .. } => Some(*duration),
            LoadExecutor::RampingVus { stages, .. }
            | LoadExecutor::RampingArrivalRate { stages, .. } => {
                Some(stages.iter().map(|stage| stage.duration).sum())
            }
        }
    }

    /// Janela total durante a qual o runtime ainda precisa esperar workers
    /// encerrarem graciosamente. Para modelos abertos não há trabalho novo
    /// depois de `duration()`, mas iterações já iniciadas podem completar até
    /// este instante.
    pub fn scheduled_end(&self) -> Option<Duration> {
        match &self.executor {
            LoadExecutor::RampingVus {
                stages,
                graceful_ramp_down,
                ..
            } => Some(
                stages.iter().map(|stage| stage.duration).sum::<Duration>() + *graceful_ramp_down,
            ),
            _ => self.duration(),
        }
    }

    /// Indica se o executor ainda agenda trabalho novo no instante dado. O
    /// graceful stop não gera VUs/iterações: ele só amplia a janela em que o
    /// runtime aguarda as que já estavam em voo.
    pub fn is_scheduling_at(&self, elapsed: Duration) -> bool {
        self.duration().is_none_or(|duration| elapsed < duration)
    }
    pub fn initial_vus(&self) -> u32 {
        match &self.executor {
            LoadExecutor::SharedIterations { vus, .. }
            | LoadExecutor::PerVuIterations { vus, .. }
            | LoadExecutor::ConstantVus { vus, .. } => *vus,
            LoadExecutor::RampingVus { start_vus, .. } => *start_vus,
            LoadExecutor::ConstantArrivalRate {
                pre_allocated_vus, ..
            }
            | LoadExecutor::RampingArrivalRate {
                pre_allocated_vus, ..
            } => *pre_allocated_vus,
        }
    }
    pub fn maximum_vus(&self) -> u32 {
        match &self.executor {
            LoadExecutor::SharedIterations { vus, .. }
            | LoadExecutor::PerVuIterations { vus, .. }
            | LoadExecutor::ConstantVus { vus, .. } => *vus,
            LoadExecutor::RampingVus {
                start_vus, stages, ..
            } => stages
                .iter()
                .fold(*start_vus, |peak, stage| peak.max(stage.target)),
            LoadExecutor::ConstantArrivalRate {
                pre_allocated_vus,
                max_vus,
                ..
            }
            | LoadExecutor::RampingArrivalRate {
                pre_allocated_vus,
                max_vus,
                ..
            } => max_vus.unwrap_or(*pre_allocated_vus),
        }
    }
    /// Pico de chegadas por segundo para executores abertos. `None` significa
    /// que o executor é fechado ou finito, portanto não define uma taxa de
    /// chegada independente da duração das iterações.
    pub fn maximum_arrival_rate_per_second(&self) -> Option<f64> {
        match &self.executor {
            LoadExecutor::ConstantArrivalRate {
                rate, time_unit, ..
            } => Some(f64::from(*rate) / time_unit.as_secs_f64()),
            LoadExecutor::RampingArrivalRate {
                start_rate,
                time_unit,
                stages,
                ..
            } => Some(
                f64::from(
                    stages
                        .iter()
                        .fold(*start_rate, |peak, stage| peak.max(stage.target)),
                ) / time_unit.as_secs_f64(),
            ),
            LoadExecutor::SharedIterations { .. }
            | LoadExecutor::PerVuIterations { .. }
            | LoadExecutor::ConstantVus { .. }
            | LoadExecutor::RampingVus { .. } => None,
        }
    }
    pub fn iteration_limit(&self) -> Option<u64> {
        match self.executor {
            LoadExecutor::SharedIterations { iterations, .. } => Some(iterations),
            LoadExecutor::PerVuIterations {
                vus,
                iterations_per_vu,
                ..
            } => Some(u64::from(vus) * iterations_per_vu),
            _ => None,
        }
    }
    pub fn target_vus_at(&self, elapsed: Duration) -> u32 {
        match &self.executor {
            LoadExecutor::SharedIterations {
                vus, max_duration, ..
            }
            | LoadExecutor::PerVuIterations {
                vus, max_duration, ..
            } => {
                if max_duration.is_none_or(|duration| elapsed < duration) {
                    *vus
                } else {
                    0
                }
            }
            LoadExecutor::ConstantVus { vus, duration } => {
                if elapsed < *duration {
                    *vus
                } else {
                    0
                }
            }
            LoadExecutor::RampingVus {
                start_vus, stages, ..
            } => ramp_target(*start_vus, stages, elapsed),
            LoadExecutor::ConstantArrivalRate { .. } | LoadExecutor::RampingArrivalRate { .. } => 0,
        }
    }
    pub fn arrival(&self, ordinal: u64) -> Option<Arrival> {
        let (at, end) = match &self.executor {
            LoadExecutor::ConstantArrivalRate {
                rate,
                time_unit,
                duration,
                ..
            } => (
                Duration::try_from_secs_f64(
                    time_unit.as_secs_f64() * ordinal as f64 / f64::from(*rate),
                )
                .ok()?,
                *duration,
            ),
            LoadExecutor::RampingArrivalRate {
                start_rate,
                time_unit,
                stages,
                ..
            } => {
                let end: Duration = stages.iter().map(|stage| stage.duration).sum();
                let target = ordinal as f64 + 1.0;
                if expected_arrivals(end, *start_rate, *time_unit, stages) + f64::EPSILON < target {
                    return None;
                }
                let (mut low, mut high) = (0.0, end.as_secs_f64());
                for _ in 0..80 {
                    let middle = (low + high) / 2.0;
                    if expected_arrivals(
                        Duration::try_from_secs_f64(middle).ok()?,
                        *start_rate,
                        *time_unit,
                        stages,
                    ) >= target
                    {
                        high = middle;
                    } else {
                        low = middle;
                    }
                }
                (Duration::try_from_secs_f64(high).ok()?, end)
            }
            _ => return None,
        };
        (at < end).then_some(Arrival { ordinal, at })
    }
}

fn validate(executor: &LoadExecutor) -> Result<(), LoadScheduleError> {
    match executor {
        LoadExecutor::PerVuIterations {
            vus,
            iterations_per_vu,
            ..
        } => {
            u64::from(*vus)
                .checked_mul(*iterations_per_vu)
                .ok_or(LoadScheduleError::Overflow)?;
        }
        LoadExecutor::RampingVus {
            stages,
            graceful_ramp_down,
            ..
        } => {
            stage_duration(stages)?
                .checked_add(*graceful_ramp_down)
                .ok_or(LoadScheduleError::Overflow)?;
        }
        LoadExecutor::RampingArrivalRate { stages, .. } => {
            stage_duration(stages)?;
        }
        _ => {}
    }
    match executor {
        LoadExecutor::SharedIterations { vus, .. }
        | LoadExecutor::PerVuIterations { vus, .. }
        | LoadExecutor::ConstantVus { vus, .. }
            if *vus == 0 =>
        {
            Err(LoadScheduleError::ZeroVus)
        }
        LoadExecutor::SharedIterations {
            max_duration: Some(duration),
            ..
        }
        | LoadExecutor::PerVuIterations {
            max_duration: Some(duration),
            ..
        } if duration.is_zero() => Err(LoadScheduleError::ZeroDuration),
        LoadExecutor::ConstantVus { duration, .. }
        | LoadExecutor::ConstantArrivalRate { duration, .. }
            if duration.is_zero() =>
        {
            Err(LoadScheduleError::ZeroDuration)
        }
        LoadExecutor::RampingVus { stages, .. } => validate_stages(stages),
        LoadExecutor::ConstantArrivalRate {
            rate,
            time_unit,
            pre_allocated_vus,
            max_vus,
            ..
        } => validate_arrival(*rate, *time_unit, *pre_allocated_vus, *max_vus),
        LoadExecutor::RampingArrivalRate {
            start_rate,
            time_unit,
            stages,
            pre_allocated_vus,
            max_vus,
        } => {
            validate_arrival(*start_rate, *time_unit, *pre_allocated_vus, *max_vus)?;
            validate_stages(stages)
        }
        _ => Ok(()),
    }
}
fn validate_stages(stages: &[LoadStage]) -> Result<(), LoadScheduleError> {
    if stages.is_empty() {
        return Err(LoadScheduleError::EmptyStages);
    }
    if stages.iter().any(|stage| stage.duration.is_zero()) {
        return Err(LoadScheduleError::ZeroStageDuration);
    }
    Ok(())
}

fn stage_duration(stages: &[LoadStage]) -> Result<Duration, LoadScheduleError> {
    stages.iter().try_fold(Duration::ZERO, |total, stage| {
        total
            .checked_add(stage.duration)
            .ok_or(LoadScheduleError::Overflow)
    })
}
fn validate_arrival(
    rate: u32,
    time_unit: Duration,
    pre_allocated_vus: u32,
    max_vus: Option<u32>,
) -> Result<(), LoadScheduleError> {
    if rate == 0 {
        return Err(LoadScheduleError::ZeroRate);
    }
    if time_unit.is_zero() {
        return Err(LoadScheduleError::ZeroTimeUnit);
    }
    if pre_allocated_vus == 0 {
        return Err(LoadScheduleError::ZeroVus);
    }
    if max_vus.is_some_and(|max| max < pre_allocated_vus) {
        return Err(LoadScheduleError::InvalidMaxVus);
    }
    Ok(())
}
fn ramp_target(start: u32, stages: &[LoadStage], elapsed: Duration) -> u32 {
    let mut cursor = Duration::ZERO;
    let mut current = start;
    for stage in stages {
        let end = cursor + stage.duration;
        if elapsed < end {
            let fraction =
                elapsed.saturating_sub(cursor).as_secs_f64() / stage.duration.as_secs_f64();
            return (f64::from(current) + (f64::from(stage.target) - f64::from(current)) * fraction)
                .floor()
                .max(0.0) as u32;
        }
        cursor = end;
        current = stage.target;
    }
    0
}
fn expected_arrivals(
    elapsed: Duration,
    start_rate: u32,
    unit: Duration,
    stages: &[LoadStage],
) -> f64 {
    let mut cursor = Duration::ZERO;
    let mut current = f64::from(start_rate);
    let mut total = 0.0;
    for stage in stages {
        if elapsed <= cursor {
            break;
        }
        let interval = elapsed
            .min(cursor + stage.duration)
            .saturating_sub(cursor)
            .as_secs_f64();
        let target = f64::from(stage.target);
        let end_rate = current + (target - current) * interval / stage.duration.as_secs_f64();
        total += (current + end_rate) * interval / 2.0 / unit.as_secs_f64();
        if elapsed < cursor + stage.duration {
            break;
        }
        cursor += stage.duration;
        current = target;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seconds(value: u64) -> Duration {
        Duration::from_secs(value)
    }
    #[test]
    fn rejects_duration_and_iteration_overflow_without_panicking() {
        assert_eq!(
            LoadSchedule::new(LoadExecutor::PerVuIterations {
                vus: 2,
                iterations_per_vu: u64::MAX,
                max_duration: None,
            })
            .unwrap_err(),
            LoadScheduleError::Overflow
        );
        for graceful in [Duration::ZERO, Duration::from_secs(1)] {
            let stages = if graceful.is_zero() {
                vec![
                    LoadStage {
                        target: 1,
                        duration: Duration::MAX,
                    },
                    LoadStage {
                        target: 1,
                        duration: seconds(1),
                    },
                ]
            } else {
                vec![LoadStage {
                    target: 1,
                    duration: Duration::MAX,
                }]
            };
            assert_eq!(
                LoadSchedule::new(LoadExecutor::RampingVus {
                    start_vus: 1,
                    stages,
                    graceful_ramp_down: graceful,
                })
                .unwrap_err(),
                LoadScheduleError::Overflow
            );
        }
    }

    #[test]
    fn huge_arrival_ordinal_is_outside_the_schedule_without_panicking() {
        let schedule = LoadSchedule::new(LoadExecutor::ConstantArrivalRate {
            rate: 1,
            time_unit: Duration::MAX,
            duration: seconds(1),
            pre_allocated_vus: 1,
            max_vus: None,
        })
        .unwrap();
        assert_eq!(schedule.arrival(0).unwrap().at, Duration::ZERO);
        assert!(schedule.arrival(u64::MAX).is_none());
    }
    #[test]
    fn open_arrivals_keep_their_original_clock() {
        let schedule = LoadSchedule::new(LoadExecutor::ConstantArrivalRate {
            rate: 2,
            time_unit: seconds(1),
            duration: seconds(2),
            pre_allocated_vus: 1,
            max_vus: Some(2),
        })
        .unwrap();
        assert_eq!(schedule.arrival(0).unwrap().at, Duration::ZERO);
        assert_eq!(schedule.arrival(3).unwrap().at, Duration::from_millis(1500));
        assert!(schedule.arrival(4).is_none());
    }

    #[test]
    fn reports_only_the_peak_rate_of_open_executors() {
        let open = LoadSchedule::new(LoadExecutor::RampingArrivalRate {
            start_rate: 2,
            time_unit: Duration::from_millis(500),
            stages: vec![LoadStage {
                target: 5,
                duration: seconds(1),
            }],
            pre_allocated_vus: 1,
            max_vus: None,
        })
        .unwrap();
        let closed = LoadSchedule::new(LoadExecutor::ConstantVus {
            vus: 2,
            duration: seconds(1),
        })
        .unwrap();

        assert_eq!(open.maximum_arrival_rate_per_second(), Some(10.0));
        assert_eq!(closed.maximum_arrival_rate_per_second(), None);
    }
    #[test]
    fn closed_ramp_has_a_virtual_clock_target() {
        let schedule = LoadSchedule::new(LoadExecutor::RampingVus {
            start_vus: 1,
            stages: vec![LoadStage {
                target: 5,
                duration: seconds(4),
            }],
            graceful_ramp_down: seconds(1),
        })
        .unwrap();
        assert_eq!(schedule.target_vus_at(seconds(2)), 3);
        assert_eq!(schedule.target_vus_at(seconds(4)), 0);
        assert_eq!(schedule.scheduled_end(), Some(seconds(5)));
        assert!(!schedule.is_scheduling_at(seconds(4)));
    }

    #[test]
    fn finite_executor_stops_scheduling_at_max_duration() {
        let schedule = LoadSchedule::new(LoadExecutor::SharedIterations {
            vus: 2,
            iterations: 10,
            max_duration: Some(seconds(3)),
        })
        .unwrap();

        assert_eq!(schedule.target_vus_at(seconds(2)), 2);
        assert_eq!(schedule.target_vus_at(seconds(3)), 0);
        assert_eq!(schedule.scheduled_end(), Some(seconds(3)));
    }

    #[test]
    fn zero_duration_is_rejected_for_time_bounded_executors() {
        let error = LoadSchedule::new(LoadExecutor::ConstantVus {
            vus: 1,
            duration: Duration::ZERO,
        })
        .unwrap_err();
        assert_eq!(error, LoadScheduleError::ZeroDuration);
    }
}
