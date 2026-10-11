//! Documento OpenAPI → documentação importada (`ApiDocsSource`, ADR 0035):
//! descrição, parâmetros (de todos os `in`), corpo, respostas e schemas de
//! cada operação. Schemas em `#/components/schemas/*` viram referências por
//! nome (`SchemaNode::ref_name`); só os alcançáveis a partir de alguma
//! operação entram na fonte.

use std::collections::{BTreeMap, HashMap, HashSet};

use alcy_domain::{
    ApiDocsSource, ApiDocsSourceKind, BodyDoc, MediaDoc, ParameterDoc, ParameterLocation,
    RequestDocs, ResponseDoc, SchemaNode, reachable_schemas,
};
use serde_json::Value;

use crate::document::{
    Components, MediaType, Operation, Parameter, resolve_request_body, resolve_response,
};

const SCHEMA_REF_PREFIX: &str = "#/components/schemas/";
/// Proteção contra schemas inline absurdamente profundos (âncoras YAML).
const MAX_SCHEMA_DEPTH: usize = 64;

/// Acumula a documentação das operações enquanto `mapping.rs` percorre o
/// documento, garantindo uma chave única por operação.
pub(crate) struct DocsBuilder<'a> {
    components: &'a Components,
    operations: BTreeMap<String, RequestDocs>,
    used_keys: HashSet<String>,
}

impl<'a> DocsBuilder<'a> {
    pub fn new(components: &'a Components) -> Self {
        Self {
            components,
            operations: BTreeMap::new(),
            used_keys: HashSet::new(),
        }
    }

    /// Registra a documentação de uma operação e devolve a chave dela na
    /// fonte — `operationId`, senão `"{MÉTODO} {path}"`. `None` quando a
    /// operação não tem nada a documentar.
    pub fn add_operation(
        &mut self,
        method_name: &str,
        path: &str,
        operation: &Operation,
        parameters: &HashMap<(String, String), Parameter>,
    ) -> Option<String> {
        let docs = self.operation_docs(operation, parameters);
        if docs.is_empty() {
            return None;
        }
        let key = self.unique_key(method_name, path, operation);
        self.operations.insert(key.clone(), docs);
        Some(key)
    }

    pub fn finish(self, title: &str) -> ApiDocsSource {
        let all_schemas: BTreeMap<String, SchemaNode> = self
            .components
            .schemas
            .iter()
            .map(|(name, value)| (name.clone(), schema_node(value, 0)))
            .collect();
        let mut roots = Vec::new();
        for docs in self.operations.values() {
            docs.collect_refs(&mut roots);
        }
        ApiDocsSource {
            title: title.to_string(),
            kind: ApiDocsSourceKind::OpenApi,
            schemas: reachable_schemas(&all_schemas, roots, usize::MAX),
            operations: self.operations,
        }
    }

    fn unique_key(&mut self, method_name: &str, path: &str, operation: &Operation) -> String {
        let fallback = format!("{} {path}", method_name.to_uppercase());
        let candidate = operation
            .operation_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| fallback.clone());
        // `operationId` repetido é inválido, mas acontece em documentos reais.
        for attempt in [candidate, fallback.clone()] {
            if self.used_keys.insert(attempt.clone()) {
                return attempt;
            }
        }
        let mut index = 2;
        loop {
            let attempt = format!("{fallback} ({index})");
            if self.used_keys.insert(attempt.clone()) {
                return attempt;
            }
            index += 1;
        }
    }

    fn operation_docs(
        &self,
        operation: &Operation,
        parameters: &HashMap<(String, String), Parameter>,
    ) -> RequestDocs {
        let mut parameter_docs: Vec<ParameterDoc> =
            parameters.values().filter_map(parameter_doc).collect();
        parameter_docs.sort_by(|a, b| {
            a.location
                .cmp(&b.location)
                .then_with(|| a.name.cmp(&b.name))
        });

        let request_body = operation
            .request_body
            .as_ref()
            .and_then(|body| resolve_request_body(self.components, body))
            .map(|body| BodyDoc {
                description: trimmed(body.description.as_deref()),
                required: body.required,
                content: media_docs(&body.content),
            });

        let responses = operation
            .responses
            .iter()
            .filter_map(|(status, response)| {
                resolve_response(self.components, response).map(|response| ResponseDoc {
                    status: status.clone(),
                    description: trimmed(response.description.as_deref()),
                    content: media_docs(&response.content),
                })
            })
            .collect();

        RequestDocs {
            summary: trimmed(operation.summary.as_deref()),
            description: trimmed(operation.description.as_deref()),
            deprecated: operation.deprecated,
            parameters: parameter_docs,
            request_body,
            responses,
        }
    }
}

fn trimmed(value: Option<&str>) -> String {
    value.map(str::trim).unwrap_or_default().to_string()
}

fn parameter_doc(parameter: &Parameter) -> Option<ParameterDoc> {
    let location = match parameter.location.as_str() {
        "path" => ParameterLocation::Path,
        "query" => ParameterLocation::Query,
        "header" => ParameterLocation::Header,
        "cookie" => ParameterLocation::Cookie,
        _ => return None,
    };
    Some(ParameterDoc {
        name: parameter.name.clone(),
        location,
        // Parâmetro de path é sempre obrigatório (regra do OpenAPI).
        required: parameter.required || location == ParameterLocation::Path,
        deprecated: parameter.deprecated,
        description: trimmed(parameter.description.as_deref()),
        schema: parameter
            .schema
            .as_ref()
            .map(|schema| schema_node(schema, 0)),
        example: parameter.example.as_ref().map(json_text),
    })
}

fn media_docs(content: &BTreeMap<String, MediaType>) -> Vec<MediaDoc> {
    content
        .iter()
        .map(|(media_type, media)| MediaDoc {
            media_type: media_type.clone(),
            schema: media.schema.as_ref().map(|schema| schema_node(schema, 0)),
            example: media
                .example_value()
                .map(|value| serde_json::to_string_pretty(value).unwrap_or_default()),
        })
        .collect()
}

fn json_text(value: &Value) -> String {
    value.to_string()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn schema_list(value: &Value, key: &str, depth: usize) -> Vec<SchemaNode> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| schema_node(item, depth + 1))
                .collect()
        })
        .unwrap_or_default()
}

/// Normaliza um schema cru (OpenAPI 3.0 ou 3.1) para `SchemaNode`.
pub(crate) fn schema_node(value: &Value, depth: usize) -> SchemaNode {
    if depth > MAX_SCHEMA_DEPTH || !value.is_object() {
        return SchemaNode::default();
    }

    let mut node = SchemaNode {
        description: string_field(value, "description").unwrap_or_default(),
        ..SchemaNode::default()
    };

    if let Some(reference) = value.get("$ref").and_then(Value::as_str) {
        // Refs externos ou para outros pontos do documento ficam com o texto
        // cru — aparecem como referência não resolvida.
        let name = reference
            .strip_prefix(SCHEMA_REF_PREFIX)
            .unwrap_or(reference);
        node.ref_name = Some(name.to_string());
        return node;
    }

    match value.get("type") {
        Some(Value::String(kind)) => node.types.push(kind.clone()),
        Some(Value::Array(kinds)) => {
            for kind in kinds.iter().filter_map(Value::as_str) {
                if kind == "null" {
                    node.nullable = true;
                } else {
                    node.types.push(kind.to_string());
                }
            }
        }
        _ => {}
    }
    node.nullable |= bool_field(value, "nullable");
    node.format = string_field(value, "format");
    node.title = string_field(value, "title");
    node.deprecated = bool_field(value, "deprecated");
    node.read_only = bool_field(value, "readOnly");
    node.write_only = bool_field(value, "writeOnly");

    if let Some(values) = value.get("enum").and_then(Value::as_array) {
        node.enum_values = values.iter().map(json_text).collect();
    } else if let Some(constant) = value.get("const") {
        node.enum_values = vec![json_text(constant)];
    }
    node.default = value.get("default").map(json_text);
    node.example = value.get("example").map(json_text).or_else(|| {
        value
            .get("examples")
            .and_then(Value::as_array)
            .and_then(|examples| examples.first())
            .map(json_text)
    });

    if let Some(properties) = value.get("properties").and_then(Value::as_object) {
        node.properties = properties
            .iter()
            .map(|(name, schema)| (name.clone(), schema_node(schema, depth + 1)))
            .collect();
    }
    if let Some(required) = value.get("required").and_then(Value::as_array) {
        node.required = required
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(items) = value.get("items").filter(|items| items.is_object()) {
        node.items = Some(Box::new(schema_node(items, depth + 1)));
    }
    if let Some(additional) = value
        .get("additionalProperties")
        .filter(|additional| additional.is_object())
    {
        node.additional_properties = Some(Box::new(schema_node(additional, depth + 1)));
    }
    node.all_of = schema_list(value, "allOf", depth);
    node.one_of = schema_list(value, "oneOf", depth);
    node.any_of = schema_list(value, "anyOf", depth);

    // Sem `type` explícito mas com propriedades: é um objeto.
    if node.types.is_empty() && !node.properties.is_empty() {
        node.types.push("object".to_string());
    }

    node
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_an_openapi_3_0_schema() {
        let node = schema_node(
            &json!({
                "type": "object",
                "description": " Um pet ",
                "required": ["name"],
                "properties": {
                    "name": {"type": "string", "example": "Rex"},
                    "status": {"type": "string", "enum": ["available", "sold"], "default": "available"},
                    "tags": {"type": "array", "items": {"$ref": "#/components/schemas/Tag"}},
                    "age": {"type": "integer", "format": "int32", "nullable": true, "readOnly": true}
                }
            }),
            0,
        );

        assert_eq!(node.types, vec!["object"]);
        assert_eq!(node.description, "Um pet");
        assert_eq!(node.required, vec!["name"]);
        let property = |name: &str| {
            node.properties
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, schema)| schema.clone())
                .unwrap()
        };
        assert_eq!(property("name").example.as_deref(), Some("\"Rex\""));
        assert_eq!(
            property("status").enum_values,
            vec!["\"available\"", "\"sold\""]
        );
        assert_eq!(property("status").default.as_deref(), Some("\"available\""));
        assert_eq!(
            property("tags").items.unwrap().ref_name.as_deref(),
            Some("Tag")
        );
        let age = property("age");
        assert!(age.nullable && age.read_only);
        assert_eq!(age.format.as_deref(), Some("int32"));
    }

    #[test]
    fn normalizes_openapi_3_1_type_arrays_const_and_examples() {
        let node = schema_node(
            &json!({"type": ["string", "null"], "const": "fixed", "examples": ["a", "b"]}),
            0,
        );

        assert_eq!(node.types, vec!["string"]);
        assert!(node.nullable);
        assert_eq!(node.enum_values, vec!["\"fixed\""]);
        assert_eq!(node.example.as_deref(), Some("\"a\""));
    }

    #[test]
    fn keeps_composition_and_additional_properties() {
        let node = schema_node(
            &json!({
                "allOf": [{"$ref": "#/components/schemas/Base"}],
                "oneOf": [{"type": "string"}, {"type": "integer"}],
                "additionalProperties": {"type": "number"}
            }),
            0,
        );

        assert_eq!(node.all_of[0].ref_name.as_deref(), Some("Base"));
        assert_eq!(node.one_of.len(), 2);
        assert_eq!(
            node.additional_properties.unwrap().types,
            vec!["number".to_string()]
        );
    }

    #[test]
    fn external_references_keep_the_raw_reference() {
        let node = schema_node(&json!({"$ref": "common.yaml#/Pet"}), 0);
        assert_eq!(node.ref_name.as_deref(), Some("common.yaml#/Pet"));
    }

    #[test]
    fn infers_object_type_from_properties() {
        let node = schema_node(&json!({"properties": {"id": {"type": "string"}}}), 0);
        assert_eq!(node.types, vec!["object"]);
    }
}
