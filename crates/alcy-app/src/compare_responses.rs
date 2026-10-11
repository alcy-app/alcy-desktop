//! Comparação entre respostas de envios da mesma requisição (ADR 0036).
//!
//! A comparação é estrita: a ordem de chaves e de itens de arrays importa.
//! Um corpo JSON é reformatado antes de comparar — só a formatação
//! (espaços e quebras de linha) nunca conta como diferença. Corpos que não
//! são JSON são comparados como vieram.

use std::time::Duration;

use alcy_domain::{BodyEncoding, HistoryFailureKind, HistoryOutcome};
use similar::{Algorithm, ChangeTag, TextDiff};

use crate::version_control::{DiffLine, DiffLineKind, MAX_DIFF_LINES};

/// Acima disso (em qualquer lado, já normalizado) o diff de linhas não é
/// calculado; a resposta ainda diz se os corpos são iguais.
pub const MAX_RESPONSE_DIFF_BYTES: usize = 5 * 1024 * 1024;

const DIFF_CONTEXT_LINES: usize = 3;

/// Tempo máximo do algoritmo de diff; passado disso ele devolve um diff
/// correto, só menos enxuto, em vez de travar em corpos patológicos.
const DIFF_TIMEOUT: Duration = Duration::from_secs(2);

/// Status de um lado da comparação.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComparedOutcome {
    Response {
        status_code: u16,
    },
    Failed {
        kind: HistoryFailureKind,
        message: String,
    },
}

/// Trecho alterado; `Removed` só existe na base e `Added` só no alvo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseDiffHunk {
    pub base_start: u32,
    pub target_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BodyDiff {
    pub hunks: Vec<ResponseDiffHunk>,
    pub too_large: bool,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseComparison {
    /// Mesmo status e mesmo corpo (falhas: mesmo tipo de falha).
    pub identical: bool,
    pub base: ComparedOutcome,
    pub target: ComparedOutcome,
    pub body: BodyDiff,
}

enum NormalizedBody<'a> {
    Text(String),
    Binary(&'a str),
}

/// Compara dois envios; `base` é o lado antigo ("−") e `target` o novo ("+").
pub fn compare_responses(base: &HistoryOutcome, target: &HistoryOutcome) -> ResponseComparison {
    let base_outcome = compared_outcome(base);
    let target_outcome = compared_outcome(target);

    let (base_response, target_response) = match (base, target) {
        (HistoryOutcome::Success(base), HistoryOutcome::Success(target)) => (base, target),
        (
            HistoryOutcome::Failed {
                kind: base_kind, ..
            },
            HistoryOutcome::Failed {
                kind: target_kind, ..
            },
        ) => {
            return ResponseComparison {
                identical: base_kind == target_kind,
                base: base_outcome,
                target: target_outcome,
                body: BodyDiff::default(),
            };
        }
        _ => {
            return ResponseComparison {
                identical: false,
                base: base_outcome,
                target: target_outcome,
                body: BodyDiff::default(),
            };
        }
    };

    let base_body = normalize_body(&base_response.body, base_response.encoding);
    let target_body = normalize_body(&target_response.body, target_response.encoding);
    let same_status = base_response.status_code == target_response.status_code;

    let (identical, body) = match (&base_body, &target_body) {
        (NormalizedBody::Text(base_text), NormalizedBody::Text(target_text)) => (
            same_status && base_text == target_text,
            text_diff(base_text, target_text),
        ),
        (NormalizedBody::Binary(base_raw), NormalizedBody::Binary(target_raw)) => (
            same_status && base_raw == target_raw,
            BodyDiff {
                binary: true,
                ..BodyDiff::default()
            },
        ),
        _ => (
            false,
            BodyDiff {
                binary: true,
                ..BodyDiff::default()
            },
        ),
    };

    ResponseComparison {
        identical,
        base: base_outcome,
        target: target_outcome,
        body,
    }
}

fn compared_outcome(outcome: &HistoryOutcome) -> ComparedOutcome {
    match outcome {
        HistoryOutcome::Success(response) => ComparedOutcome::Response {
            status_code: response.status_code,
        },
        HistoryOutcome::Failed { kind, message } => ComparedOutcome::Failed {
            kind: *kind,
            message: message.clone(),
        },
    }
}

fn normalize_body(body: &str, encoding: BodyEncoding) -> NormalizedBody<'_> {
    if encoding == BodyEncoding::Base64 {
        return NormalizedBody::Binary(body);
    }
    let trimmed = body.trim_start();
    let looks_like_json = trimmed.starts_with('{') || trimmed.starts_with('[');
    if !looks_like_json || serde_json::from_str::<serde::de::IgnoredAny>(body).is_err() {
        return NormalizedBody::Text(body.to_string());
    }
    NormalizedBody::Text(pretty_json_preserving_order(body))
}

/// Reformata um JSON válido como `serde_json::to_string_pretty` faria, mas
/// sem passar por `Value` — que ordena as chaves (o workspace não usa a
/// feature `preserve_order`) e apagaria justamente a ordem que a comparação
/// precisa enxergar.
fn pretty_json_preserving_order(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    let mut depth = 0usize;
    let mut chars = text.chars().peekable();

    let new_line = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };

    while let Some(current) = chars.next() {
        match current {
            '"' => {
                out.push('"');
                while let Some(inner) = chars.next() {
                    out.push(inner);
                    match inner {
                        '\\' => {
                            if let Some(escaped) = chars.next() {
                                out.push(escaped);
                            }
                        }
                        '"' => break,
                        _ => {}
                    }
                }
            }
            '{' | '[' => {
                let close = if current == '{' { '}' } else { ']' };
                while chars.peek().is_some_and(|next| next.is_whitespace()) {
                    chars.next();
                }
                out.push(current);
                if chars.peek() == Some(&close) {
                    chars.next();
                    out.push(close);
                } else {
                    depth += 1;
                    new_line(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                new_line(&mut out, depth);
                out.push(current);
            }
            ',' => {
                out.push(',');
                new_line(&mut out, depth);
            }
            ':' => out.push_str(": "),
            other if other.is_whitespace() => {}
            other => out.push(other),
        }
    }

    out
}

fn text_diff(base: &str, target: &str) -> BodyDiff {
    let mut diff = BodyDiff::default();
    if base.len() > MAX_RESPONSE_DIFF_BYTES || target.len() > MAX_RESPONSE_DIFF_BYTES {
        diff.too_large = true;
        return diff;
    }
    if base == target {
        return diff;
    }

    let text_diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .timeout(DIFF_TIMEOUT)
        .diff_lines(base, target);
    let mut emitted = 0usize;
    'groups: for group in text_diff.grouped_ops(DIFF_CONTEXT_LINES) {
        let Some(first) = group.first() else {
            continue;
        };
        let mut hunk = ResponseDiffHunk {
            base_start: to_line_number(first.old_range().start),
            target_start: to_line_number(first.new_range().start),
            lines: Vec::new(),
        };
        for op in &group {
            for change in text_diff.iter_changes(op) {
                if emitted >= MAX_DIFF_LINES {
                    diff.truncated = true;
                    if !hunk.lines.is_empty() {
                        diff.hunks.push(hunk);
                    }
                    break 'groups;
                }
                let kind = match change.tag() {
                    ChangeTag::Equal => DiffLineKind::Context,
                    ChangeTag::Insert => DiffLineKind::Added,
                    ChangeTag::Delete => DiffLineKind::Removed,
                };
                hunk.lines.push(DiffLine {
                    kind,
                    text: change.value().trim_end_matches(['\n', '\r']).to_string(),
                });
                emitted += 1;
            }
        }
        diff.hunks.push(hunk);
    }

    diff
}

fn to_line_number(zero_based: usize) -> u32 {
    u32::try_from(zero_based + 1).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Response, ResponseMetadata};

    fn success(status_code: u16, body: &str) -> HistoryOutcome {
        HistoryOutcome::Success(Response::new(
            status_code,
            10,
            body,
            Vec::new(),
            ResponseMetadata::default(),
        ))
    }

    fn binary(body: &str) -> HistoryOutcome {
        HistoryOutcome::Success(Response::new_binary(
            200,
            10,
            body.len(),
            body,
            Vec::new(),
            ResponseMetadata::default(),
        ))
    }

    fn failed(kind: HistoryFailureKind) -> HistoryOutcome {
        HistoryOutcome::Failed {
            kind,
            message: "boom".to_string(),
        }
    }

    fn changed_lines(diff: &BodyDiff) -> Vec<(DiffLineKind, String)> {
        diff.hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .filter(|line| line.kind != DiffLineKind::Context)
            .map(|line| (line.kind, line.text.clone()))
            .collect()
    }

    #[test]
    fn reordered_keys_and_array_items_are_differences() {
        let base = success(200, r#"{"a":1,"b":[1,2]}"#);
        let target = success(200, r#"{"b":[2,1],"a":1}"#);

        let comparison = compare_responses(&base, &target);

        assert!(!comparison.identical);
        assert!(!comparison.body.hunks.is_empty());
    }

    #[test]
    fn json_formatting_alone_is_never_a_difference() {
        let base = success(200, r#"{"a":[1,2],"b":{}}"#);
        let target = success(200, "{\n  \"a\" : [ 1, 2 ],\n  \"b\": { }\n}\n");

        let comparison = compare_responses(&base, &target);

        assert!(comparison.identical);
        assert!(comparison.body.hunks.is_empty());
    }

    #[test]
    fn diff_shows_changed_values_line_by_line_in_the_original_order() {
        let base = success(200, r#"{"z":1,"a":"old"}"#);
        let target = success(200, r#"{"z":1,"a":"new"}"#);

        let comparison = compare_responses(&base, &target);

        assert!(!comparison.identical);
        assert_eq!(
            changed_lines(&comparison.body),
            vec![
                (DiffLineKind::Removed, r#"  "a": "old""#.to_string()),
                (DiffLineKind::Added, r#"  "a": "new""#.to_string()),
            ]
        );
        let context: Vec<&str> = comparison.body.hunks[0]
            .lines
            .iter()
            .map(|line| line.text.as_str())
            .collect();
        assert_eq!(context[1], r#"  "z": 1,"#);
    }

    #[test]
    fn formatting_keeps_escaped_quotes_and_structural_characters_inside_strings() {
        let formatted = pretty_json_preserving_order(r#"{"text":"a \"{,:}\" b","list":[]}"#);

        assert_eq!(
            formatted,
            "{\n  \"text\": \"a \\\"{,:}\\\" b\",\n  \"list\": []\n}"
        );
    }

    #[test]
    fn a_different_status_is_never_identical() {
        let comparison = compare_responses(&success(200, "ok"), &success(500, "ok"));

        assert!(!comparison.identical);
        assert_eq!(
            comparison.target,
            ComparedOutcome::Response { status_code: 500 }
        );
    }

    #[test]
    fn non_json_bodies_are_compared_as_text() {
        let comparison = compare_responses(
            &success(200, "<a>1</a>\n<b/>"),
            &success(200, "<a>2</a>\n<b/>"),
        );

        assert!(!comparison.identical);
        assert_eq!(
            changed_lines(&comparison.body),
            vec![
                (DiffLineKind::Removed, "<a>1</a>".to_string()),
                (DiffLineKind::Added, "<a>2</a>".to_string()),
            ]
        );
    }

    #[test]
    fn binary_bodies_only_report_whether_they_are_equal() {
        let equal = compare_responses(&binary("AAAA"), &binary("AAAA"));
        let different = compare_responses(&binary("AAAA"), &binary("BBBB"));

        assert!(equal.identical && equal.body.binary);
        assert!(!different.identical && different.body.binary);
        assert!(different.body.hunks.is_empty());
    }

    #[test]
    fn failures_compare_by_kind_and_never_equal_a_response() {
        let network = failed(HistoryFailureKind::Network);
        let timeout = failed(HistoryFailureKind::Timeout);

        assert!(compare_responses(&network, &network).identical);
        assert!(!compare_responses(&network, &timeout).identical);
        assert!(!compare_responses(&network, &success(200, "ok")).identical);
    }

    #[test]
    fn diff_stops_at_the_line_limit_and_marks_it_truncated() {
        let base: String = (0..MAX_DIFF_LINES + 10)
            .map(|line| format!("a{line}\n"))
            .collect();
        let target: String = (0..MAX_DIFF_LINES + 10)
            .map(|line| format!("b{line}\n"))
            .collect();

        let comparison = compare_responses(&success(200, &base), &success(200, &target));

        assert!(comparison.body.truncated);
        let total: usize = comparison
            .body
            .hunks
            .iter()
            .map(|hunk| hunk.lines.len())
            .sum();
        assert_eq!(total, MAX_DIFF_LINES);
    }

    #[test]
    fn too_large_bodies_skip_the_line_diff_but_still_compare() {
        let big = "x".repeat(MAX_RESPONSE_DIFF_BYTES + 1);
        let comparison = compare_responses(&success(200, &big), &success(200, &format!("{big}y")));

        assert!(comparison.body.too_large);
        assert!(!comparison.identical);
    }
}
