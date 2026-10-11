//! Documentação importada de coleções externas (ADR 0035). Esses formatos
//! não têm schemas — só descrições da requisição e de cada parâmetro. Uma
//! requisição só ganha documentação quando alguma descrição existe; aí todos
//! os seus parâmetros (inclusive os desabilitados, que representam
//! parâmetros possíveis) entram, para servir às sugestões.

use std::collections::BTreeMap;

use alcy_domain::{
    ApiDocsSource, ApiDocsSourceKind, DocsRef, ParameterDoc, ParameterLocation, RequestDocs,
    SavedRequest,
};
use serde_json::Value;

/// Nomes dos campos de parâmetro, que variam entre os formatos.
pub(crate) struct ParameterFields<'a> {
    pub query: Option<&'a Value>,
    pub headers: Option<&'a Value>,
    pub path: Option<&'a Value>,
    pub name_key: &'a str,
}

pub(crate) struct DocsCollector {
    kind: ApiDocsSourceKind,
    operations: BTreeMap<String, RequestDocs>,
}

impl DocsCollector {
    pub fn new(kind: ApiDocsSourceKind) -> Self {
        Self {
            kind,
            operations: BTreeMap::new(),
        }
    }

    /// Guarda a documentação de `saved` (chave = id gerado da requisição,
    /// determinístico para o mesmo conteúdo) e a referencia nela.
    pub fn attach(
        &mut self,
        saved: SavedRequest,
        description: Option<&Value>,
        fields: ParameterFields,
    ) -> SavedRequest {
        let docs = request_docs(description, fields);
        let has_description = !docs.description.is_empty()
            || docs
                .parameters
                .iter()
                .any(|parameter| !parameter.description.is_empty());
        if !has_description {
            return saved;
        }
        let operation_id = saved.id.clone();
        self.operations.insert(operation_id.clone(), docs);
        saved.with_docs_ref(DocsRef {
            source_id: String::new(),
            operation_id,
        })
    }

    pub fn finish(self, title: &str) -> Option<ApiDocsSource> {
        if self.operations.is_empty() {
            return None;
        }
        Some(ApiDocsSource {
            title: title.to_string(),
            kind: self.kind,
            schemas: BTreeMap::new(),
            operations: self.operations,
        })
    }
}

/// Descrição como texto: string simples ou `{ "content": "..." }` (Postman).
pub(crate) fn description_text(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => text.as_str(),
        Some(object) => object
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        None => "",
    };
    text.trim().to_string()
}

fn request_docs(description: Option<&Value>, fields: ParameterFields) -> RequestDocs {
    let mut parameters = Vec::new();
    for (values, location) in [
        (fields.path, ParameterLocation::Path),
        (fields.query, ParameterLocation::Query),
        (fields.headers, ParameterLocation::Header),
    ] {
        for value in values.and_then(Value::as_array).into_iter().flatten() {
            let Some(name) = value
                .get(fields.name_key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            let example = value
                .get("value")
                .and_then(Value::as_str)
                .filter(|example| !example.is_empty())
                .map(|example| Value::String(example.to_string()).to_string());
            parameters.push(ParameterDoc {
                name: name.to_string(),
                location,
                required: location == ParameterLocation::Path,
                deprecated: false,
                description: description_text(value.get("description")),
                schema: None,
                example,
            });
        }
    }

    RequestDocs {
        description: description_text(description),
        parameters,
        ..RequestDocs::default()
    }
}
