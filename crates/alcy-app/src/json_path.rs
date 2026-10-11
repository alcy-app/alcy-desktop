use thiserror::Error;

/// Erros de navegação de `evaluate_json_path`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum JsonPathError {
    #[error("chave '{0}' não encontrada")]
    KeyNotFound(String),
    #[error("índice {index} fora dos limites (tamanho {len})")]
    IndexOutOfBounds { index: usize, len: usize },
    #[error("segmento '{0}' não é um índice de array válido")]
    InvalidIndex(String),
    #[error("não é possível navegar em '{0}': valor não é objeto nem array")]
    NotIndexable(String),
}

/// Navega em `value` seguindo `path` (segmentos separados por `.`, cada um
/// uma chave de objeto ou um índice inteiro de array). `path` vazio retorna
/// `value` sem alterações.
pub fn evaluate_json_path(
    value: &serde_json::Value,
    path: &str,
) -> Result<serde_json::Value, JsonPathError> {
    if path.is_empty() {
        return Ok(value.clone());
    }

    let mut current = value;
    for segment in path.split('.') {
        current = match current {
            serde_json::Value::Object(map) => map
                .get(segment)
                .ok_or_else(|| JsonPathError::KeyNotFound(segment.to_string()))?,
            serde_json::Value::Array(items) => {
                let index: usize = segment
                    .parse()
                    .map_err(|_| JsonPathError::InvalidIndex(segment.to_string()))?;
                let len = items.len();
                items
                    .get(index)
                    .ok_or(JsonPathError::IndexOutOfBounds { index, len })?
            }
            _ => return Err(JsonPathError::NotIndexable(segment.to_string())),
        };
    }

    Ok(current.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn returns_the_whole_value_for_an_empty_path() {
        let value = json!({"a": 1});

        assert_eq!(evaluate_json_path(&value, "").unwrap(), value);
    }

    #[test]
    fn descends_into_nested_objects() {
        let value = json!({"data": {"token": "abc123"}});

        assert_eq!(
            evaluate_json_path(&value, "data.token").unwrap(),
            json!("abc123")
        );
    }

    #[test]
    fn descends_into_arrays_by_index() {
        let value = json!({"items": ["first", "second"]});

        assert_eq!(
            evaluate_json_path(&value, "items.1").unwrap(),
            json!("second")
        );
    }

    #[test]
    fn fails_on_a_missing_key() {
        let value = json!({"data": {}});

        assert_eq!(
            evaluate_json_path(&value, "data.token").unwrap_err(),
            JsonPathError::KeyNotFound("token".to_string())
        );
    }

    #[test]
    fn fails_on_an_out_of_bounds_index() {
        let value = json!({"items": ["only"]});

        assert_eq!(
            evaluate_json_path(&value, "items.5").unwrap_err(),
            JsonPathError::IndexOutOfBounds { index: 5, len: 1 }
        );
    }

    #[test]
    fn fails_on_a_non_numeric_index_into_an_array() {
        let value = json!({"items": ["only"]});

        assert_eq!(
            evaluate_json_path(&value, "items.token").unwrap_err(),
            JsonPathError::InvalidIndex("token".to_string())
        );
    }

    #[test]
    fn fails_when_descending_into_a_scalar() {
        let value = json!({"data": "just a string"});

        assert_eq!(
            evaluate_json_path(&value, "data.token").unwrap_err(),
            JsonPathError::NotIndexable("token".to_string())
        );
    }
}
