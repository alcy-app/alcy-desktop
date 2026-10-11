//! Variáveis de escopo local (coleções e pastas) e a regra de precedência
//! sobre o ambiente ativo — ADR 0031.

use crate::collection::{Collection, Folder, SavedRequest};
use crate::environment::EnvironmentVariable;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariableScopeKind {
    Collection,
    Folder,
}

/// Uma camada de variáveis locais: as de uma coleção ou pasta ancestral de
/// uma requisição.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableScope {
    /// Id da coleção/pasta dona das variáveis.
    pub node_id: String,
    pub kind: VariableScopeKind,
    pub variables: Vec<EnvironmentVariable>,
}

impl VariableScope {
    /// Grava `value` em `name` (criando a variável se preciso), como
    /// `al.collection.set`/`al.folder.set`. Nomes inválidos são ignorados.
    pub fn set(&mut self, name: &str, value: &str) {
        let Ok(variable) = EnvironmentVariable::new(name, value, false) else {
            return;
        };
        upsert(&mut self.variables, variable);
    }
}

/// Valor gravado por script numa variável de coleção/pasta
/// (`al.collection.set`/`al.folder.set`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedVariableChange {
    pub node_id: String,
    pub name: String,
    pub value: Option<String>,
}

/// Aplica `changes` às camadas cujo `node_id` corresponde, na ordem dada.
pub fn apply_scoped_changes(scopes: &mut [VariableScope], changes: &[ScopedVariableChange]) {
    for change in changes {
        if let Some(scope) = scopes
            .iter_mut()
            .find(|scope| scope.node_id == change.node_id)
        {
            if let Some(value) = &change.value {
                scope.set(&change.name, value);
            } else {
                scope
                    .variables
                    .retain(|variable| variable.name() != change.name);
            }
        }
    }
}

/// Upsert de `change` em `changes` por (`node_id`, `name`): guarda só o
/// valor final de cada variável.
pub fn record_scoped_change(changes: &mut Vec<ScopedVariableChange>, change: ScopedVariableChange) {
    match changes
        .iter_mut()
        .find(|existing| existing.node_id == change.node_id && existing.name == change.name)
    {
        Some(existing) => existing.value = change.value,
        None => changes.push(change),
    }
}

/// Camadas de variáveis locais de uma requisição salva, da coleção raiz até
/// a pasta pai direta. Id desconhecido resulta em nenhuma camada.
pub fn variable_scopes(collections: &[Collection], request_id: &str) -> Vec<VariableScope> {
    collections
        .iter()
        .find_map(|collection| {
            let mut chain = vec![VariableScope {
                node_id: collection.id.clone(),
                kind: VariableScopeKind::Collection,
                variables: collection.variables().to_vec(),
            }];
            collect_in(
                collection.requests(),
                collection.folders(),
                request_id,
                &mut chain,
            )
            .then_some(chain)
        })
        .unwrap_or_default()
}

/// `chain` termina com as camadas da raiz até a pasta que contém `id`.
fn collect_in(
    requests: &[SavedRequest],
    folders: &[Folder],
    id: &str,
    chain: &mut Vec<VariableScope>,
) -> bool {
    if requests.iter().any(|request| request.id == id) {
        return true;
    }
    for folder in folders {
        chain.push(VariableScope {
            node_id: folder.id.clone(),
            kind: VariableScopeKind::Folder,
            variables: folder.variables().to_vec(),
        });
        if collect_in(folder.requests(), folder.folders(), id, chain) {
            return true;
        }
        chain.pop();
    }
    false
}

/// Variáveis vigentes de uma requisição: o ambiente sobreposto por cada
/// camada, na ordem dada (raiz → pai direto). O mais próximo vence.
pub fn merge_variables(
    environment: &[EnvironmentVariable],
    scopes: &[VariableScope],
) -> Vec<EnvironmentVariable> {
    let mut merged = environment.to_vec();
    for scope in scopes {
        for variable in &scope.variables {
            upsert(&mut merged, variable.clone());
        }
    }
    merged
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
    use crate::{Authentication, Endpoint, ProtocolId, Request, RequestDocument};

    fn var(name: &str, value: &str) -> EnvironmentVariable {
        EnvironmentVariable::new(name, value, false).unwrap()
    }

    fn saved(id: &str) -> SavedRequest {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        );
        SavedRequest::new(id, id, request).unwrap()
    }

    fn value_of(variables: &[EnvironmentVariable], name: &str) -> Option<String> {
        variables
            .iter()
            .find(|variable| variable.name() == name)
            .map(|variable| variable.value().to_string())
    }

    /// Coleção `c` (baseUrl=collection, only=collection) > pasta `f1`
    /// (baseUrl=folder) > subpasta `f2` (token=inner) > requisição `deep`;
    /// `root` fica direto na coleção.
    fn sample() -> Vec<Collection> {
        let inner = Folder::new("f2", "Inner", vec![], vec![saved("deep")])
            .unwrap()
            .with_variables(vec![var("token", "inner")])
            .unwrap();
        let outer = Folder::new("f1", "Outer", vec![inner], vec![saved("middle")])
            .unwrap()
            .with_variables(vec![var("baseUrl", "folder")])
            .unwrap();
        let collection = Collection::new("c", "API", vec![outer], vec![saved("root")])
            .unwrap()
            .with_variables(vec![
                var("baseUrl", "collection"),
                var("only", "collection"),
            ])
            .unwrap();
        vec![collection]
    }

    #[test]
    fn scopes_go_from_the_collection_to_the_direct_parent() {
        let scopes = variable_scopes(&sample(), "deep");

        let ids: Vec<_> = scopes.iter().map(|scope| scope.node_id.as_str()).collect();
        assert_eq!(ids, ["c", "f1", "f2"]);
        assert_eq!(scopes[0].kind, VariableScopeKind::Collection);
        assert_eq!(scopes[2].kind, VariableScopeKind::Folder);
    }

    #[test]
    fn a_request_on_the_collection_root_only_has_the_collection_scope() {
        let scopes = variable_scopes(&sample(), "root");

        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].node_id, "c");
    }

    #[test]
    fn an_unknown_request_has_no_scopes() {
        assert!(variable_scopes(&sample(), "missing").is_empty());
    }

    #[test]
    fn the_closest_scope_wins() {
        let environment = vec![
            var("baseUrl", "env"),
            var("token", "env"),
            var("envOnly", "env"),
        ];

        let merged = merge_variables(&environment, &variable_scopes(&sample(), "deep"));

        assert_eq!(value_of(&merged, "baseUrl").as_deref(), Some("folder"));
        assert_eq!(value_of(&merged, "token").as_deref(), Some("inner"));
        assert_eq!(value_of(&merged, "only").as_deref(), Some("collection"));
        assert_eq!(value_of(&merged, "envOnly").as_deref(), Some("env"));
    }

    #[test]
    fn the_collection_overrides_the_environment() {
        let environment = vec![var("baseUrl", "env")];

        let merged = merge_variables(&environment, &variable_scopes(&sample(), "root"));

        assert_eq!(value_of(&merged, "baseUrl").as_deref(), Some("collection"));
    }

    #[test]
    fn a_local_value_is_never_sensitive() {
        let environment = vec![EnvironmentVariable::new("token", "secret", true).unwrap()];

        let merged = merge_variables(&environment, &variable_scopes(&sample(), "deep"));

        let token = merged.iter().find(|v| v.name() == "token").unwrap();
        assert!(!token.sensitive);
    }

    #[test]
    fn set_creates_or_replaces_a_variable() {
        let mut scope = variable_scopes(&sample(), "root").remove(0);

        scope.set("only", "changed");
        scope.set("created", "new");
        scope.set("{{invalid}}", "ignored");

        assert_eq!(
            value_of(&scope.variables, "only").as_deref(),
            Some("changed")
        );
        assert_eq!(
            value_of(&scope.variables, "created").as_deref(),
            Some("new")
        );
        assert_eq!(scope.variables.len(), 3);
    }
}
