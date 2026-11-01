//! Arguments as models send them, fitted to the tool's schema before the tool
//! runs (spec 0139). Smaller models often send a nested object as JSON text, a
//! number as a string, an enum in another case or a key in another style;
//! those have a single meaning and are fixed here. Anything else becomes an
//! error that says what the tool expects, instead of a key the tool silently
//! ignores.

use serde_json::{Map, Value};

/// `Err` carries a message for the model.
pub(super) fn normalize_arguments(schema: &Value, input: &Value) -> Result<Value, String> {
    let Value::Object(arguments) = input else {
        return Err("The tool arguments must be a JSON object.".into());
    };
    let normalized = normalize_object(schema, arguments, "", true)?;
    if let Some(required) = schema["required"].as_array() {
        for key in required.iter().filter_map(Value::as_str) {
            if !normalized.contains_key(key) {
                let hint = schema["properties"][key]["description"]
                    .as_str()
                    .map(|description| format!(" ({description})"))
                    .unwrap_or_default();
                return Err(format!("Missing required argument '{key}'{hint}."));
            }
        }
    }
    Ok(Value::Object(normalized))
}

fn types(schema: &Value) -> Vec<&str> {
    match &schema["type"] {
        Value::String(kind) => vec![kind.as_str()],
        Value::Array(kinds) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn matches_type(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.is_number(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn label(path: &str) -> &str {
    if path.is_empty() {
        "the arguments"
    } else {
        path
    }
}

/// Keys compared without case, `_` or `-`: `flow_id` and `FlowID` mean `flowId`.
fn loose_key(key: &str) -> String {
    key.chars()
        .filter(|character| *character != '_' && *character != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

/// `strict` rejects unknown keys. Nested objects are not strict: some of their
/// schemas describe only the common fields, and the tool validates the rest.
fn normalize_object(
    schema: &Value,
    object: &Map<String, Value>,
    path: &str,
    strict: bool,
) -> Result<Map<String, Value>, String> {
    let Some(properties) = schema["properties"].as_object() else {
        return Ok(object.clone());
    };
    let mut normalized = Map::new();
    for (key, value) in object {
        let known = if properties.contains_key(key) {
            Some(key.as_str())
        } else {
            let mut candidates = properties
                .keys()
                .filter(|candidate| loose_key(candidate) == loose_key(key));
            match (candidates.next(), candidates.next()) {
                (Some(candidate), None) if !object.contains_key(candidate) => {
                    Some(candidate.as_str())
                }
                _ => None,
            }
        };
        let Some(name) = known else {
            if strict && schema["additionalProperties"] == Value::Bool(false) {
                let allowed = properties.keys().cloned().collect::<Vec<_>>().join(", ");
                return Err(format!(
                    "Unknown argument '{key}' in {}. Allowed: {allowed}.",
                    label(path)
                ));
            }
            normalized.insert(key.clone(), value.clone());
            continue;
        };
        let child_path = if path.is_empty() {
            name.to_string()
        } else {
            format!("{path}.{name}")
        };
        let property = &properties[name];
        // A null for a field that cannot be null means "not given".
        if value.is_null() && !types(property).is_empty() && !types(property).contains(&"null") {
            continue;
        }
        normalized.insert(
            name.to_string(),
            normalize_value(property, value, &child_path)?,
        );
    }
    Ok(normalized)
}

fn normalize_value(schema: &Value, value: &Value, path: &str) -> Result<Value, String> {
    let kinds = types(schema);
    let value = coerce(&kinds, value);
    if !kinds.is_empty() && !kinds.iter().any(|kind| matches_type(&value, kind)) {
        return Err(format!(
            "'{path}' must be {}, not {}.",
            kinds.join(" or "),
            describe(&value)
        ));
    }
    match &value {
        Value::String(text) => {
            if let Some(options) = schema["enum"].as_array() {
                return enum_value(options, text, path);
            }
            Ok(value)
        }
        Value::Object(object) => Ok(Value::Object(normalize_object(
            schema, object, path, false,
        )?)),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                normalize_value(&schema["items"], item, &format!("{path}[{index}]"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        _ => Ok(value),
    }
}

/// Values with one meaning in the expected type: JSON text for an object or a
/// list, a single item for a list, booleans and numbers written as text or
/// the other way around.
fn coerce(kinds: &[&str], value: &Value) -> Value {
    if kinds.is_empty() || kinds.iter().any(|kind| matches_type(value, kind)) {
        return value.clone();
    }
    if let Value::String(text) = value {
        let trimmed = text.trim();
        if (kinds.contains(&"object") || kinds.contains(&"array"))
            && let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
            && kinds.iter().any(|kind| matches_type(&parsed, kind))
        {
            return parsed;
        }
        if kinds.contains(&"boolean") {
            match trimmed.to_ascii_lowercase().as_str() {
                "true" => return Value::Bool(true),
                "false" => return Value::Bool(false),
                _ => {}
            }
        }
        if kinds.contains(&"integer")
            && let Ok(number) = trimmed.parse::<i64>()
        {
            return Value::from(number);
        }
        if kinds.contains(&"number")
            && let Ok(number) = trimmed.parse::<f64>()
            && let Some(number) = serde_json::Number::from_f64(number)
        {
            return Value::Number(number);
        }
    }
    if kinds.contains(&"string") && (value.is_number() || value.is_boolean()) {
        return Value::String(value.to_string());
    }
    if kinds.contains(&"integer")
        && let Some(number) = value.as_f64()
        && number.fract() == 0.0
        && number.abs() < 9e15
    {
        return Value::from(number as i64);
    }
    if kinds.contains(&"array") && !value.is_array() && !value.is_null() {
        return Value::Array(vec![value.clone()]);
    }
    value.clone()
}

fn enum_value(options: &[Value], text: &str, path: &str) -> Result<Value, String> {
    let names: Vec<&str> = options.iter().filter_map(Value::as_str).collect();
    if names.contains(&text) {
        return Ok(Value::String(text.into()));
    }
    let mut loose = names
        .iter()
        .filter(|name| loose_key(name) == loose_key(text));
    match (loose.next(), loose.next()) {
        (Some(name), None) => Ok(Value::String((*name).into())),
        _ => Err(format!(
            "'{path}' must be one of: {}; got '{text}'.",
            names.join(", ")
        )),
    }
}

fn describe(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) => "a boolean".into(),
        Value::Number(_) => "a number".into(),
        Value::String(text) => format!("the text '{}'", text.chars().take(40).collect::<String>()),
        Value::Array(_) => "a list".into(),
        Value::Object(_) => "an object".into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn schema() -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["flowId"],
            "properties": {
                "flowId": { "type": "string", "description": "Flow id from list_flows." },
                "method": { "type": "string", "enum": ["get", "post"] },
                "limit": { "type": "integer" },
                "open": { "type": "boolean" },
                "nodeIds": { "type": "array", "items": { "type": "string" } },
                "parent": { "type": ["string", "null"] },
                "node": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": { "kind": { "type": "string", "enum": ["inlineRequest", "log"] }, "x": { "type": "number" } },
                },
                "nodes": { "type": "array", "items": { "type": "object", "properties": { "durationMs": { "type": "integer" } } } },
            },
        })
    }

    fn normalize(input: Value) -> Result<Value, String> {
        normalize_arguments(&schema(), &input)
    }

    #[test]
    fn values_with_a_single_meaning_are_fixed() {
        let normalized = normalize(json!({
            "flow_id": 7,
            "method": "POST",
            "limit": "5",
            "open": "TRUE",
            "nodeIds": "a",
            "node": "{\"Kind\":\"INLINE_REQUEST\",\"x\":\"12.5\"}",
            "nodes": [{ "durationMs": 1000.0 }],
        }))
        .unwrap();

        assert_eq!(
            normalized,
            json!({
                "flowId": "7",
                "method": "post",
                "limit": 5,
                "open": true,
                "nodeIds": ["a"],
                "node": { "kind": "inlineRequest", "x": 12.5 },
                "nodes": [{ "durationMs": 1000 }],
            })
        );
    }

    #[test]
    fn nulls_mean_not_given_unless_the_field_takes_null() {
        let normalized =
            normalize(json!({ "flowId": "f", "limit": null, "parent": null })).unwrap();
        assert_eq!(normalized, json!({ "flowId": "f", "parent": null }));
    }

    #[test]
    fn errors_say_what_the_tool_expects() {
        assert_eq!(
            normalize(json!({})).unwrap_err(),
            "Missing required argument 'flowId' (Flow id from list_flows.)."
        );
        assert!(
            normalize(json!({ "flowId": "f", "flow": "x" }))
                .unwrap_err()
                .starts_with("Unknown argument 'flow' in the arguments. Allowed: flowId,")
        );
        assert_eq!(
            normalize(json!({ "flowId": "f", "method": "fetch" })).unwrap_err(),
            "'method' must be one of: get, post; got 'fetch'."
        );
        assert_eq!(
            normalize(json!({ "flowId": "f", "limit": "many" })).unwrap_err(),
            "'limit' must be integer, not the text 'many'."
        );
        assert_eq!(
            normalize(json!({ "flowId": ["f"] })).unwrap_err(),
            "'flowId' must be string, not a list."
        );
    }

    #[test]
    fn nested_objects_keep_keys_their_schema_does_not_list() {
        let normalized =
            normalize(json!({ "flowId": "f", "node": { "kind": "log", "message": "hi" } }))
                .unwrap();
        assert_eq!(normalized["node"]["message"], "hi");
    }
}
