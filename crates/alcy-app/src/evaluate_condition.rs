use std::collections::HashSet;

use alcy_domain::{ComparisonOperator, Condition, EnvironmentVariable};
use thiserror::Error;

use crate::TemplateError;
use crate::node_reference::NodeRunHistory;
use crate::resolve_variables::resolve_variables_with_node_history;

#[derive(Debug, Clone, PartialEq, Error)]
pub(crate) enum ConditionError {
    #[error(transparent)]
    Template(#[from] TemplateError),
    #[error(
        "comparação '{operator:?}' exige que os dois lados sejam números, recebeu '{left}' e '{right}'"
    )]
    NotComparableAsNumbers {
        left: String,
        right: String,
        operator: ComparisonOperator,
    },
}

/// Avalia a `Condition` de um node `If`: resolve `left`/`right` (podem
/// conter `{{...}}`, mesma resolução já usada para requisições) e compara.
/// `Equals`/`NotEquals` comparam numericamente quando os dois lados
/// resolvidos parseiam como número (`f64`), e como texto caso contrário;
/// `GreaterThan`/`LessThan` só fazem sentido numericamente — exigem que os
/// dois lados parseiem como número, senão falham com um erro estruturado
/// (não decidem um resultado arbitrário).
pub(crate) fn evaluate_condition(
    condition: &Condition,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<bool, ConditionError> {
    let left = resolve_variables_with_node_history(&condition.left, variables, history, ancestors)?;
    let right =
        resolve_variables_with_node_history(&condition.right, variables, history, ancestors)?;

    let both_numeric = left
        .trim()
        .parse::<f64>()
        .ok()
        .zip(right.trim().parse::<f64>().ok());

    match condition.operator {
        ComparisonOperator::Equals => Ok(match both_numeric {
            Some((left_number, right_number)) => left_number == right_number,
            None => left == right,
        }),
        ComparisonOperator::NotEquals => Ok(match both_numeric {
            Some((left_number, right_number)) => left_number != right_number,
            None => left != right,
        }),
        ComparisonOperator::GreaterThan => both_numeric
            .map(|(left_number, right_number)| left_number > right_number)
            .ok_or(ConditionError::NotComparableAsNumbers {
                left,
                right,
                operator: condition.operator,
            }),
        ComparisonOperator::LessThan => both_numeric
            .map(|(left_number, right_number)| left_number < right_number)
            .ok_or(ConditionError::NotComparableAsNumbers {
                left,
                right,
                operator: condition.operator,
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_variables() -> Vec<EnvironmentVariable> {
        vec![]
    }

    fn no_ancestors() -> HashSet<String> {
        HashSet::new()
    }

    fn condition(left: &str, operator: ComparisonOperator, right: &str) -> Condition {
        Condition {
            left: left.to_string(),
            operator,
            right: right.to_string(),
        }
    }

    #[test]
    fn compares_numbers_numerically_for_equals() {
        let result = evaluate_condition(
            &condition("200", ComparisonOperator::Equals, "200.0"),
            &no_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert!(result, "200 e 200.0 deveriam ser iguais numericamente");
    }

    #[test]
    fn compares_text_for_equals_when_not_both_numeric() {
        let result = evaluate_condition(
            &condition("abc", ComparisonOperator::Equals, "abc"),
            &no_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert!(result);
    }

    #[test]
    fn not_equals_is_the_inverse_of_equals() {
        let result = evaluate_condition(
            &condition("abc", ComparisonOperator::NotEquals, "def"),
            &no_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert!(result);
    }

    #[test]
    fn greater_than_compares_numbers() {
        let result = evaluate_condition(
            &condition("5", ComparisonOperator::GreaterThan, "3"),
            &no_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert!(result);
    }

    #[test]
    fn less_than_compares_numbers() {
        let result = evaluate_condition(
            &condition("3", ComparisonOperator::LessThan, "5"),
            &no_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert!(result);
    }

    #[test]
    fn greater_than_fails_structured_when_sides_are_not_numeric() {
        let error = evaluate_condition(
            &condition("abc", ComparisonOperator::GreaterThan, "def"),
            &no_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap_err();

        assert_eq!(
            error,
            ConditionError::NotComparableAsNumbers {
                left: "abc".to_string(),
                right: "def".to_string(),
                operator: ComparisonOperator::GreaterThan,
            }
        );
    }

    #[test]
    fn resolves_node_references_and_environment_variables_on_both_sides() {
        use alcy_domain::{Response, ResponseMetadata};

        let mut history = NodeRunHistory::new();
        history.record(
            "req-a".to_string(),
            Response::new(200, 1, "{}", vec![], ResponseMetadata::default()),
        );
        let ancestors = HashSet::from(["req-a".to_string()]);
        let variables = vec![EnvironmentVariable::new("expected", "200", false).unwrap()];

        let result = evaluate_condition(
            &condition(
                "{{nodes.req-a.response.status}}",
                ComparisonOperator::Equals,
                "{{expected}}",
            ),
            &variables,
            &history,
            &ancestors,
        )
        .unwrap();

        assert!(result);
    }

    #[test]
    fn fails_when_a_referenced_variable_is_missing() {
        let error = evaluate_condition(
            &condition("{{missing}}", ComparisonOperator::Equals, "1"),
            &no_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap_err();

        assert_eq!(
            error,
            ConditionError::Template(TemplateError::MissingVariable("missing".to_string()))
        );
    }
}
