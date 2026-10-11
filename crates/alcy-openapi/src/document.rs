//! Subconjunto tipado de um documento OpenAPI 3.0/3.1 — só os campos usados
//! pelo mapeamento para `Collection`/`Folder`/`SavedRequest` e pela
//! documentação importada (`docs.rs`). Não tenta representar o documento
//! inteiro (webhooks, callbacks, links etc. não entram aqui). Schemas ficam
//! como `Value` cru: `docs.rs` os normaliza para `SchemaNode`.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

/// Um "security requirement" do OpenAPI: nomes de scheme (chave em
/// `Components.security_schemes`) mapeados para a lista de escopos exigidos
/// (só relevante para OAuth2/OpenID Connect; vazio para os demais tipos).
/// Um `Vec<SecurityRequirement>` representa alternativas (OR); dentro de um
/// requirement, todos os schemes seriam exigidos simultaneamente (AND) —
/// esta fatia simplifica e usa só o primeiro scheme do primeiro requirement
/// (ver `mapping::resolve_authentication`).
pub(crate) type SecurityRequirement = BTreeMap<String, Vec<String>>;

#[derive(Debug, Default, Deserialize)]
pub(crate) struct OpenApiDocument {
    #[serde(default)]
    pub info: Info,
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub paths: BTreeMap<String, PathItem>,
    #[serde(default)]
    pub components: Components,
    #[serde(default)]
    pub security: Vec<SecurityRequirement>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct Server {
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct Info {
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct Components {
    #[serde(default)]
    pub parameters: BTreeMap<String, Parameter>,
    #[serde(default, rename = "requestBodies")]
    pub request_bodies: BTreeMap<String, RequestBody>,
    #[serde(default, rename = "securitySchemes")]
    pub security_schemes: BTreeMap<String, SecurityScheme>,
    #[serde(default)]
    pub schemas: BTreeMap<String, Value>,
    #[serde(default)]
    pub responses: BTreeMap<String, Response>,
}

/// Subconjunto de um Security Scheme Object usado pelo mapeamento —
/// cobre `http` (bearer/basic/digest), `apiKey` (só `in: header`) e
/// `oauth2` (só o fluxo `clientCredentials`); `openIdConnect` e os demais
/// fluxos OAuth2 não têm campos próprios aqui (ver
/// `mapping::resolve_authentication` para o que é de fato mapeado).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SecurityScheme {
    #[serde(rename = "type")]
    pub scheme_type: String,
    #[serde(default)]
    pub scheme: Option<String>,
    #[serde(default, rename = "in")]
    pub location: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub flows: Option<OAuthFlows>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct OAuthFlows {
    #[serde(default, rename = "clientCredentials")]
    pub client_credentials: Option<OAuthClientCredentialsFlow>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct OAuthClientCredentialsFlow {
    #[serde(rename = "tokenUrl")]
    pub token_url: String,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct PathItem {
    #[serde(default)]
    pub parameters: Vec<ParameterOrRef>,
    pub get: Option<Operation>,
    pub put: Option<Operation>,
    pub post: Option<Operation>,
    pub delete: Option<Operation>,
    pub patch: Option<Operation>,
    pub head: Option<Operation>,
    pub options: Option<Operation>,
    // `trace` é ignorado de propósito: não existe `HttpMethod::Trace` em
    // `alcy-domain` (spec 0026 não previu esse verbo).
}

impl PathItem {
    /// Operações na mesma ordem usada para gerar `HttpMethod` em
    /// `mapping.rs` — determinística, para saída reprodutível.
    pub fn operations(&self) -> Vec<(&'static str, &Operation)> {
        [
            ("get", &self.get),
            ("put", &self.put),
            ("post", &self.post),
            ("delete", &self.delete),
            ("patch", &self.patch),
            ("head", &self.head),
            ("options", &self.options),
        ]
        .into_iter()
        .filter_map(|(method, operation)| operation.as_ref().map(|op| (method, op)))
        .collect()
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct Operation {
    pub summary: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub deprecated: bool,
    #[serde(rename = "operationId")]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub parameters: Vec<ParameterOrRef>,
    #[serde(rename = "requestBody")]
    pub request_body: Option<RequestBodyOrRef>,
    #[serde(default)]
    pub responses: BTreeMap<String, ResponseOrRef>,
    /// `None` = herda `OpenApiDocument.security`; `Some(vec![])` = override
    /// explícito "sem autenticação" para esta operação (regra do OpenAPI).
    #[serde(default)]
    pub security: Option<Vec<SecurityRequirement>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum ParameterOrRef {
    Ref {
        #[serde(rename = "$ref")]
        reference: String,
    },
    Value(Parameter),
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Parameter {
    pub name: String,
    #[serde(rename = "in")]
    pub location: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub deprecated: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub example: Option<Value>,
    #[serde(default)]
    pub schema: Option<Value>,
}

impl Parameter {
    /// Chave de mesclagem entre parâmetro de path-level e operation-level
    /// (mesmo nome + `in` é o mesmo parâmetro, operation sobrescreve).
    pub fn merge_key(&self) -> (String, String) {
        (self.name.clone(), self.location.clone())
    }

    pub fn example_value(&self) -> Option<&Value> {
        self.example.as_ref().or_else(|| {
            self.schema
                .as_ref()
                .and_then(|schema| schema.get("default"))
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum RequestBodyOrRef {
    Ref {
        #[serde(rename = "$ref")]
        reference: String,
    },
    Value(RequestBody),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct RequestBody {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub content: BTreeMap<String, MediaType>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum ResponseOrRef {
    Ref {
        #[serde(rename = "$ref")]
        reference: String,
    },
    Value(Response),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct Response {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub content: BTreeMap<String, MediaType>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct MediaType {
    #[serde(default)]
    pub schema: Option<Value>,
    #[serde(default)]
    pub example: Option<Value>,
    #[serde(default)]
    pub examples: BTreeMap<String, ExampleObject>,
}

impl MediaType {
    pub fn example_value(&self) -> Option<&Value> {
        self.example.as_ref().or_else(|| {
            self.examples
                .values()
                .next()
                .and_then(|example| example.value.as_ref())
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ExampleObject {
    #[serde(default)]
    pub value: Option<Value>,
}

pub(crate) fn resolve_parameter<'a>(
    components: &'a Components,
    item: &'a ParameterOrRef,
) -> Option<&'a Parameter> {
    match item {
        ParameterOrRef::Ref { reference } => reference
            .strip_prefix("#/components/parameters/")
            .and_then(|key| components.parameters.get(key)),
        ParameterOrRef::Value(parameter) => Some(parameter),
    }
}

pub(crate) fn resolve_request_body<'a>(
    components: &'a Components,
    item: &'a RequestBodyOrRef,
) -> Option<&'a RequestBody> {
    match item {
        RequestBodyOrRef::Ref { reference } => reference
            .strip_prefix("#/components/requestBodies/")
            .and_then(|key| components.request_bodies.get(key)),
        RequestBodyOrRef::Value(body) => Some(body),
    }
}

pub(crate) fn resolve_response<'a>(
    components: &'a Components,
    item: &'a ResponseOrRef,
) -> Option<&'a Response> {
    match item {
        ResponseOrRef::Ref { reference } => reference
            .strip_prefix("#/components/responses/")
            .and_then(|key| components.responses.get(key)),
        ResponseOrRef::Value(response) => Some(response),
    }
}
