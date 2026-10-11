//! Interpretação de erro GraphQL no corpo de uma resposta.
//!
//! Pela especificação GraphQL-over-HTTP, um erro GraphQL normalmente chega
//! como HTTP 200 com um array `errors` no corpo — uma `Response` bem
//! sucedida do ponto de vista de transporte (ver `alcy_domain::Response` e a
//! spec 0003). Essa interpretação fica no adapter GraphQL, não em
//! `alcy-domain`, para não incorporar campos específicos do protocolo no
//! núcleo genérico.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlErrorLocation {
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlError {
    pub message: String,
    pub path: Vec<String>,
    pub locations: Vec<GraphqlErrorLocation>,
}

/// Extrai os erros GraphQL de um corpo de resposta.
///
/// Corpo que não é JSON, ou sem um array `errors` não vazio, resulta em uma
/// lista vazia — ausência de erro GraphQL não é uma falha de parsing.
///
/// Só o array `errors` é materializado: o resto do corpo (tipicamente um
/// `data` enorme) é percorrido sem alocar, em vez de virar
/// uma árvore `serde_json::Value` de várias vezes o tamanho do corpo. Um
/// corpo que nem menciona `"errors"` nem chega a ser percorrido.
pub fn interpret_graphql_errors(body: &str) -> Vec<GraphqlError> {
    if !body.contains("\"errors\"") {
        return Vec::new();
    }

    let Ok(envelope) = serde_json::from_str::<ErrorsEnvelope>(body) else {
        return Vec::new();
    };

    envelope
        .errors
        .unwrap_or_default()
        .iter()
        .map(parse_error)
        .collect()
}

/// Envelope GraphQL reduzido ao que a interpretação de erros usa. Campos
/// desconhecidos (`data` incluso) são pulados pelo próprio serde, que os
/// consome como `IgnoredAny` sem alocar; um `errors` que não seja array (ou
/// `null`) resulta em lista vazia, como antes.
#[derive(Deserialize)]
struct ErrorsEnvelope {
    #[serde(default, deserialize_with = "errors_array_or_none")]
    errors: Option<Vec<Value>>,
}

fn errors_array_or_none<'de, D>(deserializer: D) -> Result<Option<Vec<Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Array(errors) => Some(errors),
        _ => None,
    })
}

fn parse_error(raw: &Value) -> GraphqlError {
    let message = raw
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("erro GraphQL sem mensagem")
        .to_string();

    let path = raw
        .get("path")
        .and_then(Value::as_array)
        .map(|segments| segments.iter().map(path_segment_to_string).collect())
        .unwrap_or_default();

    let locations = raw
        .get("locations")
        .and_then(Value::as_array)
        .map(|locations| locations.iter().filter_map(parse_location).collect())
        .unwrap_or_default();

    GraphqlError {
        message,
        path,
        locations,
    }
}

fn path_segment_to_string(segment: &Value) -> String {
    match segment {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn parse_location(raw: &Value) -> Option<GraphqlErrorLocation> {
    let line = raw.get("line")?.as_u64()? as u32;
    let column = raw.get("column")?.as_u64()? as u32;
    Some(GraphqlErrorLocation { line, column })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_no_errors_for_a_body_without_an_errors_array() {
        assert_eq!(
            interpret_graphql_errors("{\"data\":{\"ping\":true}}"),
            vec![]
        );
    }

    #[test]
    fn returns_no_errors_for_a_non_json_body() {
        assert_eq!(interpret_graphql_errors("internal error"), vec![]);
    }

    #[test]
    fn returns_no_errors_for_an_empty_errors_array() {
        assert_eq!(
            interpret_graphql_errors("{\"data\":null,\"errors\":[]}"),
            vec![]
        );
    }

    #[test]
    fn parses_message_path_and_locations() {
        let body = r#"{
            "data": null,
            "errors": [
                {
                    "message": "Not authorized",
                    "path": ["currentCustomer", "orders", 0],
                    "locations": [{"line": 3, "column": 5}]
                }
            ]
        }"#;

        let errors = interpret_graphql_errors(body);

        assert_eq!(
            errors,
            vec![GraphqlError {
                message: "Not authorized".to_string(),
                path: vec![
                    "currentCustomer".to_string(),
                    "orders".to_string(),
                    "0".to_string()
                ],
                locations: vec![GraphqlErrorLocation { line: 3, column: 5 }],
            }]
        );
    }

    #[test]
    fn finds_errors_after_a_large_nested_data_field() {
        let rows: Vec<String> = (0..2_000)
            .map(|index| format!(r#"{{"id":{index},"tags":["a","b"],"nested":{{"ok":true}}}}"#))
            .collect();
        let body = format!(
            r#"{{"data":{{"items":[{}]}},"errors":[{{"message":"partial failure"}}]}}"#,
            rows.join(",")
        );

        let errors = interpret_graphql_errors(&body);

        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].message, "partial failure");
    }

    #[test]
    fn returns_no_errors_when_errors_is_not_an_array() {
        assert_eq!(interpret_graphql_errors(r#"{"errors":"boom"}"#), vec![]);
        assert_eq!(interpret_graphql_errors(r#"{"errors":null}"#), vec![]);
    }

    #[test]
    fn returns_no_errors_for_a_top_level_array_body() {
        assert_eq!(
            interpret_graphql_errors(r#"[{"errors":[{"message":"x"}]}]"#),
            vec![]
        );
    }

    #[test]
    fn defaults_the_message_when_missing() {
        let errors = interpret_graphql_errors(r#"{"errors":[{}]}"#);

        assert_eq!(errors[0].message, "erro GraphQL sem mensagem");
        assert_eq!(errors[0].path, Vec::<String>::new());
        assert_eq!(errors[0].locations, Vec::new());
    }
}
