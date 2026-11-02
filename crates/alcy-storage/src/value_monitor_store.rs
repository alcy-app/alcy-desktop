use std::fs;
use std::path::PathBuf;

use alcy_domain::{
    CaseStyle, DateTimePattern, FieldPath, RuleKind, RulePattern, TextMatch, VALUE_MONITORS_FILE,
    ValueFormat, ValueMonitor, ValueRule, ValueType,
};
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    monitors: Vec<ValueMonitorRecord>,
}

/// Serialized form of a value monitor. It is the format written to
/// `alcy-value-monitors.json` and also the IPC contract of the monitor
/// commands (ADR 0037): a single mapping to the domain, validated by
/// `to_domain`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueMonitorRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub fields: Vec<String>,
    pub rules: Vec<ValueRuleRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValueRuleRecord {
    pub id: String,
    #[serde(flatten)]
    pub kind: RuleKindRecord,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuleKindRecord {
    ExactLength {
        length: usize,
    },
    LengthRange {
        min: Option<usize>,
        max: Option<usize>,
    },
    LettersOnly,
    DigitsOnly,
    Alphanumeric,
    NoWhitespace,
    NotEmpty,
    Case {
        style: CaseStyleRecord,
    },
    Equals {
        value: String,
        case_sensitive: bool,
    },
    Contains {
        value: String,
        case_sensitive: bool,
    },
    NotContains {
        value: String,
        case_sensitive: bool,
    },
    StartsWith {
        value: String,
        case_sensitive: bool,
    },
    EndsWith {
        value: String,
        case_sensitive: bool,
    },
    OneOf {
        values: Vec<String>,
    },
    Regex {
        pattern: String,
    },
    Type {
        value_type: ValueTypeRecord,
    },
    NumberRange {
        min: Option<f64>,
        max: Option<f64>,
    },
    Format {
        format: ValueFormatRecord,
        /// Only for `customDateTime` (`DD/MM/YYYY HH:mm`). Optional, so files
        /// written before this format existed still load.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaseStyleRecord {
    Upper,
    Lower,
    Capitalized,
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueTypeRecord {
    String,
    Number,
    Boolean,
    Null,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueFormatRecord {
    Email,
    Uuid,
    IsoDate,
    IsoDateTime,
    Url,
    CustomDateTime,
}

/// A monitor or rule that breaks the domain rules; it says where, so the
/// interface can point at the exact spot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidValueMonitor {
    pub monitor_id: String,
    pub rule_id: Option<String>,
    pub message: String,
}

impl ValueMonitorRecord {
    pub fn to_domain(&self) -> Result<ValueMonitor, InvalidValueMonitor> {
        let invalid = |rule_id: Option<&str>, message: String| InvalidValueMonitor {
            monitor_id: self.id.clone(),
            rule_id: rule_id.map(str::to_string),
            message,
        };
        let fields = self
            .fields
            .iter()
            .map(|field| FieldPath::new(field.as_str()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| invalid(None, error.to_string()))?;
        let rules = self
            .rules
            .iter()
            .map(|rule| {
                rule_kind_from_record(&rule.kind)
                    .and_then(|kind| ValueRule::new(rule.id.as_str(), kind))
                    .map_err(|error| invalid(Some(&rule.id), error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        ValueMonitor::new(
            self.id.as_str(),
            self.name.as_str(),
            self.enabled,
            fields,
            rules,
        )
        .map_err(|error| invalid(None, error.to_string()))
    }

    pub fn from_domain(monitor: &ValueMonitor) -> Self {
        Self {
            id: monitor.id.clone(),
            name: monitor.name().to_string(),
            enabled: monitor.enabled,
            fields: monitor
                .fields()
                .iter()
                .map(|field| field.as_str().to_string())
                .collect(),
            rules: monitor
                .rules()
                .iter()
                .map(|rule| ValueRuleRecord {
                    id: rule.id.clone(),
                    kind: rule_kind_to_record(rule.kind()),
                })
                .collect(),
        }
    }
}

fn rule_kind_from_record(record: &RuleKindRecord) -> Result<RuleKind, alcy_domain::ValueRuleError> {
    let text = |value: &str, case_sensitive: bool| TextMatch {
        value: value.to_string(),
        case_sensitive,
    };
    Ok(match record {
        RuleKindRecord::ExactLength { length } => RuleKind::ExactLength(*length),
        RuleKindRecord::LengthRange { min, max } => RuleKind::LengthRange {
            min: *min,
            max: *max,
        },
        RuleKindRecord::LettersOnly => RuleKind::LettersOnly,
        RuleKindRecord::DigitsOnly => RuleKind::DigitsOnly,
        RuleKindRecord::Alphanumeric => RuleKind::Alphanumeric,
        RuleKindRecord::NoWhitespace => RuleKind::NoWhitespace,
        RuleKindRecord::NotEmpty => RuleKind::NotEmpty,
        RuleKindRecord::Case { style } => RuleKind::Case(match style {
            CaseStyleRecord::Upper => CaseStyle::Upper,
            CaseStyleRecord::Lower => CaseStyle::Lower,
            CaseStyleRecord::Capitalized => CaseStyle::Capitalized,
            CaseStyleRecord::Title => CaseStyle::Title,
        }),
        RuleKindRecord::Equals {
            value,
            case_sensitive,
        } => RuleKind::Equals(text(value, *case_sensitive)),
        RuleKindRecord::Contains {
            value,
            case_sensitive,
        } => RuleKind::Contains(text(value, *case_sensitive)),
        RuleKindRecord::NotContains {
            value,
            case_sensitive,
        } => RuleKind::NotContains(text(value, *case_sensitive)),
        RuleKindRecord::StartsWith {
            value,
            case_sensitive,
        } => RuleKind::StartsWith(text(value, *case_sensitive)),
        RuleKindRecord::EndsWith {
            value,
            case_sensitive,
        } => RuleKind::EndsWith(text(value, *case_sensitive)),
        RuleKindRecord::OneOf { values } => RuleKind::OneOf(values.clone()),
        RuleKindRecord::Regex { pattern } => RuleKind::Pattern(RulePattern::new(pattern.as_str())?),
        RuleKindRecord::Type { value_type } => RuleKind::Type(match value_type {
            ValueTypeRecord::String => ValueType::String,
            ValueTypeRecord::Number => ValueType::Number,
            ValueTypeRecord::Boolean => ValueType::Boolean,
            ValueTypeRecord::Null => ValueType::Null,
        }),
        RuleKindRecord::NumberRange { min, max } => RuleKind::NumberRange {
            min: *min,
            max: *max,
        },
        RuleKindRecord::Format { format, pattern } => match format {
            ValueFormatRecord::Email => RuleKind::Format(ValueFormat::Email),
            ValueFormatRecord::Uuid => RuleKind::Format(ValueFormat::Uuid),
            ValueFormatRecord::IsoDate => RuleKind::Format(ValueFormat::IsoDate),
            ValueFormatRecord::IsoDateTime => RuleKind::Format(ValueFormat::IsoDateTime),
            ValueFormatRecord::Url => RuleKind::Format(ValueFormat::Url),
            ValueFormatRecord::CustomDateTime => {
                RuleKind::DateTimeFormat(DateTimePattern::new(pattern.clone().unwrap_or_default())?)
            }
        },
    })
}

fn rule_kind_to_record(kind: &RuleKind) -> RuleKindRecord {
    let text = |text: &TextMatch| (text.value.clone(), text.case_sensitive);
    match kind {
        RuleKind::ExactLength(length) => RuleKindRecord::ExactLength { length: *length },
        RuleKind::LengthRange { min, max } => RuleKindRecord::LengthRange {
            min: *min,
            max: *max,
        },
        RuleKind::LettersOnly => RuleKindRecord::LettersOnly,
        RuleKind::DigitsOnly => RuleKindRecord::DigitsOnly,
        RuleKind::Alphanumeric => RuleKindRecord::Alphanumeric,
        RuleKind::NoWhitespace => RuleKindRecord::NoWhitespace,
        RuleKind::NotEmpty => RuleKindRecord::NotEmpty,
        RuleKind::Case(style) => RuleKindRecord::Case {
            style: match style {
                CaseStyle::Upper => CaseStyleRecord::Upper,
                CaseStyle::Lower => CaseStyleRecord::Lower,
                CaseStyle::Capitalized => CaseStyleRecord::Capitalized,
                CaseStyle::Title => CaseStyleRecord::Title,
            },
        },
        RuleKind::Equals(match_) => {
            let (value, case_sensitive) = text(match_);
            RuleKindRecord::Equals {
                value,
                case_sensitive,
            }
        }
        RuleKind::Contains(match_) => {
            let (value, case_sensitive) = text(match_);
            RuleKindRecord::Contains {
                value,
                case_sensitive,
            }
        }
        RuleKind::NotContains(match_) => {
            let (value, case_sensitive) = text(match_);
            RuleKindRecord::NotContains {
                value,
                case_sensitive,
            }
        }
        RuleKind::StartsWith(match_) => {
            let (value, case_sensitive) = text(match_);
            RuleKindRecord::StartsWith {
                value,
                case_sensitive,
            }
        }
        RuleKind::EndsWith(match_) => {
            let (value, case_sensitive) = text(match_);
            RuleKindRecord::EndsWith {
                value,
                case_sensitive,
            }
        }
        RuleKind::OneOf(values) => RuleKindRecord::OneOf {
            values: values.clone(),
        },
        RuleKind::Pattern(pattern) => RuleKindRecord::Regex {
            pattern: pattern.as_str().to_string(),
        },
        RuleKind::Type(value_type) => RuleKindRecord::Type {
            value_type: match value_type {
                ValueType::String => ValueTypeRecord::String,
                ValueType::Number => ValueTypeRecord::Number,
                ValueType::Boolean => ValueTypeRecord::Boolean,
                ValueType::Null => ValueTypeRecord::Null,
            },
        },
        RuleKind::NumberRange { min, max } => RuleKindRecord::NumberRange {
            min: *min,
            max: *max,
        },
        RuleKind::Format(format) => RuleKindRecord::Format {
            format: match format {
                ValueFormat::Email => ValueFormatRecord::Email,
                ValueFormat::Uuid => ValueFormatRecord::Uuid,
                ValueFormat::IsoDate => ValueFormatRecord::IsoDate,
                ValueFormat::IsoDateTime => ValueFormatRecord::IsoDateTime,
                ValueFormat::Url => ValueFormatRecord::Url,
            },
            pattern: None,
        },
        RuleKind::DateTimeFormat(pattern) => RuleKindRecord::Format {
            format: ValueFormatRecord::CustomDateTime,
            pattern: Some(pattern.as_str().to_string()),
        },
    }
}

/// Reads and writes a workspace's value monitors (`alcy-value-monitors.json`)
/// at the root of the workspace folder, with atomic writes and a versioned
/// format (ADR 0003).
pub struct ValueMonitorStore {
    path: PathBuf,
}

impl ValueMonitorStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join(VALUE_MONITORS_FILE),
        }
    }

    pub fn load(&self) -> Result<Vec<ValueMonitor>, StorageError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let persisted: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if persisted.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(persisted.version));
        }
        persisted
            .monitors
            .iter()
            .map(|record| {
                record.to_domain().map_err(|error| {
                    StorageError::Corrupted(format!(
                        "monitor '{}': {}",
                        error.monitor_id, error.message
                    ))
                })
            })
            .collect()
    }

    pub fn save(&self, monitors: &[ValueMonitor]) -> Result<(), StorageError> {
        let persisted = PersistedFile {
            version: CURRENT_VERSION,
            monitors: monitors
                .iter()
                .map(ValueMonitorRecord::from_domain)
                .collect(),
        };
        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }
        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.path).map_err(|error| StorageError::Write(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("alcy-value-monitors-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn sample_record() -> ValueMonitorRecord {
        ValueMonitorRecord {
            id: "m1".into(),
            name: "Nome curto".into(),
            enabled: true,
            fields: vec!["usuario.nome".into()],
            rules: vec![
                ValueRuleRecord {
                    id: "r1".into(),
                    kind: RuleKindRecord::LengthRange {
                        min: Some(1),
                        max: Some(10),
                    },
                },
                ValueRuleRecord {
                    id: "r2".into(),
                    kind: RuleKindRecord::Contains {
                        value: "a".into(),
                        case_sensitive: false,
                    },
                },
                ValueRuleRecord {
                    id: "r3".into(),
                    kind: RuleKindRecord::Regex {
                        pattern: "[A-Za-z]+".into(),
                    },
                },
                ValueRuleRecord {
                    id: "r4".into(),
                    kind: RuleKindRecord::Type {
                        value_type: ValueTypeRecord::String,
                    },
                },
            ],
        }
    }

    #[test]
    fn missing_file_loads_as_empty() {
        let store = ValueMonitorStore::new(temp_root("missing"));
        assert_eq!(store.load().unwrap(), Vec::new());
    }

    #[test]
    fn saves_and_loads_round_trip() {
        let root = temp_root("round-trip");
        let store = ValueMonitorStore::new(root.clone());
        let monitor = sample_record().to_domain().unwrap();

        store.save(std::slice::from_ref(&monitor)).unwrap();

        assert_eq!(store.load().unwrap(), vec![monitor]);
        let raw = fs::read_to_string(root.join(VALUE_MONITORS_FILE)).unwrap();
        assert!(raw.contains("\"kind\": \"lengthRange\""));
        assert!(raw.contains("\"caseSensitive\": false"));
        assert!(raw.contains("\"valueType\": \"string\""));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_rule_points_to_monitor_and_rule() {
        let mut record = sample_record();
        record.rules[2].kind = RuleKindRecord::Regex {
            pattern: "(".into(),
        };
        let error = record.to_domain().unwrap_err();
        assert_eq!(error.monitor_id, "m1");
        assert_eq!(error.rule_id.as_deref(), Some("r3"));
    }

    #[test]
    fn custom_date_time_format_round_trips_and_older_format_rules_still_load() {
        let raw = r#"{ "version": 1, "monitors": [{
            "id": "m1", "name": "Datas", "enabled": true, "fields": ["criadoEm"],
            "rules": [
                { "id": "r1", "kind": "format", "format": "isoDate" },
                { "id": "r2", "kind": "format", "format": "customDateTime", "pattern": "DD/MM/YYYY" }
            ]
        }] }"#;
        let root = temp_root("custom-date");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(VALUE_MONITORS_FILE), raw).unwrap();
        let store = ValueMonitorStore::new(root.clone());

        let monitors = store.load().unwrap();
        assert!(matches!(
            monitors[0].rules()[0].kind(),
            RuleKind::Format(ValueFormat::IsoDate)
        ));
        assert!(matches!(
            monitors[0].rules()[1].kind(),
            RuleKind::DateTimeFormat(pattern) if pattern.as_str() == "DD/MM/YYYY"
        ));

        store.save(&monitors).unwrap();
        let saved = fs::read_to_string(root.join(VALUE_MONITORS_FILE)).unwrap();
        assert!(saved.contains("\"pattern\": \"DD/MM/YYYY\""));
        assert_eq!(saved.matches("\"pattern\"").count(), 1);
        assert_eq!(store.load().unwrap(), monitors);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_date_time_format_without_pattern_is_invalid() {
        let mut record = sample_record();
        record.rules[3].kind = RuleKindRecord::Format {
            format: ValueFormatRecord::CustomDateTime,
            pattern: None,
        };
        let error = record.to_domain().unwrap_err();
        assert_eq!(error.rule_id.as_deref(), Some("r4"));
    }

    #[test]
    fn rejects_unsupported_version() {
        let root = temp_root("version");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(VALUE_MONITORS_FILE),
            r#"{ "version": 99, "monitors": [] }"#,
        )
        .unwrap();
        let store = ValueMonitorStore::new(root.clone());
        assert!(matches!(
            store.load(),
            Err(StorageError::UnsupportedVersion(99))
        ));
        let _ = fs::remove_dir_all(root);
    }
}
