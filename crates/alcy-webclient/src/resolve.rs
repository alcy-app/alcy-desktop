//! Resolução das variáveis não sensíveis no export: o webclient mostra os
//! valores (`https://api.empresa.com/pedidos`) em vez de `{{baseUrl}}/pedidos`.
//!
//! Continuam como `{{nome}}` as variáveis que viram credencial no webclient
//! (sensíveis do ambiente e de escopo com nome e valor de segredo) e as que
//! não têm valor. Roda antes da redação, para que um segredo literal trazido
//! por uma variável não marcada ainda passe pelas regras de dados sensíveis.
//!
//! Mesmas regras do app (`alcy-app/src/resolve_request_variables.rs`): uma
//! passada só, a pasta mais próxima vence, a query GraphQL não é resolvida e
//! os nomes de header também não.

use std::collections::HashMap;

use crate::redaction::{has_literal_secret, is_suspicious_field_name};
use crate::snapshot::{
    ExportEnvironment, SnapshotAuthentication, SnapshotBody, SnapshotFolder, SnapshotProtocol,
    SnapshotRequest, SnapshotVariable,
};

/// Nome → valor a resolver, ou `None` para manter a referência.
type Scope = HashMap<String, Option<String>>;

pub(crate) fn resolve_non_sensitive(
    root: &mut SnapshotFolder,
    environment: Option<&ExportEnvironment>,
) {
    let mut scope = Scope::new();
    for variable in environment.map_or(&[][..], |environment| &environment.variables) {
        let value = (!variable.sensitive).then(|| variable.value().to_string());
        scope.insert(variable.name().to_string(), value);
    }
    resolve_folder(root, &scope);
}

/// Variável de escopo que a redação transforma em credencial.
fn is_credential_variable(variable: &SnapshotVariable) -> bool {
    is_suspicious_field_name(&variable.name) && has_literal_secret(&variable.value)
}

fn resolve_folder(folder: &mut SnapshotFolder, parent: &Scope) {
    let mut scope = parent.clone();
    for variable in &folder.variables {
        let value = (!is_credential_variable(variable)).then(|| variable.value.clone());
        scope.insert(variable.name.clone(), value);
    }
    resolve_authentication(&mut folder.authentication, &scope);
    for request in &mut folder.requests {
        resolve_request(request, &scope);
    }
    for child in &mut folder.folders {
        resolve_folder(child, &scope);
    }
}

fn resolve_request(request: &mut SnapshotRequest, scope: &Scope) {
    let resolve = |text: &mut String| *text = resolve_text(text, scope);
    resolve(&mut request.url);
    for header in &mut request.headers {
        resolve(&mut header.value);
    }
    for parameter in &mut request.route_parameters {
        resolve(&mut parameter.value);
    }
    match request.protocol {
        SnapshotProtocol::Graphql => resolve(&mut request.variables),
        SnapshotProtocol::Rest => resolve(&mut request.body),
    }
    if let SnapshotBody::UrlEncoded { fields } | SnapshotBody::FormData { fields } =
        &mut request.body_payload
    {
        for field in fields {
            resolve(&mut field.name);
            resolve(&mut field.value);
        }
    }
    resolve_authentication(&mut request.authentication, scope);
}

fn resolve_authentication(authentication: &mut SnapshotAuthentication, scope: &Scope) {
    let resolve = |text: &mut String| *text = resolve_text(text, scope);
    match authentication {
        SnapshotAuthentication::None | SnapshotAuthentication::Inherit => {}
        SnapshotAuthentication::CustomHeader { name, value } => {
            resolve(name);
            resolve(value);
        }
        SnapshotAuthentication::Bearer { token } => resolve(token),
        SnapshotAuthentication::Basic { username, password }
        | SnapshotAuthentication::Digest { username, password } => {
            resolve(username);
            resolve(password);
        }
        SnapshotAuthentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope: oauth_scope,
        } => {
            resolve(client_id);
            resolve(client_secret);
            resolve(token_url);
            resolve(oauth_scope);
        }
    }
}

/// Troca `{{nome}}` pelo valor quando há um a resolver; o resto fica igual.
fn resolve_text(template: &str, scope: &Scope) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            result.push_str(&rest[start..]);
            return result;
        };
        match scope.get(after_open[..end].trim()) {
            Some(Some(value)) => result.push_str(value),
            _ => result.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after_open[end + 2..];
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::SnapshotField;
    use alcy_domain::EnvironmentVariable;

    fn request(protocol: SnapshotProtocol) -> SnapshotRequest {
        SnapshotRequest {
            id: "r1".into(),
            name: "R".into(),
            protocol,
            method: "POST",
            url: "{{ baseUrl }}/users/:id?tenant={{tenant}}&x={{unknown}}".into(),
            headers: vec![SnapshotField {
                name: "X-{{tenant}}".into(),
                value: "{{tenant}}".into(),
                enabled: true,
            }],
            authentication: SnapshotAuthentication::Bearer {
                token: "{{token}}".into(),
            },
            body: "{\"tenant\": \"{{tenant}}\", \"key\": \"{{apiKey}}\"}".into(),
            body_payload: SnapshotBody::Raw { language: "json" },
            variables: "{\"t\": \"{{tenant}}\"}".into(),
            route_parameters: vec![SnapshotVariable {
                name: "id".into(),
                value: "{{userId}}".into(),
            }],
            unsupported: vec![],
        }
    }

    fn folder(requests: Vec<SnapshotRequest>) -> SnapshotFolder {
        SnapshotFolder {
            id: "root".into(),
            name: "Root".into(),
            variables: vec![
                SnapshotVariable {
                    name: "tenant".into(),
                    value: "acme".into(),
                },
                SnapshotVariable {
                    name: "apiKey".into(),
                    value: "scoped-literal-key".into(),
                },
            ],
            authentication: SnapshotAuthentication::Basic {
                username: "{{tenant}}".into(),
                password: "{{token}}".into(),
            },
            folders: vec![SnapshotFolder {
                id: "child".into(),
                name: "Child".into(),
                variables: vec![SnapshotVariable {
                    name: "tenant".into(),
                    value: "child-tenant".into(),
                }],
                authentication: SnapshotAuthentication::Inherit,
                folders: vec![],
                requests: vec![request(SnapshotProtocol::Rest)],
            }],
            requests,
        }
    }

    fn environment() -> ExportEnvironment {
        ExportEnvironment {
            name: "Dev".into(),
            variables: vec![
                EnvironmentVariable::new("baseUrl", "https://api.test", false).unwrap(),
                EnvironmentVariable::new("userId", "42", false).unwrap(),
                EnvironmentVariable::new("token", "env-secret", true).unwrap(),
            ],
        }
    }

    #[test]
    fn resolves_non_sensitive_variables_and_keeps_the_rest() {
        let mut root = folder(vec![request(SnapshotProtocol::Rest)]);

        resolve_non_sensitive(&mut root, Some(&environment()));

        let request = &root.requests[0];
        assert_eq!(
            request.url,
            "https://api.test/users/:id?tenant=acme&x={{unknown}}"
        );
        assert_eq!(request.headers[0].name, "X-{{tenant}}");
        assert_eq!(request.headers[0].value, "acme");
        assert_eq!(request.route_parameters[0].value, "42");
        // `apiKey` tem nome e valor de segredo: vira credencial, não é resolvida.
        assert_eq!(
            request.body,
            "{\"tenant\": \"acme\", \"key\": \"{{apiKey}}\"}"
        );
        assert_eq!(
            request.authentication,
            SnapshotAuthentication::Bearer {
                token: "{{token}}".into()
            }
        );
        assert_eq!(
            root.authentication,
            SnapshotAuthentication::Basic {
                username: "acme".into(),
                password: "{{token}}".into()
            }
        );
    }

    #[test]
    fn the_nearest_folder_wins() {
        let mut root = folder(vec![]);

        resolve_non_sensitive(&mut root, Some(&environment()));

        let nested = &root.folders[0].requests[0];
        assert_eq!(
            nested.url,
            "https://api.test/users/:id?tenant=child-tenant&x={{unknown}}"
        );
    }

    #[test]
    fn graphql_queries_are_not_resolved_but_their_variables_are() {
        let mut graphql = request(SnapshotProtocol::Graphql);
        graphql.body = "query { user(t: \"{{tenant}}\") { id } }".into();
        let mut root = folder(vec![graphql]);

        resolve_non_sensitive(&mut root, Some(&environment()));

        assert_eq!(
            root.requests[0].body,
            "query { user(t: \"{{tenant}}\") { id } }"
        );
        assert_eq!(root.requests[0].variables, "{\"t\": \"acme\"}");
    }

    #[test]
    fn a_scoped_variable_can_shadow_a_sensitive_one() {
        let mut root = folder(vec![request(SnapshotProtocol::Rest)]);
        root.variables.push(SnapshotVariable {
            name: "token".into(),
            value: "{{baseUrl}}".into(),
        });

        resolve_non_sensitive(&mut root, Some(&environment()));

        assert_eq!(
            root.requests[0].authentication,
            SnapshotAuthentication::Bearer {
                token: "{{baseUrl}}".into()
            }
        );
    }

    #[test]
    fn values_are_inserted_once_like_the_app() {
        let scope: Scope = [("a".to_string(), Some("{{b}}".to_string()))].into();

        assert_eq!(resolve_text("{{a}}-{{a", &scope), "{{b}}-{{a");
    }
}
