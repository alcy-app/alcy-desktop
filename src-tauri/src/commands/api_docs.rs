//! Leitura da documentação importada de uma chamada (ADR 0035). Só a
//! operação pedida e os schemas que ela alcança cruzam o IPC — nunca a fonte
//! inteira.

use std::collections::BTreeMap;
use std::path::PathBuf;

use alcy_domain::{ApiDocsSourceKind, DocsRef, MediaDoc, ParameterLocation, SchemaNode};
use alcy_storage::{ApiDocsStore, OperationDocs, StorageError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRequestDocsInput {
    pub root_path: String,
    pub source_id: String,
    pub operation_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiDocsCommandError {
    Storage { message: String },
}

impl From<StorageError> for ApiDocsCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestDocsDto {
    pub source_title: String,
    /// `openapi`, `postman` ou `insomnia`.
    pub source_kind: String,
    pub summary: String,
    pub description: String,
    pub deprecated: bool,
    pub parameters: Vec<ParameterDocDto>,
    pub request_body: Option<BodyDocDto>,
    pub responses: Vec<ResponseDocDto>,
    /// Schemas nomeados alcançáveis a partir desta operação.
    pub schemas: BTreeMap<String, SchemaNodeDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParameterDocDto {
    pub name: String,
    /// `path`, `query`, `header` ou `cookie`.
    pub location: String,
    pub required: bool,
    pub deprecated: bool,
    pub description: String,
    pub schema: Option<SchemaNodeDto>,
    /// Texto JSON literal (ex. `"abc"`, `10`).
    pub example: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BodyDocDto {
    pub description: String,
    pub required: bool,
    pub content: Vec<MediaDocDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDocDto {
    pub status: String,
    pub description: String,
    pub content: Vec<MediaDocDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaDocDto {
    pub media_type: String,
    pub schema: Option<SchemaNodeDto>,
    pub example: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaPropertyDto {
    pub name: String,
    pub schema: SchemaNodeDto,
}

/// Valores de `enumValues`, `default` e `example` são texto JSON literal.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNodeDto {
    pub ref_name: Option<String>,
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
    pub properties: Vec<SchemaPropertyDto>,
    pub required: Vec<String>,
    pub items: Option<Box<SchemaNodeDto>>,
    pub additional_properties: Option<Box<SchemaNodeDto>>,
    pub all_of: Vec<SchemaNodeDto>,
    pub one_of: Vec<SchemaNodeDto>,
    pub any_of: Vec<SchemaNodeDto>,
}

/// Documentação da operação `operationId` da fonte `sourceId`, ou `null`
/// quando ela não existe neste workspace (ex.: requisição vinda de outro
/// workspace pelo formato Alcy). A primeira leitura de um arquivo grande
/// roda fora da runtime assíncrona.
#[tauri::command]
pub async fn get_request_docs(
    input: GetRequestDocsInput,
    store: tauri::State<'_, ApiDocsStore>,
) -> Result<Option<RequestDocsDto>, ApiDocsCommandError> {
    let result: Result<Option<RequestDocsDto>, ApiDocsCommandError> = async {
        let store = store.inner().clone();
        tauri::async_runtime::spawn_blocking(move || get_request_docs_inner(input, &store))
            .await
            .unwrap_or_else(|error| {
                Err(ApiDocsCommandError::Storage {
                    message: error.to_string(),
                })
            })
    }
    .await;
    crate::logging::logged("alcy::docs", "carregar documentação", result)
}

fn get_request_docs_inner(
    input: GetRequestDocsInput,
    store: &ApiDocsStore,
) -> Result<Option<RequestDocsDto>, ApiDocsCommandError> {
    let docs_ref = DocsRef {
        source_id: input.source_id,
        operation_id: input.operation_id,
    };
    Ok(store
        .operation_docs(&PathBuf::from(input.root_path), &docs_ref)?
        .map(docs_to_dto))
}

fn docs_to_dto(operation: OperationDocs) -> RequestDocsDto {
    let docs = operation.docs;
    RequestDocsDto {
        source_title: operation.source_title,
        source_kind: match operation.source_kind {
            ApiDocsSourceKind::OpenApi => "openapi",
            ApiDocsSourceKind::Postman => "postman",
            ApiDocsSourceKind::Insomnia => "insomnia",
            ApiDocsSourceKind::Bruno => "bruno",
        }
        .to_string(),
        summary: docs.summary,
        description: docs.description,
        deprecated: docs.deprecated,
        parameters: docs
            .parameters
            .iter()
            .map(|parameter| ParameterDocDto {
                name: parameter.name.clone(),
                location: match parameter.location {
                    ParameterLocation::Path => "path",
                    ParameterLocation::Query => "query",
                    ParameterLocation::Header => "header",
                    ParameterLocation::Cookie => "cookie",
                }
                .to_string(),
                required: parameter.required,
                deprecated: parameter.deprecated,
                description: parameter.description.clone(),
                schema: parameter.schema.as_ref().map(schema_to_dto),
                example: parameter.example.clone(),
            })
            .collect(),
        request_body: docs.request_body.as_ref().map(|body| BodyDocDto {
            description: body.description.clone(),
            required: body.required,
            content: body.content.iter().map(media_to_dto).collect(),
        }),
        responses: docs
            .responses
            .iter()
            .map(|response| ResponseDocDto {
                status: response.status.clone(),
                description: response.description.clone(),
                content: response.content.iter().map(media_to_dto).collect(),
            })
            .collect(),
        schemas: operation
            .schemas
            .iter()
            .map(|(name, schema)| (name.clone(), schema_to_dto(schema)))
            .collect(),
    }
}

fn media_to_dto(media: &MediaDoc) -> MediaDocDto {
    MediaDocDto {
        media_type: media.media_type.clone(),
        schema: media.schema.as_ref().map(schema_to_dto),
        example: media.example.clone(),
    }
}

fn schema_to_dto(schema: &SchemaNode) -> SchemaNodeDto {
    let list = |nodes: &[SchemaNode]| nodes.iter().map(schema_to_dto).collect();
    SchemaNodeDto {
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
            .map(|(name, child)| SchemaPropertyDto {
                name: name.clone(),
                schema: schema_to_dto(child),
            })
            .collect(),
        required: schema.required.clone(),
        items: schema
            .items
            .as_deref()
            .map(|child| Box::new(schema_to_dto(child))),
        additional_properties: schema
            .additional_properties
            .as_deref()
            .map(|child| Box::new(schema_to_dto(child))),
        all_of: list(&schema.all_of),
        one_of: list(&schema.one_of),
        any_of: list(&schema.any_of),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::{
        CollectionDto, FolderDto, SavedRequestDto, import_collections_for_test,
    };

    const OPENAPI: &str = r##"{
        "openapi": "3.0.3",
        "info": {"title": "Pet Store"},
        "paths": {
            "/pets": {
                "post": {
                    "operationId": "createPet",
                    "summary": "Cria um pet",
                    "parameters": [{"name": "dryRun", "in": "query", "description": "Só valida", "schema": {"type": "boolean"}}],
                    "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}
                }
            }
        },
        "components": {"schemas": {"Pet": {"type": "object", "properties": {"name": {"type": "string"}}}}}
    }"##;

    /// First request in tree order. OpenAPI imports group requests into
    /// folders by URL segment, so it may sit at any depth.
    fn first_request(collections: &[CollectionDto]) -> &SavedRequestDto {
        fn in_folders(folders: &[FolderDto]) -> Option<&SavedRequestDto> {
            folders.iter().find_map(|folder| {
                folder
                    .requests
                    .first()
                    .or_else(|| in_folders(&folder.folders))
            })
        }
        collections
            .iter()
            .find_map(|collection| {
                collection
                    .requests
                    .first()
                    .or_else(|| in_folders(&collection.folders))
            })
            .expect("the imported collection has a request")
    }

    #[test]
    fn an_imported_openapi_document_is_readable_through_the_request_reference() {
        let root = std::env::temp_dir().join(format!(
            "alcy-api-docs-cmd-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = ApiDocsStore::new();

        let imported = import_collections_for_test(OPENAPI, &store, &root);
        let docs_ref = first_request(&imported).docs_ref.clone().unwrap();
        assert!(!docs_ref.source_id.is_empty());
        assert_eq!(docs_ref.operation_id, "createPet");

        let docs = get_request_docs_inner(
            GetRequestDocsInput {
                root_path: root.to_string_lossy().into_owned(),
                source_id: docs_ref.source_id,
                operation_id: docs_ref.operation_id,
            },
            &ApiDocsStore::new(),
        )
        .unwrap()
        .unwrap();

        assert_eq!(docs.source_title, "Pet Store");
        assert_eq!(docs.source_kind, "openapi");
        assert_eq!(docs.summary, "Cria um pet");
        assert_eq!(docs.parameters[0].location, "query");
        assert_eq!(docs.parameters[0].description, "Só valida");
        assert_eq!(
            docs.request_body.unwrap().content[0]
                .schema
                .as_ref()
                .unwrap()
                .ref_name
                .as_deref(),
            Some("Pet")
        );
        assert_eq!(docs.schemas["Pet"].properties[0].name, "name");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unknown_reference_has_no_docs() {
        let docs = get_request_docs_inner(
            GetRequestDocsInput {
                root_path: std::env::temp_dir()
                    .join("alcy-api-docs-cmd-test-missing")
                    .to_string_lossy()
                    .into_owned(),
                source_id: "missing".into(),
                operation_id: "op".into(),
            },
            &ApiDocsStore::new(),
        )
        .unwrap();

        assert_eq!(docs, None);
    }
}
