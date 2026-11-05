use std::collections::HashSet;

use alcy_domain::EnvironmentVariable;
use thiserror::Error;

use crate::TemplateError;
use crate::node_reference::NodeRunHistory;
use crate::resolve_variables::{resolve_for_display, resolve_variables_with_node_history};

/// Why a numeric block setting (a number or a `{{...}}` template) could not be read.
/// The value shown is the display text, so sensitive variables stay masked.
#[derive(Debug, Clone, PartialEq, Error)]
pub(crate) enum NumberSettingError {
    #[error(transparent)]
    Template(#[from] TemplateError),
    #[error("'{0}' não é um número inteiro maior ou igual a zero")]
    NotAnInteger(String),
    #[error("'{0}' não é um número")]
    NotANumber(String),
}

/// Resolve a whole-number setting such as a While limit or a Sleep duration.
/// Integral decimals ("20.0", what Increment can produce) are accepted.
pub(crate) fn resolve_integer_setting(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<u64, NumberSettingError> {
    let resolved = resolve_variables_with_node_history(template, variables, history, ancestors)?;
    let text = resolved.trim();
    if let Ok(number) = text.parse::<u64>() {
        return Ok(number);
    }
    match text.parse::<f64>() {
        Ok(number)
            if number.is_finite()
                && number >= 0.0
                && number.fract() == 0.0
                && number <= u64::MAX as f64 =>
        {
            Ok(number as u64)
        }
        _ => Err(NumberSettingError::NotAnInteger(shown(
            template, variables, history, ancestors,
        ))),
    }
}

/// Resolve a decimal setting such as an Increment amount.
pub(crate) fn resolve_decimal_setting(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<f64, NumberSettingError> {
    let resolved = resolve_variables_with_node_history(template, variables, history, ancestors)?;
    match resolved.trim().parse::<f64>() {
        Ok(number) if number.is_finite() => Ok(number),
        _ => Err(NumberSettingError::NotANumber(shown(
            template, variables, history, ancestors,
        ))),
    }
}

/// The resolved text as the run log may show it, with sensitive values masked.
fn shown(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> String {
    resolve_for_display(template, variables, history, ancestors)
        .map(|display| display.text)
        .unwrap_or_else(|_| template.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variable(name: &str, value: &str, sensitive: bool) -> EnvironmentVariable {
        EnvironmentVariable::new(name, value, sensitive).unwrap()
    }

    fn integer(
        template: &str,
        variables: &[EnvironmentVariable],
    ) -> Result<u64, NumberSettingError> {
        resolve_integer_setting(template, variables, &NodeRunHistory::new(), &HashSet::new())
    }

    #[test]
    fn reads_a_plain_number() {
        assert_eq!(integer("20", &[]), Ok(20));
        assert_eq!(integer(" 20 ", &[]), Ok(20));
    }

    #[test]
    fn reads_a_number_from_a_variable() {
        let variables = [variable("loop-count", "20", false)];
        assert_eq!(integer("{{loop-count}}", &variables), Ok(20));
    }

    #[test]
    fn accepts_integral_decimals_from_increment() {
        let variables = [variable("count", "3.0", false)];
        assert_eq!(integer("{{count}}", &variables), Ok(3));
    }

    #[test]
    fn rejects_negative_fractional_or_text_values() {
        assert_eq!(
            integer("-1", &[]),
            Err(NumberSettingError::NotAnInteger("-1".to_string()))
        );
        assert_eq!(
            integer("1.5", &[]),
            Err(NumberSettingError::NotAnInteger("1.5".to_string()))
        );
        assert_eq!(
            integer("abc", &[]),
            Err(NumberSettingError::NotAnInteger("abc".to_string()))
        );
    }

    #[test]
    fn masks_a_sensitive_value_in_the_error() {
        let variables = [variable("secret", "hunter2", true)];
        let error = integer("{{secret}}", &variables).unwrap_err();
        assert!(!error.to_string().contains("hunter2"), "{error}");
    }

    #[test]
    fn reports_a_missing_variable() {
        assert!(matches!(
            integer("{{missing}}", &[]),
            Err(NumberSettingError::Template(_))
        ));
    }

    #[test]
    fn reads_decimals() {
        let variables = [variable("step", "2.5", false)];
        let decimal = |template: &str| {
            resolve_decimal_setting(
                template,
                &variables,
                &NodeRunHistory::new(),
                &HashSet::new(),
            )
        };
        assert_eq!(decimal("{{step}}"), Ok(2.5));
        assert_eq!(decimal("-1"), Ok(-1.0));
        assert_eq!(
            decimal("x"),
            Err(NumberSettingError::NotANumber("x".to_string()))
        );
    }
}
