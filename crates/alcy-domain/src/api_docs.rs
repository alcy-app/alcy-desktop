//! Documentação de API importada (ADR 0035): o que um documento externo
//! (OpenAPI, coleções de outras ferramentas) diz sobre cada chamada —
//! descrição, parâmetros possíveis, corpo, respostas e schemas. Genérico:
//! um subconjunto de JSON Schema, sem conceitos de um protocolo específico.
//!
//! Valores de exemplo, default e enum são guardados como texto JSON literal
//! (ex. `"available"`, `10`, `true`) — o domínio não depende de `serde_json`
//! e quem exibe/sugere só precisa do texto.

use std::collections::{BTreeMap, HashSet};

use crate::collection::{Collection, Folder, SavedRequest};
use crate::flow::{Flow, FlowNodeKind};

/// Aponta, a partir de uma requisição salva, para a documentação de uma
/// operação dentro de uma fonte do workspace. Não usa o id da requisição,
/// então sobrevive a duplicar, mover ou reimportar a requisição.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DocsRef {
    pub source_id: String,
    pub operation_id: String,
}

/// De onde veio uma fonte de documentação.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiDocsSourceKind {
    OpenApi,
    Postman,
    Insomnia,
    Bruno,
}

/// Documentação produzida por uma importação: schemas nomeados
/// compartilhados entre operações e a documentação de cada operação.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiDocsSource {
    pub title: String,
    pub kind: ApiDocsSourceKind,
    pub schemas: BTreeMap<String, SchemaNode>,
    pub operations: BTreeMap<String, RequestDocs>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestDocs {
    pub summary: String,
    pub description: String,
    pub deprecated: bool,
    pub parameters: Vec<ParameterDoc>,
    pub request_body: Option<BodyDoc>,
    pub responses: Vec<ResponseDoc>,
}

impl RequestDocs {
    /// Sem nenhuma informação útil — não vale a pena guardar.
    pub fn is_empty(&self) -> bool {
        self.summary.is_empty()
            && self.description.is_empty()
            && !self.deprecated
            && self.parameters.is_empty()
            && self.request_body.is_none()
            && self.responses.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ParameterLocation {
    Path,
    Query,
    Header,
    Cookie,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParameterDoc {
    pub name: String,
    pub location: ParameterLocation,
    pub required: bool,
    pub deprecated: bool,
    pub description: String,
    pub schema: Option<SchemaNode>,
    pub example: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BodyDoc {
    pub description: String,
    pub required: bool,
    pub content: Vec<MediaDoc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaDoc {
    pub media_type: String,
    pub schema: Option<SchemaNode>,
    pub example: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseDoc {
    /// Código (`200`), faixa (`2XX`) ou `default`.
    pub status: String,
    pub description: String,
    pub content: Vec<MediaDoc>,
}

/// Nó de schema no formato JSON Schema simplificado. Uma referência a um
/// schema nomeado (`ref_name`) não é expandida aqui — quem lê resolve pelo
/// mapa `ApiDocsSource::schemas`, o que mantém estruturas recursivas finitas.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SchemaNode {
    pub ref_name: Option<String>,
    /// `string`, `integer`, `object`… — mais de um no OpenAPI 3.1.
    pub types: Vec<String>,
    pub format: Option<String>,
    pub title: Option<String>,
    pub description: String,
    pub nullable: bool,
    pub deprecated: bool,
    pub read_only: bool,
    pub write_only: bool,
    pub enum_values: Vec<String>,
    pub default: Option<String>,
    pub example: Option<String>,
    pub properties: Vec<(String, SchemaNode)>,
    pub required: Vec<String>,
    pub items: Option<Box<SchemaNode>>,
    pub additional_properties: Option<Box<SchemaNode>>,
    pub all_of: Vec<SchemaNode>,
    pub one_of: Vec<SchemaNode>,
    pub any_of: Vec<SchemaNode>,
}

impl SchemaNode {
    pub fn reference(name: impl Into<String>) -> Self {
        Self {
            ref_name: Some(name.into()),
            ..Self::default()
        }
    }

    /// Nomes de schema referenciados diretamente por este nó ou por seus
    /// filhos (sem seguir as referências).
    pub fn collect_refs(&self, into: &mut Vec<String>) {
        if let Some(name) = &self.ref_name {
            into.push(name.clone());
        }
        for (_, child) in &self.properties {
            child.collect_refs(into);
        }
        for child in self.items.iter().chain(self.additional_properties.iter()) {
            child.collect_refs(into);
        }
        for child in self.all_of.iter().chain(&self.one_of).chain(&self.any_of) {
            child.collect_refs(into);
        }
    }
}

impl RequestDocs {
    /// Nomes de schema referenciados diretamente pela operação.
    pub fn collect_refs(&self, into: &mut Vec<String>) {
        for parameter in &self.parameters {
            if let Some(schema) = &parameter.schema {
                schema.collect_refs(into);
            }
        }
        let media = self
            .request_body
            .iter()
            .flat_map(|body| &body.content)
            .chain(self.responses.iter().flat_map(|response| &response.content));
        for media in media {
            if let Some(schema) = &media.schema {
                schema.collect_refs(into);
            }
        }
    }
}

/// Schemas nomeados alcançáveis a partir de `roots`, seguindo referências
/// transitivamente (ciclos são visitados uma vez só). Para em `limit`
/// schemas para que um documento patológico não gere uma resposta enorme.
pub fn reachable_schemas(
    schemas: &BTreeMap<String, SchemaNode>,
    roots: Vec<String>,
    limit: usize,
) -> BTreeMap<String, SchemaNode> {
    let mut reached = BTreeMap::new();
    let mut pending = roots;
    while let Some(name) = pending.pop() {
        if reached.len() >= limit {
            break;
        }
        if reached.contains_key(&name) {
            continue;
        }
        if let Some(schema) = schemas.get(&name) {
            schema.collect_refs(&mut pending);
            reached.insert(name, schema.clone());
        }
    }
    reached
}

/// Fontes de documentação ainda referenciadas por alguma requisição —
/// de coleção ou avulsa dentro de um flow. As demais são órfãs.
pub fn referenced_docs_sources(collections: &[Collection], flows: &[Flow]) -> HashSet<String> {
    fn add(requests: &[SavedRequest], into: &mut HashSet<String>) {
        for request in requests {
            if let Some(docs_ref) = &request.docs_ref {
                into.insert(docs_ref.source_id.clone());
            }
        }
    }
    fn add_folder(folder: &Folder, into: &mut HashSet<String>) {
        add(folder.requests(), into);
        for child in folder.folders() {
            add_folder(child, into);
        }
    }

    let mut referenced = HashSet::new();
    for collection in collections {
        add(collection.requests(), &mut referenced);
        for folder in collection.folders() {
            add_folder(folder, &mut referenced);
        }
    }
    for flow in flows {
        for node in flow.nodes() {
            if let FlowNodeKind::InlineRequest { request } = &node.kind {
                add(std::slice::from_ref(request.as_ref()), &mut referenced);
            }
        }
    }
    referenced
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Authentication, Endpoint, FlowNode, FlowPosition, ProtocolId, Request, RequestDocument,
    };

    fn object(properties: Vec<(&str, SchemaNode)>) -> SchemaNode {
        SchemaNode {
            types: vec!["object".into()],
            properties: properties
                .into_iter()
                .map(|(name, node)| (name.to_string(), node))
                .collect(),
            ..SchemaNode::default()
        }
    }

    #[test]
    fn reachable_schemas_follows_references_transitively_and_survives_cycles() {
        let mut schemas = BTreeMap::new();
        schemas.insert(
            "Pet".to_string(),
            object(vec![
                ("owner", SchemaNode::reference("Person")),
                ("parent", SchemaNode::reference("Pet")),
            ]),
        );
        schemas.insert(
            "Person".to_string(),
            object(vec![(
                "pets",
                SchemaNode {
                    items: Some(Box::new(SchemaNode::reference("Pet"))),
                    ..SchemaNode::default()
                },
            )]),
        );
        schemas.insert("Unused".to_string(), object(vec![]));

        let reached = reachable_schemas(&schemas, vec!["Pet".into()], 100);

        assert_eq!(
            reached.keys().cloned().collect::<Vec<_>>(),
            vec!["Person".to_string(), "Pet".to_string()]
        );
    }

    #[test]
    fn reachable_schemas_respects_the_limit() {
        let mut schemas = BTreeMap::new();
        schemas.insert(
            "A".to_string(),
            object(vec![("b", SchemaNode::reference("B"))]),
        );
        schemas.insert("B".to_string(), object(vec![]));

        assert_eq!(reachable_schemas(&schemas, vec!["A".into()], 1).len(), 1);
    }

    #[test]
    fn unknown_references_are_ignored() {
        let reached = reachable_schemas(&BTreeMap::new(), vec!["Missing".into()], 10);
        assert!(reached.is_empty());
    }

    #[test]
    fn request_docs_collects_references_from_parameters_body_and_responses() {
        let media = |name: &str| MediaDoc {
            media_type: "application/json".into(),
            schema: Some(SchemaNode::reference(name)),
            example: None,
        };
        let docs = RequestDocs {
            parameters: vec![ParameterDoc {
                name: "status".into(),
                location: ParameterLocation::Query,
                required: false,
                deprecated: false,
                description: String::new(),
                schema: Some(SchemaNode::reference("Status")),
                example: None,
            }],
            request_body: Some(BodyDoc {
                content: vec![media("NewPet")],
                ..BodyDoc::default()
            }),
            responses: vec![ResponseDoc {
                status: "200".into(),
                description: String::new(),
                content: vec![media("Pet")],
            }],
            ..RequestDocs::default()
        };

        let mut refs = Vec::new();
        docs.collect_refs(&mut refs);

        assert_eq!(refs, vec!["Status", "NewPet", "Pet"]);
    }

    #[test]
    fn empty_request_docs_are_detected() {
        assert!(RequestDocs::default().is_empty());
        assert!(
            !RequestDocs {
                description: "Lista".into(),
                ..RequestDocs::default()
            }
            .is_empty()
        );
    }

    fn documented(id: &str, source_id: &str) -> SavedRequest {
        let request = Request::new(
            Endpoint::new("https://example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        );
        SavedRequest::new(id, id, request)
            .unwrap()
            .with_docs_ref(DocsRef {
                source_id: source_id.into(),
                operation_id: "op".into(),
            })
    }

    #[test]
    fn referenced_sources_come_from_nested_collection_requests_and_inline_flow_requests() {
        let nested = Folder::new("f2", "Inner", vec![], vec![documented("r2", "b")]).unwrap();
        let folder = Folder::new("f1", "Outer", vec![nested], vec![]).unwrap();
        let collection =
            Collection::new("c1", "API", vec![folder], vec![documented("r1", "a")]).unwrap();
        let flow = Flow::new(
            "flow-1",
            "Flow",
            vec![FlowNode {
                id: "n1".into(),
                kind: FlowNodeKind::InlineRequest {
                    request: Box::new(documented("r3", "c")),
                },
                position: FlowPosition { x: 0.0, y: 0.0 },
            }],
            vec![],
            std::time::SystemTime::UNIX_EPOCH,
            std::time::SystemTime::UNIX_EPOCH,
        )
        .unwrap();

        let referenced = referenced_docs_sources(&[collection], &[flow]);

        assert_eq!(
            referenced,
            HashSet::from(["a".to_string(), "b".to_string(), "c".to_string()])
        );
    }
}
