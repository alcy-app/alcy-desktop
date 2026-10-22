//! Bounded interpretation of declarative values, never JavaScript execution.

use std::collections::{BTreeMap, BTreeSet};

use oxc_ast::ast::{Argument, Expression, ObjectPropertyKind, PropertyKey};

use super::is_js_identifier;

const MAX_EXPANDED_BYTES: usize = 2 * 1024 * 1024;

/// Oxc represents lone UTF-16 surrogates as literal backslash text. Reject
/// those values instead of silently changing their JSON or HTTP encoding.
fn valid_unicode_escapes(raw: &str) -> bool {
    fn unicode(raw: &str) -> Option<(u32, usize)> {
        let tail = raw.strip_prefix("\\u")?;
        if let Some(braced) = tail.strip_prefix('{') {
            let end = braced.find('}')?;
            Some((u32::from_str_radix(&braced[..end], 16).ok()?, end + 4))
        } else {
            Some((u32::from_str_radix(tail.get(..4)?, 16).ok()?, 6))
        }
    }
    let mut index = 0;
    while index < raw.len() {
        if raw.as_bytes()[index] != b'\\' {
            index += 1;
            continue;
        }
        if raw.as_bytes().get(index + 1) != Some(&b'u') {
            index += 2;
            continue;
        }
        let Some((unit, consumed)) = unicode(&raw[index..]) else {
            return false;
        };
        index += consumed;
        if (0xd800..=0xdbff).contains(&unit) {
            if consumed != 6 {
                return false;
            }
            let Some((low, consumed)) = raw.get(index..).and_then(unicode) else {
                return false;
            };
            if consumed != 6 || !(0xdc00..=0xdfff).contains(&low) {
                return false;
            }
            index += consumed;
        } else if (0xdc00..=0xdfff).contains(&unit) {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone)]
pub(super) enum K6Value {
    String(String),
    Template(String),
    Number(f64),
    Bool(bool),
    Null,
    Array(Vec<K6Value>),
    Object(Vec<(String, K6Value)>),
}

impl K6Value {
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::String(value) | Self::Template(value) => Some(value),
            _ => None,
        }
    }

    pub fn string(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn object(&self) -> Option<&[(String, Self)]> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }

    pub fn array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }

    pub fn field(&self, name: &str) -> Option<&Self> {
        self.object()?
            .iter()
            .find_map(|(key, value)| (key == name).then_some(value))
    }

    pub fn number(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn unsigned(&self) -> Option<u64> {
        let value = self.number()?;
        (value >= 0.0 && value.fract() == 0.0 && value < u64::MAX as f64).then_some(value as u64)
    }

    pub fn dynamic(&self) -> bool {
        match self {
            Self::Template(_) => true,
            Self::Array(values) => values.iter().any(Self::dynamic),
            Self::Object(values) => values.iter().any(|(_, value)| value.dynamic()),
            _ => false,
        }
    }

    fn scalar_text(&self) -> Option<String> {
        match self {
            Self::String(value) | Self::Template(value) => Some(value.clone()),
            Self::Number(value) => Some(number_text(*value)),
            Self::Bool(value) => Some(value.to_string()),
            Self::Null => Some("null".into()),
            _ => None,
        }
    }

    fn bytes(&self) -> usize {
        match self {
            Self::String(value) | Self::Template(value) => value.len() + 8,
            Self::Array(values) => 8 + values.iter().map(Self::bytes).sum::<usize>(),
            Self::Object(values) => {
                8 + values
                    .iter()
                    .map(|(key, value)| key.len() + value.bytes())
                    .sum::<usize>()
            }
            _ => 16,
        }
    }

    fn depth(&self) -> usize {
        match self {
            Self::Array(values) => 1 + values.iter().map(Self::depth).max().unwrap_or(0),
            Self::Object(values) => {
                1 + values
                    .iter()
                    .map(|(_, value)| value.depth())
                    .max()
                    .unwrap_or(0)
            }
            _ => 0,
        }
    }

    /// JSON.stringify for the supported JSON data subset. Integer-index keys
    /// precede other keys; other keys retain their JavaScript insertion order.
    fn json(&self) -> Option<String> {
        match self {
            Self::String(value) => serde_json::to_string(value).ok(),
            Self::Number(value) => Some(number_text(*value)),
            Self::Bool(value) => Some(value.to_string()),
            Self::Null => Some("null".into()),
            Self::Array(values) => Some(format!(
                "[{}]",
                values
                    .iter()
                    .map(Self::json)
                    .collect::<Option<Vec<_>>>()?
                    .join(",")
            )),
            Self::Object(values) => {
                let mut ordered = values.iter().collect::<Vec<_>>();
                ordered.sort_by_key(|(key, _)| index_key(key).map_or((1, 0), |index| (0, index)));
                Some(format!(
                    "{{{}}}",
                    ordered
                        .into_iter()
                        .map(|(key, value)| Some(format!(
                            "{}:{}",
                            serde_json::to_string(key).ok()?,
                            value.json()?
                        )))
                        .collect::<Option<Vec<_>>>()?
                        .join(",")
                ))
            }
            Self::Template(_) => None,
        }
    }
}

fn index_key(key: &str) -> Option<u32> {
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

pub(super) fn number_text(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.abs() < 1e-6 || value.abs() >= 1e21 {
        let raw = format!("{value:e}");
        if let Some((mantissa, exponent)) = raw.split_once('e') {
            let sign = if exponent.starts_with('-') { "" } else { "+" };
            return format!("{mantissa}e{sign}{exponent}");
        }
    }
    value.to_string()
}

#[derive(Default)]
pub(super) struct K6Resolver<'s> {
    source: &'s str,
    pub values: BTreeMap<String, K6Value>,
    pub required_variables: BTreeSet<String>,
    expanded_bytes: usize,
}

impl<'s> K6Resolver<'s> {
    pub fn new(source: &'s str) -> Self {
        Self {
            source,
            ..Self::default()
        }
    }
    pub fn resolve(&mut self, expression: &Expression<'_>) -> Result<K6Value, &'static str> {
        self.value(expression, 0)
    }

    fn charge(&mut self, bytes: usize) -> Result<(), &'static str> {
        self.expanded_bytes = self.expanded_bytes.saturating_add(bytes);
        if self.expanded_bytes > MAX_EXPANDED_BYTES {
            return Err("k6 static values exceed the 2 MiB expansion limit");
        }
        Ok(())
    }

    fn environment(&mut self, name: &str) -> Result<K6Value, &'static str> {
        if !is_js_identifier(name) {
            return Err("__ENV requires a literal identifier name");
        }
        let mapped = format!("K6_ENV_{name}");
        self.required_variables.insert(mapped.clone());
        Ok(K6Value::Template(format!("{{{{{mapped}}}}}")))
    }

    fn value(
        &mut self,
        expression: &Expression<'_>,
        depth: usize,
    ) -> Result<K6Value, &'static str> {
        if depth > 32 {
            return Err("k6 static values exceed the depth limit of 32");
        }
        let invalid = "unsupported or unresolved k6 static expression";
        let value = match expression {
            Expression::StringLiteral(value) => {
                if !valid_unicode_escapes(
                    &self.source[value.span.start as usize..value.span.end as usize],
                ) {
                    return Err("unpaired UTF-16 surrogate escapes cannot be imported faithfully");
                }
                K6Value::String(value.value.to_string())
            }
            Expression::NumericLiteral(value) if value.value.is_finite() => {
                K6Value::Number(value.value)
            }
            Expression::BooleanLiteral(value) => K6Value::Bool(value.value),
            Expression::NullLiteral(_) => K6Value::Null,
            Expression::Identifier(id) => {
                let value = self.values.get(id.name.as_str()).ok_or(invalid)?;
                if depth + value.depth() > 32 {
                    return Err("k6 static values exceed the depth limit of 32");
                }
                self.charge(value.bytes())?;
                return self.values.get(id.name.as_str()).cloned().ok_or(invalid);
            }
            Expression::UnaryExpression(unary) => {
                let value = self
                    .value(&unary.argument, depth + 1)?
                    .number()
                    .ok_or(invalid)?;
                K6Value::Number(match unary.operator.as_str() {
                    "+" => value,
                    "-" => -value,
                    _ => return Err(invalid),
                })
            }
            Expression::ParenthesizedExpression(value) => {
                return self.value(&value.expression, depth + 1);
            }
            Expression::TSAsExpression(value) => return self.value(&value.expression, depth + 1),
            Expression::TSSatisfiesExpression(value) => {
                return self.value(&value.expression, depth + 1);
            }
            Expression::ObjectExpression(object) => {
                let mut fields = Vec::new();
                let mut keys = BTreeSet::new();
                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        return Err(invalid);
                    };
                    if property.computed
                        || property.method
                        || !matches!(property.kind, oxc_ast::ast::PropertyKind::Init)
                    {
                        return Err(invalid);
                    }
                    let key = match &property.key {
                        PropertyKey::StaticIdentifier(id) => id.name.to_string(),
                        PropertyKey::StringLiteral(value) => {
                            if !valid_unicode_escapes(
                                &self.source[value.span.start as usize..value.span.end as usize],
                            ) {
                                return Err(invalid);
                            }
                            value.value.to_string()
                        }
                        PropertyKey::NumericLiteral(value) => number_text(value.value),
                        _ => return Err(invalid),
                    };
                    if key == "__proto__" || !keys.insert(key.clone()) {
                        return Err(invalid);
                    }
                    fields.push((key, self.value(&property.value, depth + 1)?));
                }
                K6Value::Object(fields)
            }
            Expression::ArrayExpression(array) => K6Value::Array(
                array
                    .elements
                    .iter()
                    .map(|element| self.value(element.as_expression().ok_or(invalid)?, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            Expression::StaticMemberExpression(member) if !member.optional => {
                if matches!(&member.object, Expression::Identifier(id) if id.name == "__ENV") {
                    self.environment(member.property.name.as_str())?
                } else {
                    let object = self.value(&member.object, depth + 1)?;
                    object
                        .field(member.property.name.as_str())
                        .cloned()
                        .ok_or(invalid)?
                }
            }
            Expression::ComputedMemberExpression(member) if !member.optional => {
                if matches!(&member.object, Expression::Identifier(id) if id.name == "__ENV")
                    && !matches!(&member.expression, Expression::StringLiteral(_))
                {
                    return Err(invalid);
                }
                let key = self.value(&member.expression, depth + 1)?;
                if matches!(&member.object, Expression::Identifier(id) if id.name == "__ENV") {
                    self.environment(key.string().ok_or(invalid)?)?
                } else {
                    let object = self.value(&member.object, depth + 1)?;
                    match &object {
                        K6Value::Array(values) => values
                            .get(key.unsigned().ok_or(invalid)? as usize)
                            .cloned()
                            .ok_or(invalid)?,
                        _ => object
                            .field(key.string().ok_or(invalid)?)
                            .cloned()
                            .ok_or(invalid)?,
                    }
                }
            }
            Expression::BinaryExpression(binary) if binary.operator.as_str() == "+" => {
                let left = self.value(&binary.left, depth + 1)?;
                let right = self.value(&binary.right, depth + 1)?;
                if left.text().is_none() && right.text().is_none() {
                    return Err(invalid);
                }
                let joined = format!(
                    "{}{}",
                    left.scalar_text().ok_or(invalid)?,
                    right.scalar_text().ok_or(invalid)?
                );
                if left.dynamic() || right.dynamic() {
                    K6Value::Template(joined)
                } else {
                    K6Value::String(joined)
                }
            }
            Expression::TemplateLiteral(template) => {
                let mut text = String::new();
                let mut dynamic = false;
                for (index, quasi) in template.quasis.iter().enumerate() {
                    if !valid_unicode_escapes(quasi.value.raw.as_str()) {
                        return Err(invalid);
                    }
                    text.push_str(quasi.value.cooked.as_ref().ok_or(invalid)?.as_str());
                    if let Some(expression) = template.expressions.get(index) {
                        let value = self.value(expression, depth + 1)?;
                        dynamic |= value.dynamic();
                        text.push_str(&value.scalar_text().ok_or(invalid)?);
                    }
                    if text.len() > MAX_EXPANDED_BYTES {
                        return Err("k6 template exceeds the expansion limit");
                    }
                }
                if dynamic {
                    K6Value::Template(text)
                } else {
                    K6Value::String(text)
                }
            }
            Expression::CallExpression(call) if !call.optional => {
                if !matches!(&call.callee, Expression::StaticMemberExpression(member)
                    if !member.optional && member.property.name == "stringify"
                    && matches!(&member.object, Expression::Identifier(id) if id.name == "JSON")
                    && !self.values.contains_key("JSON"))
                {
                    return Err(invalid);
                }
                let [argument] = call.arguments.as_slice() else {
                    return Err(invalid);
                };
                let value = self.value(argument.as_expression().ok_or(invalid)?, depth + 1)?;
                K6Value::String(
                    value
                        .json()
                        .ok_or("JSON.stringify requires entirely static JSON data")?,
                )
            }
            _ => return Err(invalid),
        };
        self.charge(value.bytes())?;
        Ok(value)
    }

    pub fn arguments(&mut self, arguments: &[Argument<'_>]) -> Result<Vec<K6Value>, &'static str> {
        arguments
            .iter()
            .map(|argument| {
                self.resolve(
                    argument
                        .as_expression()
                        .ok_or("spread arguments are unsupported")?,
                )
            })
            .collect()
    }
}
