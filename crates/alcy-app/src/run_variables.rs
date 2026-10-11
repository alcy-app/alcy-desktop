use std::collections::HashSet;

use alcy_domain::{EnvironmentVariable, VariableAssignment, VariableOperation};
use thiserror::Error;

use crate::TemplateError;
use crate::node_reference::{NodeRunHistory, is_node_reference};
use crate::resolve_variables::{
    MASKED_VALUE, MAX_OUTPUT_VALUE_CHARS, resolve_for_display, resolve_variables_with_node_history,
    truncate_for_display,
};

#[derive(Debug, Clone, PartialEq, Error)]
pub(crate) enum RunVariableError {
    #[error(
        "nome de variável inválido '{0}' (não pode ser vazio, conter '{{'/'}}' nem começar com 'nodes.')"
    )]
    InvalidName(String),
    #[error(transparent)]
    Template(#[from] TemplateError),
    #[error("variável '{name}' não é um número ('{value}'), não dá para incrementar")]
    NotANumber { name: String, value: String },
}

/// `base` (ambiente já sobreposto por coleção/pastas) sobreposto pelas
/// variáveis locais do run — a local vence (spec 0083).
pub(crate) fn with_run_variables(
    base: &[EnvironmentVariable],
    run_variables: &[EnvironmentVariable],
) -> Vec<EnvironmentVariable> {
    let mut merged = base.to_vec();
    for variable in run_variables {
        upsert(&mut merged, variable.clone());
    }
    merged
}

/// Aplica as atribuições de um node `SetVariables`, na ordem (uma
/// atribuição vê as anteriores do mesmo node). Tudo ou nada: com qualquer
/// erro, nenhuma variável do node é gravada. Devolve as variáveis locais
/// resultantes e um resumo exibível ("a = 1, b = ••••••••").
pub(crate) fn apply_assignments(
    assignments: &[VariableAssignment],
    base: &[EnvironmentVariable],
    run_variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<(Vec<EnvironmentVariable>, String), RunVariableError> {
    let mut next = run_variables.to_vec();
    let mut summary = Vec::with_capacity(assignments.len());

    for assignment in assignments {
        let name = assignment.name.trim();
        if is_node_reference(name) {
            return Err(RunVariableError::InvalidName(assignment.name.clone()));
        }
        let visible = with_run_variables(base, &next);

        let (value, sensitive) = match &assignment.operation {
            VariableOperation::Set { value } => {
                let resolved =
                    resolve_variables_with_node_history(value, &visible, history, ancestors)?;
                let sensitive = resolve_for_display(value, &visible, history, ancestors)?
                    .substitutions
                    .iter()
                    .any(|substitution| substitution.sensitive);
                (resolved, sensitive)
            }
            VariableOperation::Increment { by } => {
                let current = visible.iter().find(|variable| variable.name() == name);
                let number = match current {
                    None => 0.0,
                    Some(variable) => variable.value().trim().parse::<f64>().map_err(|_| {
                        RunVariableError::NotANumber {
                            name: name.to_string(),
                            value: if variable.sensitive {
                                MASKED_VALUE.to_string()
                            } else {
                                truncate_for_display(
                                    variable.value().to_string(),
                                    MAX_OUTPUT_VALUE_CHARS,
                                )
                            },
                        }
                    })?,
                };
                let sensitive = current.is_some_and(|variable| variable.sensitive);
                ((number + by).to_string(), sensitive)
            }
        };

        let shown = if sensitive {
            MASKED_VALUE.to_string()
        } else {
            truncate_for_display(value.clone(), MAX_OUTPUT_VALUE_CHARS)
        };
        let variable = EnvironmentVariable::new(name, value, sensitive)
            .map_err(|_| RunVariableError::InvalidName(assignment.name.clone()))?;
        summary.push(format!("{name} = {shown}"));
        upsert(&mut next, variable);
    }

    Ok((next, summary.join(", ")))
}

fn upsert(variables: &mut Vec<EnvironmentVariable>, variable: EnvironmentVariable) {
    match variables
        .iter_mut()
        .find(|existing| existing.name() == variable.name())
    {
        Some(existing) => *existing = variable,
        None => variables.push(variable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variable(name: &str, value: &str, sensitive: bool) -> EnvironmentVariable {
        EnvironmentVariable::new(name, value, sensitive).unwrap()
    }

    fn set(name: &str, value: &str) -> VariableAssignment {
        VariableAssignment {
            name: name.to_string(),
            operation: VariableOperation::Set {
                value: value.to_string(),
            },
        }
    }

    fn increment(name: &str, by: f64) -> VariableAssignment {
        VariableAssignment {
            name: name.to_string(),
            operation: VariableOperation::Increment { by },
        }
    }

    fn apply(
        assignments: &[VariableAssignment],
        base: &[EnvironmentVariable],
        run: &[EnvironmentVariable],
    ) -> Result<(Vec<EnvironmentVariable>, String), RunVariableError> {
        apply_assignments(
            assignments,
            base,
            run,
            &NodeRunHistory::new(),
            &HashSet::new(),
        )
    }

    #[test]
    fn a_run_variable_overrides_a_base_variable_with_the_same_name() {
        let merged = with_run_variables(
            &[variable("page", "1", false), variable("host", "a", false)],
            &[variable("page", "2", false)],
        );

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].value(), "2");
    }

    #[test]
    fn set_resolves_the_template_and_later_assignments_see_earlier_ones() {
        let (run, summary) = apply(
            &[set("host", "{{base}}/v1"), set("url", "{{host}}/users")],
            &[variable("base", "https://api.test", false)],
            &[],
        )
        .unwrap();

        assert_eq!(run[1].value(), "https://api.test/v1/users");
        assert_eq!(
            summary,
            "host = https://api.test/v1, url = https://api.test/v1/users"
        );
    }

    #[test]
    fn a_value_built_from_a_sensitive_variable_is_sensitive_and_masked_in_the_summary() {
        let (run, summary) = apply(
            &[set("auth", "Bearer {{token}}")],
            &[variable("token", "s3cr3t", true)],
            &[],
        )
        .unwrap();

        assert!(run[0].sensitive);
        assert_eq!(run[0].value(), "Bearer s3cr3t");
        assert_eq!(summary, "auth = ••••••••");
    }

    #[test]
    fn increment_adds_to_the_current_value_or_starts_from_zero() {
        let (run, _) = apply(&[increment("i", 1.0)], &[], &[]).unwrap();
        assert_eq!(run[0].value(), "1");

        let (run, summary) = apply(&[increment("i", 2.0)], &[], &run).unwrap();
        assert_eq!(run[0].value(), "3");
        assert_eq!(summary, "i = 3");
    }

    #[test]
    fn increment_fails_on_a_non_numeric_value_without_applying_anything() {
        let error = apply(
            &[set("a", "1"), increment("name", 1.0)],
            &[variable("name", "abc", false)],
            &[],
        )
        .unwrap_err();

        assert_eq!(
            error,
            RunVariableError::NotANumber {
                name: "name".to_string(),
                value: "abc".to_string(),
            }
        );
    }

    #[test]
    fn rejects_empty_braced_and_reserved_names() {
        for name in ["", "  ", "a{b", "nodes.x"] {
            let error = apply(&[set(name, "1")], &[], &[]).unwrap_err();
            assert_eq!(error, RunVariableError::InvalidName(name.to_string()));
        }
    }
}
