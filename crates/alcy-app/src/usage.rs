//! Usage events (spec 0142, ADR 0068): small, typed facts about how the app
//! is used (a request ran, a mock started, a shortcut changed…).
//!
//! The app records them through a [`UsageHub`]. The hub forwards them to a
//! [`UsageEventSink`] registered by a downstream extension; this repository
//! ships none, so every event is dropped and nothing leaves the machine.
//!
//! Events carry only closed enums, counters, durations and identifiers
//! defined in code. They never carry URLs, hosts, bodies, headers, variable
//! values or names typed by the user, and nothing that links them: each event
//! has its own random id and only the local date, never a time of day.
//! Durations measure latency or performance (a request, a flow, a load test,
//! the app's startup), never how long someone used the app.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alcy_domain::{FlowExecutionKind, ProtocolId};
use serde_json::{Map, Value, json};

/// Version of the JSON produced by [`UsageEnvelope::to_json`].
pub const USAGE_EVENT_SCHEMA_VERSION: u32 = 1;

/// Longest code identifier accepted in an event (`action`, `category`…).
pub const MAX_USAGE_IDENTIFIER_LEN: usize = 64;

/// Events of this run kept for the person to see in Settings > Telemetry.
pub const MAX_RECENT_USAGE_EVENTS: usize = 200;

/// Valid local time offsets from UTC, in minutes (UTC−14:00 to UTC+14:00).
pub const UTC_OFFSET_RANGE_MINUTES: std::ops::RangeInclusive<i32> = -840..=840;

/// Mock hits are grouped and emitted at most this often (plus when a server
/// stops and when the app closes): a load test can hit a mock thousands of
/// times per second.
const MOCK_HITS_FLUSH_INTERVAL: Duration = Duration::from_secs(60);

/// Closed outcome of a run, an import or a sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

impl UsageOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// HTTP status bucket; `Error` when no response arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StatusClass {
    Informational,
    Success,
    Redirection,
    ClientError,
    ServerError,
    Error,
}

impl StatusClass {
    pub fn from_status(status: u16) -> Self {
        match status {
            100..=199 => Self::Informational,
            200..=299 => Self::Success,
            300..=399 => Self::Redirection,
            400..=499 => Self::ClientError,
            500..=599 => Self::ServerError,
            _ => Self::Error,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Informational => "1xx",
            Self::Success => "2xx",
            Self::Redirection => "3xx",
            Self::ClientError => "4xx",
            Self::ServerError => "5xx",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceOpenKind {
    Opened,
    Created,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MockServerOrigin {
    /// A mock saved in the workspace, started by the person or a flow.
    Saved,
    /// A mock defined inline in a flow block.
    FlowInline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorChange {
    Created,
    Enabled,
    Disabled,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutChange {
    Assigned,
    Removed,
    Reset,
    ResetAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportSource {
    File,
    Text,
    Url,
}

/// One request sent from a request tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestExecuted {
    pub protocol: ProtocolId,
    /// HTTP method, GraphQL operation type or gRPC/WebSocket call kind; a
    /// code identifier, never user text.
    pub operation: Option<UsageIdentifier>,
    pub status_class: StatusClass,
    /// Serde tag of the error returned to the interface (`timeout`,
    /// `network`…), when the request failed.
    pub error_kind: Option<UsageIdentifier>,
    /// Typed cause of a network error (`hostNotFound`, `tls`…).
    pub error_cause: Option<UsageIdentifier>,
    pub duration_ms: u64,
}

/// A code identifier: ASCII letters, digits and `_ . : -`, at most
/// [`MAX_USAGE_IDENTIFIER_LEN`] characters. Rejects anything that could be
/// free text typed by the user.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UsageIdentifier(String);

impl UsageIdentifier {
    pub fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        let valid = !value.is_empty()
            && value.len() <= MAX_USAGE_IDENTIFIER_LEN
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte));
        valid.then_some(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Everything the app records (catalogue v1, spec 0142).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsageEvent {
    AppOpened {
        startup_ms: u64,
    },
    AppClosed,
    WorkspaceOpened {
        kind: WorkspaceOpenKind,
    },
    RequestExecuted(RequestExecuted),
    CollectionRunFinished {
        iterations: u64,
        requests: u64,
        failed: u64,
        duration_ms: u64,
        outcome: UsageOutcome,
    },
    FlowRunStarted {
        kind: FlowExecutionKind,
        node_count: u64,
        uses_mocks: bool,
    },
    FlowRunFinished {
        kind: FlowExecutionKind,
        node_count: u64,
        duration_ms: u64,
        outcome: UsageOutcome,
    },
    LoadTestFinished {
        requests: u64,
        failed_requests: u64,
        thresholds: u64,
        failed_thresholds: u64,
        duration_ms: u64,
        outcome: UsageOutcome,
    },
    MockServerStarted {
        origin: MockServerOrigin,
        route_count: u64,
    },
    MockServerStopped {
        origin: MockServerOrigin,
    },
    /// Aggregated mock hits since the previous flush, by answer; never the
    /// route that was called or configured.
    MockRequestsServed {
        origin: MockServerOrigin,
        /// Whether a configured route answered.
        matched: bool,
        status_class: StatusClass,
        count: u64,
    },
    MonitorChanged {
        change: MonitorChange,
        rule_count: u64,
    },
    ShortcutChanged {
        action: Option<UsageIdentifier>,
        change: ShortcutChange,
    },
    ImportFinished {
        format: Option<UsageIdentifier>,
        source: ImportSource,
        items: u64,
        outcome: UsageOutcome,
    },
    ExportFinished {
        format: UsageIdentifier,
    },
    EnvironmentSwitched,
    SettingsChanged {
        category: UsageIdentifier,
        key: Option<UsageIdentifier>,
    },
    SidebarModuleOpened {
        module: UsageIdentifier,
    },
    AgentMessageSent {
        provider_kind: UsageIdentifier,
    },
    VersionControlSynced {
        operation: UsageIdentifier,
        outcome: UsageOutcome,
    },
    UpdateInstalled {
        to_version: UsageIdentifier,
    },
}

impl UsageEvent {
    /// Stable `snake_case` name sent with the event.
    pub fn name(&self) -> &'static str {
        match self {
            Self::AppOpened { .. } => "app_opened",
            Self::AppClosed => "app_closed",
            Self::WorkspaceOpened { .. } => "workspace_opened",
            Self::RequestExecuted(_) => "request_executed",
            Self::CollectionRunFinished { .. } => "collection_run_finished",
            Self::FlowRunStarted { .. } => "flow_run_started",
            Self::FlowRunFinished { .. } => "flow_run_finished",
            Self::LoadTestFinished { .. } => "load_test_finished",
            Self::MockServerStarted { .. } => "mock_server_started",
            Self::MockServerStopped { .. } => "mock_server_stopped",
            Self::MockRequestsServed { .. } => "mock_requests_served",
            Self::MonitorChanged { change, .. } => match change {
                MonitorChange::Created => "monitor_created",
                MonitorChange::Enabled => "monitor_enabled",
                MonitorChange::Disabled => "monitor_disabled",
                MonitorChange::Deleted => "monitor_deleted",
            },
            Self::ShortcutChanged { .. } => "shortcut_changed",
            Self::ImportFinished { .. } => "import_finished",
            Self::ExportFinished { .. } => "export_finished",
            Self::EnvironmentSwitched => "environment_switched",
            Self::SettingsChanged { .. } => "settings_changed",
            Self::SidebarModuleOpened { .. } => "sidebar_module_opened",
            Self::AgentMessageSent { .. } => "agent_message_sent",
            Self::VersionControlSynced { .. } => "version_control_synced",
            Self::UpdateInstalled { .. } => "update_installed",
        }
    }

    /// Properties as a JSON object with `camelCase` keys; absent optional
    /// values are omitted.
    pub fn props(&self) -> Value {
        let identifier = |value: &Option<UsageIdentifier>| {
            value.as_ref().map(|value| Value::from(value.as_str()))
        };
        let props = match self {
            Self::AppOpened { startup_ms } => json!({ "startupMs": startup_ms }),
            Self::AppClosed => json!({}),
            Self::WorkspaceOpened { kind } => json!({
                "kind": match kind {
                    WorkspaceOpenKind::Opened => "opened",
                    WorkspaceOpenKind::Created => "created",
                }
            }),
            Self::RequestExecuted(request) => json!({
                "protocol": protocol_name(request.protocol),
                "operation": identifier(&request.operation),
                "statusClass": request.status_class.as_str(),
                "errorKind": identifier(&request.error_kind),
                "errorCause": identifier(&request.error_cause),
                "durationMs": request.duration_ms,
            }),
            Self::CollectionRunFinished {
                iterations,
                requests,
                failed,
                duration_ms,
                outcome,
            } => json!({
                "iterations": iterations,
                "requests": requests,
                "failed": failed,
                "durationMs": duration_ms,
                "outcome": outcome.as_str(),
            }),
            Self::FlowRunStarted {
                kind,
                node_count,
                uses_mocks,
            } => json!({
                "kind": flow_kind_name(*kind),
                "nodeCount": node_count,
                "usesMocks": uses_mocks,
            }),
            Self::FlowRunFinished {
                kind,
                node_count,
                duration_ms,
                outcome,
            } => json!({
                "kind": flow_kind_name(*kind),
                "nodeCount": node_count,
                "durationMs": duration_ms,
                "outcome": outcome.as_str(),
            }),
            Self::LoadTestFinished {
                requests,
                failed_requests,
                thresholds,
                failed_thresholds,
                duration_ms,
                outcome,
            } => json!({
                "requests": requests,
                "failedRequests": failed_requests,
                "thresholds": thresholds,
                "failedThresholds": failed_thresholds,
                "durationMs": duration_ms,
                "outcome": outcome.as_str(),
            }),
            Self::MockServerStarted {
                origin,
                route_count,
            } => json!({ "origin": origin_name(*origin), "routeCount": route_count }),
            Self::MockServerStopped { origin } => json!({ "origin": origin_name(*origin) }),
            Self::MockRequestsServed {
                origin,
                matched,
                status_class,
                count,
            } => json!({
                "origin": origin_name(*origin),
                "matched": matched,
                "statusClass": status_class.as_str(),
                "count": count,
            }),
            Self::MonitorChanged { rule_count, .. } => json!({ "ruleCount": rule_count }),
            Self::ShortcutChanged { action, change } => json!({
                "action": identifier(action),
                "change": match change {
                    ShortcutChange::Assigned => "assigned",
                    ShortcutChange::Removed => "removed",
                    ShortcutChange::Reset => "reset",
                    ShortcutChange::ResetAll => "resetAll",
                },
            }),
            Self::ImportFinished {
                format,
                source,
                items,
                outcome,
            } => json!({
                "format": identifier(format),
                "source": match source {
                    ImportSource::File => "file",
                    ImportSource::Text => "text",
                    ImportSource::Url => "url",
                },
                "items": items,
                "outcome": outcome.as_str(),
            }),
            Self::ExportFinished { format } => json!({ "format": format.as_str() }),
            Self::EnvironmentSwitched => json!({}),
            Self::SettingsChanged { category, key } => {
                json!({ "category": category.as_str(), "key": identifier(key) })
            }
            Self::SidebarModuleOpened { module } => json!({ "module": module.as_str() }),
            Self::AgentMessageSent { provider_kind } => {
                json!({ "providerKind": provider_kind.as_str() })
            }
            Self::VersionControlSynced { operation, outcome } => json!({
                "operation": operation.as_str(),
                "outcome": outcome.as_str(),
            }),
            Self::UpdateInstalled { to_version } => json!({ "toVersion": to_version.as_str() }),
        };
        without_nulls(props)
    }
}

fn without_nulls(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, value)| !value.is_null())
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

fn protocol_name(protocol: ProtocolId) -> &'static str {
    match protocol {
        ProtocolId::GraphQl => "graphql",
        ProtocolId::Rest => "rest",
        ProtocolId::Grpc => "grpc",
        ProtocolId::WebSocket => "websocket",
    }
}

fn flow_kind_name(kind: FlowExecutionKind) -> &'static str {
    match kind {
        FlowExecutionKind::Standard => "standard",
        FlowExecutionKind::Load => "load",
    }
}

fn origin_name(origin: MockServerOrigin) -> &'static str {
    match origin {
        MockServerOrigin::Saved => "saved",
        MockServerOrigin::FlowInline => "flowInline",
    }
}

/// An event with what every event carries, and nothing that links it to
/// the others.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageEnvelope {
    /// 128 random bits as hex, unrelated to any other event: it only lets
    /// the receiver drop duplicates.
    pub event_id: String,
    /// Local date (`YYYY-MM-DD`); no time of day leaves the app.
    pub occurred_on: String,
    pub app_version: String,
    pub platform: String,
    pub event: UsageEvent,
}

impl UsageEnvelope {
    /// Wire format (schema [`USAGE_EVENT_SCHEMA_VERSION`]).
    pub fn to_json(&self) -> Value {
        json!({
            "schema": USAGE_EVENT_SCHEMA_VERSION,
            "eventId": self.event_id,
            "occurredOn": self.occurred_on,
            "appVersion": self.app_version,
            "platform": self.platform,
            "name": self.event.name(),
            "props": self.event.props(),
        })
    }
}

/// Port to whatever keeps or sends usage events. Implemented by downstream
/// extensions; the app ships no implementation.
pub trait UsageEventSink: Send + Sync {
    /// Takes one event. Called from UI-facing paths and the mock listener
    /// threads: it must only enqueue, never block or do I/O.
    fn record(&self, envelope: UsageEnvelope);

    /// The app is closing: deliver or persist what is pending, within
    /// `deadline`.
    fn shutdown(&self, _deadline: Duration) {}

    /// The person turned usage events off: drop everything not sent yet.
    fn discard(&self) {}
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MockHitKey {
    origin: MockServerOrigin,
    matched: bool,
    status_class: StatusClass,
}

struct MockHits {
    counts: HashMap<MockHitKey, u64>,
    last_flush: Instant,
}

struct HubInner {
    sink: OnceLock<Arc<dyn UsageEventSink>>,
    /// The interface started the hub (once per run).
    activated: AtomicBool,
    /// The person's preference; on by default.
    enabled: AtomicBool,
    /// Events of this run, newest last, for the person to see.
    recent: Mutex<VecDeque<UsageEnvelope>>,
    /// Minutes to add to UTC for the local date, set on activation.
    utc_offset_minutes: AtomicI32,
    app_version: String,
    platform: String,
    started: Instant,
    mock_hits: Mutex<MockHits>,
}

/// Entry point for recording usage events. Cheap to clone.
///
/// Dormant until [`UsageHub::activate`] is called with a sink registered,
/// and silent while the person keeps usage events off
/// ([`UsageHub::set_enabled`]): [`UsageHub::record`] then does nothing.
#[derive(Clone)]
pub struct UsageHub {
    inner: Arc<HubInner>,
}

impl Default for UsageHub {
    fn default() -> Self {
        Self::new("", "")
    }
}

impl UsageHub {
    pub fn new(app_version: impl Into<String>, platform: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(HubInner {
                sink: OnceLock::new(),
                activated: AtomicBool::new(false),
                enabled: AtomicBool::new(true),
                recent: Mutex::new(VecDeque::new()),
                utc_offset_minutes: AtomicI32::new(0),
                app_version: app_version.into(),
                platform: platform.into(),
                started: Instant::now(),
                mock_hits: Mutex::new(MockHits {
                    counts: HashMap::new(),
                    last_flush: Instant::now(),
                }),
            }),
        }
    }

    /// Registers the sink; only the first registration counts. Returns
    /// `false` when a sink was already registered.
    pub fn register_sink(&self, sink: Arc<dyn UsageEventSink>) -> bool {
        self.inner.sink.set(sink).is_ok()
    }

    /// Starts the hub when a sink is registered and the offset is a real
    /// one, and records `app_opened` the first time if the person has usage
    /// events on. `utc_offset_minutes` is added to UTC to get the local date.
    /// Returns whether this build collects usage events at all.
    pub fn activate(&self, utc_offset_minutes: i32) -> bool {
        if self.inner.sink.get().is_none()
            || !UTC_OFFSET_RANGE_MINUTES.contains(&utc_offset_minutes)
        {
            return false;
        }
        self.inner
            .utc_offset_minutes
            .store(utc_offset_minutes, Ordering::Relaxed);
        if !self.inner.activated.swap(true, Ordering::SeqCst) {
            self.record(UsageEvent::AppOpened {
                startup_ms: millis(self.inner.started.elapsed()),
            });
        }
        true
    }

    /// Whether this build collects usage events (an extension registered a
    /// sink).
    pub fn is_available(&self) -> bool {
        self.inner.sink.get().is_some()
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Relaxed)
    }

    /// Applies the person's preference. Turning usage events off drops what
    /// was recorded and not sent yet, here and in the sink.
    pub fn set_enabled(&self, enabled: bool) {
        let was_enabled = self.inner.enabled.swap(enabled, Ordering::SeqCst);
        if was_enabled && !enabled {
            lock(&self.inner.mock_hits).counts.clear();
            lock(&self.inner.recent).clear();
            if let Some(sink) = self.inner.sink.get() {
                sink.discard();
            }
        }
    }

    pub fn is_active(&self) -> bool {
        self.inner.activated.load(Ordering::Relaxed)
            && self.is_enabled()
            && self.inner.sink.get().is_some()
    }

    /// Events recorded in this run, oldest first (at most
    /// [`MAX_RECENT_USAGE_EVENTS`]), exactly as handed to the sink.
    pub fn recent_events(&self) -> Vec<UsageEnvelope> {
        lock(&self.inner.recent).iter().cloned().collect()
    }

    pub fn record(&self, event: UsageEvent) {
        if !self.is_active() {
            return;
        }
        let Some(sink) = self.inner.sink.get() else {
            return;
        };
        // Without randomness there is no id that cannot link events: drop it.
        let Some(event_id) = random_event_id() else {
            return;
        };
        let offset = self.inner.utc_offset_minutes.load(Ordering::Relaxed);
        let envelope = UsageEnvelope {
            event_id,
            occurred_on: local_date(now_ms(), offset),
            app_version: self.inner.app_version.clone(),
            platform: self.inner.platform.clone(),
            event,
        };
        {
            let mut recent = lock(&self.inner.recent);
            if recent.len() == MAX_RECENT_USAGE_EVENTS {
                recent.pop_front();
            }
            recent.push_back(envelope.clone());
        }
        sink.record(envelope);
    }

    /// Counts one mock call; counts are emitted as `mock_requests_served`
    /// at most once per minute, or by [`UsageHub::flush_mock_hits`].
    pub fn record_mock_hit(&self, origin: MockServerOrigin, matched: bool, status: u16) {
        if !self.is_active() {
            return;
        }
        let key = MockHitKey {
            origin,
            matched,
            status_class: StatusClass::from_status(status),
        };
        let due = {
            let mut hits = lock(&self.inner.mock_hits);
            *hits.counts.entry(key).or_default() += 1;
            hits.last_flush.elapsed() >= MOCK_HITS_FLUSH_INTERVAL
        };
        if due {
            self.flush_mock_hits();
        }
    }

    /// Emits the pending mock hit counts.
    pub fn flush_mock_hits(&self) {
        let counts = {
            let mut hits = lock(&self.inner.mock_hits);
            hits.last_flush = Instant::now();
            std::mem::take(&mut hits.counts)
        };
        for (key, count) in counts {
            self.record(UsageEvent::MockRequestsServed {
                origin: key.origin,
                matched: key.matched,
                status_class: key.status_class,
                count,
            });
        }
    }

    /// The app is closing: records `app_closed`, flushes the mock counts and
    /// lets the sink deliver or persist within `deadline`.
    pub fn shutdown(&self, deadline: Duration) {
        if !self.is_active() {
            return;
        }
        self.flush_mock_hits();
        self.record(UsageEvent::AppClosed);
        self.inner.activated.store(false, Ordering::SeqCst);
        if let Some(sink) = self.inner.sink.get() {
            sink.shutdown(deadline);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Milliseconds, saturating.
pub fn millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// `YYYY-MM-DD` of `utc_ms` shifted by `offset_minutes`.
fn local_date(utc_ms: i64, offset_minutes: i32) -> String {
    let local_ms = utc_ms.saturating_add(i64::from(offset_minutes) * 60_000);
    let days = local_ms.div_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 128 random bits as hex, or `None` when the OS has no randomness.
fn random_event_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<UsageEnvelope>>,
        shutdowns: std::sync::atomic::AtomicU64,
        discards: std::sync::atomic::AtomicU64,
    }

    impl RecordingSink {
        fn names(&self) -> Vec<&'static str> {
            lock(&self.events)
                .iter()
                .map(|envelope| envelope.event.name())
                .collect()
        }
    }

    impl UsageEventSink for RecordingSink {
        fn record(&self, envelope: UsageEnvelope) {
            lock(&self.events).push(envelope);
        }

        fn shutdown(&self, _deadline: Duration) {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
        }

        fn discard(&self) {
            self.discards.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn active_hub() -> (UsageHub, Arc<RecordingSink>) {
        let hub = UsageHub::new("1.2.3", "linux");
        let sink = Arc::new(RecordingSink::default());
        assert!(hub.register_sink(sink.clone()));
        assert!(hub.activate(-180));
        (hub, sink)
    }

    #[test]
    fn without_a_sink_the_hub_stays_dormant() {
        let hub = UsageHub::new("1.2.3", "linux");
        assert!(!hub.activate(0));
        assert!(!hub.is_active());
        hub.record(UsageEvent::EnvironmentSwitched);
        hub.record_mock_hit(MockServerOrigin::Saved, false, 404);
        hub.shutdown(Duration::ZERO);
    }

    #[test]
    fn a_registered_sink_receives_nothing_before_activation() {
        let hub = UsageHub::new("1.2.3", "linux");
        let sink = Arc::new(RecordingSink::default());
        hub.register_sink(sink.clone());
        hub.record(UsageEvent::EnvironmentSwitched);
        assert!(sink.names().is_empty());
    }

    #[test]
    fn offsets_outside_the_real_range_do_not_activate() {
        let hub = UsageHub::new("1.2.3", "linux");
        hub.register_sink(Arc::new(RecordingSink::default()));
        assert!(!hub.activate(841));
        assert!(!hub.activate(-841));
        assert!(!hub.is_active());
        assert!(hub.activate(840));
    }

    #[test]
    fn activation_records_app_opened_once() {
        let (hub, sink) = active_hub();
        assert!(hub.activate(-180));
        hub.record(UsageEvent::EnvironmentSwitched);
        assert_eq!(sink.names(), ["app_opened", "environment_switched"]);
    }

    #[test]
    fn every_event_gets_its_own_unrelated_id_and_only_a_date() {
        let (hub, sink) = active_hub();
        hub.record(UsageEvent::EnvironmentSwitched);
        let events = lock(&sink.events);
        assert_eq!(events[0].event_id.len(), 32);
        assert!(
            events[0]
                .event_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
        assert_ne!(events[0].event_id, events[1].event_id);
        assert_eq!(events[0].occurred_on.len(), "2026-11-02".len());
    }

    #[test]
    fn the_local_date_follows_the_offset() {
        // 2026-11-02 01:30 UTC.
        let utc = 1_793_583_000_000;
        assert_eq!(local_date(utc, 0), "2026-11-02");
        assert_eq!(local_date(utc, -180), "2026-11-01");
        assert_eq!(local_date(utc, 840), "2026-11-02");
        assert_eq!(local_date(0, -1), "1969-12-31");
        assert_eq!(local_date(951_782_400_000, 0), "2000-02-29");
    }

    #[test]
    fn turning_usage_events_off_stops_recording_and_discards_what_is_pending() {
        let (hub, sink) = active_hub();
        hub.record_mock_hit(MockServerOrigin::Saved, true, 200);
        assert_eq!(hub.recent_events().len(), 1);

        hub.set_enabled(false);
        assert!(!hub.is_active());
        assert!(hub.is_available());
        assert!(hub.recent_events().is_empty());
        assert_eq!(sink.discards.load(Ordering::SeqCst), 1);
        hub.record(UsageEvent::EnvironmentSwitched);
        hub.shutdown(Duration::ZERO);
        assert_eq!(sink.names(), ["app_opened"]);
        assert_eq!(sink.shutdowns.load(Ordering::SeqCst), 0);

        hub.set_enabled(true);
        hub.record(UsageEvent::EnvironmentSwitched);
        assert_eq!(sink.names(), ["app_opened", "environment_switched"]);
        assert_eq!(hub.recent_events().len(), 1);
    }

    #[test]
    fn a_hub_started_with_usage_events_off_records_nothing_not_even_app_opened() {
        let hub = UsageHub::new("1.2.3", "linux");
        let sink = Arc::new(RecordingSink::default());
        hub.register_sink(sink.clone());
        hub.set_enabled(false);
        assert!(hub.activate(0));
        hub.record(UsageEvent::EnvironmentSwitched);
        assert!(sink.names().is_empty());
    }

    #[test]
    fn recent_events_keep_only_the_newest() {
        let (hub, _) = active_hub();
        for _ in 0..MAX_RECENT_USAGE_EVENTS + 10 {
            hub.record(UsageEvent::EnvironmentSwitched);
        }
        let recent = hub.recent_events();
        assert_eq!(recent.len(), MAX_RECENT_USAGE_EVENTS);
        assert!(
            recent
                .iter()
                .all(|envelope| envelope.event.name() == "environment_switched")
        );
    }

    #[test]
    fn only_the_first_sink_is_kept() {
        let (hub, _) = active_hub();
        assert!(!hub.register_sink(Arc::new(RecordingSink::default())));
    }

    #[test]
    fn shutdown_flushes_mock_hits_records_app_closed_and_stops() {
        let (hub, sink) = active_hub();
        hub.record_mock_hit(MockServerOrigin::Saved, true, 200);
        hub.record_mock_hit(MockServerOrigin::Saved, true, 201);
        hub.record_mock_hit(MockServerOrigin::Saved, false, 404);
        hub.shutdown(Duration::from_secs(1));
        hub.record(UsageEvent::EnvironmentSwitched);

        let events = lock(&sink.events);
        let served: Vec<_> = events
            .iter()
            .filter(|envelope| envelope.event.name() == "mock_requests_served")
            .map(|envelope| envelope.event.props())
            .collect();
        assert_eq!(served.len(), 2);
        assert!(served.contains(&json!({
            "origin": "saved", "matched": true, "statusClass": "2xx", "count": 2
        })));
        assert!(served.contains(&json!({
            "origin": "saved", "matched": false, "statusClass": "4xx", "count": 1
        })));
        assert_eq!(
            events.last().map(|envelope| envelope.event.to_owned()),
            Some(UsageEvent::AppClosed)
        );
        assert_eq!(
            events.last().map(|envelope| envelope.event.props()),
            Some(json!({}))
        );
        assert_eq!(sink.shutdowns.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn identifiers_reject_free_text() {
        assert!(UsageIdentifier::new("request.send").is_some());
        assert!(UsageIdentifier::new("ext:feedback").is_some());
        assert!(UsageIdentifier::new("").is_none());
        assert!(UsageIdentifier::new("my secret token").is_none());
        assert!(UsageIdentifier::new("https://host/path").is_none());
        assert!(UsageIdentifier::new("a".repeat(MAX_USAGE_IDENTIFIER_LEN + 1)).is_none());
    }

    #[test]
    fn the_wire_format_has_no_session_sequence_or_time_of_day() {
        let envelope = UsageEnvelope {
            event_id: "0123456789abcdef0123456789abcdef".into(),
            occurred_on: "2026-11-02".into(),
            app_version: "1.2.3".into(),
            platform: "windows".into(),
            event: UsageEvent::RequestExecuted(RequestExecuted {
                protocol: ProtocolId::Rest,
                operation: UsageIdentifier::new("GET"),
                status_class: StatusClass::from_status(404),
                error_kind: None,
                error_cause: None,
                duration_ms: 12,
            }),
        };
        assert_eq!(
            envelope.to_json(),
            json!({
                "schema": 1,
                "eventId": "0123456789abcdef0123456789abcdef",
                "occurredOn": "2026-11-02",
                "appVersion": "1.2.3",
                "platform": "windows",
                "name": "request_executed",
                "props": {
                    "protocol": "rest",
                    "operation": "GET",
                    "statusClass": "4xx",
                    "durationMs": 12,
                },
            })
        );
    }

    #[test]
    fn mock_events_carry_no_route_or_uptime() {
        let stopped = UsageEvent::MockServerStopped {
            origin: MockServerOrigin::FlowInline,
        };
        assert_eq!(stopped.props(), json!({ "origin": "flowInline" }));
    }

    #[test]
    fn monitor_changes_have_one_name_each() {
        let names: Vec<_> = [
            MonitorChange::Created,
            MonitorChange::Enabled,
            MonitorChange::Disabled,
            MonitorChange::Deleted,
        ]
        .into_iter()
        .map(|change| {
            UsageEvent::MonitorChanged {
                change,
                rule_count: 1,
            }
            .name()
        })
        .collect();
        assert_eq!(
            names,
            [
                "monitor_created",
                "monitor_enabled",
                "monitor_disabled",
                "monitor_deleted"
            ]
        );
    }
}
