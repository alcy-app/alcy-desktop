//! Métricas agregadas do runner independente de carga.
//!
//! Séries de tendência mantêm somente seus agregados na memória. As amostras
//! numéricas seguem para arquivos temporários, para que percentis exatos não
//! façam o consumo de memória crescer com a quantidade de requests.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap};
use std::fs::{File, OpenOptions, remove_file};
use std::io::{BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use thiserror::Error;

/// Protege o histórico e o IPC contra explosão de cardinalidade por tags.
pub const MAX_LOAD_METRIC_SERIES: usize = 1_000;
const TREND_SORT_CHUNK_VALUES: usize = 4_096;
/// Cada passagem de merge abre no máximo estes inputs e um output.
const TREND_MERGE_FAN_IN: usize = 32;
static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadMetricKind {
    Counter,
    Gauge,
    Rate,
    Trend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadMetricSelector {
    pub name: String,
    /// Tags requeridas; uma série pode ter tags adicionais.
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadMetricStatistic {
    Count,
    Value,
    Rate,
    Average,
    Minimum,
    Maximum,
    P90,
    P95,
    P99,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadThresholdComparison {
    LessThan,
    LessOrEqual,
    GreaterThan,
    GreaterOrEqual,
    Equal,
    NotEqual,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadThreshold {
    pub selector: LoadMetricSelector,
    pub statistic: LoadMetricStatistic,
    pub comparison: LoadThresholdComparison,
    pub target: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadThresholdResult {
    pub threshold: LoadThreshold,
    pub actual: Option<f64>,
    pub passed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadMetricSnapshot {
    pub selector: LoadMetricSelector,
    pub kind: LoadMetricKind,
    /// Quantidade de emissões. Para Counter, a soma usada por `count` em
    /// thresholds está em `value`, e pode diferir desta quantidade.
    pub count: u64,
    pub value: f64,
    pub average: Option<f64>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    /// Percentis exatos de séries Trend. Tipos sem amostras ordenáveis
    /// permanecem `None`, sem transformar ausência em zero.
    pub p90: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
}

#[derive(Debug, Error)]
pub enum LoadMetricError {
    #[error("métrica precisa ter nome")]
    EmptyName,
    #[error("valor da métrica precisa ser finito")]
    NonFiniteValue,
    #[error("Counter não aceita valor negativo")]
    NegativeCounter,
    #[error("Rate aceita somente 0 ou 1")]
    InvalidRate,
    #[error("agregação da métrica excedeu um valor finito")]
    AggregateOverflow,
    #[error("a métrica '{name}' já existe com outro tipo")]
    KindMismatch { name: String },
    #[error("limite de {MAX_LOAD_METRIC_SERIES} séries de métricas excedido")]
    CardinalityLimit,
    #[error("limite de {limit} bytes de amostras Trend excedido")]
    SampleStorageLimit { limit: u64 },
    #[error("não há valores para avaliar a métrica '{name}'")]
    NoValues { name: String },
    #[error("não foi possível usar amostras temporárias: {0}")]
    TemporaryStorage(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct MetricKey {
    name: String,
    tags: BTreeMap<String, String>,
}

#[derive(Debug)]
enum MetricSeries {
    Counter {
        value: f64,
        count: u64,
    },
    Gauge {
        value: f64,
        sequence: u64,
        count: u64,
        minimum: f64,
        maximum: f64,
    },
    Rate {
        passed: u64,
        total: u64,
    },
    Trend {
        count: u64,
        sum: f64,
        minimum: f64,
        maximum: f64,
        samples: TrendSamples,
    },
}

impl MetricSeries {
    fn kind(&self) -> LoadMetricKind {
        match self {
            Self::Counter { .. } => LoadMetricKind::Counter,
            Self::Gauge { .. } => LoadMetricKind::Gauge,
            Self::Rate { .. } => LoadMetricKind::Rate,
            Self::Trend { .. } => LoadMetricKind::Trend,
        }
    }

    fn count(&self) -> u64 {
        match self {
            Self::Counter { count, .. } | Self::Gauge { count, .. } | Self::Trend { count, .. } => {
                *count
            }
            Self::Rate { total, .. } => *total,
        }
    }
}

/// Registro de séries de uma execução. Não é `Clone`: os arquivos de amostra
/// pertencem exclusivamente ao registro e são removidos no `Drop`.
#[derive(Debug)]
pub struct LoadMetricRegistry {
    series: BTreeMap<MetricKey, MetricSeries>,
    sequence: u64,
    sample_bytes: u64,
    max_sample_bytes: u64,
}

impl Default for LoadMetricRegistry {
    fn default() -> Self {
        Self::with_sample_budget(crate::LoadRunLimits::default().max_trend_sample_bytes)
    }
}

impl LoadMetricRegistry {
    pub fn with_sample_budget(max_sample_bytes: u64) -> Self {
        Self {
            series: BTreeMap::new(),
            sequence: 0,
            sample_bytes: 0,
            max_sample_bytes,
        }
    }

    pub fn record(
        &mut self,
        name: impl Into<String>,
        kind: LoadMetricKind,
        tags: BTreeMap<String, String>,
        value: f64,
    ) -> Result<(), LoadMetricError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(LoadMetricError::EmptyName);
        }
        if !value.is_finite() {
            return Err(LoadMetricError::NonFiniteValue);
        }
        if kind == LoadMetricKind::Counter && value < 0.0 {
            return Err(LoadMetricError::NegativeCounter);
        }
        if kind == LoadMetricKind::Rate && !matches!(value, 0.0 | 1.0) {
            return Err(LoadMetricError::InvalidRate);
        }
        if kind == LoadMetricKind::Trend
            && self
                .sample_bytes
                .checked_add(8)
                .is_none_or(|bytes| bytes > self.max_sample_bytes)
        {
            return Err(LoadMetricError::SampleStorageLimit {
                limit: self.max_sample_bytes,
            });
        }

        let key = MetricKey { name, tags };
        self.sequence = self.sequence.saturating_add(1);
        if let Some(series) = self.series.get_mut(&key) {
            if series.kind() != kind {
                return Err(LoadMetricError::KindMismatch { name: key.name });
            }
            match series {
                MetricSeries::Counter {
                    value: current,
                    count,
                } => {
                    let next = *current + value;
                    if !next.is_finite() {
                        return Err(LoadMetricError::AggregateOverflow);
                    }
                    *current = next;
                    *count = count.saturating_add(1);
                }
                MetricSeries::Gauge {
                    value: current,
                    sequence,
                    count,
                    minimum,
                    maximum,
                } => {
                    *current = value;
                    *sequence = self.sequence;
                    *count = count.saturating_add(1);
                    *minimum = minimum.min(value);
                    *maximum = maximum.max(value);
                }
                MetricSeries::Rate { passed, total } => {
                    *passed = passed.saturating_add(u64::from(value == 1.0));
                    *total = total.saturating_add(1);
                }
                MetricSeries::Trend {
                    count,
                    sum,
                    minimum,
                    maximum,
                    samples,
                } => {
                    let next = *sum + value;
                    if !next.is_finite() {
                        return Err(LoadMetricError::AggregateOverflow);
                    }
                    samples.append(value)?;
                    self.sample_bytes += 8;
                    *count = count.saturating_add(1);
                    *sum = next;
                    *minimum = minimum.min(value);
                    *maximum = maximum.max(value);
                }
            }
            return Ok(());
        }

        if self.series.len() >= MAX_LOAD_METRIC_SERIES {
            return Err(LoadMetricError::CardinalityLimit);
        }
        let series = match kind {
            LoadMetricKind::Counter => MetricSeries::Counter { value, count: 1 },
            LoadMetricKind::Gauge => MetricSeries::Gauge {
                value,
                sequence: self.sequence,
                count: 1,
                minimum: value,
                maximum: value,
            },
            LoadMetricKind::Rate => MetricSeries::Rate {
                passed: u64::from(value == 1.0),
                total: 1,
            },
            LoadMetricKind::Trend => {
                let mut samples = TrendSamples::new()?;
                samples.append(value)?;
                self.sample_bytes += 8;
                MetricSeries::Trend {
                    count: 1,
                    sum: value,
                    minimum: value,
                    maximum: value,
                    samples,
                }
            }
        };
        self.series.insert(key, series);
        Ok(())
    }

    pub fn snapshots(&self) -> Result<Vec<LoadMetricSnapshot>, LoadMetricError> {
        let mut snapshots = Vec::with_capacity(self.series.len());
        for (key, series) in &self.series {
            let (p90, p95, p99) = if matches!(series, MetricSeries::Trend { .. }) {
                let current = [(key, series)];
                (
                    Some(trend_percentile(&current, 90.0)?),
                    Some(trend_percentile(&current, 95.0)?),
                    Some(trend_percentile(&current, 99.0)?),
                )
            } else {
                (None, None, None)
            };
            let (value, average, minimum, maximum, p90, p95, p99) = match series {
                MetricSeries::Counter { value, .. } => (*value, None, None, None, None, None, None),
                MetricSeries::Gauge {
                    value,
                    minimum,
                    maximum,
                    ..
                } => (
                    *value,
                    None,
                    Some(*minimum),
                    Some(*maximum),
                    None,
                    None,
                    None,
                ),
                MetricSeries::Rate { passed, total } => {
                    (rate(*passed, *total), None, None, None, None, None, None)
                }
                MetricSeries::Trend {
                    count,
                    sum,
                    minimum,
                    maximum,
                    ..
                } => (
                    *sum / *count as f64,
                    Some(*sum / *count as f64),
                    Some(*minimum),
                    Some(*maximum),
                    p90,
                    p95,
                    p99,
                ),
            };
            snapshots.push(LoadMetricSnapshot {
                selector: LoadMetricSelector {
                    name: key.name.clone(),
                    tags: key.tags.clone(),
                },
                kind: series.kind(),
                count: series.count(),
                value,
                average,
                minimum,
                maximum,
                p90,
                p95,
                p99,
            });
        }
        Ok(snapshots)
    }

    pub fn evaluate(
        &self,
        threshold: LoadThreshold,
    ) -> Result<LoadThresholdResult, LoadMetricError> {
        if !threshold.target.is_finite() {
            return Err(LoadMetricError::NonFiniteValue);
        }
        let matching = self
            .series
            .iter()
            .filter(|(key, _)| matches_selector(key, &threshold.selector))
            .collect::<Vec<_>>();
        let actual = metric_statistic(&threshold.selector.name, &matching, threshold.statistic)?;
        let passed = compare(actual, threshold.comparison, threshold.target);
        Ok(LoadThresholdResult {
            threshold,
            actual: Some(actual),
            passed,
        })
    }
}

fn matches_selector(key: &MetricKey, selector: &LoadMetricSelector) -> bool {
    key.name == selector.name
        && selector
            .tags
            .iter()
            .all(|(name, value)| key.tags.get(name) == Some(value))
}

fn metric_statistic(
    name: &str,
    series: &[(&MetricKey, &MetricSeries)],
    statistic: LoadMetricStatistic,
) -> Result<f64, LoadMetricError> {
    let Some((_, first)) = series.first() else {
        return Err(LoadMetricError::NoValues {
            name: name.to_string(),
        });
    };
    let kind = first.kind();
    if series.iter().any(|(_, value)| value.kind() != kind) {
        return Err(LoadMetricError::KindMismatch {
            name: name.to_string(),
        });
    }
    match statistic {
        LoadMetricStatistic::Count if kind == LoadMetricKind::Counter => {
            metric_statistic(name, series, LoadMetricStatistic::Value)
        }
        LoadMetricStatistic::Count => {
            Ok(series.iter().map(|(_, value)| value.count()).sum::<u64>() as f64)
        }
        LoadMetricStatistic::Value => match kind {
            LoadMetricKind::Counter => Ok(series
                .iter()
                .filter_map(|(_, series)| match series {
                    MetricSeries::Counter { value, .. } => Some(*value),
                    _ => None,
                })
                .sum()),
            LoadMetricKind::Gauge => series
                .iter()
                .filter_map(|(_, series)| match series {
                    MetricSeries::Gauge {
                        value, sequence, ..
                    } => Some((*value, *sequence)),
                    _ => None,
                })
                .max_by_key(|(_, sequence)| *sequence)
                .map(|(value, _)| value)
                .ok_or_else(|| LoadMetricError::NoValues {
                    name: name.to_string(),
                }),
            LoadMetricKind::Rate => {
                let (passed, total) = series.iter().fold(
                    (0_u64, 0_u64),
                    |(passed, total), (_, series)| match series {
                        MetricSeries::Rate {
                            passed: current,
                            total: count,
                        } => (
                            passed.saturating_add(*current),
                            total.saturating_add(*count),
                        ),
                        _ => (passed, total),
                    },
                );
                Ok(rate(passed, total))
            }
            LoadMetricKind::Trend => trend_average(series, name),
        },
        LoadMetricStatistic::Rate if kind == LoadMetricKind::Rate => {
            metric_statistic(name, series, LoadMetricStatistic::Value)
        }
        LoadMetricStatistic::Average if kind == LoadMetricKind::Trend => {
            trend_average(series, name)
        }
        LoadMetricStatistic::Minimum if kind == LoadMetricKind::Trend => {
            trend_bound(series, name, true)
        }
        LoadMetricStatistic::Maximum if kind == LoadMetricKind::Trend => {
            trend_bound(series, name, false)
        }
        LoadMetricStatistic::P90 if kind == LoadMetricKind::Trend => trend_percentile(series, 90.0),
        LoadMetricStatistic::P95 if kind == LoadMetricKind::Trend => trend_percentile(series, 95.0),
        LoadMetricStatistic::P99 if kind == LoadMetricKind::Trend => trend_percentile(series, 99.0),
        _ => Err(LoadMetricError::KindMismatch {
            name: name.to_string(),
        }),
    }
}

fn trend_average(
    series: &[(&MetricKey, &MetricSeries)],
    name: &str,
) -> Result<f64, LoadMetricError> {
    let (count, sum) = series
        .iter()
        .fold((0_u64, 0.0), |(count, sum), (_, series)| match series {
            MetricSeries::Trend {
                count: current,
                sum: value,
                ..
            } => (count.saturating_add(*current), sum + value),
            _ => (count, sum),
        });
    (count > 0)
        .then_some(sum / count as f64)
        .ok_or_else(|| LoadMetricError::NoValues {
            name: name.to_string(),
        })
}

fn trend_bound(
    series: &[(&MetricKey, &MetricSeries)],
    name: &str,
    minimum: bool,
) -> Result<f64, LoadMetricError> {
    series
        .iter()
        .filter_map(|(_, series)| match series {
            MetricSeries::Trend { minimum: value, .. } if minimum => Some(*value),
            MetricSeries::Trend { maximum: value, .. } => Some(*value),
            _ => None,
        })
        .reduce(|left, right| {
            if minimum {
                left.min(right)
            } else {
                left.max(right)
            }
        })
        .ok_or_else(|| LoadMetricError::NoValues {
            name: name.to_string(),
        })
}

fn trend_percentile(
    series: &[(&MetricKey, &MetricSeries)],
    percentile: f64,
) -> Result<f64, LoadMetricError> {
    let samples = series
        .iter()
        .filter_map(|(_, series)| match series {
            MetricSeries::Trend { samples, .. } => Some(samples),
            _ => None,
        })
        .collect::<Vec<_>>();
    percentile_from_samples(&samples, percentile).map_err(LoadMetricError::from)
}

fn rate(passed: u64, total: u64) -> f64 {
    if total > 0 {
        passed as f64 / total as f64
    } else {
        0.0
    }
}

fn compare(actual: f64, comparison: LoadThresholdComparison, target: f64) -> bool {
    match comparison {
        LoadThresholdComparison::LessThan => actual < target,
        LoadThresholdComparison::LessOrEqual => actual <= target,
        LoadThresholdComparison::GreaterThan => actual > target,
        LoadThresholdComparison::GreaterOrEqual => actual >= target,
        LoadThresholdComparison::Equal => actual == target,
        LoadThresholdComparison::NotEqual => actual != target,
    }
}

#[derive(Debug)]
struct TrendSamples {
    // Campos são descartados na ordem declarada: fecha antes de remover,
    // inclusive no Windows. O guard também cobre falhas de escrita.
    file: File,
    path: TemporaryPath,
}

impl TrendSamples {
    fn new() -> Result<Self, std::io::Error> {
        let (path, file) = create_temporary_file("samples")?;
        Ok(Self {
            file,
            path: TemporaryPath(path),
        })
    }

    fn append(&mut self, value: f64) -> Result<(), std::io::Error> {
        self.file.write_all(&value.to_le_bytes())
    }
}

#[derive(Debug)]
struct TemporaryPath(PathBuf);

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        let _ = remove_file(&self.0);
    }
}

fn percentile_from_samples(
    samples: &[&TrendSamples],
    percentile: f64,
) -> Result<f64, std::io::Error> {
    let count = samples
        .iter()
        .map(|sample| sample.file.metadata().map(|metadata| metadata.len() / 8))
        .sum::<Result<u64, _>>()?;
    if count == 0 {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "sem amostras"));
    }
    let position = (percentile / 100.0) * (count - 1) as f64;
    let lower_rank = position.floor() as u64;
    let upper_rank = position.ceil() as u64;
    let runs = compact_sorted_runs(create_sorted_runs(samples)?)?;
    let (lower, upper) = merge_ranks(&runs.paths, lower_rank, upper_rank)?;
    Ok(lower + (upper - lower) * (position - position.floor()))
}

#[derive(Debug, Default)]
struct TemporaryRuns {
    paths: Vec<PathBuf>,
}

impl Drop for TemporaryRuns {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = remove_file(path);
        }
    }
}

fn create_sorted_runs(samples: &[&TrendSamples]) -> Result<TemporaryRuns, std::io::Error> {
    create_sorted_runs_using(samples, create_temporary_file)
}

fn create_sorted_runs_using(
    samples: &[&TrendSamples],
    mut create: impl FnMut(&str) -> Result<(PathBuf, File), std::io::Error>,
) -> Result<TemporaryRuns, std::io::Error> {
    let mut runs = TemporaryRuns::default();
    for sample in samples {
        let mut source = BufReader::new(File::open(&sample.path.0)?);
        loop {
            let mut values = Vec::with_capacity(TREND_SORT_CHUNK_VALUES);
            for _ in 0..TREND_SORT_CHUNK_VALUES {
                match read_f64(&mut source)? {
                    Some(value) => values.push(value),
                    None => break,
                }
            }
            if values.is_empty() {
                break;
            }
            values.sort_by(f64::total_cmp);
            let (path, file) = create("run")?;
            // Registrar antes da primeira escrita garante limpeza se ela falhar.
            runs.paths.push(path);
            let mut run = BufWriter::new(file);
            for value in values {
                run.write_all(&value.to_le_bytes())?;
            }
            run.flush()?;
        }
    }
    Ok(runs)
}

fn compact_sorted_runs(mut runs: TemporaryRuns) -> Result<TemporaryRuns, std::io::Error> {
    while runs.paths.len() > TREND_MERGE_FAN_IN {
        let mut next = TemporaryRuns::default();
        for group in runs.paths.chunks(TREND_MERGE_FAN_IN) {
            let (path, file) = create_temporary_file("merge")?;
            next.paths.push(path);
            let mut output = BufWriter::new(file);
            let (mut readers, mut heap) = open_runs(group)?;
            while let Some(current) = heap.pop() {
                output.write_all(&current.value.to_le_bytes())?;
                if let Some(value) = read_f64(&mut readers[current.run])? {
                    heap.push(HeapValue {
                        value,
                        run: current.run,
                    });
                }
            }
            output.flush()?;
        }
        // Os readers/outputs já fecharam; a geração anterior é removida aqui.
        runs = next;
    }
    Ok(runs)
}

fn create_temporary_file(kind: &str) -> Result<(PathBuf, File), std::io::Error> {
    for _ in 0..128 {
        let index = NEXT_TEMPORARY_FILE.fetch_add(1, AtomicOrdering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("alcy-load-{}-{index}.{kind}", std::process::id()));
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "não foi possível criar arquivo temporário único",
    ))
}

fn read_f64(file: &mut impl Read) -> Result<Option<f64>, std::io::Error> {
    let mut bytes = [0_u8; 8];
    match file.read_exact(&mut bytes[..1]) {
        Ok(()) => {
            // EOF depois do primeiro byte é corrupção, não fim limpo.
            file.read_exact(&mut bytes[1..])?;
            Ok(Some(f64::from_le_bytes(bytes)))
        }
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Debug)]
struct HeapValue {
    value: f64,
    run: usize,
}

impl PartialEq for HeapValue {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value && self.run == other.run
    }
}
impl Eq for HeapValue {}
impl PartialOrd for HeapValue {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for HeapValue {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .value
            .total_cmp(&self.value)
            .then_with(|| other.run.cmp(&self.run))
    }
}

fn merge_ranks(
    paths: &[PathBuf],
    lower_rank: u64,
    upper_rank: u64,
) -> Result<(f64, f64), std::io::Error> {
    let (mut readers, mut heap) = open_runs(paths)?;
    let mut lower = None;
    for index in 0..=upper_rank {
        let Some(current) = heap.pop() else {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "amostras incompletas",
            ));
        };
        if index == lower_rank {
            lower = Some(current.value);
        }
        if index == upper_rank {
            return lower
                .map(|lower| (lower, current.value))
                .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidData, "rank inválido"));
        }
        if let Some(value) = read_f64(&mut readers[current.run])? {
            heap.push(HeapValue {
                value,
                run: current.run,
            });
        }
    }
    Err(std::io::Error::new(ErrorKind::InvalidData, "rank inválido"))
}

fn open_runs(
    paths: &[PathBuf],
) -> Result<(Vec<BufReader<File>>, BinaryHeap<HeapValue>), std::io::Error> {
    if paths.len() > TREND_MERGE_FAN_IN {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "fan-in de merge excedido",
        ));
    }
    let mut readers = paths
        .iter()
        .map(|path| File::open(path).map(BufReader::new))
        .collect::<Result<Vec<_>, _>>()?;
    let mut heap = BinaryHeap::new();
    for (run, reader) in readers.iter_mut().enumerate() {
        if let Some(value) = read_f64(reader)? {
            heap.push(HeapValue { value, run });
        }
    }
    Ok((readers, heap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_budget_is_shared_and_failed_records_do_not_change_aggregates() {
        let mut registry = LoadMetricRegistry::with_sample_budget(16);
        registry
            .record("latency", LoadMetricKind::Trend, tags(&[("s", "a")]), 1.0)
            .unwrap();
        registry
            .record("latency", LoadMetricKind::Trend, tags(&[("s", "b")]), 2.0)
            .unwrap();
        assert!(matches!(
            registry.record("latency", LoadMetricKind::Trend, tags(&[("s", "a")]), 3.0),
            Err(LoadMetricError::SampleStorageLimit { limit: 16 })
        ));
        assert_eq!(
            registry
                .snapshots()
                .unwrap()
                .iter()
                .map(|s| s.count)
                .sum::<u64>(),
            2
        );
        let paths: Vec<_> = registry
            .series
            .values()
            .filter_map(|s| match s {
                MetricSeries::Trend { samples, .. } => Some(samples.path.0.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            paths
                .iter()
                .map(|p| std::fs::metadata(p).unwrap().len())
                .sum::<u64>(),
            16
        );
        // O limite de amostras não afeta counters sem armazenamento em disco.
        registry
            .record("events", LoadMetricKind::Counter, BTreeMap::new(), 1.0)
            .unwrap();
        drop(registry);
        assert!(paths.iter().all(|path| !path.exists()));
    }

    #[test]
    fn percentile_uses_bounded_merge_and_preserves_exact_interpolation() {
        let mut samples = TrendSamples::new().unwrap();
        let count = TREND_SORT_CHUNK_VALUES * (TREND_MERGE_FAN_IN + 1) + 1;
        for value in (0..count).rev() {
            samples.append(value as f64).unwrap();
        }
        let runs = create_sorted_runs(&[&samples]).unwrap();
        assert!(runs.paths.len() > TREND_MERGE_FAN_IN);
        assert!(open_runs(&runs.paths).is_err());
        let previous_paths = runs.paths.clone();
        let compact = compact_sorted_runs(runs).unwrap();
        assert!(compact.paths.len() <= TREND_MERGE_FAN_IN);
        assert!(previous_paths.iter().all(|path| !path.exists()));
        let compact_paths = compact.paths.clone();
        drop(compact);
        assert!(compact_paths.iter().all(|path| !path.exists()));
        assert_eq!(
            percentile_from_samples(&[&samples], 95.0).unwrap(),
            0.95 * (count - 1) as f64
        );
    }

    #[test]
    fn sorted_run_failure_removes_files_from_previous_chunks() {
        let mut samples = TrendSamples::new().unwrap();
        for value in 0..=TREND_SORT_CHUNK_VALUES {
            samples.append(value as f64).unwrap();
        }
        let mut created = vec![];
        let result = create_sorted_runs_using(&[&samples], |kind| {
            if !created.is_empty() {
                return Err(std::io::Error::other("falha simulada de criação"));
            }
            let (path, file) = create_temporary_file(kind)?;
            created.push(path.clone());
            Ok((path, file))
        });
        assert!(result.is_err());
        assert_eq!(created.len(), 1);
        assert!(!created[0].exists());
    }

    #[test]
    fn truncated_sample_is_not_silently_ignored() {
        let mut clean = std::io::Cursor::new(Vec::<u8>::new());
        assert_eq!(read_f64(&mut clean).unwrap(), None);
        let mut partial = std::io::Cursor::new(vec![0; 7]);
        assert_eq!(
            read_f64(&mut partial).unwrap_err().kind(),
            ErrorKind::UnexpectedEof
        );
    }

    fn tags(values: &[(&str, &str)]) -> BTreeMap<String, String> {
        values
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn aggregates_counter_gauge_and_rate_with_tag_filters() {
        let mut registry = LoadMetricRegistry::default();
        registry
            .record(
                "requests",
                LoadMetricKind::Counter,
                tags(&[("kind", "api")]),
                2.0,
            )
            .unwrap();
        registry
            .record(
                "requests",
                LoadMetricKind::Counter,
                tags(&[("kind", "api")]),
                3.0,
            )
            .unwrap();
        registry
            .record(
                "success",
                LoadMetricKind::Rate,
                tags(&[("kind", "api")]),
                1.0,
            )
            .unwrap();
        registry
            .record(
                "success",
                LoadMetricKind::Rate,
                tags(&[("kind", "api")]),
                0.0,
            )
            .unwrap();

        let counter = registry
            .evaluate(LoadThreshold {
                selector: LoadMetricSelector {
                    name: "requests".to_string(),
                    tags: tags(&[("kind", "api")]),
                },
                statistic: LoadMetricStatistic::Value,
                comparison: LoadThresholdComparison::Equal,
                target: 5.0,
            })
            .unwrap();
        assert!(counter.passed);

        let rate = registry
            .evaluate(LoadThreshold {
                selector: LoadMetricSelector {
                    name: "success".to_string(),
                    tags: BTreeMap::new(),
                },
                statistic: LoadMetricStatistic::Rate,
                comparison: LoadThresholdComparison::GreaterOrEqual,
                target: 0.5,
            })
            .unwrap();
        assert_eq!(rate.actual, Some(0.5));
        assert!(rate.passed);
    }

    #[test]
    fn evaluates_exact_percentiles_from_temporary_trend_samples() {
        let mut registry = LoadMetricRegistry::default();
        for value in 1..=100 {
            registry
                .record(
                    "latency",
                    LoadMetricKind::Trend,
                    BTreeMap::new(),
                    value as f64,
                )
                .unwrap();
        }
        let result = registry
            .evaluate(LoadThreshold {
                selector: LoadMetricSelector {
                    name: "latency".to_string(),
                    tags: BTreeMap::new(),
                },
                statistic: LoadMetricStatistic::P95,
                comparison: LoadThresholdComparison::LessOrEqual,
                target: 95.05,
            })
            .unwrap();
        assert_eq!(result.actual, Some(95.05));
        assert!(result.passed);
    }

    #[test]
    fn counter_count_is_the_sum_of_values_across_matching_tags() {
        let mut registry = LoadMetricRegistry::default();
        for (group, value) in [("a", 2.0), ("b", 3.0)] {
            registry
                .record(
                    "items",
                    LoadMetricKind::Counter,
                    tags(&[("group", group)]),
                    value,
                )
                .unwrap();
        }
        let result = registry
            .evaluate(LoadThreshold {
                selector: LoadMetricSelector {
                    name: "items".to_string(),
                    tags: BTreeMap::new(),
                },
                statistic: LoadMetricStatistic::Count,
                comparison: LoadThresholdComparison::Equal,
                target: 5.0,
            })
            .unwrap();
        assert_eq!(result.actual, Some(5.0));
        assert!(result.passed);
        assert_eq!(
            registry
                .snapshots()
                .unwrap()
                .iter()
                .map(|series| series.count)
                .sum::<u64>(),
            2
        );
    }

    #[test]
    fn percentiles_interpolate_across_series_and_preserve_single_samples() {
        let mut registry = LoadMetricRegistry::default();
        registry
            .record(
                "latency",
                LoadMetricKind::Trend,
                tags(&[("group", "a")]),
                0.0,
            )
            .unwrap();
        registry
            .record(
                "latency",
                LoadMetricKind::Trend,
                tags(&[("group", "b")]),
                100.0,
            )
            .unwrap();
        for (statistic, expected) in [
            (LoadMetricStatistic::P90, 90.0),
            (LoadMetricStatistic::P95, 95.0),
            (LoadMetricStatistic::P99, 99.0),
        ] {
            let result = registry
                .evaluate(LoadThreshold {
                    selector: LoadMetricSelector {
                        name: "latency".to_string(),
                        tags: BTreeMap::new(),
                    },
                    statistic,
                    comparison: LoadThresholdComparison::Equal,
                    target: expected,
                })
                .unwrap();
            assert_eq!(result.actual, Some(expected));
            assert!(result.passed);
        }
        let result = registry
            .evaluate(LoadThreshold {
                selector: LoadMetricSelector {
                    name: "latency".to_string(),
                    tags: tags(&[("group", "b")]),
                },
                statistic: LoadMetricStatistic::P95,
                comparison: LoadThresholdComparison::Equal,
                target: 100.0,
            })
            .unwrap();
        assert!(result.passed);
        let snapshot = registry
            .snapshots()
            .unwrap()
            .into_iter()
            .find(|metric| metric.selector.tags == tags(&[("group", "b")]))
            .unwrap();
        assert_eq!(
            (snapshot.p90, snapshot.p95, snapshot.p99),
            (Some(100.0), Some(100.0), Some(100.0))
        );
    }

    #[test]
    fn rejects_invalid_rate_and_non_finite_values() {
        let mut registry = LoadMetricRegistry::default();
        assert!(matches!(
            registry.record("rate", LoadMetricKind::Rate, BTreeMap::new(), 0.5),
            Err(LoadMetricError::InvalidRate)
        ));
        assert!(matches!(
            registry.record("trend", LoadMetricKind::Trend, BTreeMap::new(), f64::NAN),
            Err(LoadMetricError::NonFiniteValue)
        ));
    }
}
