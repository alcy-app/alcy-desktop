use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;
/// Days kept per provider: enough for any week plus margin.
pub const AGENT_USAGE_DAYS_KEPT: usize = 14;

/// Serializes the read-modify-write of concurrent turns in this process.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Tokens a provider used, input and output apart.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTokenTotals {
    pub input: u64,
    pub output: u64,
}

impl AgentTokenTotals {
    fn add(&mut self, other: AgentTokenTotals) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    /// Provider id → local day (`YYYY-MM-DD`) → tokens.
    providers: BTreeMap<String, BTreeMap<String, AgentTokenTotals>>,
}

/// Tokens the agent used per provider and local day (`agent-usage.json` in
/// app data, ADR 0065). The interface owns the calendar: it names the days.
pub struct AgentUsageStore {
    path: PathBuf,
}

/// A local calendar day as `YYYY-MM-DD`.
pub fn is_valid_usage_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

impl AgentUsageStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Adds a turn's tokens to `day`, keeping the most recent days only.
    pub fn record(
        &self,
        provider_id: &str,
        day: &str,
        tokens: AgentTokenTotals,
    ) -> Result<(), StorageError> {
        if !is_valid_usage_day(day) {
            return Err(StorageError::Write(format!("invalid usage day '{day}'")));
        }
        let _guard = WRITE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.load()?;
        let days = file.providers.entry(provider_id.to_string()).or_default();
        days.entry(day.to_string()).or_default().add(tokens);
        while days.len() > AGENT_USAGE_DAYS_KEPT {
            days.pop_first();
        }
        let json = serde_json::to_string_pretty(&file)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        crate::agent_session_store::write_atomically(&self.path, json.as_bytes())
    }

    /// Sum of the tokens a provider used on the given days.
    pub fn totals(
        &self,
        provider_id: &str,
        days: &[String],
    ) -> Result<AgentTokenTotals, StorageError> {
        let file = self.load()?;
        let mut totals = AgentTokenTotals::default();
        if let Some(recorded) = file.providers.get(provider_id) {
            for day in days {
                if let Some(tokens) = recorded.get(day) {
                    totals.add(*tokens);
                }
            }
        }
        Ok(totals)
    }

    fn load(&self) -> Result<PersistedFile, StorageError> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(PersistedFile {
                    version: CURRENT_VERSION,
                    providers: BTreeMap::new(),
                });
            }
            Err(error) => return Err(StorageError::Read(error.to_string())),
        };
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_path() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "alcy-agent-usage-test-{}-{}.json",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn tokens(input: u64, output: u64) -> AgentTokenTotals {
        AgentTokenTotals { input, output }
    }

    #[test]
    fn adds_turns_per_provider_and_day() {
        let path = temp_path();
        let store = AgentUsageStore::new(path.clone());
        assert_eq!(
            store.totals("claude", &["2026-10-30".into()]).unwrap(),
            AgentTokenTotals::default()
        );
        store
            .record("claude", "2026-10-29", tokens(100, 10))
            .unwrap();
        store
            .record("claude", "2026-10-30", tokens(200, 20))
            .unwrap();
        store.record("claude", "2026-10-30", tokens(1, 2)).unwrap();
        store
            .record("opencode", "2026-10-30", tokens(999, 9))
            .unwrap();
        assert_eq!(
            store.totals("claude", &["2026-10-30".into()]).unwrap(),
            tokens(201, 22)
        );
        assert_eq!(
            store
                .totals(
                    "claude",
                    &[
                        "2026-10-29".into(),
                        "2026-10-30".into(),
                        "2026-10-31".into()
                    ]
                )
                .unwrap(),
            tokens(301, 32)
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn keeps_only_the_most_recent_days() {
        let path = temp_path();
        let store = AgentUsageStore::new(path.clone());
        for day in 1..=20 {
            store
                .record("p", &format!("2026-10-{day:02}"), tokens(1, 0))
                .unwrap();
        }
        let all: Vec<String> = (1..=20).map(|day| format!("2026-10-{day:02}")).collect();
        assert_eq!(
            store.totals("p", &all).unwrap().input,
            AGENT_USAGE_DAYS_KEPT as u64
        );
        assert_eq!(store.totals("p", &["2026-10-06".into()]).unwrap().input, 0);
        assert_eq!(store.totals("p", &["2026-10-07".into()]).unwrap().input, 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_days_that_are_not_dates() {
        let store = AgentUsageStore::new(temp_path());
        for day in ["", "2026-1-30", "2026/10/30", "../../etc", "2026-10-3x"] {
            assert!(!is_valid_usage_day(day), "{day}");
            assert!(store.record("p", day, tokens(1, 1)).is_err());
        }
        assert!(is_valid_usage_day("2026-10-30"));
    }
}
