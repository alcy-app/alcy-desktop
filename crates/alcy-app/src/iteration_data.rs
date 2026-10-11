//! Arquivo de dados do runner de coleções (spec 0073): CSV com cabeçalho ou
//! JSON (array de objetos). Cada linha vira as variáveis de uma iteração.

use thiserror::Error;

pub const MAX_ITERATION_DATA_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_ITERATION_DATA_ROWS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IterationDataError {
    #[error("o arquivo de dados passa de 10 MB")]
    TooLarge,
    #[error("o arquivo de dados passa de {MAX_ITERATION_DATA_ROWS} linhas")]
    TooManyRows,
    #[error("o arquivo de dados não tem linhas")]
    Empty,
    #[error("CSV inválido na linha {line}: {message}")]
    Csv { line: usize, message: String },
    #[error("JSON inválido: {0}")]
    Json(String),
}

/// Linhas do arquivo de dados, já como pares nome/valor, na ordem das colunas.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IterationData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<(String, String)>>,
}

impl IterationData {
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }
}

/// Interpreta o conteúdo pelo formato, não pela extensão: começa com `[`,
/// JSON; senão, CSV.
pub fn parse_iteration_data(text: &str) -> Result<IterationData, IterationDataError> {
    if text.len() > MAX_ITERATION_DATA_BYTES {
        return Err(IterationDataError::TooLarge);
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let data = if text.trim_start().starts_with('[') {
        parse_json(text)?
    } else {
        parse_csv(text)?
    };
    if data.rows.is_empty() {
        return Err(IterationDataError::Empty);
    }
    if data.rows.len() > MAX_ITERATION_DATA_ROWS {
        return Err(IterationDataError::TooManyRows);
    }
    Ok(data)
}

fn parse_json(text: &str) -> Result<IterationData, IterationDataError> {
    use serde_json::Value;

    let value: Value =
        serde_json::from_str(text).map_err(|error| IterationDataError::Json(error.to_string()))?;
    let Value::Array(items) = value else {
        return Err(IterationDataError::Json(
            "esperado um array de objetos".to_string(),
        ));
    };
    if items.len() > MAX_ITERATION_DATA_ROWS {
        return Err(IterationDataError::TooManyRows);
    }

    let mut columns: Vec<String> = Vec::new();
    let mut rows = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        let Value::Object(fields) = item else {
            return Err(IterationDataError::Json(format!(
                "o item {} não é um objeto",
                index + 1
            )));
        };
        let mut row = Vec::with_capacity(fields.len());
        for (name, value) in fields {
            if !columns.contains(&name) {
                columns.push(name.clone());
            }
            let value = match value {
                Value::String(text) => text,
                Value::Null => String::new(),
                other => other.to_string(),
            };
            row.push((name, value));
        }
        rows.push(row);
    }
    Ok(IterationData { columns, rows })
}

fn parse_csv(text: &str) -> Result<IterationData, IterationDataError> {
    let delimiter = detect_delimiter(text);
    let records = split_csv_records(text, delimiter)?;
    let mut records = records
        .into_iter()
        .filter(|(_, fields)| !(fields.len() == 1 && fields[0].trim().is_empty()));

    let Some((_, header)) = records.next() else {
        return Err(IterationDataError::Empty);
    };
    let columns: Vec<String> = header.into_iter().map(|c| c.trim().to_string()).collect();
    if let Some(position) = columns.iter().position(|c| c.is_empty()) {
        return Err(IterationDataError::Csv {
            line: 1,
            message: format!("a coluna {} do cabeçalho está vazia", position + 1),
        });
    }

    let mut rows = Vec::new();
    for (line, fields) in records {
        if fields.len() > columns.len() {
            return Err(IterationDataError::Csv {
                line,
                message: format!("{} valores para {} colunas", fields.len(), columns.len()),
            });
        }
        if rows.len() == MAX_ITERATION_DATA_ROWS {
            return Err(IterationDataError::TooManyRows);
        }
        // Colunas faltando no fim da linha ficam vazias.
        let row = columns
            .iter()
            .enumerate()
            .map(|(i, name)| (name.clone(), fields.get(i).cloned().unwrap_or_default()))
            .collect();
        rows.push(row);
    }
    Ok(IterationData { columns, rows })
}

/// `;` quando o cabeçalho usa `;` e não `,` (planilhas exportadas em pt-BR).
fn detect_delimiter(text: &str) -> char {
    let header = text.lines().next().unwrap_or_default();
    if header.contains(';') && !header.contains(',') {
        ';'
    } else {
        ','
    }
}

/// Divide o texto em registros (RFC 4180): campos entre aspas podem conter
/// delimitador, quebra de linha e `""` como aspas literal. Devolve a linha
/// em que cada registro começa.
fn split_csv_records(
    text: &str,
    delimiter: char,
) -> Result<Vec<(usize, Vec<String>)>, IterationDataError> {
    let mut records = Vec::new();
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut line = 1;
    let mut record_line = 1;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => in_quotes = false,
                '\n' => {
                    line += 1;
                    field.push(c);
                }
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => in_quotes = true,
            c if c == delimiter => fields.push(std::mem::take(&mut field)),
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' => {
                fields.push(std::mem::take(&mut field));
                records.push((record_line, std::mem::take(&mut fields)));
                line += 1;
                record_line = line;
            }
            _ => field.push(c),
        }
    }
    if in_quotes {
        return Err(IterationDataError::Csv {
            line: record_line,
            message: "aspas sem fechamento".to_string(),
        });
    }
    if !field.is_empty() || !fields.is_empty() {
        fields.push(field);
        records.push((record_line, fields));
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(row: &[(String, String)]) -> Vec<(&str, &str)> {
        row.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect()
    }

    #[test]
    fn parses_csv_with_header_quotes_and_crlf() {
        let data = parse_iteration_data(
            "\u{feff}user,note\r\nana,\"olá, mundo\"\r\nbia,\"diz \"\"oi\"\"\nem duas linhas\"\r\n",
        )
        .unwrap();

        assert_eq!(data.columns, vec!["user", "note"]);
        assert_eq!(data.len(), 2);
        assert_eq!(
            pairs(&data.rows[0]),
            vec![("user", "ana"), ("note", "olá, mundo")]
        );
        assert_eq!(
            pairs(&data.rows[1]),
            vec![("user", "bia"), ("note", "diz \"oi\"\nem duas linhas")]
        );
    }

    #[test]
    fn detects_semicolon_delimiter_and_fills_missing_columns() {
        let data = parse_iteration_data("a;b;c\n1;2\n\n3;4;5").unwrap();

        assert_eq!(
            pairs(&data.rows[0]),
            vec![("a", "1"), ("b", "2"), ("c", "")]
        );
        assert_eq!(data.len(), 2);
    }

    #[test]
    fn rejects_rows_with_extra_values_and_open_quotes() {
        assert_eq!(
            parse_iteration_data("a,b\n1,2,3"),
            Err(IterationDataError::Csv {
                line: 2,
                message: "3 valores para 2 colunas".to_string()
            })
        );
        assert!(matches!(
            parse_iteration_data("a\n\"1"),
            Err(IterationDataError::Csv { line: 2, .. })
        ));
    }

    #[test]
    fn header_only_is_empty() {
        assert_eq!(
            parse_iteration_data("a,b\n"),
            Err(IterationDataError::Empty)
        );
        assert_eq!(parse_iteration_data(""), Err(IterationDataError::Empty));
    }

    #[test]
    fn parses_json_array_of_objects() {
        let data = parse_iteration_data(
            r#"[{"id": 1, "name": "ana", "ok": true}, {"extra": null, "id": 2, "tags": [1]}]"#,
        )
        .unwrap();

        assert_eq!(data.columns, vec!["id", "name", "ok", "extra", "tags"]);
        assert_eq!(data.len(), 2);
        assert_eq!(
            pairs(&data.rows[0]),
            vec![("id", "1"), ("name", "ana"), ("ok", "true")]
        );
        assert_eq!(
            pairs(&data.rows[1]),
            vec![("extra", ""), ("id", "2"), ("tags", "[1]")]
        );
    }

    #[test]
    fn rejects_json_that_is_not_an_array_of_objects() {
        assert!(matches!(
            parse_iteration_data("[1, 2]"),
            Err(IterationDataError::Json(_))
        ));
        assert!(matches!(
            parse_iteration_data("[{"),
            Err(IterationDataError::Json(_))
        ));
        assert_eq!(parse_iteration_data("[]"), Err(IterationDataError::Empty));
    }

    #[test]
    fn limits_the_number_of_rows() {
        let mut csv = String::from("n\n");
        for i in 0..=MAX_ITERATION_DATA_ROWS {
            csv.push_str(&format!("{i}\n"));
        }
        assert_eq!(
            parse_iteration_data(&csv),
            Err(IterationDataError::TooManyRows)
        );
    }
}
