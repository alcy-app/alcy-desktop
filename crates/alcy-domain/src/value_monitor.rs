use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use thiserror::Error;

/// Segment of the path to a value inside a JSON response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValuePathSegment {
    Key(String),
    Index(usize),
}

/// A primitive value of a response, as the monitor sees it. Numbers keep the
/// original literal (`1.50` stays `1.50`) because the text rules look at
/// what appears in the response.
#[derive(Debug, Clone, PartialEq)]
pub enum MonitoredValue {
    Text(String),
    Number(String),
    Boolean(bool),
    Null,
    /// Array without items (`[]`). The items of a non-empty array are
    /// evaluated one by one; an empty one has none, so the array itself is
    /// evaluated and fails every rule.
    EmptyArray,
}

impl MonitoredValue {
    /// Text used by the text rules; `None` for `null` and the empty array.
    fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) | Self::Number(text) => Some(text),
            Self::Boolean(true) => Some("true"),
            Self::Boolean(false) => Some("false"),
            Self::Null | Self::EmptyArray => None,
        }
    }
}

/// A monitored field, written as a dot-separated key path (`user.name`). It
/// matches by suffix: `name` matches any `name` key, `user.name` only `name`
/// inside `user`. Array indices don't count (`items[].name` is the same as
/// `items.name`), and the items of an array are values of the field that
/// holds it (`tags` matches `tags[0]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldPath {
    source: String,
    keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FieldPathError {
    #[error("o campo não pode ser vazio")]
    Empty,
    #[error("o campo '{0}' tem um trecho vazio entre pontos")]
    EmptySegment(String),
}

impl FieldPath {
    pub fn new(source: impl Into<String>) -> Result<Self, FieldPathError> {
        let source = source.into().trim().to_string();
        if source.is_empty() {
            return Err(FieldPathError::Empty);
        }
        let keys = source
            .split('.')
            .map(|segment| segment.trim().trim_end_matches("[]").trim().to_string())
            .collect::<Vec<_>>();
        if keys.iter().any(String::is_empty) {
            return Err(FieldPathError::EmptySegment(source));
        }
        Ok(Self { source, keys })
    }

    pub fn as_str(&self) -> &str {
        &self.source
    }

    /// Last key of the path: what must appear at the end of the value's path.
    pub fn last_key(&self) -> &str {
        self.keys.last().map(String::as_str).unwrap_or_default()
    }

    pub fn matches(&self, path: &[ValuePathSegment]) -> bool {
        // The value belongs to the last key of its path: it is that key's
        // value or an item (at any depth) of the array stored in it. A value
        // at the root, or in a root array, has no key and matches no field.
        if !path
            .iter()
            .any(|segment| matches!(segment, ValuePathSegment::Key(_)))
        {
            return false;
        }
        let keys: Vec<&str> = path
            .iter()
            .filter_map(|segment| match segment {
                ValuePathSegment::Key(key) => Some(key.as_str()),
                ValuePathSegment::Index(_) => None,
            })
            .collect();
        keys.len() >= self.keys.len()
            && keys[keys.len() - self.keys.len()..]
                .iter()
                .zip(&self.keys)
                .all(|(key, expected)| *key == expected)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseStyle {
    /// No lowercase letters.
    Upper,
    /// No uppercase letters.
    Lower,
    /// First letter uppercase.
    Capitalized,
    /// Every word starts with an uppercase letter.
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueType {
    String,
    Number,
    Boolean,
    Null,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueFormat {
    Email,
    Uuid,
    IsoDate,
    IsoDateTime,
    Url,
}

/// Comparison text of the "equals", "contains", "starts with"… rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextMatch {
    pub value: String,
    pub case_sensitive: bool,
}

/// Compiled regular expression of a rule. Matches the whole value.
#[derive(Debug, Clone)]
pub struct RulePattern {
    source: String,
    compiled: Regex,
}

impl RulePattern {
    pub fn new(source: impl Into<String>) -> Result<Self, ValueRuleError> {
        let source = source.into();
        if source.is_empty() {
            return Err(ValueRuleError::EmptyPattern);
        }
        let compiled = Regex::new(&format!("^(?:{source})$"))
            .map_err(|_| ValueRuleError::InvalidPattern(source.clone()))?;
        Ok(Self { source, compiled })
    }

    pub fn as_str(&self) -> &str {
        &self.source
    }
}

impl PartialEq for RulePattern {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source
    }
}

/// What a date/time token captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DateToken {
    Year4,
    Year2,
    Month,
    Day,
    Hour24,
    Hour12,
    Minute,
    Second,
    Millisecond,
    Meridiem,
    Offset,
}

/// Tokens in the style of JavaScript date libraries, longest first so `YYYY`
/// wins over `YY` and `MM` over `M`. `yyyy`, `yy`, `dd` and `d` are accepted
/// as aliases for year and day. Every other character is literal.
const DATE_TOKENS: &[(&str, DateToken, &str)] = &[
    ("YYYY", DateToken::Year4, r"(\d{4})"),
    ("yyyy", DateToken::Year4, r"(\d{4})"),
    ("SSS", DateToken::Millisecond, r"(\d{3})"),
    ("YY", DateToken::Year2, r"(\d{2})"),
    ("yy", DateToken::Year2, r"(\d{2})"),
    ("MM", DateToken::Month, r"(\d{2})"),
    ("DD", DateToken::Day, r"(\d{2})"),
    ("dd", DateToken::Day, r"(\d{2})"),
    ("HH", DateToken::Hour24, r"(\d{2})"),
    ("hh", DateToken::Hour12, r"(\d{2})"),
    ("mm", DateToken::Minute, r"(\d{2})"),
    ("ss", DateToken::Second, r"(\d{2})"),
    ("ZZ", DateToken::Offset, r"(Z|[+-]\d{4})"),
    ("M", DateToken::Month, r"(\d{1,2})"),
    ("D", DateToken::Day, r"(\d{1,2})"),
    ("d", DateToken::Day, r"(\d{1,2})"),
    ("H", DateToken::Hour24, r"(\d{1,2})"),
    ("h", DateToken::Hour12, r"(\d{1,2})"),
    ("m", DateToken::Minute, r"(\d{1,2})"),
    ("s", DateToken::Second, r"(\d{1,2})"),
    ("A", DateToken::Meridiem, r"(AM|PM)"),
    ("a", DateToken::Meridiem, r"(am|pm)"),
    ("Z", DateToken::Offset, r"(Z|[+-]\d{2}:\d{2})"),
];

/// Custom date/time format (`DD/MM/YYYY HH:mm`), compiled to a regular
/// expression over the whole value. Text inside `[...]` is literal. A value
/// passes when it matches the format and is a date and time that exists.
#[derive(Debug, Clone)]
pub struct DateTimePattern {
    source: String,
    compiled: Regex,
    tokens: Vec<DateToken>,
}

impl DateTimePattern {
    pub fn new(source: impl Into<String>) -> Result<Self, ValueRuleError> {
        let source = source.into();
        if source.trim().is_empty() {
            return Err(ValueRuleError::EmptyDateFormat);
        }
        let mut expression = String::from("^");
        let mut tokens = Vec::new();
        let mut rest = source.as_str();
        while let Some(first) = rest.chars().next() {
            if first == '[' {
                let Some(end) = rest.find(']') else {
                    return Err(ValueRuleError::UnclosedDateLiteral(source.clone()));
                };
                expression.push_str(&regex::escape(&rest[1..end]));
                rest = &rest[end + 1..];
                continue;
            }
            if let Some((token, kind, group)) = DATE_TOKENS
                .iter()
                .find(|(token, _, _)| rest.starts_with(token))
            {
                expression.push_str(group);
                tokens.push(*kind);
                rest = &rest[token.len()..];
                continue;
            }
            expression.push_str(&regex::escape(first.encode_utf8(&mut [0; 4])));
            rest = &rest[first.len_utf8()..];
        }
        if tokens.is_empty() {
            return Err(ValueRuleError::DateFormatWithoutTokens(source));
        }
        expression.push('$');
        let compiled = Regex::new(&expression)
            .map_err(|_| ValueRuleError::DateFormatWithoutTokens(source.clone()))?;
        Ok(Self {
            source,
            compiled,
            tokens,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.source
    }

    fn matches(&self, text: &str) -> bool {
        let Some(captures) = self.compiled.captures(text) else {
            return false;
        };
        let mut year = None;
        let mut month = None;
        let mut day = None;
        for (index, token) in self.tokens.iter().enumerate() {
            let Some(raw) = captures.get(index + 1).map(|found| found.as_str()) else {
                return false;
            };
            let number = || raw.parse::<u32>().ok();
            let valid = match token {
                DateToken::Year4 => {
                    year = number();
                    year.is_some()
                }
                DateToken::Year2 => {
                    // Same pivot as the JavaScript libraries: 69–99 → 19xx.
                    year = number().map(|yy| if yy > 68 { 1900 + yy } else { 2000 + yy });
                    year.is_some()
                }
                DateToken::Month => {
                    month = number();
                    month.is_some_and(|month| (1..=12).contains(&month))
                }
                DateToken::Day => {
                    day = number();
                    day.is_some_and(|day| day >= 1)
                }
                DateToken::Hour24 => number().is_some_and(|hour| hour <= 23),
                DateToken::Hour12 => number().is_some_and(|hour| (1..=12).contains(&hour)),
                DateToken::Minute | DateToken::Second => number().is_some_and(|value| value <= 59),
                DateToken::Millisecond | DateToken::Meridiem => true,
                DateToken::Offset => valid_offset(raw),
            };
            if !valid {
                return false;
            }
        }
        day.is_none_or(|day| day <= days_in_month(year, month))
    }
}

impl PartialEq for DateTimePattern {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source
    }
}

/// Most days the month can have; without a year February allows 29 and
/// without a month any day up to 31 is accepted.
fn days_in_month(year: Option<u32>, month: Option<u32>) -> u32 {
    match month {
        Some(4 | 6 | 9 | 11) => 30,
        Some(2) => match year {
            Some(year) if !(year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) => 28,
            _ => 29,
        },
        _ => 31,
    }
}

/// `Z`, `+03:00` or `-0300`, with hours up to 23 and minutes up to 59.
fn valid_offset(raw: &str) -> bool {
    if raw == "Z" {
        return true;
    }
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    let (Some(hours), Some(minutes)) = (digits.get(..2), digits.get(2..)) else {
        return false;
    };
    hours.parse::<u32>().is_ok_and(|hours| hours <= 23)
        && minutes.parse::<u32>().is_ok_and(|minutes| minutes <= 59)
}

#[derive(Debug, Clone, PartialEq)]
pub enum RuleKind {
    ExactLength(usize),
    LengthRange {
        min: Option<usize>,
        max: Option<usize>,
    },
    LettersOnly,
    DigitsOnly,
    Alphanumeric,
    NoWhitespace,
    NotEmpty,
    Case(CaseStyle),
    Equals(TextMatch),
    Contains(TextMatch),
    NotContains(TextMatch),
    StartsWith(TextMatch),
    EndsWith(TextMatch),
    OneOf(Vec<String>),
    Pattern(RulePattern),
    Type(ValueType),
    NumberRange {
        min: Option<f64>,
        max: Option<f64>,
    },
    Format(ValueFormat),
    DateTimeFormat(DateTimePattern),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ValueRuleError {
    #[error("informe um mínimo, um máximo ou os dois")]
    EmptyRange,
    #[error("o mínimo não pode ser maior que o máximo")]
    InvertedRange,
    #[error("o texto de comparação não pode ser vazio")]
    EmptyText,
    #[error("informe pelo menos um valor permitido")]
    EmptyOptions,
    #[error("a expressão regular não pode ser vazia")]
    EmptyPattern,
    #[error("expressão regular inválida: '{0}'")]
    InvalidPattern(String),
    #[error("o formato da data não pode ser vazio")]
    EmptyDateFormat,
    #[error("o formato da data '{0}' tem um '[' sem ']'")]
    UnclosedDateLiteral(String),
    #[error("o formato da data '{0}' não tem nenhum token de data ou hora (YYYY, MM, DD, HH, mm…)")]
    DateFormatWithoutTokens(String),
}

/// A rule applied to every value of a monitored field.
#[derive(Debug, Clone, PartialEq)]
pub struct ValueRule {
    pub id: String,
    kind: RuleKind,
}

impl ValueRule {
    pub fn new(id: impl Into<String>, kind: RuleKind) -> Result<Self, ValueRuleError> {
        match &kind {
            RuleKind::LengthRange { min, max } => check_range(*min, *max)?,
            RuleKind::NumberRange { min, max } => check_range(*min, *max)?,
            RuleKind::Contains(text)
            | RuleKind::NotContains(text)
            | RuleKind::StartsWith(text)
            | RuleKind::EndsWith(text)
                if text.value.is_empty() =>
            {
                return Err(ValueRuleError::EmptyText);
            }
            RuleKind::OneOf(values) if values.is_empty() => {
                return Err(ValueRuleError::EmptyOptions);
            }
            _ => {}
        }
        Ok(Self {
            id: id.into(),
            kind,
        })
    }

    pub fn kind(&self) -> &RuleKind {
        &self.kind
    }

    pub fn passes(&self, value: &MonitoredValue) -> bool {
        let text = value.as_text();
        match &self.kind {
            RuleKind::ExactLength(length) => {
                text.is_some_and(|text| text.chars().count() == *length)
            }
            RuleKind::LengthRange { min, max } => text.is_some_and(|text| {
                let length = text.chars().count();
                min.is_none_or(|min| length >= min) && max.is_none_or(|max| length <= max)
            }),
            RuleKind::LettersOnly => non_empty_all(text, char::is_alphabetic),
            RuleKind::DigitsOnly => non_empty_all(text, |c| c.is_ascii_digit()),
            RuleKind::Alphanumeric => non_empty_all(text, char::is_alphanumeric),
            RuleKind::NoWhitespace => {
                text.is_some_and(|text| !text.chars().any(char::is_whitespace))
            }
            RuleKind::NotEmpty => text.is_some_and(|text| !text.trim().is_empty()),
            RuleKind::Case(style) => text.is_some_and(|text| matches_case(text, *style)),
            RuleKind::Equals(expected) => {
                text.is_some_and(|text| compare_text(text, expected, |a, b| a == b))
            }
            RuleKind::Contains(expected) => {
                text.is_some_and(|text| compare_text(text, expected, |a, b| a.contains(b)))
            }
            RuleKind::NotContains(expected) => {
                text.is_some_and(|text| !compare_text(text, expected, |a, b| a.contains(b)))
            }
            RuleKind::StartsWith(expected) => {
                text.is_some_and(|text| compare_text(text, expected, |a, b| a.starts_with(b)))
            }
            RuleKind::EndsWith(expected) => {
                text.is_some_and(|text| compare_text(text, expected, |a, b| a.ends_with(b)))
            }
            RuleKind::OneOf(values) => {
                text.is_some_and(|text| values.iter().any(|value| value == text))
            }
            RuleKind::Pattern(pattern) => text.is_some_and(|text| pattern.compiled.is_match(text)),
            RuleKind::Type(expected) => matches!(
                (expected, value),
                (ValueType::String, MonitoredValue::Text(_))
                    | (ValueType::Number, MonitoredValue::Number(_))
                    | (ValueType::Boolean, MonitoredValue::Boolean(_))
                    | (ValueType::Null, MonitoredValue::Null)
            ),
            RuleKind::NumberRange { min, max } => {
                let number = match value {
                    MonitoredValue::Number(text) | MonitoredValue::Text(text) => {
                        text.trim().parse::<f64>().ok()
                    }
                    _ => None,
                };
                number.is_some_and(|number| {
                    min.is_none_or(|min| number >= min) && max.is_none_or(|max| number <= max)
                })
            }
            RuleKind::Format(format) => text.is_some_and(|text| {
                format_regex(*format).is_some_and(|regex| regex.is_match(text))
            }),
            RuleKind::DateTimeFormat(pattern) => text.is_some_and(|text| pattern.matches(text)),
        }
    }
}

fn check_range<T: PartialOrd>(min: Option<T>, max: Option<T>) -> Result<(), ValueRuleError> {
    match (min, max) {
        (None, None) => Err(ValueRuleError::EmptyRange),
        (Some(min), Some(max)) if min > max => Err(ValueRuleError::InvertedRange),
        _ => Ok(()),
    }
}

fn non_empty_all(text: Option<&str>, predicate: impl Fn(char) -> bool) -> bool {
    text.is_some_and(|text| !text.is_empty() && text.chars().all(predicate))
}

fn matches_case(text: &str, style: CaseStyle) -> bool {
    let starts_upper = |word: &str| {
        word.chars()
            .find(|c| c.is_alphabetic())
            .is_none_or(char::is_uppercase)
    };
    match style {
        CaseStyle::Upper => !text.chars().any(char::is_lowercase),
        CaseStyle::Lower => !text.chars().any(char::is_uppercase),
        CaseStyle::Capitalized => starts_upper(text),
        CaseStyle::Title => text.split_whitespace().all(starts_upper),
    }
}

fn compare_text(text: &str, expected: &TextMatch, compare: impl Fn(&str, &str) -> bool) -> bool {
    if expected.case_sensitive {
        compare(text, &expected.value)
    } else {
        compare(&text.to_lowercase(), &expected.value.to_lowercase())
    }
}

fn format_regex(format: ValueFormat) -> Option<&'static Regex> {
    static EMAIL: LazyLock<Option<Regex>> =
        LazyLock::new(|| fixed_regex(r"^[^\s@]+@[^\s@]+\.[^\s@]+$"));
    static UUID: LazyLock<Option<Regex>> = LazyLock::new(|| {
        fixed_regex(
            r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )
    });
    static ISO_DATE: LazyLock<Option<Regex>> =
        LazyLock::new(|| fixed_regex(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"));
    static ISO_DATE_TIME: LazyLock<Option<Regex>> = LazyLock::new(|| {
        fixed_regex(
            r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$",
        )
    });
    static URL: LazyLock<Option<Regex>> =
        LazyLock::new(|| fixed_regex(r"^[A-Za-z][A-Za-z0-9+.-]*://[^\s/?#]+\S*$"));
    match format {
        ValueFormat::Email => EMAIL.as_ref(),
        ValueFormat::Uuid => UUID.as_ref(),
        ValueFormat::IsoDate => ISO_DATE.as_ref(),
        ValueFormat::IsoDateTime => ISO_DATE_TIME.as_ref(),
        ValueFormat::Url => URL.as_ref(),
    }
}

/// Compiles a fixed expression from this file. If one is broken the rule
/// just fails (instead of crashing the app), and the format tests catch it.
fn fixed_regex(source: &str) -> Option<Regex> {
    Regex::new(source).ok()
}

/// A named set of rules applied to the monitored fields of any response; it
/// doesn't belong to a specific request.
#[derive(Debug, Clone, PartialEq)]
pub struct ValueMonitor {
    pub id: String,
    name: String,
    pub enabled: bool,
    fields: Vec<FieldPath>,
    rules: Vec<ValueRule>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ValueMonitorError {
    #[error("o nome do monitor não pode ser vazio")]
    EmptyName,
    #[error("o campo '{0}' está repetido")]
    DuplicateField(String),
}

impl ValueMonitor {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        enabled: bool,
        fields: Vec<FieldPath>,
        rules: Vec<ValueRule>,
    ) -> Result<Self, ValueMonitorError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(ValueMonitorError::EmptyName);
        }
        let mut seen = HashSet::new();
        for field in &fields {
            if !seen.insert(field.as_str()) {
                return Err(ValueMonitorError::DuplicateField(
                    field.as_str().to_string(),
                ));
            }
        }
        Ok(Self {
            id: id.into(),
            name,
            enabled,
            fields,
            rules,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn fields(&self) -> &[FieldPath] {
        &self.fields
    }

    pub fn rules(&self) -> &[ValueRule] {
        &self.rules
    }

    /// First field of the monitor that matches the path, if any.
    pub fn matching_field(&self, path: &[ValuePathSegment]) -> Option<&FieldPath> {
        self.fields.iter().find(|field| field.matches(path))
    }

    /// Ids of the rules the value failed (empty when it passed).
    pub fn failed_rules(&self, value: &MonitoredValue) -> Vec<&str> {
        self.rules
            .iter()
            .filter(|rule| !rule.passes(value))
            .map(|rule| rule.id.as_str())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> ValuePathSegment {
        ValuePathSegment::Key(name.to_string())
    }

    fn text(value: &str) -> MonitoredValue {
        MonitoredValue::Text(value.to_string())
    }

    fn rule(kind: RuleKind) -> ValueRule {
        ValueRule::new("r", kind).expect("valid rule")
    }

    fn matcher(value: &str, case_sensitive: bool) -> TextMatch {
        TextMatch {
            value: value.to_string(),
            case_sensitive,
        }
    }

    #[test]
    fn field_matches_by_suffix_ignoring_array_indices() {
        let field = FieldPath::new("usuario.nome").unwrap();
        assert!(field.matches(&[key("data"), key("usuario"), key("nome")]));
        assert!(field.matches(&[key("usuario"), ValuePathSegment::Index(2), key("nome")]));
        assert!(!field.matches(&[key("empresa"), key("nome")]));
        assert!(!field.matches(&[key("nome")]));

        let bare = FieldPath::new("nome").unwrap();
        assert!(bare.matches(&[key("a"), ValuePathSegment::Index(0), key("nome")]));
        assert!(!bare.matches(&[key("nomes")]));
        assert!(!bare.matches(&[ValuePathSegment::Index(0)]));
    }

    #[test]
    fn array_items_belong_to_the_field_that_holds_the_array() {
        let tags = FieldPath::new("tags").unwrap();
        assert!(tags.matches(&[key("tags"), ValuePathSegment::Index(0)]));
        assert!(tags.matches(&[
            key("filme"),
            key("tags"),
            ValuePathSegment::Index(1),
            ValuePathSegment::Index(0),
        ]));
        // An item of an array of objects belongs to the object's key, not the array.
        assert!(!tags.matches(&[key("tags"), ValuePathSegment::Index(0), key("nome")]));

        let marked = FieldPath::new("filme.tags[]").unwrap();
        assert!(marked.matches(&[key("filme"), key("tags"), ValuePathSegment::Index(2)]));
        assert!(!marked.matches(&[key("serie"), key("tags"), ValuePathSegment::Index(2)]));
    }

    #[test]
    fn empty_array_fails_every_rule() {
        let empty = MonitoredValue::EmptyArray;
        assert!(!rule(RuleKind::NotEmpty).passes(&empty));
        assert!(
            !rule(RuleKind::LengthRange {
                min: None,
                max: Some(10)
            })
            .passes(&empty)
        );
        assert!(!rule(RuleKind::NotContains(matcher("x", true))).passes(&empty));
        assert!(!rule(RuleKind::Type(ValueType::String)).passes(&empty));
        assert!(!rule(RuleKind::Type(ValueType::Null)).passes(&empty));
        assert!(
            !rule(RuleKind::NumberRange {
                min: Some(0.0),
                max: None
            })
            .passes(&empty)
        );
    }

    #[test]
    fn field_accepts_array_marker_and_rejects_empty_segments() {
        let field = FieldPath::new(" itens[].nome ").unwrap();
        assert_eq!(field.as_str(), "itens[].nome");
        assert_eq!(field.last_key(), "nome");
        assert!(field.matches(&[key("itens"), ValuePathSegment::Index(0), key("nome")]));
        assert_eq!(FieldPath::new("  "), Err(FieldPathError::Empty));
        assert!(matches!(
            FieldPath::new("a..b"),
            Err(FieldPathError::EmptySegment(_))
        ));
    }

    #[test]
    fn length_rules_count_unicode_characters() {
        assert!(rule(RuleKind::ExactLength(4)).passes(&text("João")));
        let range = rule(RuleKind::LengthRange {
            min: Some(1),
            max: Some(10),
        });
        assert!(range.passes(&text("Ana")));
        assert!(!range.passes(&text("")));
        assert!(!range.passes(&text("Maximiliano")));
        assert!(!range.passes(&MonitoredValue::Null));
        assert!(range.passes(&MonitoredValue::Number("12345".into())));
    }

    #[test]
    fn range_rules_require_consistent_bounds() {
        assert_eq!(
            ValueRule::new(
                "r",
                RuleKind::LengthRange {
                    min: None,
                    max: None
                }
            ),
            Err(ValueRuleError::EmptyRange)
        );
        assert_eq!(
            ValueRule::new(
                "r",
                RuleKind::NumberRange {
                    min: Some(5.0),
                    max: Some(1.0)
                }
            ),
            Err(ValueRuleError::InvertedRange)
        );
    }

    #[test]
    fn character_class_rules() {
        assert!(rule(RuleKind::LettersOnly).passes(&text("Conceição")));
        assert!(!rule(RuleKind::LettersOnly).passes(&text("Ana Paula")));
        assert!(!rule(RuleKind::LettersOnly).passes(&text("")));
        assert!(rule(RuleKind::DigitsOnly).passes(&MonitoredValue::Number("42".into())));
        assert!(!rule(RuleKind::DigitsOnly).passes(&MonitoredValue::Number("4.2".into())));
        assert!(rule(RuleKind::Alphanumeric).passes(&text("abc123")));
        assert!(!rule(RuleKind::Alphanumeric).passes(&text("abc-123")));
        assert!(rule(RuleKind::NoWhitespace).passes(&text("sem_espaco")));
        assert!(!rule(RuleKind::NoWhitespace).passes(&text("com espaço")));
        assert!(!rule(RuleKind::NotEmpty).passes(&text("   ")));
        assert!(!rule(RuleKind::NotEmpty).passes(&MonitoredValue::Null));
        assert!(rule(RuleKind::NotEmpty).passes(&MonitoredValue::Boolean(false)));
    }

    #[test]
    fn case_rules() {
        assert!(rule(RuleKind::Case(CaseStyle::Upper)).passes(&text("ABC-1")));
        assert!(!rule(RuleKind::Case(CaseStyle::Upper)).passes(&text("ABc")));
        assert!(rule(RuleKind::Case(CaseStyle::Lower)).passes(&text("abc")));
        assert!(rule(RuleKind::Case(CaseStyle::Capitalized)).passes(&text("Maria da silva")));
        assert!(!rule(RuleKind::Case(CaseStyle::Title)).passes(&text("Maria da Silva")));
        assert!(rule(RuleKind::Case(CaseStyle::Title)).passes(&text("Maria Da Silva")));
    }

    #[test]
    fn text_comparison_rules_respect_case_sensitivity() {
        assert!(rule(RuleKind::Equals(matcher("ativo", false))).passes(&text("ATIVO")));
        assert!(!rule(RuleKind::Equals(matcher("ativo", true))).passes(&text("ATIVO")));
        assert!(rule(RuleKind::Contains(matcher("@", true))).passes(&text("a@b")));
        assert!(rule(RuleKind::NotContains(matcher("x", true))).passes(&text("abc")));
        assert!(rule(RuleKind::StartsWith(matcher("BR", true))).passes(&text("BR-1")));
        assert!(rule(RuleKind::EndsWith(matcher(".com", true))).passes(&text("a.com")));
        assert_eq!(
            ValueRule::new("r", RuleKind::Contains(matcher("", true))),
            Err(ValueRuleError::EmptyText)
        );
        let one_of = rule(RuleKind::OneOf(vec!["A".into(), "B".into()]));
        assert!(one_of.passes(&text("B")));
        assert!(!one_of.passes(&text("C")));
    }

    #[test]
    fn pattern_rule_matches_whole_value_and_rejects_invalid_regex() {
        let pattern = rule(RuleKind::Pattern(RulePattern::new("[a-z]+").unwrap()));
        assert!(pattern.passes(&text("abc")));
        assert!(!pattern.passes(&text("abc1")));
        assert!(matches!(
            RulePattern::new("(abc"),
            Err(ValueRuleError::InvalidPattern(_))
        ));
        assert!(matches!(
            RulePattern::new(""),
            Err(ValueRuleError::EmptyPattern)
        ));
    }

    #[test]
    fn type_and_number_range_rules() {
        assert!(rule(RuleKind::Type(ValueType::Null)).passes(&MonitoredValue::Null));
        assert!(!rule(RuleKind::Type(ValueType::Number)).passes(&text("1")));
        let range = rule(RuleKind::NumberRange {
            min: Some(0.0),
            max: Some(100.0),
        });
        assert!(range.passes(&MonitoredValue::Number("99.5".into())));
        assert!(range.passes(&text("10")));
        assert!(!range.passes(&MonitoredValue::Number("101".into())));
        assert!(!range.passes(&text("dez")));
    }

    #[test]
    fn format_rules() {
        let format = |format| rule(RuleKind::Format(format));
        assert!(format(ValueFormat::Email).passes(&text("ana@exemplo.com")));
        assert!(!format(ValueFormat::Email).passes(&text("ana@exemplo")));
        assert!(format(ValueFormat::Uuid).passes(&text("123e4567-e89b-12d3-a456-426614174000")));
        assert!(format(ValueFormat::IsoDate).passes(&text("2026-09-28")));
        assert!(!format(ValueFormat::IsoDate).passes(&text("2026-13-01")));
        assert!(format(ValueFormat::IsoDateTime).passes(&text("2026-09-28T10:30:00.123Z")));
        assert!(format(ValueFormat::IsoDateTime).passes(&text("2026-09-28T10:30-03:00")));
        assert!(format(ValueFormat::Url).passes(&text("https://alcy.dev/a?b=1")));
        assert!(!format(ValueFormat::Url).passes(&text("alcy.dev")));
    }

    #[test]
    fn custom_date_time_format_checks_layout_and_calendar() {
        let format = |source: &str| {
            rule(RuleKind::DateTimeFormat(
                DateTimePattern::new(source).unwrap(),
            ))
        };

        let brazilian = format("DD/MM/YYYY HH:mm");
        assert!(brazilian.passes(&text("28/09/2026 14:05")));
        assert!(!brazilian.passes(&text("28/09/2026")));
        assert!(!brazilian.passes(&text("2026-09-28 14:05")));
        assert!(!brazilian.passes(&text("31/04/2026 10:00")));
        assert!(!brazilian.passes(&text("10/13/2026 10:00")));
        assert!(!brazilian.passes(&text("10/10/2026 24:00")));
        assert!(!brazilian.passes(&MonitoredValue::Null));

        let leap = format("yyyy-MM-dd");
        assert!(leap.passes(&text("2024-02-29")));
        assert!(!leap.passes(&text("2026-02-29")));
        assert!(format("DD/MM").passes(&text("29/02")));

        let loose = format("D/M/YY h:mm A");
        assert!(loose.passes(&text("5/9/26 9:30 PM")));
        assert!(!loose.passes(&text("5/9/26 0:30 PM")));
        assert!(!loose.passes(&text("5/9/26 9:30 pm")));

        let iso = format("YYYY-MM-DD[T]HH:mm:ss.SSSZ");
        assert!(iso.passes(&text("2026-09-28T10:30:00.123-03:00")));
        assert!(iso.passes(&text("2026-09-28T10:30:00.123Z")));
        assert!(!iso.passes(&text("2026-09-28T10:30:00.123-03:75")));
        assert!(format("HH:mm ZZ").passes(&text("10:30 +0530")));

        // Characters that are special in a regular expression stay literal.
        assert!(format("YYYY.MM.DD (x)").passes(&text("2026.09.28 (x)")));
        assert!(!format("YYYY.MM.DD (x)").passes(&text("2026-09-28 (x)")));
    }

    #[test]
    fn custom_date_time_format_rejects_unusable_patterns() {
        assert!(matches!(
            DateTimePattern::new("  "),
            Err(ValueRuleError::EmptyDateFormat)
        ));
        assert!(matches!(
            DateTimePattern::new("YYYY[T"),
            Err(ValueRuleError::UnclosedDateLiteral(_))
        ));
        assert!(matches!(
            DateTimePattern::new("[YYYY]"),
            Err(ValueRuleError::DateFormatWithoutTokens(_))
        ));
        assert_eq!(DateTimePattern::new("DD/MM").unwrap().as_str(), "DD/MM");
    }

    #[test]
    fn monitor_reports_failed_rules_and_rejects_duplicate_fields() {
        let monitor = ValueMonitor::new(
            "m",
            "Nome curto",
            true,
            vec![FieldPath::new("nome").unwrap()],
            vec![
                ValueRule::new(
                    "tamanho",
                    RuleKind::LengthRange {
                        min: Some(1),
                        max: Some(10),
                    },
                )
                .unwrap(),
                ValueRule::new("letras", RuleKind::LettersOnly).unwrap(),
            ],
        )
        .unwrap();
        assert!(monitor.failed_rules(&text("Ana")).is_empty());
        assert_eq!(monitor.failed_rules(&text("Ana Maria")), vec!["letras"]);
        assert!(monitor.matching_field(&[key("nome")]).is_some());

        assert_eq!(
            ValueMonitor::new(
                "m",
                "x",
                true,
                vec![FieldPath::new("a").unwrap(), FieldPath::new("a").unwrap()],
                vec![],
            ),
            Err(ValueMonitorError::DuplicateField("a".into()))
        );
        assert_eq!(
            ValueMonitor::new("m", " ", true, vec![], vec![]),
            Err(ValueMonitorError::EmptyName)
        );
    }
}
