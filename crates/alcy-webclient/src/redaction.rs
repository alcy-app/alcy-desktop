//! Detecção e remoção de dados sensíveis do export (ADR 0046).
//!
//! Cada valor sensível encontrado vira uma `Credential`: um lugar que quem
//! usa o webclient pode preencher na tela. Sem `include_sensitive`, o valor
//! sai do export; com ela, o valor vai e a credencial só permite trocá-lo.
//!
//! As regras espelham as do frontend (`har-redaction.ts` e
//! `screenshot/import-metadata.ts`): variáveis de ambiente marcadas como
//! sensíveis, segredos digitados nos campos de autenticação, headers de
//! credencial e campos com nome de segredo. Referências `{{variável}}` não
//! são segredo e ficam como estão.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Serialize;

use crate::snapshot::{
    ExportEnvironment, SnapshotAuthentication, SnapshotBody, SnapshotEnvironment, SnapshotFolder,
    SnapshotProtocol, SnapshotRequest, SnapshotVariable, to_variable,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    /// Estável dentro do export; chave do valor preenchido no runtime.
    pub id: String,
    /// Nome da pasta ou requisição dona do campo (ausente para variáveis).
    pub owner: Option<String>,
    pub target: CredentialTarget,
    /// O valor original foi exportado (confirmação de dados sensíveis).
    pub included: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CredentialTarget {
    /// Variável de ambiente sensível ou variável de escopo com nome de segredo.
    Variable {
        name: String,
    },
    Authentication {
        node_id: String,
        field: AuthenticationField,
    },
    Header {
        node_id: String,
        name: String,
    },
    Query {
        node_id: String,
        name: String,
    },
    RouteParameter {
        node_id: String,
        name: String,
    },
    /// Campo urlencoded ou de texto do form-data.
    BodyField {
        node_id: String,
        name: String,
    },
    /// Chave `"nome": "valor"` (JSON) ou `nome: "valor"` (GraphQL) num texto.
    BodyText {
        node_id: String,
        source: TextSource,
        key: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationField {
    Token,
    Password,
    Value,
    ClientSecret,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TextSource {
    /// Corpo REST.
    Body,
    /// Variáveis GraphQL.
    Variables,
    /// Query GraphQL.
    Query,
}

/// Regex de padrão fixo; `None` só se o padrão fosse inválido, o que o teste
/// `fixed_patterns_compile` impede. Sem ela, cada regra cai no lado seguro
/// (tratar como segredo).
fn fixed_regex(source: &str) -> Option<Regex> {
    Regex::new(source).ok()
}

static TEMPLATE: LazyLock<Option<Regex>> = LazyLock::new(|| fixed_regex(r"\{\{[^{}]*\}\}"));
static LEADING_SCHEME: LazyLock<Option<Regex>> = LazyLock::new(|| fixed_regex(r"^\s*[A-Za-z]+\s+"));
/// Mesmo `SECRET_HEADER_PATTERN` de `har-redaction.ts`.
static SECRET_HEADER: LazyLock<Option<Regex>> =
    LazyLock::new(|| fixed_regex(r"(?i)token|api[-_ ]?key|secret|password|session|credential"));
/// Mesmo `SUSPICIOUS_FIELD_PATTERN` de `screenshot/import-metadata.ts`.
static SUSPICIOUS_FIELD: LazyLock<Option<Regex>> = LazyLock::new(|| {
    fixed_regex(
        r"(?i)\b(?:password|passwd|pwd|passphrase|senha|secret|token|api\s*key|credential)\b",
    )
});
static CAMEL_BOUNDARY: LazyLock<Option<Regex>> = LazyLock::new(|| fixed_regex(r"([a-z\d])([A-Z])"));
static NON_ALPHANUMERIC: LazyLock<Option<Regex>> = LazyLock::new(|| fixed_regex(r"[^A-Za-z\d]+"));
/// `"chave": "valor"` (JSON) ou `chave: "valor"` (argumento GraphQL). Sem
/// backreference no `regex`, as aspas da chave são conferidas no código.
/// Espelhada por `keyedStringPattern` em `apps/desktop/src/webclient/credentials.ts`.
static KEYED_STRING: LazyLock<Option<Regex>> =
    LazyLock::new(|| fixed_regex(r#"("?)([A-Za-z_][\w-]*)("?)(\s*:\s*)"((?:\\.|[^"\\])*)""#));

/// O valor tem algo além de `{{variáveis}}` e do esquema (`Bearer`,
/// `Basic`…), ou seja, um segredo digitado direto no campo.
pub fn has_literal_secret(value: &str) -> bool {
    let (Some(template), Some(scheme)) = (TEMPLATE.as_ref(), LEADING_SCHEME.as_ref()) else {
        return !value.trim().is_empty();
    };
    let without_templates = template.replace_all(value, "");
    !scheme.replace(&without_templates, "").trim().is_empty()
}

/// Header de requisição que carrega credencial: autorização, cookie, nome
/// de segredo ou o header da autenticação customizada.
pub fn is_credential_header(name: &str, custom_header_names: &[String]) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "authorization" | "proxy-authorization" | "cookie"
    ) || custom_header_names
        .iter()
        .any(|custom| custom.trim().eq_ignore_ascii_case(&lower))
        || SECRET_HEADER
            .as_ref()
            .is_none_or(|pattern| pattern.is_match(name))
}

/// Nome de campo que sugere segredo (`password`, `apiKey`, `client_secret`…).
pub fn is_suspicious_field_name(name: &str) -> bool {
    let (Some(camel), Some(separators), Some(suspicious)) = (
        CAMEL_BOUNDARY.as_ref(),
        NON_ALPHANUMERIC.as_ref(),
        SUSPICIOUS_FIELD.as_ref(),
    ) else {
        return true;
    };
    let spaced = camel.replace_all(name, "$1 $2");
    let words = separators.replace_all(&spaced, " ");
    suspicious.is_match(&words)
}

struct Redactor {
    include: bool,
    /// Valores sensíveis do ambiente, do maior para o menor, para que um
    /// segredo que contém outro seja trocado inteiro.
    sensitive_values: Vec<(String, String)>,
    credentials: Vec<Credential>,
}

impl Redactor {
    fn register(&mut self, owner: Option<&str>, target: CredentialTarget) {
        let id = credential_id(&target);
        if self.credentials.iter().any(|existing| existing.id == id) {
            return;
        }
        self.credentials.push(Credential {
            id,
            owner: owner.map(str::to_string),
            target,
            included: self.include,
        });
    }

    /// Registra a credencial e, sem `include`, esvazia o valor.
    fn take(&mut self, value: &mut String, owner: Option<&str>, target: CredentialTarget) {
        self.register(owner, target);
        if !self.include {
            value.clear();
        }
    }

    /// Troca valores sensíveis do ambiente digitados direto no texto por
    /// `{{nome}}`, que o runtime resolve com a credencial da variável.
    fn replace_sensitive_values(&self, text: &mut String) {
        if self.include || text.is_empty() {
            return;
        }
        for (name, value) in &self.sensitive_values {
            let reference = format!("{{{{{name}}}}}");
            if text == value {
                *text = reference;
                return;
            }
            if value.chars().count() >= 4 && text.contains(value.as_str()) {
                *text = text.replace(value.as_str(), &reference);
            }
        }
    }
}

fn credential_id(target: &CredentialTarget) -> String {
    match target {
        CredentialTarget::Variable { name } => format!("variable:{name}"),
        CredentialTarget::Authentication { node_id, field } => {
            format!("authentication:{node_id}:{field:?}")
        }
        CredentialTarget::Header { node_id, name } => {
            format!("header:{node_id}:{}", name.to_ascii_lowercase())
        }
        CredentialTarget::Query { node_id, name } => format!("query:{node_id}:{name}"),
        CredentialTarget::RouteParameter { node_id, name } => format!("route:{node_id}:{name}"),
        CredentialTarget::BodyField { node_id, name } => format!("field:{node_id}:{name}"),
        CredentialTarget::BodyText {
            node_id,
            source,
            key,
        } => format!("text:{node_id}:{source:?}:{key}"),
    }
}

/// Resultado da redação: o ambiente exportado e as credenciais encontradas.
pub(crate) struct Redacted {
    pub environment: Option<SnapshotEnvironment>,
    pub credentials: Vec<Credential>,
}

/// Aplica as regras sobre `root` (no lugar) e monta o ambiente exportado.
pub(crate) fn redact(
    root: &mut SnapshotFolder,
    environment: Option<&ExportEnvironment>,
    include: bool,
) -> Redacted {
    let mut sensitive_values: Vec<(String, String)> = environment
        .map(|environment| {
            environment
                .variables
                .iter()
                .filter(|variable| variable.sensitive && !variable.value().is_empty())
                .map(|variable| (variable.name().to_string(), variable.value().to_string()))
                .collect()
        })
        .unwrap_or_default();
    sensitive_values.sort_by_key(|(_, value)| std::cmp::Reverse(value.len()));

    let mut redactor = Redactor {
        include,
        sensitive_values,
        credentials: Vec::new(),
    };

    let environment = environment.map(|environment| SnapshotEnvironment {
        name: environment.name.clone(),
        variables: environment
            .variables
            .iter()
            .map(|variable| {
                let mut exported: SnapshotVariable = to_variable(variable);
                if variable.sensitive {
                    let target = CredentialTarget::Variable {
                        name: exported.name.clone(),
                    };
                    redactor.take(&mut exported.value, None, target);
                }
                exported
            })
            .collect(),
    });

    redact_folder(&mut redactor, root, &[]);

    Redacted {
        environment,
        credentials: redactor.credentials,
    }
}

fn custom_header_name(authentication: &SnapshotAuthentication) -> Option<String> {
    match authentication {
        SnapshotAuthentication::CustomHeader { name, .. } => Some(name.trim().to_string()),
        _ => None,
    }
}

fn redact_folder(redactor: &mut Redactor, folder: &mut SnapshotFolder, inherited: &[String]) {
    let owner = folder.name.clone();
    for variable in &mut folder.variables {
        redactor.replace_sensitive_values(&mut variable.value);
        if is_suspicious_field_name(&variable.name) && has_literal_secret(&variable.value) {
            let target = CredentialTarget::Variable {
                name: variable.name.clone(),
            };
            redactor.take(&mut variable.value, Some(&owner), target);
        }
    }
    redact_authentication(redactor, &mut folder.authentication, &folder.id, &owner);

    let mut custom_headers = inherited.to_vec();
    custom_headers.extend(custom_header_name(&folder.authentication));

    for request in &mut folder.requests {
        redact_request(redactor, request, &custom_headers);
    }
    for child in &mut folder.folders {
        redact_folder(redactor, child, &custom_headers);
    }
}

fn redact_authentication(
    redactor: &mut Redactor,
    authentication: &mut SnapshotAuthentication,
    node_id: &str,
    owner: &str,
) {
    let (secret, field) = match authentication {
        SnapshotAuthentication::None | SnapshotAuthentication::Inherit => return,
        SnapshotAuthentication::CustomHeader { name, value } => {
            redactor.replace_sensitive_values(name);
            (value, AuthenticationField::Value)
        }
        SnapshotAuthentication::Bearer { token } => (token, AuthenticationField::Token),
        SnapshotAuthentication::Basic { username, password }
        | SnapshotAuthentication::Digest { username, password } => {
            redactor.replace_sensitive_values(username);
            (password, AuthenticationField::Password)
        }
        SnapshotAuthentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => {
            redactor.replace_sensitive_values(client_id);
            redactor.replace_sensitive_values(token_url);
            redactor.replace_sensitive_values(scope);
            (client_secret, AuthenticationField::ClientSecret)
        }
    };
    redactor.replace_sensitive_values(secret);
    if has_literal_secret(secret) {
        let target = CredentialTarget::Authentication {
            node_id: node_id.to_string(),
            field,
        };
        redactor.take(secret, Some(owner), target);
    }
}

fn redact_request(redactor: &mut Redactor, request: &mut SnapshotRequest, inherited: &[String]) {
    let owner = request.name.clone();
    let node_id = request.id.clone();
    redact_authentication(redactor, &mut request.authentication, &node_id, &owner);

    let mut custom_headers = inherited.to_vec();
    custom_headers.extend(custom_header_name(&request.authentication));

    redactor.replace_sensitive_values(&mut request.url);
    request.url = redact_query(redactor, &request.url, &node_id, &owner);

    for header in &mut request.headers {
        redactor.replace_sensitive_values(&mut header.value);
        if is_credential_header(&header.name, &custom_headers) && has_literal_secret(&header.value)
        {
            let target = CredentialTarget::Header {
                node_id: node_id.clone(),
                name: header.name.trim().to_string(),
            };
            redactor.take(&mut header.value, Some(&owner), target);
        }
    }

    for parameter in &mut request.route_parameters {
        redactor.replace_sensitive_values(&mut parameter.value);
        if is_suspicious_field_name(&parameter.name) && has_literal_secret(&parameter.value) {
            let target = CredentialTarget::RouteParameter {
                node_id: node_id.clone(),
                name: parameter.name.clone(),
            };
            redactor.take(&mut parameter.value, Some(&owner), target);
        }
    }

    if let SnapshotBody::UrlEncoded { fields } | SnapshotBody::FormData { fields } =
        &mut request.body_payload
    {
        for field in fields {
            redactor.replace_sensitive_values(&mut field.value);
            if is_suspicious_field_name(&field.name) && has_literal_secret(&field.value) {
                let target = CredentialTarget::BodyField {
                    node_id: node_id.clone(),
                    name: field.name.clone(),
                };
                redactor.take(&mut field.value, Some(&owner), target);
            }
        }
    }

    let body_source = match request.protocol {
        SnapshotProtocol::Graphql => TextSource::Query,
        SnapshotProtocol::Rest => TextSource::Body,
    };
    redactor.replace_sensitive_values(&mut request.body);
    request.body = redact_keyed_strings(redactor, &request.body, &node_id, &owner, body_source);
    redactor.replace_sensitive_values(&mut request.variables);
    request.variables = redact_keyed_strings(
        redactor,
        &request.variables,
        &node_id,
        &owner,
        TextSource::Variables,
    );
}

/// Esvazia, na query string, parâmetros com nome de segredo e valor literal.
fn redact_query(redactor: &mut Redactor, url: &str, node_id: &str, owner: &str) -> String {
    let Some(query_start) = url.find('?') else {
        return url.to_string();
    };
    let query_end = url[query_start..]
        .find('#')
        .map_or(url.len(), |offset| query_start + offset);
    let query = &url[query_start + 1..query_end];
    let pairs: Vec<String> = query
        .split('&')
        .map(|pair| {
            let Some((name, value)) = pair.split_once('=') else {
                return pair.to_string();
            };
            if !is_suspicious_field_name(name) || !has_literal_secret(value) {
                return pair.to_string();
            }
            let mut value = value.to_string();
            let target = CredentialTarget::Query {
                node_id: node_id.to_string(),
                name: name.to_string(),
            };
            redactor.take(&mut value, Some(owner), target);
            format!("{name}={value}")
        })
        .collect();
    format!(
        "{}?{}{}",
        &url[..query_start],
        pairs.join("&"),
        &url[query_end..]
    )
}

/// Esvazia strings literais cujas chaves têm nome de segredo, em JSON ou em
/// argumentos GraphQL, preservando a formatação do resto do texto.
fn redact_keyed_strings(
    redactor: &mut Redactor,
    text: &str,
    node_id: &str,
    owner: &str,
    source: TextSource,
) -> String {
    let Some(keyed_string) = KEYED_STRING.as_ref() else {
        return text.to_string();
    };
    keyed_string
        .replace_all(text, |captures: &Captures| {
            let whole = captures[0].to_string();
            let (open, key, close, separator, value) = (
                &captures[1],
                &captures[2],
                &captures[3],
                &captures[4],
                &captures[5],
            );
            if open != close || !is_suspicious_field_name(key) || !has_literal_secret(value) {
                return whole;
            }
            let mut value = value.to_string();
            let target = CredentialTarget::BodyText {
                node_id: node_id.to_string(),
                source,
                key: key.to_string(),
            };
            redactor.take(&mut value, Some(owner), target);
            format!("{open}{key}{close}{separator}\"{value}\"")
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::{SnapshotField, SnapshotProtocol};
    use alcy_domain::EnvironmentVariable;

    fn request() -> SnapshotRequest {
        SnapshotRequest {
            id: "r1".into(),
            name: "Login".into(),
            protocol: SnapshotProtocol::Rest,
            method: "POST",
            url: "{{baseUrl}}/login?api_key=abc123&page=2#top".into(),
            headers: vec![
                SnapshotField {
                    name: "Authorization".into(),
                    value: "Bearer literal-token".into(),
                    enabled: true,
                },
                SnapshotField {
                    name: "X-Session".into(),
                    value: "{{session}}".into(),
                    enabled: true,
                },
                SnapshotField {
                    name: "Accept".into(),
                    value: "application/json".into(),
                    enabled: true,
                },
            ],
            authentication: SnapshotAuthentication::Basic {
                username: "admin".into(),
                password: "hunter22".into(),
            },
            body: "{\n  \"user\": \"ana\",\n  \"password\": \"s3cret\",\n  \"note\": \"uses super-secret-value\"\n}"
                .into(),
            body_payload: SnapshotBody::Raw { language: "json" },
            variables: String::new(),
            route_parameters: vec![],
            unsupported: vec![],
        }
    }

    fn folder() -> SnapshotFolder {
        SnapshotFolder {
            id: "root".into(),
            name: "Root".into(),
            variables: vec![
                SnapshotVariable {
                    name: "apiToken".into(),
                    value: "scoped-literal".into(),
                },
                SnapshotVariable {
                    name: "baseUrl".into(),
                    value: "https://api.test".into(),
                },
            ],
            authentication: SnapshotAuthentication::Bearer {
                token: "{{token}}".into(),
            },
            folders: vec![],
            requests: vec![request()],
        }
    }

    fn environment() -> ExportEnvironment {
        ExportEnvironment {
            name: "Dev".into(),
            variables: vec![
                EnvironmentVariable::new("token", "super-secret-value", true).unwrap(),
                EnvironmentVariable::new("baseUrl", "https://api.test", false).unwrap(),
            ],
        }
    }

    const SECRETS: [&str; 7] = [
        "super-secret-value",
        "scoped-literal",
        "literal-token",
        "hunter22",
        "s3cret",
        "abc123",
        "hunter",
    ];

    #[test]
    fn removes_every_secret_by_default() {
        let mut root = folder();
        let redacted = redact(&mut root, Some(&environment()), false);

        let exported = format!(
            "{}{}",
            serde_json::to_string(&root).unwrap(),
            serde_json::to_string(&redacted.environment).unwrap()
        );
        for secret in SECRETS {
            assert!(!exported.contains(secret), "vazou {secret}: {exported}");
        }
        let request = &root.requests[0];
        assert_eq!(
            request.body,
            "{\n  \"user\": \"ana\",\n  \"password\": \"\",\n  \"note\": \"uses {{token}}\"\n}"
        );
        assert_eq!(request.url, "{{baseUrl}}/login?api_key=&page=2#top");
        assert_eq!(request.headers[1].value, "{{session}}");
        assert_eq!(
            request.authentication,
            SnapshotAuthentication::Basic {
                username: "admin".into(),
                password: String::new()
            }
        );
        assert_eq!(root.variables[1].value, "https://api.test");
    }

    #[test]
    fn lists_each_secret_as_a_credential() {
        let mut root = folder();
        let redacted = redact(&mut root, Some(&environment()), false);
        let ids: Vec<&str> = redacted
            .credentials
            .iter()
            .map(|credential| credential.id.as_str())
            .collect();

        assert_eq!(
            ids,
            vec![
                "variable:token",
                "variable:apiToken",
                "authentication:r1:Password",
                "query:r1:api_key",
                "header:r1:authorization",
                "text:r1:Body:password",
            ]
        );
        assert!(
            redacted
                .credentials
                .iter()
                .all(|credential| !credential.included)
        );
    }

    #[test]
    fn keeps_values_when_sensitive_data_is_included() {
        let mut root = folder();
        let redacted = redact(&mut root, Some(&environment()), true);

        assert_eq!(root, folder());
        let environment = redacted.environment.unwrap();
        assert_eq!(environment.variables[0].value, "super-secret-value");
        assert!(
            redacted
                .credentials
                .iter()
                .all(|credential| credential.included)
        );
        assert_eq!(redacted.credentials.len(), 6);
    }

    #[test]
    fn fixed_patterns_compile() {
        for pattern in [
            &TEMPLATE,
            &LEADING_SCHEME,
            &SECRET_HEADER,
            &SUSPICIOUS_FIELD,
            &CAMEL_BOUNDARY,
            &NON_ALPHANUMERIC,
            &KEYED_STRING,
        ] {
            assert!(pattern.is_some());
        }
    }

    #[test]
    fn literal_secret_detection_ignores_templates_and_schemes() {
        assert!(!has_literal_secret("{{token}}"));
        assert!(!has_literal_secret("Bearer {{token}}"));
        assert!(!has_literal_secret("  "));
        assert!(has_literal_secret("abc"));
        assert!(has_literal_secret("Bearer abc"));
    }

    #[test]
    fn credential_headers_follow_the_frontend_rules() {
        assert!(is_credential_header("Authorization", &[]));
        assert!(is_credential_header("cookie", &[]));
        assert!(is_credential_header("X-Api-Key", &[]));
        assert!(is_credential_header("X-Custom", &["x-custom".into()]));
        assert!(!is_credential_header("Accept", &[]));
    }

    #[test]
    fn suspicious_names_split_words() {
        assert!(is_suspicious_field_name("clientSecret"));
        assert!(is_suspicious_field_name("api_key"));
        assert!(is_suspicious_field_name("senha"));
        assert!(!is_suspicious_field_name("tokenizer"));
        assert!(!is_suspicious_field_name("page"));
    }

    #[test]
    fn graphql_arguments_are_redacted() {
        let mut redactor = Redactor {
            include: false,
            sensitive_values: vec![],
            credentials: vec![],
        };
        let query = "mutation { login(user: \"ana\", password: \"p4ss\") { token } }";

        let result = redact_keyed_strings(&mut redactor, query, "r", "R", TextSource::Query);

        assert_eq!(
            result,
            "mutation { login(user: \"ana\", password: \"\") { token } }"
        );
        assert_eq!(redactor.credentials[0].id, "text:r:Query:password");
    }

    #[test]
    fn custom_authentication_header_is_a_credential_header_in_descendants() {
        let mut root = folder();
        root.authentication = SnapshotAuthentication::CustomHeader {
            name: "X-Tenant-Auth".into(),
            value: "{{token}}".into(),
        };
        root.requests[0].headers.push(SnapshotField {
            name: "X-Tenant-Auth".into(),
            value: "raw".into(),
            enabled: false,
        });

        redact(&mut root, None, false);

        assert_eq!(root.requests[0].headers[3].value, "");
    }
}
