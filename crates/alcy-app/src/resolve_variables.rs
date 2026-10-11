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

/// Substitui cada ocorrência de `{{nome}}` em `template`, resolvendo cada
/// nome com `resolve_name`.
///
/// `{{` sem um `}}` correspondente é mantido literal (não é um erro) — só
/// um nome referenciado e não resolvido produz um erro.
fn resolve_placeholders(
    template: &str,
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
                result.push_str(&resolve_name(name)?);
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

/// Substitui cada ocorrência de `{{nome}}` em `template` pelo valor da
/// variável correspondente em `variables`.
///
/// `{{` sem um `}}` correspondente é mantido literal (não é um erro) —
/// só uma variável referenciada e ausente do ambiente produz
/// `TemplateError::MissingVariable`.
pub fn resolve_variables(
    template: &str,
    variables: &[EnvironmentVariable],
) -> Result<String, TemplateError> {
    resolve_placeholders(template, |name| {
        lookup_environment_variable(name, variables)
    })
}

/// Como `resolve_variables`, mas nomes com o prefixo reservado `nodes.`
/// resolvem contra `history` (respostas de nodes de requisição já
/// concluídos num run de flow) em vez do ambiente ativo — só aceito quando
/// o node referenciado está em `ancestors` (dependência real via edge).
pub(crate) fn resolve_variables_with_node_history(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<String, TemplateError> {
    resolve_placeholders(template, |name| {
        if is_node_reference(name) {
            Ok(resolve_node_reference(name, history, ancestors)?)
        } else {
            lookup_environment_variable(name, variables)
        }
    })
}

/// Valor exibido no lugar de uma variável sensível.
pub(crate) const MASKED_VALUE: &str = "••••••••";
/// Limite do valor exibido de uma referência a node (o corpo de uma resposta
/// pode ser grande; o detalhe é só para inspeção).
const MAX_DISPLAY_VALUE_CHARS: usize = 200;
/// Limite de cada valor substituído na saída de um node `Log`/`Display` —
/// maior que o do detalhe da URL chamada porque aqui o valor é o conteúdo
/// principal, mas ainda limitado para não trafegar/gravar um corpo inteiro.
pub(crate) const MAX_OUTPUT_VALUE_CHARS: usize = 4000;

/// Uma variável `{{nome}}` substituída em um template, com o valor usado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Substitution {
    pub name: String,
    /// Mascarado quando a variável é sensível; truncado se muito longo.
    pub value: String,
    pub sensitive: bool,
}

/// Template resolvido para exibição (histórico de um run): `text` é o
/// template com cada placeholder trocado pelo valor exibível (sensíveis
/// mascarados) e `substitutions` lista o que foi usado, na ordem de aparição.
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

/// Template resolvido para exibição (ex.: a URL chamada num run de
/// coleção): variáveis sensíveis mascaradas, valores longos truncados. Com
/// um placeholder que não resolve, devolve o template como está.
pub fn resolve_template_for_display(template: &str, variables: &[EnvironmentVariable]) -> String {
    resolve_for_display(template, variables, &NodeRunHistory::new(), &HashSet::new())
        .map(|resolved| resolved.text)
        .unwrap_or_else(|_| template.to_string())
}

/// Como `resolve_variables_with_node_history`, mas para exibição: nunca
/// devolve um segredo e reporta cada substituição feita.
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

/// Como `resolve_for_display`, com o limite de caracteres de cada valor
/// substituído dado por quem chama.
pub(crate) fn resolve_for_display_with_limit(
    template: &str,
    variables: &[EnvironmentVariable],
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
    max_value_chars: usize,
) -> Result<ResolvedForDisplay, TemplateError> {
    let substitutions = RefCell::new(Vec::new());
    let text = resolve_placeholders(template, |name| {
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
    fn fails_when_a_referenced_variable_is_missing() {
        let error = resolve_variables("{{missing}}", &variables()).unwrap_err();

        assert_eq!(error, TemplateError::MissingVariable("missing".to_string()));
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
