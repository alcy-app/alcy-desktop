//! Introspection e modelagem do schema GraphQL.
//!
//! Schema é um conceito específico do protocolo — mora aqui, não em
//! `alcy-domain` (o núcleo genérico só conhece o identificador do
//! protocolo, ver `ARCHITECTURE.md`).

use alcy_domain::{Authentication, Endpoint, HeaderEntry, ProtocolId, Request, RequestDocument};
use serde_json::Value;
use thiserror::Error;

use crate::interpret_graphql_errors;

/// Query de introspection completa: tipos (com deprecados, valores padrão
/// de argumentos, interfaces implementadas e tipos possíveis de
/// union/interface) e diretivas do schema.
pub const INTROSPECTION_QUERY: &str = r#"
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
        args {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        type { ...TypeRef }
      }
      inputFields {
        name
        description
        type { ...TypeRef }
        defaultValue
      }
      interfaces { ...TypeRef }
      possibleTypes { ...TypeRef }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
    }
    directives {
      name
      description
      locations
      args {
        name
        description
        type { ...TypeRef }
        defaultValue
      }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SchemaError {
    #[error("erro do servidor GraphQL ao buscar o schema: {0}")]
    GraphqlError(String),
    #[error("resposta de introspection inválida: {0}")]
    InvalidJson(String),
    #[error("resposta de introspection não contém __schema")]
    MissingSchema,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlSchema {
    pub query_type: Option<String>,
    pub mutation_type: Option<String>,
    pub subscription_type: Option<String>,
    pub types: Vec<GraphqlNamedType>,
    pub directives: Vec<GraphqlDirective>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphqlTypeKind {
    Scalar,
    Object,
    Interface,
    Union,
    Enum,
    InputObject,
    /// Preserva o valor bruto para um `kind` desconhecido/futuro em vez de
    /// falhar o parsing inteiro por causa de um único tipo incomum.
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlNamedType {
    pub name: String,
    pub kind: GraphqlTypeKind,
    pub description: Option<String>,
    pub fields: Vec<GraphqlField>,
    pub input_fields: Vec<GraphqlInputValue>,
    pub enum_values: Vec<GraphqlEnumValue>,
    /// Nomes das interfaces implementadas (OBJECT/INTERFACE).
    pub interfaces: Vec<String>,
    /// Nomes dos tipos concretos possíveis (INTERFACE/UNION).
    pub possible_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlField {
    pub name: String,
    pub description: Option<String>,
    pub args: Vec<GraphqlInputValue>,
    pub type_display: String,
    pub type_name: Option<String>,
    pub is_deprecated: bool,
    pub deprecation_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlInputValue {
    pub name: String,
    pub description: Option<String>,
    pub type_display: String,
    pub type_name: Option<String>,
    /// Literal GraphQL bruto devolvido pela introspection (ex.: `"10"`,
    /// `"\"foo\""`), não reinterpretado — só exibido como texto.
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlEnumValue {
    pub name: String,
    pub description: Option<String>,
    pub is_deprecated: bool,
    pub deprecation_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphqlDirective {
    pub name: String,
    pub description: Option<String>,
    pub locations: Vec<String>,
    pub args: Vec<GraphqlInputValue>,
}

/// Monta a query de introspection como um `Request` comum — do ponto de
/// vista de transporte não é diferente de qualquer outra operação GraphQL,
/// então reaproveita a mesma execução (e cancelamento) já usada para
/// executar queries do usuário.
pub fn introspection_request(
    endpoint: Endpoint,
    headers: Vec<HeaderEntry>,
    authentication: Authentication,
) -> Request {
    Request::new(
        endpoint,
        RequestDocument::new(ProtocolId::GraphQl, INTROSPECTION_QUERY),
        "",
        headers,
        authentication,
    )
}

/// Interpreta o corpo de uma resposta de introspection.
///
/// Um array `errors` não vazio (ex.: introspection desabilitada no
/// servidor) vira `SchemaError::GraphqlError` — diferente de
/// `interpret_graphql_errors` (usado para respostas de queries do
/// usuário), aqui não há um corpo parcial útil para mostrar sem schema.
pub fn parse_schema(body: &str) -> Result<GraphqlSchema, SchemaError> {
    let value: Value =
        serde_json::from_str(body).map_err(|error| SchemaError::InvalidJson(error.to_string()))?;

    let errors = interpret_graphql_errors(body);
    if !errors.is_empty() {
        let message = errors
            .into_iter()
            .map(|error| error.message)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(SchemaError::GraphqlError(message));
    }

    let schema = value
        .get("data")
        .and_then(|data| data.get("__schema"))
        .ok_or(SchemaError::MissingSchema)?;

    let query_type = root_type_name(schema, "queryType");
    let mutation_type = root_type_name(schema, "mutationType");
    let subscription_type = root_type_name(schema, "subscriptionType");

    let types = schema
        .get("types")
        .and_then(Value::as_array)
        .map(|types| {
            types
                .iter()
                .filter(|raw| !is_introspection_type(raw))
                .map(parse_named_type)
                .collect()
        })
        .unwrap_or_default();

    let directives = array_field(schema, "directives", parse_directive);

    Ok(GraphqlSchema {
        query_type,
        mutation_type,
        subscription_type,
        types,
        directives,
    })
}

fn root_type_name(schema: &Value, field: &str) -> Option<String> {
    schema
        .get(field)
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Tipos de introspection (`__Type`, `__Schema`, ...) são detalhe de
/// implementação do protocolo, não algo útil para o usuário explorar.
fn is_introspection_type(raw: &Value) -> bool {
    raw.get("name")
        .and_then(Value::as_str)
        .map(|name| name.starts_with("__"))
        .unwrap_or(false)
}

fn parse_named_type(raw: &Value) -> GraphqlNamedType {
    GraphqlNamedType {
        name: string_field(raw, "name"),
        kind: parse_kind(raw.get("kind").and_then(Value::as_str)),
        description: optional_string_field(raw, "description"),
        fields: array_field(raw, "fields", parse_field),
        input_fields: array_field(raw, "inputFields", parse_input_value),
        enum_values: array_field(raw, "enumValues", parse_enum_value),
        interfaces: array_field(raw, "interfaces", type_ref_name),
        possible_types: array_field(raw, "possibleTypes", type_ref_name),
    }
}

fn type_ref_name(raw: &Value) -> String {
    describe_type_ref(raw).1.unwrap_or_default()
}

fn parse_kind(raw: Option<&str>) -> GraphqlTypeKind {
    match raw {
        Some("SCALAR") => GraphqlTypeKind::Scalar,
        Some("OBJECT") => GraphqlTypeKind::Object,
        Some("INTERFACE") => GraphqlTypeKind::Interface,
        Some("UNION") => GraphqlTypeKind::Union,
        Some("ENUM") => GraphqlTypeKind::Enum,
        Some("INPUT_OBJECT") => GraphqlTypeKind::InputObject,
        Some(other) => GraphqlTypeKind::Other(other.to_string()),
        None => GraphqlTypeKind::Other("UNKNOWN".to_string()),
    }
}

fn parse_field(raw: &Value) -> GraphqlField {
    let (type_display, type_name) = type_ref_field(raw);
    GraphqlField {
        name: string_field(raw, "name"),
        description: optional_string_field(raw, "description"),
        args: array_field(raw, "args", parse_input_value),
        type_display,
        type_name,
        is_deprecated: bool_field(raw, "isDeprecated"),
        deprecation_reason: optional_string_field(raw, "deprecationReason"),
    }
}

fn parse_input_value(raw: &Value) -> GraphqlInputValue {
    let (type_display, type_name) = type_ref_field(raw);
    GraphqlInputValue {
        name: string_field(raw, "name"),
        description: optional_string_field(raw, "description"),
        type_display,
        type_name,
        default_value: optional_string_field(raw, "defaultValue"),
    }
}

fn parse_enum_value(raw: &Value) -> GraphqlEnumValue {
    GraphqlEnumValue {
        name: string_field(raw, "name"),
        description: optional_string_field(raw, "description"),
        is_deprecated: bool_field(raw, "isDeprecated"),
        deprecation_reason: optional_string_field(raw, "deprecationReason"),
    }
}

fn parse_directive(raw: &Value) -> GraphqlDirective {
    let locations = raw
        .get("locations")
        .and_then(Value::as_array)
        .map(|locations| {
            locations
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    GraphqlDirective {
        name: string_field(raw, "name"),
        description: optional_string_field(raw, "description"),
        locations,
        args: array_field(raw, "args", parse_input_value),
    }
}

fn type_ref_field(raw: &Value) -> (String, Option<String>) {
    raw.get("type")
        .map(describe_type_ref)
        .unwrap_or_else(|| ("Unknown".to_string(), None))
}

/// Achata a árvore recursiva `NON_NULL`/`LIST`/tipo nomeado da introspection
/// numa string de exibição (ex.: `"[Customer!]!"`) e no nome do tipo
/// nomeado no fundo da árvore (para navegação na UI).
fn describe_type_ref(value: &Value) -> (String, Option<String>) {
    match value.get("kind").and_then(Value::as_str) {
        Some("NON_NULL") => {
            let (display, name) = value
                .get("ofType")
                .map(describe_type_ref)
                .unwrap_or_else(|| ("Unknown".to_string(), None));
            (format!("{display}!"), name)
        }
        Some("LIST") => {
            let (display, name) = value
                .get("ofType")
                .map(describe_type_ref)
                .unwrap_or_else(|| ("Unknown".to_string(), None));
            (format!("[{display}]"), name)
        }
        _ => {
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
            (name.clone().unwrap_or_else(|| "Unknown".to_string()), name)
        }
    }
}

fn string_field(raw: &Value, field: &str) -> String {
    raw.get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional_string_field(raw: &Value, field: &str) -> Option<String> {
    raw.get(field).and_then(Value::as_str).map(str::to_string)
}

fn bool_field(raw: &Value, field: &str) -> bool {
    raw.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn array_field<T>(raw: &Value, field: &str, parse_item: impl Fn(&Value) -> T) -> Vec<T> {
    raw.get(field)
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse_item).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_minimal_schema_with_a_wrapped_field_type() {
        let body = r#"{
            "data": {
                "__schema": {
                    "queryType": {"name": "Query"},
                    "mutationType": null,
                    "subscriptionType": null,
                    "types": [
                        {
                            "kind": "OBJECT",
                            "name": "Query",
                            "description": "Raiz de consultas",
                            "fields": [
                                {
                                    "name": "ping",
                                    "description": "Verifica disponibilidade",
                                    "isDeprecated": false,
                                    "deprecationReason": null,
                                    "args": [],
                                    "type": {
                                        "kind": "NON_NULL",
                                        "name": null,
                                        "ofType": {"kind": "SCALAR", "name": "Boolean", "ofType": null}
                                    }
                                }
                            ],
                            "inputFields": [],
                            "interfaces": [],
                            "possibleTypes": [],
                            "enumValues": []
                        },
                        {
                            "kind": "SCALAR",
                            "name": "Boolean",
                            "description": null,
                            "fields": null,
                            "inputFields": null,
                            "interfaces": null,
                            "possibleTypes": null,
                            "enumValues": null
                        },
                        {
                            "kind": "OBJECT",
                            "name": "__Type",
                            "description": null,
                            "fields": null,
                            "inputFields": null,
                            "interfaces": null,
                            "possibleTypes": null,
                            "enumValues": null
                        }
                    ],
                    "directives": []
                }
            }
        }"#;

        let schema = parse_schema(body).unwrap();

        assert_eq!(schema.query_type, Some("Query".to_string()));
        assert_eq!(schema.mutation_type, None);
        assert_eq!(
            schema
                .types
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Query", "Boolean"]
        );

        let query = schema.types.iter().find(|t| t.name == "Query").unwrap();
        assert_eq!(query.kind, GraphqlTypeKind::Object);
        assert_eq!(query.description.as_deref(), Some("Raiz de consultas"));
        assert_eq!(query.fields.len(), 1);
        assert_eq!(query.fields[0].name, "ping");
        assert_eq!(query.fields[0].type_display, "Boolean!");
        assert_eq!(query.fields[0].type_name, Some("Boolean".to_string()));
        assert!(!query.fields[0].is_deprecated);
    }

    #[test]
    fn parses_deprecated_fields_default_values_interfaces_and_directives() {
        let body = r#"{
            "data": {
                "__schema": {
                    "queryType": {"name": "Query"},
                    "mutationType": null,
                    "subscriptionType": null,
                    "types": [
                        {
                            "kind": "OBJECT",
                            "name": "Query",
                            "description": null,
                            "fields": [
                                {
                                    "name": "legacyPing",
                                    "description": null,
                                    "isDeprecated": true,
                                    "deprecationReason": "Use ping instead",
                                    "args": [
                                        {
                                            "name": "limit",
                                            "description": null,
                                            "type": {"kind": "SCALAR", "name": "Int", "ofType": null},
                                            "defaultValue": "10"
                                        }
                                    ],
                                    "type": {"kind": "SCALAR", "name": "Boolean", "ofType": null}
                                }
                            ],
                            "inputFields": [],
                            "interfaces": [{"kind": "INTERFACE", "name": "Node", "ofType": null}],
                            "possibleTypes": [],
                            "enumValues": []
                        },
                        {
                            "kind": "INTERFACE",
                            "name": "Node",
                            "description": null,
                            "fields": [],
                            "inputFields": [],
                            "interfaces": [],
                            "possibleTypes": [{"kind": "OBJECT", "name": "Query", "ofType": null}],
                            "enumValues": []
                        }
                    ],
                    "directives": [
                        {
                            "name": "cacheControl",
                            "description": "Define cache",
                            "locations": ["FIELD", "OBJECT"],
                            "args": [
                                {
                                    "name": "maxAge",
                                    "description": null,
                                    "type": {"kind": "SCALAR", "name": "Int", "ofType": null},
                                    "defaultValue": null
                                }
                            ]
                        }
                    ]
                }
            }
        }"#;

        let schema = parse_schema(body).unwrap();

        let query = schema.types.iter().find(|t| t.name == "Query").unwrap();
        assert!(query.fields[0].is_deprecated);
        assert_eq!(
            query.fields[0].deprecation_reason.as_deref(),
            Some("Use ping instead")
        );
        assert_eq!(query.fields[0].args[0].default_value.as_deref(), Some("10"));
        assert_eq!(query.interfaces, vec!["Node".to_string()]);

        let node = schema.types.iter().find(|t| t.name == "Node").unwrap();
        assert_eq!(node.possible_types, vec!["Query".to_string()]);

        assert_eq!(schema.directives.len(), 1);
        assert_eq!(schema.directives[0].name, "cacheControl");
        assert_eq!(
            schema.directives[0].locations,
            vec!["FIELD".to_string(), "OBJECT".to_string()]
        );
        assert_eq!(schema.directives[0].args[0].name, "maxAge");
    }

    #[test]
    fn describes_a_list_of_non_null_named_type() {
        let value: Value = serde_json::from_str(
            r#"{
                "kind": "NON_NULL",
                "name": null,
                "ofType": {
                    "kind": "LIST",
                    "name": null,
                    "ofType": {
                        "kind": "NON_NULL",
                        "name": null,
                        "ofType": {"kind": "OBJECT", "name": "Customer", "ofType": null}
                    }
                }
            }"#,
        )
        .unwrap();

        assert_eq!(
            describe_type_ref(&value),
            ("[Customer!]!".to_string(), Some("Customer".to_string()))
        );
    }

    #[test]
    fn fails_with_invalid_response_for_a_non_json_body() {
        let error = parse_schema("not json").unwrap_err();

        assert!(matches!(error, SchemaError::InvalidJson(_)));
    }

    #[test]
    fn fails_with_invalid_response_when_schema_is_missing() {
        let error = parse_schema(r#"{"data": {}}"#).unwrap_err();

        assert_eq!(error, SchemaError::MissingSchema);
    }

    #[test]
    fn fails_with_graphql_error_when_introspection_is_disabled() {
        let body = r#"{"data": null, "errors": [{"message": "Introspection is disabled"}]}"#;

        let error = parse_schema(body).unwrap_err();

        assert_eq!(
            error,
            SchemaError::GraphqlError("Introspection is disabled".to_string())
        );
    }
}
