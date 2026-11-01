use std::cell::RefCell;
use std::collections::HashSet;

use alcy_domain::EnvironmentVariable;
use thiserror::Error;

use crate::node_reference::{
    NodeReferenceError, NodeRunHistory, is_node_reference, resolve_node_reference,
};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TemplateError {
    #[error("variável '{0}' não definida no ambiente ativo")]
    MissingVariable(String),
    #[error(transparent)]
    NodeReference(#[from] NodeReferenceError),
}

#[derive(Clone, Copy)]
enum MissingVariables {
    Preserve,
    Reject,
}

/// Resolve each `{{name}}`, preserving unmatched opening braces literally.
fn resolve_placeholders(
    template: &str,
    missing_variables: MissingVariables,
    resolve_name: impl Fn(&str) -> Result<String, TemplateError>,
) -> Result<String, TemplateError> {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];

        match after_open.find("}}") {
            Some(end) => {
                let name = after_open[..end].trim();
                match resolve_name(name) {
                    Err(TemplateError::MissingVariable(_))
                        if matches!(missing_variables, MissingVariables::Preserve) =>
                    {
                        result.push_str(&rest[start..start + end + 4]);
                    }
                    resolved => result.push_str(&resolved?),
                }
                rest = &after_open[end + 2..];
            }
            None => {
                result.push_str(&rest[start..]);
                rest = "";
            }
        }
    }

    result.push_str(rest);
    Ok(result)
}

/// Names written as `{{name}}` in a template, trimmed, in order. Unclosed
/// braces are text, as in [`resolve_placeholders`].
pub(crate) fn placeholder_names(template: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            break;
        };
        names.push(after_open[..end].trim());
        rest = &after_open[end + 2..];
    }
    names
}

fn lookup_environment_variable(
    name: &str,
    variables: &[EnvironmentVariable],
) -> Result<String, TemplateError> {
    variables
        .iter()
        .find(|variable| variable.name() == name)
        .map(|variable| variable.value().to_string())
        .ok_or_else(|| TemplateError::MissingVariable(name.to_string()))
}

/// Substitute defined environment variables and preserve unknown placeholders
/// exactly as typed so a missing environment value does not prevent sending.
pub fn resolve_variables(
    template: &str,
    variables: &[EnvironmentVariable],
) -> Result<String, TemplateError> {
    resolve_placeholders(template, MissingVariables::Preserve, |name| {
        lookup_environment_variable(name, variables)
    })
}

/// Resolve flow control values strictly, including references to ancestor nodes.
pub(crate) fn resolve_variables_with_node_history(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<String, TemplateError> {
    resolve_placeholders(template, MissingVariables::Reject, |name| {
        if is_node_reference(name) {
            Ok(resolve_node_reference(name, history, ancestors)?)
        } else {
            lookup_environment_variable(name, variables)
        }
    })
}

/// Resolve request values while preserving unknown environment placeholders.
/// Node references still require valid syntax and available ancestor outputs.
pub(crate) fn resolve_request_template(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<String, TemplateError> {
    resolve_placeholders(template, MissingVariables::Preserve, |name| {
        if is_node_reference(name) {
            Ok(resolve_node_reference(name, history, ancestors)?)
        } else {
            lookup_environment_variable(name, variables)
        }
    })
}

/// Display value for sensitive variables.
pub(crate) const MASKED_VALUE: &str = "••••••••";
/// Node reference display limit: response bodies can be large.
const MAX_DISPLAY_VALUE_CHARS: usize = 200;
/// Log/Display values allow more detail but still avoid transporting or storing
/// an entire response body.
pub(crate) const MAX_OUTPUT_VALUE_CHARS: usize = 4000;

/// A substituted `{{name}}` and its display value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Substitution {
    pub name: String,
    /// Masked when sensitive; truncated when too long.
    pub value: String,
    pub sensitive: bool,
}

/// Resolved run history text with masked values and substitutions in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedForDisplay {
    pub text: String,
    pub substitutions: Vec<Substitution>,
}

pub(crate) fn truncate_for_display(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut truncated: String = value.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}

/// Resolve request display text, masking sensitive values and preserving unknown
/// environment placeholders. Invalid node references retain the original text.
pub fn resolve_template_for_display(template: &str, variables: &[EnvironmentVariable]) -> String {
    resolve_request_for_display(template, variables, &NodeRunHistory::new(), &HashSet::new())
        .map(|resolved| resolved.text)
        .unwrap_or_else(|_| template.to_string())
}

/// Request history keeps unresolved environment placeholders without losing
/// substitutions or sensitive value masking for the variables that do resolve.
pub(crate) fn resolve_request_for_display(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<ResolvedForDisplay, TemplateError> {
    resolve_for_display_with_policy(
        template,
        variables,
        history,
        ancestors,
        MAX_DISPLAY_VALUE_CHARS,
        MissingVariables::Preserve,
    )
}

/// Resolve flow display text without exposing secrets and report substitutions.
pub(crate) fn resolve_for_display(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<ResolvedForDisplay, TemplateError> {
    resolve_for_display_with_limit(
        template,
        variables,
        history,
        ancestors,
        MAX_DISPLAY_VALUE_CHARS,
    )
}

/// Resolve display text with a caller-selected character limit per substitution.
pub(crate) fn resolve_for_display_with_limit(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
    max_value_chars: usize,
) -> Result<ResolvedForDisplay, TemplateError> {
    resolve_for_display_with_policy(
        template,
        variables,
        history,
        ancestors,
        max_value_chars,
        MissingVariables::Reject,
    )
}

fn resolve_for_display_with_policy(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
    max_value_chars: usize,
    missing_variables: MissingVariables,
) -> Result<ResolvedForDisplay, TemplateError> {
    let substitutions = RefCell::new(Vec::new());
    let text = resolve_placeholders(template, missing_variables, |name| {
        let (value, sensitive) = if is_node_reference(name) {
            (resolve_node_reference(name, history, ancestors)?, false)
        } else {
            let variable = variables
                .iter()
                .find(|variable| variable.name() == name)
                .ok_or_else(|| TemplateError::MissingVariable(name.to_string()))?;
            (variable.value().to_string(), variable.sensitive)
        };
        let value = if sensitive {
            MASKED_VALUE.to_string()
        } else {
            truncate_for_display(value, max_value_chars)
        };
        substitutions.borrow_mut().push(Substitution {
            name: name.to_string(),
            value: value.clone(),
            sensitive,
        });
        Ok(value)
    })?;
    Ok(ResolvedForDisplay {
        text,
        substitutions: substitutions.into_inner(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variables() -> Vec<EnvironmentVariable> {
        vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("token", "secret", true).unwrap(),
        ]
    }

    #[test]
    fn replaces_a_single_variable() {
        let result = resolve_variables("{{baseUrl}}/graphql", &variables()).unwrap();

        assert_eq!(result, "https://api.example.com/graphql");
    }

    #[test]
    fn replaces_multiple_variables() {
        let result = resolve_variables("Bearer {{token}} for {{baseUrl}}", &variables()).unwrap();

        assert_eq!(result, "Bearer secret for https://api.example.com");
    }

    #[test]
    fn trims_whitespace_inside_the_placeholder() {
        let result = resolve_variables("{{ baseUrl }}/graphql", &variables()).unwrap();

        assert_eq!(result, "https://api.example.com/graphql");
    }

    #[test]
    fn leaves_text_without_placeholders_untouched() {
        let result = resolve_variables("https://static.example.com/graphql", &variables()).unwrap();

        assert_eq!(result, "https://static.example.com/graphql");
    }

    #[test]
    fn keeps_an_unclosed_placeholder_literal() {
        let result = resolve_variables("prefix {{unclosed", &variables()).unwrap();

        assert_eq!(result, "prefix {{unclosed");
    }

    #[test]
    fn preserves_missing_placeholders_without_skipping_defined_variables() {
        let result = resolve_variables(
            "{{baseUrl}}/{{ missing }}/{{token}}/{{missing}}",
            &variables(),
        )
        .unwrap();

        assert_eq!(
            result,
            "https://api.example.com/{{ missing }}/secret/{{missing}}"
        );
    }

    #[test]
    fn flow_control_resolution_still_requires_defined_variables() {
        let error = resolve_variables_with_node_history(
            "{{missing}}",
            &variables(),
            &NodeRunHistory::new(),
            &HashSet::new(),
        )
        .unwrap_err();

        assert_eq!(error, TemplateError::MissingVariable("missing".to_string()));
    }

    #[test]
    fn request_display_preserves_missing_placeholders_and_masks_defined_secrets() {
        let template = "{{baseUrl}}/{{ missing }}?token={{token}}";
        let result = resolve_request_for_display(
            template,
            &variables(),
            &NodeRunHistory::new(),
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(
            result.text,
            "https://api.example.com/{{ missing }}?token=••••••••"
        );
        assert_eq!(result.substitutions.len(), 2);
        assert_eq!(result.substitutions[0].name, "baseUrl");
        assert_eq!(result.substitutions[1].value, MASKED_VALUE);
        assert!(result.substitutions[1].sensitive);
        assert_eq!(
            resolve_template_for_display(template, &variables()),
            result.text
        );
        assert!(
            resolve_for_display(
                template,
                &variables(),
                &NodeRunHistory::new(),
                &HashSet::new(),
            )
            .is_err()
        );
    }

    #[test]
    fn display_resolution_reports_substitutions_and_masks_sensitive_values() {
        let history = NodeRunHistory::new();
        let result = resolve_for_display(
            "{{baseUrl}}/x?t={{token}}",
            &variables(),
            &history,
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(result.text, "https://api.example.com/x?t=••••••••");
        assert_eq!(
            result.substitutions,
            vec![
                Substitution {
                    name: "baseUrl".to_string(),
                    value: "https://api.example.com".to_string(),
                    sensitive: false,
                },
                Substitution {
                    name: "token".to_string(),
                    value: "••••••••".to_string(),
                    sensitive: true,
                },
            ]
        );
    }
}
