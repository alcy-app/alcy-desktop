use alcy_domain::{MonitoredValue, ValueMonitor, ValuePathSegment};
use serde_json::Value;

/// Limite de valores avaliados de uma vez — o frontend corta antes de
/// enviar e avisa o usuário; o backend repete o corte por segurança.
pub const MAX_MONITOR_CANDIDATES: usize = 10_000;

/// Um valor primitivo da resposta candidato a monitoramento: o caminho até
/// ele e o literal JSON como aparece no corpo (`"Ana"`, `12.50`, `null`).
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorCandidate {
    pub path: Vec<ValuePathSegment>,
    pub literal: String,
}

/// Resultado de um monitor sobre um candidato. `failed_rule_ids` vazio
/// significa que o valor foi aprovado por todas as regras.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueFinding {
    pub value_index: usize,
    pub monitor_id: String,
    pub field: String,
    pub failed_rule_ids: Vec<String>,
}

/// Aplica os monitores habilitados a cada candidato cujo caminho casa com
/// algum campo do monitor. Um candidato pode gerar um resultado por
/// monitor; literais que não são JSON primitivo válido são ignorados.
pub fn evaluate_value_monitors(
    monitors: &[ValueMonitor],
    candidates: &[MonitorCandidate],
) -> Vec<ValueFinding> {
    let enabled: Vec<&ValueMonitor> = monitors.iter().filter(|monitor| monitor.enabled).collect();
    if enabled.is_empty() {
        return Vec::new();
    }

    let mut findings = Vec::new();
    for (value_index, candidate) in candidates.iter().take(MAX_MONITOR_CANDIDATES).enumerate() {
        let mut value = None;
        for monitor in &enabled {
            let Some(field) = monitor.matching_field(&candidate.path) else {
                continue;
            };
            let parsed = value.get_or_insert_with(|| monitored_value(&candidate.literal));
            let Some(parsed) = parsed else {
                break;
            };
            findings.push(ValueFinding {
                value_index,
                monitor_id: monitor.id.clone(),
                field: field.as_str().to_string(),
                failed_rule_ids: monitor
                    .failed_rules(parsed)
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            });
        }
    }
    findings
}

fn monitored_value(literal: &str) -> Option<MonitoredValue> {
    match serde_json::from_str::<Value>(literal).ok()? {
        Value::String(text) => Some(MonitoredValue::Text(text)),
        Value::Number(_) => Some(MonitoredValue::Number(literal.trim().to_string())),
        Value::Bool(value) => Some(MonitoredValue::Boolean(value)),
        Value::Null => Some(MonitoredValue::Null),
        Value::Array(_) | Value::Object(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use alcy_domain::{FieldPath, RuleKind, ValueRule};

    use super::*;

    fn monitor(id: &str, field: &str, enabled: bool) -> ValueMonitor {
        ValueMonitor::new(
            id,
            id,
            enabled,
            vec![FieldPath::new(field).unwrap()],
            vec![
                ValueRule::new(
                    "tamanho",
                    RuleKind::LengthRange {
                        min: None,
                        max: Some(5),
                    },
                )
                .unwrap(),
                ValueRule::new("letras", RuleKind::LettersOnly).unwrap(),
            ],
        )
        .unwrap()
    }

    fn candidate(keys: &[&str], literal: &str) -> MonitorCandidate {
        MonitorCandidate {
            path: keys
                .iter()
                .map(|key| match key.parse::<usize>() {
                    Ok(index) => ValuePathSegment::Index(index),
                    Err(_) => ValuePathSegment::Key(key.to_string()),
                })
                .collect(),
            literal: literal.to_string(),
        }
    }

    #[test]
    fn reports_pass_and_fail_for_matching_values_only() {
        let findings = evaluate_value_monitors(
            &[monitor("nomes", "nome", true)],
            &[
                candidate(&["usuarios", "0", "nome"], r#""Ana""#),
                candidate(&["usuarios", "1", "nome"], r#""Ana Maria""#),
                candidate(&["usuarios", "1", "idade"], "30"),
            ],
        );

        assert_eq!(
            findings,
            vec![
                ValueFinding {
                    value_index: 0,
                    monitor_id: "nomes".into(),
                    field: "nome".into(),
                    failed_rule_ids: vec![],
                },
                ValueFinding {
                    value_index: 1,
                    monitor_id: "nomes".into(),
                    field: "nome".into(),
                    failed_rule_ids: vec!["tamanho".into(), "letras".into()],
                },
            ]
        );
    }

    #[test]
    fn ignores_disabled_monitors_and_invalid_literals() {
        let findings = evaluate_value_monitors(
            &[monitor("off", "nome", false), monitor("on", "nome", true)],
            &[
                candidate(&["nome"], "não é json"),
                candidate(&["nome"], "12"),
            ],
        );

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].value_index, 1);
        assert_eq!(findings[0].monitor_id, "on");
        assert_eq!(findings[0].failed_rule_ids, vec!["letras".to_string()]);
    }
}
