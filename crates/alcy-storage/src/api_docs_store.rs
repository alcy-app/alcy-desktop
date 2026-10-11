use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use alcy_domain::{
    API_DOCS_FILE, ApiDocsSource, ApiDocsSourceKind, BodyDoc, DocsRef, MediaDoc, ParameterDoc,
    ParameterLocation, RequestDocs, ResponseDoc, SchemaNode, reachable_schemas,
};
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;
/// Teto de schemas nomeados devolvidos junto de uma operação — protege a
/// fronteira IPC de documentos patológicos (invariante 8).
const MAX_SCHEMAS_PER_OPERATION: usize = 2000;
/// Tamanho do prefixo hexadecimal do SHA-256 usado como id da fonte.
const SOURCE_ID_LENGTH: usize = 16;

/// Documentação de uma operação pronta para exibir: a operação e os schemas
/// nomeados que ela alcança.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationDocs {
    pub source_title: String,
    pub source_kind: ApiDocsSourceKind,
    pub docs: RequestDocs,
    pub schemas: BTreeMap<String, SchemaNode>,
}

type Sources = BTreeMap<String, ApiDocsSource>;

struct CachedFile {
    path: PathBuf,
    stamp: Option<(SystemTime, u64)>,
    sources: Arc<Sources>,
}

/// Lê e grava a documentação importada de um workspace (`alcy-api-docs.json`,
/// ADR 0035), um arquivo canônico e versionado como as coleções.
///
/// O arquivo pode ter vários MB (schemas de APIs grandes), então o conteúdo
/// interpretado fica em cache, revalidado pela data de modificação e pelo
/// tamanho: uma escrita externa (ex.: pull do controle de versão) invalida
/// sozinha. `Clone` compartilha o mesmo cache.
#[derive(Clone, Default)]
pub struct ApiDocsStore {
    cache: Arc<Mutex<Option<CachedFile>>>,
}

impl ApiDocsStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Grava `source` no workspace e devolve seu id — derivado do conteúdo,
    /// então importar de novo o mesmo documento reaproveita a mesma fonte.
    pub fn upsert_source(
        &self,
        root: &Path,
        source: ApiDocsSource,
    ) -> Result<String, StorageError> {
        let persisted = persisted_from_source(&source);
        let id = source_id(&persisted)?;
        let current = self.load(root)?;
        if current.contains_key(&id) {
            return Ok(id);
        }
        let mut next = (*current).clone();
        next.insert(id.clone(), source);
        self.write(root, next)?;
        Ok(id)
    }

    pub fn operation_docs(
        &self,
        root: &Path,
        docs_ref: &DocsRef,
    ) -> Result<Option<OperationDocs>, StorageError> {
        let sources = self.load(root)?;
        let Some(source) = sources.get(&docs_ref.source_id) else {
            return Ok(None);
        };
        let Some(docs) = source.operations.get(&docs_ref.operation_id) else {
            return Ok(None);
        };
        let mut roots = Vec::new();
        docs.collect_refs(&mut roots);
        Ok(Some(OperationDocs {
            source_title: source.title.clone(),
            source_kind: source.kind,
            docs: docs.clone(),
            schemas: reachable_schemas(&source.schemas, roots, MAX_SCHEMAS_PER_OPERATION),
        }))
    }

    /// Remove as fontes que nenhuma requisição referencia mais. Só escreve
    /// quando há o que remover; sem nenhuma fonte, o arquivo é apagado.
    pub fn prune(&self, root: &Path, referenced: &HashSet<String>) -> Result<(), StorageError> {
        let current = self.load(root)?;
        if current.keys().all(|id| referenced.contains(id)) {
            return Ok(());
        }
        let next: Sources = current
            .iter()
            .filter(|(id, _)| referenced.contains(*id))
            .map(|(id, source)| (id.clone(), source.clone()))
            .collect();
        self.write(root, next)
    }

    fn load(&self, root: &Path) -> Result<Arc<Sources>, StorageError> {
        let path = root.join(API_DOCS_FILE);
        let stamp = file_stamp(&path);
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = cache.as_ref()
            && cached.path == path
            && cached.stamp == stamp
        {
            return Ok(Arc::clone(&cached.sources));
        }

        let sources = Arc::new(match stamp {
            None => Sources::new(),
            Some(_) => read_sources(&path)?,
        });
        *cache = Some(CachedFile {
            path,
            stamp,
            sources: Arc::clone(&sources),
        });
        Ok(sources)
    }

    fn write(&self, root: &Path, sources: Sources) -> Result<(), StorageError> {
        let path = root.join(API_DOCS_FILE);
        if sources.is_empty() {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| StorageError::Write(error.to_string()))?;
            }
        } else {
            let file = PersistedFile {
                version: CURRENT_VERSION,
                sources: sources
                    .iter()
                    .map(|(id, source)| PersistedSource {
                        id: id.clone(),
                        content: persisted_from_source(source),
                    })
                    .collect(),
            };
            let json = serde_json::to_string_pretty(&file)
                .map_err(|error| StorageError::Write(error.to_string()))?;
            fs::create_dir_all(root).map_err(|error| StorageError::Write(error.to_string()))?;
            let tmp_path = path.with_extension("tmp");
            fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
            fs::rename(&tmp_path, &path).map_err(|error| StorageError::Write(error.to_string()))?;
        }

        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *cache = Some(CachedFile {
            stamp: file_stamp(&path),
            path,
            sources: Arc::new(sources),
        });
        Ok(())
    }
}

fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

fn read_sources(path: &Path) -> Result<Sources, StorageError> {
    let raw = fs::read_to_string(path).map_err(|error| StorageError::Read(error.to_string()))?;
    let file: PersistedFile =
        serde_json::from_str(&raw).map_err(|error| StorageError::Corrupted(error.to_string()))?;
    if file.version != CURRENT_VERSION {
        return Err(StorageError::UnsupportedVersion(file.version));
    }
    Ok(file
        .sources
        .into_iter()
        .map(|source| (source.id, source_from_persisted(source.content)))
        .collect())
}

fn source_id(content: &PersistedSourceContent) -> Result<String, StorageError> {
    let json =
        serde_json::to_vec(content).map_err(|error| StorageError::Write(error.to_string()))?;
    let digest = ring::digest::digest(&ring::digest::SHA256, &json);
    let hex: String = digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(hex[..SOURCE_ID_LENGTH].to_string())
}

// ---------------------------------------------------------------------------
// Formato persistido
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    sources: Vec<PersistedSource>,
}

#[derive(Serialize, Deserialize)]
struct PersistedSource {
    id: String,
    #[serde(flatten)]
    content: PersistedSourceContent,
}

#[derive(Serialize, Deserialize)]
struct PersistedSourceContent {
    title: String,
    kind: PersistedSourceKind,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    schemas: BTreeMap<String, PersistedSchema>,
    #[serde(default)]
    operations: BTreeMap<String, PersistedOperation>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PersistedSourceKind {
    OpenApi,
    Postman,
    Insomnia,
    Bruno,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Serialize, Deserialize)]
struct PersistedOperation {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    summary: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(default, skip_serializing_if = "is_false")]
    deprecated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    parameters: Vec<PersistedParameter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_body: Option<PersistedBody>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    responses: Vec<PersistedResponse>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PersistedLocation {
    Path,
    Query,
    Header,
    Cookie,
}

#[derive(Serialize, Deserialize)]
struct PersistedParameter {
    name: String,
    #[serde(rename = "in")]
    location: PersistedLocation,
    #[serde(default, skip_serializing_if = "is_false")]
    required: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    deprecated: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<PersistedSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    example: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PersistedBody {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(default, skip_serializing_if = "is_false")]
    required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content: Vec<PersistedMedia>,
}

#[derive(Serialize, Deserialize)]
struct PersistedResponse {
    status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content: Vec<PersistedMedia>,
}

#[derive(Serialize, Deserialize)]
struct PersistedMedia {
    media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<PersistedSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    example: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PersistedProperty {
    name: String,
    schema: PersistedSchema,
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedSchema {
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    ref_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    types: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(default, skip_serializing_if = "is_false")]
    nullable: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    deprecated: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    read_only: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    write_only: bool,
    #[serde(rename = "enum", default, skip_serializing_if = "Vec::is_empty")]
    enum_values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    example: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    properties: Vec<PersistedProperty>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    required: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    items: Option<Box<PersistedSchema>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    additional_properties: Option<Box<PersistedSchema>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    all_of: Vec<PersistedSchema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    one_of: Vec<PersistedSchema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    any_of: Vec<PersistedSchema>,
}

fn persisted_from_source(source: &ApiDocsSource) -> PersistedSourceContent {
    PersistedSourceContent {
        title: source.title.clone(),
        kind: match source.kind {
            ApiDocsSourceKind::OpenApi => PersistedSourceKind::OpenApi,
            ApiDocsSourceKind::Postman => PersistedSourceKind::Postman,
            ApiDocsSourceKind::Insomnia => PersistedSourceKind::Insomnia,
            ApiDocsSourceKind::Bruno => PersistedSourceKind::Bruno,
        },
        schemas: source
            .schemas
            .iter()
            .map(|(name, schema)| (name.clone(), persisted_from_schema(schema)))
            .collect(),
        operations: source
            .operations
            .iter()
            .map(|(id, docs)| (id.clone(), persisted_from_operation(docs)))
            .collect(),
    }
}

fn source_from_persisted(content: PersistedSourceContent) -> ApiDocsSource {
    ApiDocsSource {
        title: content.title,
        kind: match content.kind {
            PersistedSourceKind::OpenApi => ApiDocsSourceKind::OpenApi,
            PersistedSourceKind::Postman => ApiDocsSourceKind::Postman,
            PersistedSourceKind::Insomnia => ApiDocsSourceKind::Insomnia,
            PersistedSourceKind::Bruno => ApiDocsSourceKind::Bruno,
        },
        schemas: content
            .schemas
            .into_iter()
            .map(|(name, schema)| (name, schema_from_persisted(schema)))
            .collect(),
        operations: content
            .operations
            .into_iter()
            .map(|(id, operation)| (id, operation_from_persisted(operation)))
            .collect(),
    }
}

fn persisted_from_operation(docs: &RequestDocs) -> PersistedOperation {
    PersistedOperation {
        summary: docs.summary.clone(),
        description: docs.description.clone(),
        deprecated: docs.deprecated,
        parameters: docs
            .parameters
            .iter()
            .map(|parameter| PersistedParameter {
                name: parameter.name.clone(),
                location: match parameter.location {
                    ParameterLocation::Path => PersistedLocation::Path,
                    ParameterLocation::Query => PersistedLocation::Query,
                    ParameterLocation::Header => PersistedLocation::Header,
                    ParameterLocation::Cookie => PersistedLocation::Cookie,
                },
                required: parameter.required,
                deprecated: parameter.deprecated,
                description: parameter.description.clone(),
                schema: parameter.schema.as_ref().map(persisted_from_schema),
                example: parameter.example.clone(),
            })
            .collect(),
        request_body: docs.request_body.as_ref().map(|body| PersistedBody {
            description: body.description.clone(),
            required: body.required,
            content: body.content.iter().map(persisted_from_media).collect(),
        }),
        responses: docs
            .responses
            .iter()
            .map(|response| PersistedResponse {
                status: response.status.clone(),
                description: response.description.clone(),
                content: response.content.iter().map(persisted_from_media).collect(),
            })
            .collect(),
    }
}

fn operation_from_persisted(operation: PersistedOperation) -> RequestDocs {
    RequestDocs {
        summary: operation.summary,
        description: operation.description,
        deprecated: operation.deprecated,
        parameters: operation
            .parameters
            .into_iter()
            .map(|parameter| ParameterDoc {
                name: parameter.name,
                location: match parameter.location {
                    PersistedLocation::Path => ParameterLocation::Path,
                    PersistedLocation::Query => ParameterLocation::Query,
                    PersistedLocation::Header => ParameterLocation::Header,
                    PersistedLocation::Cookie => ParameterLocation::Cookie,
                },
                required: parameter.required,
                deprecated: parameter.deprecated,
                description: parameter.description,
                schema: parameter.schema.map(schema_from_persisted),
                example: parameter.example,
            })
            .collect(),
        request_body: operation.request_body.map(|body| BodyDoc {
            description: body.description,
            required: body.required,
            content: body.content.into_iter().map(media_from_persisted).collect(),
        }),
        responses: operation
            .responses
            .into_iter()
            .map(|response| ResponseDoc {
                status: response.status,
                description: response.description,
                content: response
                    .content
                    .into_iter()
                    .map(media_from_persisted)
                    .collect(),
            })
            .collect(),
    }
}

fn persisted_from_media(media: &MediaDoc) -> PersistedMedia {
    PersistedMedia {
        media_type: media.media_type.clone(),
        schema: media.schema.as_ref().map(persisted_from_schema),
        example: media.example.clone(),
    }
}

fn media_from_persisted(media: PersistedMedia) -> MediaDoc {
    MediaDoc {
        media_type: media.media_type,
        schema: media.schema.map(schema_from_persisted),
        example: media.example,
    }
}

fn persisted_from_schema(schema: &SchemaNode) -> PersistedSchema {
    let list = |nodes: &[SchemaNode]| nodes.iter().map(persisted_from_schema).collect();
    PersistedSchema {
        ref_name: schema.ref_name.clone(),
        types: schema.types.clone(),
        format: schema.format.clone(),
        title: schema.title.clone(),
        description: schema.description.clone(),
        nullable: schema.nullable,
        deprecated: schema.deprecated,
        read_only: schema.read_only,
        write_only: schema.write_only,
        enum_values: schema.enum_values.clone(),
        default: schema.default.clone(),
        example: schema.example.clone(),
        properties: schema
            .properties
            .iter()
            .map(|(name, child)| PersistedProperty {
                name: name.clone(),
                schema: persisted_from_schema(child),
            })
            .collect(),
        required: schema.required.clone(),
        items: schema
            .items
            .as_deref()
            .map(|child| Box::new(persisted_from_schema(child))),
        additional_properties: schema
            .additional_properties
            .as_deref()
            .map(|child| Box::new(persisted_from_schema(child))),
        all_of: list(&schema.all_of),
        one_of: list(&schema.one_of),
        any_of: list(&schema.any_of),
    }
}

fn schema_from_persisted(schema: PersistedSchema) -> SchemaNode {
    let list = |nodes: Vec<PersistedSchema>| nodes.into_iter().map(schema_from_persisted).collect();
    SchemaNode {
        ref_name: schema.ref_name,
        types: schema.types,
        format: schema.format,
        title: schema.title,
        description: schema.description,
        nullable: schema.nullable,
        deprecated: schema.deprecated,
        read_only: schema.read_only,
        write_only: schema.write_only,
        enum_values: schema.enum_values,
        default: schema.default,
        example: schema.example,
        properties: schema
            .properties
            .into_iter()
            .map(|property| (property.name, schema_from_persisted(property.schema)))
            .collect(),
        required: schema.required,
        items: schema
            .items
            .map(|child| Box::new(schema_from_persisted(*child))),
        additional_properties: schema
            .additional_properties
            .map(|child| Box::new(schema_from_persisted(*child))),
        all_of: list(schema.all_of),
        one_of: list(schema.one_of),
        any_of: list(schema.any_of),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::UNIX_EPOCH;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("alcy-api-docs-store-test-{nanos}-{count}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn pet_source(title: &str) -> ApiDocsSource {
        let pet = SchemaNode {
            types: vec!["object".into()],
            description: "Um pet".into(),
            properties: vec![
                (
                    "name".into(),
                    SchemaNode {
                        types: vec!["string".into()],
                        ..SchemaNode::default()
                    },
                ),
                ("owner".into(), SchemaNode::reference("Person")),
            ],
            required: vec!["name".into()],
            ..SchemaNode::default()
        };
        let person = SchemaNode {
            types: vec!["object".into()],
            properties: vec![(
                "pets".into(),
                SchemaNode {
                    types: vec!["array".into()],
                    items: Some(Box::new(SchemaNode::reference("Pet"))),
                    ..SchemaNode::default()
                },
            )],
            ..SchemaNode::default()
        };
        let operation = RequestDocs {
            summary: "Cria um pet".into(),
            parameters: vec![ParameterDoc {
                name: "dryRun".into(),
                location: ParameterLocation::Query,
                required: false,
                deprecated: false,
                description: "Só valida".into(),
                schema: Some(SchemaNode {
                    types: vec!["boolean".into()],
                    enum_values: vec!["true".into(), "false".into()],
                    ..SchemaNode::default()
                }),
                example: Some("true".into()),
            }],
            request_body: Some(BodyDoc {
                description: "Pet".into(),
                required: true,
                content: vec![MediaDoc {
                    media_type: "application/json".into(),
                    schema: Some(SchemaNode::reference("Pet")),
                    example: Some("{\"name\": \"Rex\"}".into()),
                }],
            }),
            responses: vec![ResponseDoc {
                status: "201".into(),
                description: "Criado".into(),
                content: vec![],
            }],
            ..RequestDocs::default()
        };
        ApiDocsSource {
            title: title.into(),
            kind: ApiDocsSourceKind::OpenApi,
            schemas: BTreeMap::from([
                ("Pet".into(), pet),
                ("Person".into(), person),
                ("Unrelated".into(), SchemaNode::default()),
            ]),
            operations: BTreeMap::from([("createPet".into(), operation)]),
        }
    }

    fn docs_ref(source_id: &str, operation_id: &str) -> DocsRef {
        DocsRef {
            source_id: source_id.into(),
            operation_id: operation_id.into(),
        }
    }

    #[test]
    fn upsert_then_read_round_trips_an_operation_with_its_reachable_schemas() {
        let root = temp_root();
        let store = ApiDocsStore::new();

        let id = store.upsert_source(&root, pet_source("Pets")).unwrap();
        // Uma instância nova (sem cache) lê do disco.
        let loaded = ApiDocsStore::new()
            .operation_docs(&root, &docs_ref(&id, "createPet"))
            .unwrap()
            .unwrap();

        let source = pet_source("Pets");
        assert_eq!(loaded.source_title, "Pets");
        assert_eq!(loaded.source_kind, ApiDocsSourceKind::OpenApi);
        assert_eq!(loaded.docs, source.operations["createPet"]);
        assert_eq!(
            loaded
                .schemas
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["Person", "Pet"]
        );
        assert_eq!(loaded.schemas["Pet"], source.schemas["Pet"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn importing_the_same_source_twice_reuses_it() {
        let root = temp_root();
        let store = ApiDocsStore::new();

        let first = store.upsert_source(&root, pet_source("Pets")).unwrap();
        let second = store.upsert_source(&root, pet_source("Pets")).unwrap();
        let other = store.upsert_source(&root, pet_source("Other")).unwrap();

        assert_eq!(first, second);
        assert_ne!(first, other);
        assert_eq!(first.len(), SOURCE_ID_LENGTH);
        let raw = fs::read_to_string(root.join(API_DOCS_FILE)).unwrap();
        let file: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(file["sources"].as_array().unwrap().len(), 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unknown_sources_and_operations_have_no_docs() {
        let root = temp_root();
        let store = ApiDocsStore::new();
        let id = store.upsert_source(&root, pet_source("Pets")).unwrap();

        assert_eq!(
            store
                .operation_docs(&root, &docs_ref("missing", "createPet"))
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .operation_docs(&root, &docs_ref(&id, "missing"))
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .operation_docs(&temp_root(), &docs_ref(&id, "createPet"))
                .unwrap(),
            None
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_removes_unreferenced_sources_and_the_file_when_empty() {
        let root = temp_root();
        let store = ApiDocsStore::new();
        let kept = store.upsert_source(&root, pet_source("Kept")).unwrap();
        let dropped = store.upsert_source(&root, pet_source("Dropped")).unwrap();

        store.prune(&root, &HashSet::from([kept.clone()])).unwrap();

        assert!(
            store
                .operation_docs(&root, &docs_ref(&kept, "createPet"))
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .operation_docs(&root, &docs_ref(&dropped, "createPet"))
                .unwrap()
                .is_none()
        );

        store.prune(&root, &HashSet::new()).unwrap();
        assert!(!root.join(API_DOCS_FILE).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_external_rewrite_of_the_file_invalidates_the_cache() {
        let root = temp_root();
        let store = ApiDocsStore::new();
        let id = store.upsert_source(&root, pet_source("Pets")).unwrap();
        assert!(
            store
                .operation_docs(&root, &docs_ref(&id, "createPet"))
                .unwrap()
                .is_some()
        );

        fs::write(root.join(API_DOCS_FILE), r#"{"version": 1, "sources": []}"#).unwrap();

        assert!(
            store
                .operation_docs(&root, &docs_ref(&id, "createPet"))
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_unknown_versions_and_corrupted_files() {
        let root = temp_root();
        fs::write(
            root.join(API_DOCS_FILE),
            r#"{"version": 99, "sources": []}"#,
        )
        .unwrap();
        assert!(matches!(
            ApiDocsStore::new().operation_docs(&root, &docs_ref("a", "b")),
            Err(StorageError::UnsupportedVersion(99))
        ));

        fs::write(root.join(API_DOCS_FILE), "{").unwrap();
        assert!(matches!(
            ApiDocsStore::new().operation_docs(&root, &docs_ref("a", "b")),
            Err(StorageError::Corrupted(_))
        ));
        fs::remove_dir_all(&root).ok();
    }
}
