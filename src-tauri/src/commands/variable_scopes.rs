//! Camadas de variáveis de coleção/pasta enviadas pelo frontend na execução
//! interativa (ADR 0031): o frontend monta a partir da árvore em memória e o
//! backend aplica a precedência de `alcy_domain::merge_variables`.

use alcy_domain::{EnvironmentVariableError, VariableScope, VariableScopeKind, merge_variables};
use serde::{Deserialize, Serialize};

use crate::commands::collections::{ScopedVariableDto, variables_from_dto};
use crate::commands::environments::EnvironmentVariableDto;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VariableScopeKindDto {
    Collection,
    Folder,
}

/// Uma camada (coleção ou pasta ancestral da requisição), da raiz ao pai
/// direto.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariableScopeDto {
    pub node_id: String,
    pub kind: VariableScopeKindDto,
    pub variables: Vec<ScopedVariableDto>,
}

pub(crate) fn scopes_from_dto(
    scopes: Vec<VariableScopeDto>,
) -> Result<Vec<VariableScope>, EnvironmentVariableError> {
    scopes
        .into_iter()
        .map(|scope| {
            Ok(VariableScope {
                node_id: scope.node_id,
                kind: match scope.kind {
                    VariableScopeKindDto::Collection => VariableScopeKind::Collection,
                    VariableScopeKindDto::Folder => VariableScopeKind::Folder,
                },
                variables: variables_from_dto(scope.variables)?,
            })
        })
        .collect()
}

/// Ambiente sobreposto pelas camadas locais — o mais próximo vence. As
/// locais nunca são sensíveis, então uma variável sensível do ambiente
/// sobrescrita por uma local deixa de ser redigida no histórico.
pub(crate) fn with_scoped_variables(
    environment: &[EnvironmentVariableDto],
    scopes: &[VariableScope],
) -> Vec<EnvironmentVariableDto> {
    let mut merged = environment.to_vec();
    for variable in merge_variables(&[], scopes) {
        let local = EnvironmentVariableDto {
            name: variable.name().to_string(),
            value: variable.value().to_string(),
            sensitive: false,
        };
        match merged
            .iter_mut()
            .find(|existing| existing.name == local.name)
        {
            Some(existing) => *existing = local,
            None => merged.push(local),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(
        node_id: &str,
        kind: VariableScopeKindDto,
        pairs: &[(&str, &str)],
    ) -> VariableScopeDto {
        VariableScopeDto {
            node_id: node_id.to_string(),
            kind,
            variables: pairs
                .iter()
                .map(|(name, value)| ScopedVariableDto {
                    name: name.to_string(),
                    value: value.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn the_closest_scope_overrides_the_environment() {
        let scopes = scopes_from_dto(vec![
            scope(
                "c",
                VariableScopeKindDto::Collection,
                &[("baseUrl", "collection"), ("a", "1")],
            ),
            scope("f", VariableScopeKindDto::Folder, &[("baseUrl", "folder")]),
        ])
        .unwrap();
        let environment = vec![EnvironmentVariableDto {
            name: "baseUrl".to_string(),
            value: "env".to_string(),
            sensitive: true,
        }];

        let merged = with_scoped_variables(&environment, &scopes);

        assert_eq!(
            merged,
            vec![
                EnvironmentVariableDto {
                    name: "baseUrl".to_string(),
                    value: "folder".to_string(),
                    sensitive: false,
                },
                EnvironmentVariableDto {
                    name: "a".to_string(),
                    value: "1".to_string(),
                    sensitive: false,
                },
            ]
        );
    }

    #[test]
    fn rejects_an_invalid_variable_name() {
        assert!(
            scopes_from_dto(vec![scope(
                "c",
                VariableScopeKindDto::Collection,
                &[("{{x}}", "1")]
            )])
            .is_err()
        );
    }
}
