use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::{collections::HashMap, time::SystemTime};

use alcy_domain::{
    ApiDocsSourceKind, Authentication, BodyPayload, Collection, CollectionError, CollectionLabel,
    DocsRef, Endpoint, EnvironmentVariable, EnvironmentVariableError, Folder, FolderError,
    GrpcCall, GrpcSchemaSource, HeaderEntry, HeaderError, LabelColor, ProtocolId, Request,
    RequestDocument, RouteParameter, SavedRequest, SavedRequestError,
};
use alcy_storage::{ApiDocsStore, CollectionsStore, FlowStore, StorageError};
use serde::{Deserialize, Serialize};

use crate::commands::environments::{EnvironmentDto, EnvironmentVariableDto, environment_to_dto};
use crate::commands::execute_rest_request::{
    BodyInput, HttpMethodInput, body_input_from_domain, body_to_domain,
};
use crate::commands::import_fetcher::ImportFetcher;
use crate::commands::ordered_save::OrderedSaves;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequestHeaderDto {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteParameterDto {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SavedRequestAuthenticationDto {
    None,
    Inherit,
    CustomHeader {
        name: String,
        value: String,
    },
    Bearer {
        token: String,
    },
    Basic {
        username: String,
        password: String,
    },
    Digest {
        username: String,
        password: String,
    },
    OAuth2ClientCredentials {
        client_id: String,
        client_secret: String,
        token_url: String,
        scope: String,
    },
}

fn inherit_authentication() -> SavedRequestAuthenticationDto {
    SavedRequestAuthenticationDto::Inherit
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequestDto {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub endpoint: String,
    pub method: HttpMethodInput,
    /// Query GraphQL, ou o texto do corpo REST (raw/urlencoded codificado).
    pub body: String,
    /// Corpo REST estruturado (tipo + campos). Ausente para GraphQL e em
    /// DTOs antigos — nesses casos `body` é tratado como corpo raw JSON.
    #[serde(default)]
    pub rest_body: Option<BodyInput>,
    pub variables: String,
    pub headers: Vec<SavedRequestHeaderDto>,
    pub authentication: SavedRequestAuthenticationDto,
    #[serde(default)]
    pub pre_request_script: String,
    #[serde(default)]
    pub post_response_script: String,
    #[serde(default)]
    pub route_params: Vec<RouteParameterDto>,
    /// Documentação importada desta chamada (ADR 0035); ausente em DTOs
    /// antigos e em requisições sem documentação.
    #[serde(default)]
    pub docs_ref: Option<DocsRefDto>,
    /// Method and schema source of a gRPC request (spec 0129); absent for the
    /// other protocols and in older DTOs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grpc: Option<GrpcCallDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrpcCallDto {
    pub service: String,
    pub method: String,
    pub schema_source: GrpcSchemaSourceDto,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GrpcSchemaSourceDto {
    Reflection,
    #[serde(rename_all = "camelCase")]
    ProtoFiles {
        files: Vec<String>,
        #[serde(default)]
        import_paths: Vec<String>,
    },
}

impl From<&GrpcCall> for GrpcCallDto {
    fn from(call: &GrpcCall) -> Self {
        Self {
            service: call.service.clone(),
            method: call.method.clone(),
            schema_source: match &call.schema_source {
                GrpcSchemaSource::Reflection => GrpcSchemaSourceDto::Reflection,
                GrpcSchemaSource::ProtoFiles {
                    files,
                    import_paths,
                } => GrpcSchemaSourceDto::ProtoFiles {
                    files: files.clone(),
                    import_paths: import_paths.clone(),
                },
            },
            deadline_ms: call.deadline_ms,
        }
    }
}

impl From<GrpcCallDto> for GrpcCall {
    fn from(dto: GrpcCallDto) -> Self {
        Self {
            service: dto.service,
            method: dto.method,
            schema_source: match dto.schema_source {
                GrpcSchemaSourceDto::Reflection => GrpcSchemaSource::Reflection,
                GrpcSchemaSourceDto::ProtoFiles {
                    files,
                    import_paths,
                } => GrpcSchemaSource::ProtoFiles {
                    files,
                    import_paths,
                },
            },
            deadline_ms: dto.deadline_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocsRefDto {
    pub source_id: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: String,
    pub name: String,
    pub folders: Vec<FolderDto>,
    #[serde(default)]
    pub requests: Vec<SavedRequestDto>,
    #[serde(default = "inherit_authentication")]
    pub authentication: SavedRequestAuthenticationDto,
    /// Variáveis de escopo local (ADR 0031).
    #[serde(default)]
    pub variables: Vec<ScopedVariableDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDto {
    pub id: String,
    pub name: String,
    pub folders: Vec<FolderDto>,
    #[serde(default)]
    pub requests: Vec<SavedRequestDto>,
    #[serde(default = "inherit_authentication")]
    pub authentication: SavedRequestAuthenticationDto,
    /// Variáveis de escopo local (ADR 0031).
    #[serde(default)]
    pub variables: Vec<ScopedVariableDto>,
    /// Rótulos da coleção (ADR 0060). Ausente em DTOs antigos.
    #[serde(default)]
    pub labels: Vec<CollectionLabelDto>,
}

/// Rótulo de coleção: `color` é a chave da paleta (`gray`, `red`, ...).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionLabelDto {
    pub name: String,
    pub color: String,
}

/// Variável de coleção/pasta — sem `sensitive` (ADR 0031).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScopedVariableDto {
    pub name: String,
    pub value: String,
}

pub(crate) fn variables_to_dto(variables: &[EnvironmentVariable]) -> Vec<ScopedVariableDto> {
    variables
        .iter()
        .map(|variable| ScopedVariableDto {
            name: variable.name().to_string(),
            value: variable.value().to_string(),
        })
        .collect()
}

pub(crate) fn variables_from_dto(
    variables: Vec<ScopedVariableDto>,
) -> Result<Vec<EnvironmentVariable>, EnvironmentVariableError> {
    variables
        .into_iter()
        .map(|variable| EnvironmentVariable::new(variable.name, variable.value, false))
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCollectionsInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCollectionsInput {
    pub root_path: String,
    pub collections: Vec<CollectionDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CollectionsCommandError {
    Invalid { message: String },
    Storage { message: String },
}

impl From<StorageError> for CollectionsCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

fn invalid(message: impl ToString) -> CollectionsCommandError {
    CollectionsCommandError::Invalid {
        message: message.to_string(),
    }
}

/// Roda `work` (potencialmente pesado — parsing de um documento grande) na
/// thread pool de blocking do Tauri, para nunca ocupar a runtime assíncrona
/// que também entrega eventos de IPC/webview.
async fn run_blocking<T, F>(work: F) -> Result<T, CollectionsCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CollectionsCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(CollectionsCommandError::Storage {
                message: error.to_string(),
            })
        })
}

fn protocol_to_str(protocol: ProtocolId) -> &'static str {
    match protocol {
        ProtocolId::GraphQl => "graphql",
        ProtocolId::Rest => "rest",
        ProtocolId::Grpc => "grpc",
    }
}

fn protocol_from_str(value: &str) -> Result<ProtocolId, CollectionsCommandError> {
    match value {
        "graphql" => Ok(ProtocolId::GraphQl),
        "rest" => Ok(ProtocolId::Rest),
        "grpc" => Ok(ProtocolId::Grpc),
        other => Err(invalid(format!(
            "protocolo de requisição desconhecido: {other}"
        ))),
    }
}

fn authentication_to_dto(authentication: &Authentication) -> SavedRequestAuthenticationDto {
    match authentication {
        Authentication::None => SavedRequestAuthenticationDto::None,
        Authentication::Inherit => SavedRequestAuthenticationDto::Inherit,
        Authentication::CustomHeader { name, value } => {
            SavedRequestAuthenticationDto::CustomHeader {
                name: name.clone(),
                value: value.clone(),
            }
        }
        Authentication::Bearer { token } => SavedRequestAuthenticationDto::Bearer {
            token: token.clone(),
        },
        Authentication::Basic { username, password } => SavedRequestAuthenticationDto::Basic {
            username: username.clone(),
            password: password.clone(),
        },
        Authentication::Digest { username, password } => SavedRequestAuthenticationDto::Digest {
            username: username.clone(),
            password: password.clone(),
        },
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => SavedRequestAuthenticationDto::OAuth2ClientCredentials {
            client_id: client_id.clone(),
            client_secret: client_secret.clone(),
            token_url: token_url.clone(),
            scope: scope.clone(),
        },
    }
}

fn authentication_from_dto(dto: SavedRequestAuthenticationDto) -> Authentication {
    match dto {
        SavedRequestAuthenticationDto::None => Authentication::None,
        SavedRequestAuthenticationDto::Inherit => Authentication::Inherit,
        SavedRequestAuthenticationDto::CustomHeader { name, value } => {
            Authentication::CustomHeader { name, value }
        }
        SavedRequestAuthenticationDto::Bearer { token } => Authentication::Bearer { token },
        SavedRequestAuthenticationDto::Basic { username, password } => {
            Authentication::Basic { username, password }
        }
        SavedRequestAuthenticationDto::Digest { username, password } => {
            Authentication::Digest { username, password }
        }
        SavedRequestAuthenticationDto::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        },
    }
}

pub(crate) fn request_to_dto(request: &SavedRequest) -> SavedRequestDto {
    let authentication = authentication_to_dto(&request.request.authentication);

    SavedRequestDto {
        id: request.id.clone(),
        name: request.name().to_string(),
        protocol: protocol_to_str(request.request.document.protocol).to_string(),
        endpoint: request.request.endpoint.url().to_string(),
        method: request.request.method.into(),
        body: request.request.document.body.clone(),
        rest_body: (request.request.document.protocol == ProtocolId::Rest).then(|| {
            body_input_from_domain(
                &request.request.document.body,
                &request.request.body_payload,
            )
        }),
        variables: request.request.variables.clone(),
        headers: request
            .request
            .headers
            .iter()
            .map(|header| SavedRequestHeaderDto {
                name: header.name().to_string(),
                value: header.value().to_string(),
                enabled: header.enabled,
            })
            .collect(),
        authentication,
        pre_request_script: request.request.pre_request_script.clone(),
        post_response_script: request.request.post_response_script.clone(),
        route_params: request
            .request
            .route_parameters
            .iter()
            .map(|parameter| RouteParameterDto {
                name: parameter.name.clone(),
                value: parameter.value.clone(),
            })
            .collect(),
        docs_ref: request.docs_ref.as_ref().map(|docs_ref| DocsRefDto {
            source_id: docs_ref.source_id.clone(),
            operation_id: docs_ref.operation_id.clone(),
        }),
        grpc: (request.request.document.protocol == ProtocolId::Grpc)
            .then(|| GrpcCallDto::from(&request.request.grpc)),
    }
}

pub(crate) fn request_from_dto(
    dto: SavedRequestDto,
) -> Result<SavedRequest, CollectionsCommandError> {
    let protocol = protocol_from_str(&dto.protocol)?;
    let endpoint = Endpoint::saved(dto.endpoint);
    let (body_text, body_payload) = match dto.rest_body {
        Some(rest_body) if protocol == ProtocolId::Rest => body_to_domain(rest_body, |text| {
            Ok::<_, CollectionsCommandError>(text.to_string())
        })?,
        _ => (dto.body, BodyPayload::default()),
    };
    let document = RequestDocument::new(protocol, body_text);
    let headers = dto
        .headers
        .into_iter()
        .map(|header| {
            HeaderEntry::new(header.name, header.value, header.enabled)
                .map_err(|error: HeaderError| invalid(error))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let authentication = authentication_from_dto(dto.authentication);

    let request = Request::new(endpoint, document, dto.variables, headers, authentication)
        .with_method(dto.method.into())
        .with_body_payload(body_payload)
        .with_route_parameters(
            dto.route_params
                .into_iter()
                .map(|parameter| RouteParameter {
                    name: parameter.name,
                    value: parameter.value,
                })
                .collect(),
        )
        .with_scripts(dto.pre_request_script, dto.post_response_script)
        .with_grpc(dto.grpc.map(GrpcCall::from).unwrap_or_default());

    let saved = SavedRequest::new(dto.id, dto.name, request)
        .map_err(|error: SavedRequestError| invalid(error))?;
    Ok(match dto.docs_ref {
        Some(docs_ref) => saved.with_docs_ref(DocsRef {
            source_id: docs_ref.source_id,
            operation_id: docs_ref.operation_id,
        }),
        None => saved,
    })
}

fn folder_to_dto(folder: &Folder) -> FolderDto {
    FolderDto {
        id: folder.id.clone(),
        name: folder.name().to_string(),
        folders: folder.folders().iter().map(folder_to_dto).collect(),
        requests: folder.requests().iter().map(request_to_dto).collect(),
        authentication: authentication_to_dto(&folder.authentication),
        variables: variables_to_dto(folder.variables()),
    }
}

fn collection_to_dto(collection: &Collection) -> CollectionDto {
    CollectionDto {
        id: collection.id.clone(),
        name: collection.name().to_string(),
        folders: collection.folders().iter().map(folder_to_dto).collect(),
        requests: collection.requests().iter().map(request_to_dto).collect(),
        authentication: authentication_to_dto(&collection.authentication),
        variables: variables_to_dto(collection.variables()),
        labels: collection
            .labels()
            .iter()
            .map(|label| CollectionLabelDto {
                name: label.name().to_string(),
                color: label.color.as_key().to_string(),
            })
            .collect(),
    }
}

fn labels_from_dto(
    labels: Vec<CollectionLabelDto>,
) -> Result<Vec<CollectionLabel>, CollectionsCommandError> {
    labels
        .into_iter()
        .map(|label| {
            let color = LabelColor::from_key(&label.color)
                .ok_or_else(|| invalid(format!("cor de rótulo desconhecida: '{}'", label.color)))?;
            CollectionLabel::new(label.name, color).map_err(invalid)
        })
        .collect()
}

fn folder_from_dto(dto: FolderDto) -> Result<Folder, CollectionsCommandError> {
    let folders = dto
        .folders
        .into_iter()
        .map(folder_from_dto)
        .collect::<Result<Vec<_>, _>>()?;
    let requests = dto
        .requests
        .into_iter()
        .map(request_from_dto)
        .collect::<Result<Vec<_>, _>>()?;

    let variables = variables_from_dto(dto.variables).map_err(invalid)?;
    Folder::new(dto.id, dto.name, folders, requests)
        .and_then(|folder| {
            folder
                .with_authentication(authentication_from_dto(dto.authentication))
                .with_variables(variables)
        })
        .map_err(|error: FolderError| invalid(error))
}

pub(crate) fn collection_from_dto(
    dto: CollectionDto,
) -> Result<Collection, CollectionsCommandError> {
    let folders = dto
        .folders
        .into_iter()
        .map(folder_from_dto)
        .collect::<Result<Vec<_>, _>>()?;
    let requests = dto
        .requests
        .into_iter()
        .map(request_from_dto)
        .collect::<Result<Vec<_>, _>>()?;

    let variables = variables_from_dto(dto.variables).map_err(invalid)?;
    let labels = labels_from_dto(dto.labels)?;
    Collection::new(dto.id, dto.name, folders, requests)
        .and_then(|collection| {
            collection
                .with_authentication(authentication_from_dto(dto.authentication))
                .with_variables(variables)
        })
        .and_then(|collection| collection.with_labels(labels))
        .map_err(|error: CollectionError| invalid(error))
}

/// Lista as coleções persistidas no workspace em `input.root_path`. Lista
/// vazia quando o workspace ainda não tem nenhuma (estado normal de um
/// workspace recém criado).
///
/// Também descarta a documentação importada que nenhuma requisição usa mais
/// (ADR 0035). Isso acontece aqui — na abertura do workspace ou depois de um
/// pull —, e não ao salvar, porque um salvamento em andamento ainda pode
/// carregar a árvore anterior a uma importação recém-gravada.
#[tauri::command]
pub async fn list_collections(
    input: ListCollectionsInput,
    docs: tauri::State<'_, ApiDocsStore>,
) -> Result<Vec<CollectionDto>, CollectionsCommandError> {
    let docs = ApiDocsStore::clone(&docs);
    let result =
        run_blocking(move || list_collections_inner(PathBuf::from(input.root_path), &docs)).await;
    crate::logging::logged("alcy::collections", "carregar coleções", result)
}

fn list_collections_inner(
    root: PathBuf,
    docs: &ApiDocsStore,
) -> Result<Vec<CollectionDto>, CollectionsCommandError> {
    let store = CollectionsStore::new(root.clone());
    let collections = store.load()?;
    prune_orphan_docs(&root, &collections, docs);
    Ok(collections.iter().map(collection_to_dto).collect())
}

/// Sem conseguir ler os flows não dá para saber o que eles referenciam —
/// nesse caso nada é removido. Falhas aqui nunca impedem de listar.
fn prune_orphan_docs(root: &Path, collections: &[Collection], docs: &ApiDocsStore) {
    let flows = match FlowStore::new(root.to_path_buf()).load() {
        Ok(snapshot) => snapshot.flows,
        Err(error) => {
            log::warn!("documentação importada não foi limpa (flows ilegíveis): {error}");
            return;
        }
    };
    let referenced = alcy_domain::referenced_docs_sources(collections, &flows);
    if let Err(error) = docs.prune(root, &referenced) {
        log::warn!("documentação importada não foi limpa: {error}");
    }
}

/// Ver `ordered_save`: o autosave dispara gravações em sequência, e uma
/// mais antiga nunca pode sobrescrever uma mais nova.
static COLLECTION_SAVES: OrderedSaves = OrderedSaves::new();

#[tauri::command]
pub async fn save_collections(input: SaveCollectionsInput) -> Result<(), CollectionsCommandError> {
    let ticket = COLLECTION_SAVES.ticket();
    let result = run_blocking(move || {
        let root = PathBuf::from(input.root_path);
        COLLECTION_SAVES.run(ticket, &root.clone(), || {
            save_collections_inner(root, input.collections)
        })
    })
    .await;
    crate::logging::logged("alcy::collections", "salvar coleções", result)
}

fn save_collections_inner(
    root: PathBuf,
    dtos: Vec<CollectionDto>,
) -> Result<(), CollectionsCommandError> {
    let collections = dtos
        .into_iter()
        .map(collection_from_dto)
        .collect::<Result<Vec<_>, _>>()?;

    let store = CollectionsStore::new(root);
    store.save(&collections)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCollectionsInput {
    pub path: String,
    pub collections: Vec<CollectionDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCollectionsInput {
    pub path: String,
    /// Workspace que recebe a documentação importada (ADR 0035).
    pub root_path: String,
}

#[derive(Clone)]
struct PreparedImport {
    imported: alcy_collection_import::ImportedCollectionData,
    root_path: String,
    prepared_at: SystemTime,
}

/// Sessões de revisão ficam apenas em memória e têm limite pequeno. Assim o
/// frontend revisa metadados compactos sem transportar o documento completo
/// nem gravar documentação antes da confirmação.
pub struct PreparedImports {
    next_id: AtomicU64,
    entries: Mutex<HashMap<String, PreparedImport>>,
}

impl Default for PreparedImports {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedImportOutput {
    pub id: String,
    pub format: String,
    pub title: String,
    pub collection_count: usize,
    pub folder_count: usize,
    pub request_count: usize,
    pub environment_count: usize,
    pub supports_documentation: bool,
    pub script_count: usize,
    pub warning_count: usize,
    /// Variables the review offers (spec 0130).
    pub variables: Vec<ImportVariableCandidateDto>,
    /// Names of the imported environments and collections, by index, for
    /// the review's destinations.
    pub environment_names: Vec<String>,
    pub collection_names: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportVariableCandidateDto {
    pub key: String,
    pub name: String,
    pub value: String,
    pub value_truncated: bool,
    pub sensitive: bool,
    pub origin: VariableOriginDto,
    pub included: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VariableOriginDto {
    Environment { index: usize },
    Collection { index: usize },
    Referenced,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VariableTargetDto {
    ImportedEnvironment { index: usize },
    NewEnvironment { name: String },
    ExistingEnvironment { id: String },
    Collection { index: usize },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableSelectionDto {
    pub key: String,
    pub include: bool,
    pub name: String,
    pub value: Option<String>,
    pub sensitive: bool,
    pub target: VariableTargetDto,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentMergeDto {
    pub environment_id: String,
    pub variables: Vec<EnvironmentVariableDto>,
}

fn candidate_to_dto(
    candidate: alcy_collection_import::ImportVariableCandidate,
) -> ImportVariableCandidateDto {
    use alcy_collection_import::VariableOrigin;
    ImportVariableCandidateDto {
        key: candidate.key,
        name: candidate.name,
        value: candidate.value,
        value_truncated: candidate.value_truncated,
        sensitive: candidate.sensitive,
        origin: match candidate.origin {
            VariableOrigin::Environment(index) => VariableOriginDto::Environment { index },
            VariableOrigin::Collection(index) => VariableOriginDto::Collection { index },
            VariableOrigin::Referenced => VariableOriginDto::Referenced,
        },
        included: candidate.included,
    }
}

fn selection_from_dto(dto: VariableSelectionDto) -> alcy_collection_import::VariableSelection {
    use alcy_collection_import::VariableTarget;
    alcy_collection_import::VariableSelection {
        key: dto.key,
        include: dto.include,
        name: dto.name,
        value: dto.value,
        sensitive: dto.sensitive,
        target: match dto.target {
            VariableTargetDto::ImportedEnvironment { index } => {
                VariableTarget::ImportedEnvironment(index)
            }
            VariableTargetDto::NewEnvironment { name } => VariableTarget::NewEnvironment(name),
            VariableTargetDto::ExistingEnvironment { id } => {
                VariableTarget::ExistingEnvironment(id)
            }
            VariableTargetDto::Collection { index } => VariableTarget::Collection(index),
        },
    }
}

fn merge_to_dto(merge: alcy_collection_import::EnvironmentMerge) -> EnvironmentMergeDto {
    EnvironmentMergeDto {
        environment_id: merge.environment_id,
        variables: merge
            .variables
            .iter()
            .map(|variable| EnvironmentVariableDto {
                name: variable.name().to_string(),
                value: variable.value().to_string(),
                sensitive: variable.sensitive,
            })
            .collect(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareImportFromTextInput {
    pub content: String,
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareImportFromUrlInput {
    pub url: String,
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPreparedImportInput {
    pub id: String,
    pub root_path: String,
    pub include_documentation: bool,
    /// The review's variable choices; absent keeps the import as parsed.
    #[serde(default)]
    pub variables: Option<Vec<VariableSelectionDto>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardPreparedImportInput {
    pub id: String,
}

/// Onde gravar a documentação que uma importação trouxer.
pub struct DocsTarget {
    pub store: ApiDocsStore,
    pub root: PathBuf,
}

impl DocsTarget {
    fn new(store: &ApiDocsStore, root_path: String) -> Self {
        Self {
            store: store.clone(),
            root: PathBuf::from(root_path),
        }
    }
}

fn count_folder(folder: &Folder) -> (usize, usize) {
    folder.folders().iter().fold(
        (1, folder.requests().len()),
        |(folder_count, request_count), child| {
            let (child_folders, child_requests) = count_folder(child);
            (folder_count + child_folders, request_count + child_requests)
        },
    )
}

fn prepared_format(imported: &alcy_collection_import::ImportedCollectionData) -> &'static str {
    if let Some(alcy_collection_import::ImportFormat::Har) = imported.format {
        return "har";
    }
    match imported.source_kind {
        Some(ApiDocsSourceKind::OpenApi) => "openapi",
        Some(ApiDocsSourceKind::Postman) => "postman",
        Some(ApiDocsSourceKind::Insomnia) => "insomnia",
        Some(ApiDocsSourceKind::Bruno) => "bruno",
        None => "alcy",
    }
}

fn store_prepared_import(
    prepared: &PreparedImports,
    imported: alcy_collection_import::ImportedCollectionData,
    root_path: String,
) -> Result<PreparedImportOutput, CollectionsCommandError> {
    let id = format!(
        "import-{}",
        prepared.next_id.fetch_add(1, Ordering::Relaxed)
    );
    let (folder_count, request_count) =
        imported
            .collections
            .iter()
            .fold((0, 0), |(folder_count, request_count), collection| {
                collection.folders().iter().fold(
                    (folder_count, request_count + collection.requests().len()),
                    |(folders, requests), folder| {
                        let (child_folders, child_requests) = count_folder(folder);
                        (folders + child_folders, requests + child_requests)
                    },
                )
            });
    let output = PreparedImportOutput {
        id: id.clone(),
        format: prepared_format(&imported).to_string(),
        title: imported
            .collections
            .first()
            .map(|collection| collection.name().to_string())
            .or_else(|| imported.docs.as_ref().map(|docs| docs.title.clone()))
            .unwrap_or_else(|| "Importação".to_string()),
        collection_count: imported.collections.len(),
        folder_count,
        request_count,
        environment_count: imported.environments.len(),
        supports_documentation: imported.docs.is_some(),
        script_count: imported.script_count,
        warning_count: imported.warnings.len(),
        variables: alcy_collection_import::variable_candidates(&imported)
            .into_iter()
            .map(candidate_to_dto)
            .collect(),
        environment_names: imported
            .environments
            .iter()
            .map(|environment| environment.name().to_string())
            .collect(),
        collection_names: imported
            .collections
            .iter()
            .map(|collection| collection.name().to_string())
            .collect(),
    };

    let mut entries =
        prepared
            .entries
            .lock()
            .map_err(|error| CollectionsCommandError::Storage {
                message: error.to_string(),
            })?;
    if entries.len() >= 16
        && let Some(oldest) = entries
            .iter()
            .min_by_key(|(_, entry)| entry.prepared_at)
            .map(|(id, _)| id.clone())
    {
        entries.remove(&oldest);
    }
    entries.insert(
        id,
        PreparedImport {
            imported,
            root_path,
            prepared_at: SystemTime::now(),
        },
    );
    Ok(output)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportCollectionsOutput {
    pub collections: Vec<CollectionDto>,
    pub environments: Vec<EnvironmentDto>,
    /// Variables for environments the workspace already has (spec 0130).
    pub environment_merges: Vec<EnvironmentMergeDto>,
    pub script_count: usize,
    pub warnings: Vec<ImportWarningDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarningDto {
    pub request_path: String,
    pub phase: String,
    pub line: Option<u32>,
    pub api: String,
    pub reason: String,
}

/// Exporta coleções (uma ou todas) para um arquivo escolhido pelo
/// usuário, no "formato Alcy".
#[tauri::command]
pub async fn export_collections(
    input: ExportCollectionsInput,
) -> Result<(), CollectionsCommandError> {
    let result = run_blocking(move || {
        export_collections_inner(PathBuf::from(input.path), input.collections)
    })
    .await;
    crate::logging::logged("alcy::collections", "exportar coleções", result)
}

fn export_collections_inner(
    path: PathBuf,
    dtos: Vec<CollectionDto>,
) -> Result<(), CollectionsCommandError> {
    let collections = dtos
        .into_iter()
        .map(collection_from_dto)
        .collect::<Result<Vec<_>, _>>()?;

    alcy_storage::export_collections(&path, &collections)?;
    Ok(())
}

/// Importa coleções de um arquivo escolhido pelo usuário. O formato é
/// detectado pelo conteúdo do arquivo, não pela extensão. O chamador insere
/// as coleções retornadas no nível raiz do workspace aberto.
///
/// Um documento OpenAPI grande (dezenas de MB, ex. a API REST do GitHub)
/// pode levar da ordem de 1s para interpretar num build de desenvolvimento
/// (sem otimizações) — `spawn_blocking` roda esse trabalho fora da runtime
/// assíncrona do Tauri, para não travar a entrega de outros eventos/IPC
/// enquanto isso acontece.
#[tauri::command]
pub async fn import_collections(
    input: ImportCollectionsInput,
    docs: tauri::State<'_, ApiDocsStore>,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let result: Result<ImportCollectionsOutput, CollectionsCommandError> = async {
        let path = PathBuf::from(input.path);
        let target = DocsTarget::new(&docs, input.root_path);
        run_blocking(move || import_collections_inner(path, &target)).await
    }
    .await;
    crate::logging::logged("alcy::collections", "importar coleções de arquivo", result)
}

#[tauri::command]
pub async fn prepare_import_from_path(
    input: ImportCollectionsInput,
    prepared: tauri::State<'_, PreparedImports>,
) -> Result<PreparedImportOutput, CollectionsCommandError> {
    let root_path = input.root_path;
    let imported = run_blocking(move || read_import_from_path(PathBuf::from(input.path))).await?;
    store_prepared_import(&prepared, imported, root_path)
}

#[tauri::command]
pub async fn prepare_import_from_text(
    input: PrepareImportFromTextInput,
    prepared: tauri::State<'_, PreparedImports>,
) -> Result<PreparedImportOutput, CollectionsCommandError> {
    if input.content.trim().is_empty() {
        return Err(invalid("conteúdo vazio"));
    }
    let root_path = input.root_path;
    let imported = run_blocking(move || parse_import_content(&input.content)).await?;
    store_prepared_import(&prepared, imported, root_path)
}

#[tauri::command]
pub async fn prepare_import_from_url(
    input: PrepareImportFromUrlInput,
    fetcher: tauri::State<'_, ImportFetcher>,
    prepared: tauri::State<'_, PreparedImports>,
) -> Result<PreparedImportOutput, CollectionsCommandError> {
    let raw = fetcher
        .fetch_text(&input.url)
        .await
        .map_err(|message| CollectionsCommandError::Storage { message })?;
    let root_path = input.root_path;
    let imported = run_blocking(move || parse_import_content(&raw)).await?;
    store_prepared_import(&prepared, imported, root_path)
}

#[tauri::command]
pub async fn commit_prepared_import(
    input: CommitPreparedImportInput,
    prepared: tauri::State<'_, PreparedImports>,
    docs: tauri::State<'_, ApiDocsStore>,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let CommitPreparedImportInput {
        id,
        root_path,
        include_documentation,
        variables,
    } = input;
    let entry = prepared
        .entries
        .lock()
        .map_err(|error| CollectionsCommandError::Storage {
            message: error.to_string(),
        })?
        .get(&id)
        .cloned()
        .ok_or_else(|| invalid("a revisão da importação expirou"))?;
    if entry.root_path != root_path {
        return Err(invalid("a revisão pertence a outro workspace"));
    }

    let target = DocsTarget::new(&docs, root_path);
    let output = run_blocking(move || {
        commit_with_variables(entry.imported, &target, include_documentation, variables)
    })
    .await?;
    prepared
        .entries
        .lock()
        .map_err(|error| CollectionsCommandError::Storage {
            message: error.to_string(),
        })?
        .remove(&id);
    Ok(output)
}

#[tauri::command]
pub fn discard_prepared_import(
    input: DiscardPreparedImportInput,
    prepared: tauri::State<'_, PreparedImports>,
) -> Result<(), CollectionsCommandError> {
    prepared
        .entries
        .lock()
        .map_err(|error| CollectionsCommandError::Storage {
            message: error.to_string(),
        })?
        .remove(&input.id);
    Ok(())
}

fn commit_with_variables(
    imported: alcy_collection_import::ImportedCollectionData,
    target: &DocsTarget,
    include_documentation: bool,
    variables: Option<Vec<VariableSelectionDto>>,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let Some(variables) = variables else {
        return import_collections_from_imported(imported, target, include_documentation);
    };
    let selections: Vec<_> = variables.into_iter().map(selection_from_dto).collect();
    let (imported, merges) =
        alcy_collection_import::apply_variable_selection(imported, &selections)
            .map_err(|error| invalid(error.to_string()))?;
    let mut output = import_collections_from_imported(imported, target, include_documentation)?;
    output.environment_merges = merges.into_iter().map(merge_to_dto).collect();
    Ok(output)
}

fn import_collections_inner(
    path: PathBuf,
    target: &DocsTarget,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let imported = read_import_from_path(path)?;
    import_collections_from_imported(imported, target, true)
}

fn read_import_from_path(
    path: PathBuf,
) -> Result<alcy_collection_import::ImportedCollectionData, CollectionsCommandError> {
    if path.is_dir() {
        return parse_bruno_directory(&path);
    }
    // Um arquivo de uma coleção Bruno em árvore importa a coleção inteira:
    // o diálogo nativo não escolhe arquivos e pastas ao mesmo tempo.
    if let Some(root) = bruno_collection_root(&path) {
        return parse_bruno_directory(&root);
    }
    let bytes = fs::read(&path).map_err(|error| CollectionsCommandError::Storage {
        message: error.to_string(),
    })?;

    // Imagem do "Compartilhar como imagem": a requisição vem do chunk de
    // texto do PNG, no formato Alcy (ADR 0032).
    if alcy_collection_import::is_png(&bytes) {
        let text =
            alcy_collection_import::png_text(&bytes, alcy_collection_import::IMPORT_PNG_KEYWORD)
                .map_err(|error| invalid(error.to_string()))?
                .ok_or_else(|| invalid("a imagem não tem dados de importação do Alcy"))?;
        return parse_import_content(&text);
    }

    let raw = String::from_utf8(bytes).map_err(|error| CollectionsCommandError::Storage {
        message: error.to_string(),
    })?;
    parse_import_content(&raw)
}

fn parse_bruno_directory(
    root: &Path,
) -> Result<alcy_collection_import::ImportedCollectionData, CollectionsCommandError> {
    let files = read_bruno_tree(root)?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Bruno");
    alcy_collection_import::parse_bruno_directory(name, &files)
        .map_err(|error| invalid(error.to_string()))
}

fn is_bruno_root(dir: &Path) -> bool {
    ["bruno.json", "opencollection.yml", "opencollection.yaml"]
        .iter()
        .any(|marker| dir.join(marker).is_file())
}

/// Raiz da coleção Bruno em árvore à qual `file` pertence: o próprio
/// diretório de `bruno.json`/`opencollection.yml`, ou o ancestral mais
/// próximo que os contém no caso de um `.bru`. `None` para qualquer outro
/// arquivo, que segue a detecção pelo conteúdo.
fn bruno_collection_root(file: &Path) -> Option<PathBuf> {
    let name = file.file_name()?.to_str()?;
    let parent = file.parent()?;
    match name {
        "bruno.json" | "opencollection.yml" | "opencollection.yaml" => {
            return Some(parent.to_path_buf());
        }
        _ if name.ends_with(".bru") => {}
        _ => return None,
    }
    parent
        .ancestors()
        .take(MAX_IMPORT_DEPTH + 1)
        .find(|dir| is_bruno_root(dir))
        .map(Path::to_path_buf)
}

const MAX_IMPORT_FILES: usize = 10_000;
const MAX_IMPORT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMPORT_DEPTH: usize = 32;

fn read_bruno_tree(
    root: &Path,
) -> Result<Vec<alcy_collection_import::BrunoFile>, CollectionsCommandError> {
    let open_collection =
        root.join("opencollection.yml").is_file() || root.join("opencollection.yaml").is_file();
    fn walk(
        root: &Path,
        dir: &Path,
        open_collection: bool,
        depth: usize,
        total: &mut u64,
        files: &mut Vec<alcy_collection_import::BrunoFile>,
    ) -> Result<(), CollectionsCommandError> {
        if depth > MAX_IMPORT_DEPTH {
            return Err(invalid("diretório excede o limite de profundidade"));
        }
        for entry in fs::read_dir(dir).map_err(|e| invalid(e.to_string()))? {
            let entry = entry.map_err(|e| invalid(e.to_string()))?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| invalid(e.to_string()))?;
            if meta.file_type().is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            if meta.is_dir() {
                walk(root, &path, open_collection, depth + 1, total, files)?;
                continue;
            }
            let is_open_collection_file =
                open_collection && (name.ends_with(".yml") || name.ends_with(".yaml"));
            if !name.ends_with(".bru") && name != "bruno.json" && !is_open_collection_file {
                continue;
            }
            if meta.len() > MAX_IMPORT_FILE_BYTES {
                return Err(invalid("arquivo da coleção excede 2 MiB"));
            }
            *total = total.saturating_add(meta.len());
            if *total > MAX_IMPORT_TOTAL_BYTES {
                return Err(invalid("coleção excede 64 MiB"));
            }
            if files.len() >= MAX_IMPORT_FILES {
                return Err(invalid("coleção excede 10000 arquivos"));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|e| invalid(e.to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            let content = fs::read_to_string(&path).map_err(|e| invalid(e.to_string()))?;
            files.push(alcy_collection_import::BrunoFile {
                relative_path: relative,
                content,
            });
        }
        Ok(())
    }
    let mut files = Vec::new();
    let mut total = 0;
    walk(root, root, open_collection, 0, &mut total, &mut files)?;
    Ok(files)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandImportPathsInput {
    pub paths: Vec<String>,
}

/// Extensões consideradas ao percorrer uma pasta escolhida para importar —
/// as mesmas do diálogo de arquivos. Imagens ficam de fora: cada PNG viraria
/// um rascunho aberto, e pastas costumam ter imagens sem dados do Alcy.
const IMPORTABLE_EXTENSIONS: [&str; 6] = ["json", "yaml", "yml", "har", "sh", "txt"];

/// Troca cada pasta comum em `paths` pelos arquivos importáveis dentro dela
/// (recursivamente), para a modal importá-los um a um e agrupar as falhas.
/// Arquivos e raízes de coleção Bruno/OpenCollection passam como estão — a
/// coleção em árvore continua sendo importada inteira por `import_collections`.
#[tauri::command]
pub async fn expand_import_paths(
    input: ExpandImportPathsInput,
) -> Result<Vec<String>, CollectionsCommandError> {
    let result = run_blocking(move || {
        expand_import_paths_inner(input.paths.into_iter().map(PathBuf::from).collect())
    })
    .await;
    crate::logging::logged("alcy::collections", "listar arquivos para importar", result)
}

fn expand_import_paths_inner(paths: Vec<PathBuf>) -> Result<Vec<String>, CollectionsCommandError> {
    fn walk(
        dir: &Path,
        depth: usize,
        found: &mut Vec<PathBuf>,
    ) -> Result<(), CollectionsCommandError> {
        if depth > MAX_IMPORT_DEPTH {
            return Err(invalid("pasta excede o limite de profundidade"));
        }
        let mut entries = fs::read_dir(dir)
            .map_err(|e| invalid(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| invalid(e.to_string()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| invalid(e.to_string()))?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if is_bruno_root(&path) {
                    found.push(path);
                } else {
                    walk(&path, depth + 1, found)?;
                }
            } else if has_importable_extension(&path) {
                found.push(path);
            }
            if found.len() > MAX_IMPORT_FILES {
                return Err(invalid("pasta excede 10000 arquivos"));
            }
        }
        Ok(())
    }

    let mut found = Vec::new();
    for path in paths {
        if path.is_dir() && !is_bruno_root(&path) {
            walk(&path, 0, &mut found)?;
        } else {
            found.push(path);
        }
    }
    // Caminhos não UTF-8 não cruzam o IPC como `String`; ficam de fora.
    Ok(found
        .into_iter()
        .filter_map(|path| path.into_os_string().into_string().ok())
        .collect())
}

fn has_importable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            IMPORTABLE_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializeCollectionsInput {
    pub collections: Vec<CollectionDto>,
}

/// Coleções no formato Alcy, como texto — o conteúdo que o "Compartilhar
/// como imagem" embute no PNG para a imagem poder ser importada (ADR 0032).
#[tauri::command]
pub async fn serialize_collections(
    input: SerializeCollectionsInput,
) -> Result<String, CollectionsCommandError> {
    let result = run_blocking(move || {
        let collections = input
            .collections
            .into_iter()
            .map(collection_from_dto)
            .collect::<Result<Vec<_>, _>>()?;

        Ok(alcy_storage::export_collections_to_string(&collections)?)
    })
    .await;
    crate::logging::logged("alcy::collections", "serializar coleções", result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCollectionsFromTextInput {
    pub content: String,
    pub root_path: String,
}

/// Importa coleções a partir de texto colado pelo usuário (aba "Código" da
/// modal de importar) — mesma detecção de formato de `import_collections`,
/// sem tocar disco. Ver `import_collections` sobre por que roda em
/// `run_blocking`.
#[tauri::command]
pub async fn import_collections_from_text(
    input: ImportCollectionsFromTextInput,
    docs: tauri::State<'_, ApiDocsStore>,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let result: Result<ImportCollectionsOutput, CollectionsCommandError> =
        async { import_collections_from_text_inner(input, &docs).await }.await;
    crate::logging::logged("alcy::collections", "importar coleções de texto", result)
}

async fn import_collections_from_text_inner(
    input: ImportCollectionsFromTextInput,
    docs: &ApiDocsStore,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    if input.content.trim().is_empty() {
        return Err(invalid("conteúdo vazio"));
    }

    let target = DocsTarget::new(docs, input.root_path);
    run_blocking(move || import_collections_from_content(&input.content, &target)).await
}

/// Núcleo compartilhado por `import_collections`, `import_collections_from_text`
/// e `import_collections_from_url`: tenta os formatos estruturados suportados
/// antes do formato Alcy. Erros de formato reconhecido são definitivos;
/// somente o sinal explícito de "não reconhecido" avança para o próximo.
/// Comandos `curl`/`wget` vêm primeiro porque não são YAML válido e o
/// parser de OpenAPI os rejeitaria como sintaxe inválida.
///
/// A documentação trazida pela importação é gravada no workspace antes de
/// devolver as coleções — só elas cruzam o IPC, com `docsRef` apontando para
/// a fonte gravada (ADR 0035).
fn import_collections_from_content(
    raw: &str,
    target: &DocsTarget,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let imported = parse_import_content(raw)?;
    import_collections_from_imported(imported, target, true)
}

fn parse_import_content(
    raw: &str,
) -> Result<alcy_collection_import::ImportedCollectionData, CollectionsCommandError> {
    let imported = match alcy_collection_import::parse_shell_commands(raw) {
        Ok(imported) => imported,
        Err(alcy_collection_import::CollectionImportError::NotRecognized) => {
            import_structured_document(raw)?
        }
        Err(error) => return Err(invalid(error.to_string())),
    };

    Ok(imported)
}

fn import_collections_from_imported(
    imported: alcy_collection_import::ImportedCollectionData,
    target: &DocsTarget,
    include_documentation: bool,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let script_count = imported.script_count;
    let warnings = imported
        .warnings
        .iter()
        .map(|warning| ImportWarningDto {
            request_path: warning.request_path.clone(),
            phase: warning.phase.clone(),
            line: warning.line,
            api: warning.api.clone(),
            reason: warning.reason.clone(),
        })
        .collect();
    let mut collections: Vec<CollectionDto> =
        imported.collections.iter().map(collection_to_dto).collect();
    if include_documentation && let Some(docs) = imported.docs {
        let source_id = target.store.upsert_source(&target.root, docs)?;
        for collection in &mut collections {
            fill_docs_source(
                &mut collection.requests,
                &mut collection.folders,
                &source_id,
            );
        }
    }
    if !include_documentation {
        for collection in &mut collections {
            clear_docs_refs(&mut collection.requests, &mut collection.folders);
        }
    }

    Ok(ImportCollectionsOutput {
        collections,
        environments: imported
            .environments
            .iter()
            .map(environment_to_dto)
            .collect(),
        environment_merges: Vec::new(),
        script_count,
        warnings,
    })
}

fn clear_docs_refs(requests: &mut [SavedRequestDto], folders: &mut [FolderDto]) {
    for request in requests {
        request.docs_ref = None;
    }
    for folder in folders {
        clear_docs_refs(&mut folder.requests, &mut folder.folders);
    }
}

/// Completa o `source_id` das referências criadas pela importação (as que
/// vieram vazias do conversor). Referências já completas — de um arquivo no
/// formato Alcy — ficam como estão.
fn fill_docs_source(requests: &mut [SavedRequestDto], folders: &mut [FolderDto], source_id: &str) {
    for request in requests {
        if let Some(docs_ref) = &mut request.docs_ref {
            if docs_ref.source_id.is_empty() {
                docs_ref.source_id = source_id.to_string();
            }
        }
    }
    for folder in folders {
        fill_docs_source(&mut folder.requests, &mut folder.folders, source_id);
    }
}

fn import_structured_document(
    raw: &str,
) -> Result<alcy_collection_import::ImportedCollectionData, CollectionsCommandError> {
    Ok(match alcy_openapi::parse_document(raw) {
        Ok(import) => alcy_collection_import::ImportedCollectionData {
            collections: import.collections,
            environments: Vec::new(),
            source_kind: Some(ApiDocsSourceKind::OpenApi),
            format: None,
            docs: (!import.docs.operations.is_empty()).then_some(import.docs),
            script_count: 0,
            warnings: Vec::new(),
        },
        Err(alcy_openapi::OpenApiError::NotOpenApi) => {
            match alcy_collection_import::parse_collection(raw) {
                Ok(imported) => imported,
                Err(alcy_collection_import::CollectionImportError::NotRecognized) => {
                    alcy_collection_import::ImportedCollectionData {
                        collections: alcy_storage::import_collections_from_str(raw)?,
                        environments: Vec::new(),
                        source_kind: None,
                        format: None,
                        docs: None,
                        script_count: 0,
                        warnings: Vec::new(),
                    }
                }
                Err(error) => return Err(invalid(error.to_string())),
            }
        }
        Err(error) => return Err(invalid(error.to_string())),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCollectionsFromUrlInput {
    pub url: String,
    pub root_path: String,
}

/// Importa coleções a partir do corpo de uma URL (aba "URL" da modal de
/// importar coleção) — mesma detecção de formato de `import_collections`.
#[tauri::command]
pub async fn import_collections_from_url(
    input: ImportCollectionsFromUrlInput,
    fetcher: tauri::State<'_, ImportFetcher>,
    docs: tauri::State<'_, ApiDocsStore>,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let result: Result<ImportCollectionsOutput, CollectionsCommandError> = async {
        let target = DocsTarget::new(&docs, input.root_path);
        import_collections_from_url_inner(&input.url, &fetcher, target).await
    }
    .await;
    crate::logging::logged("alcy::collections", "importar coleções de URL", result)
}

async fn import_collections_from_url_inner(
    url: &str,
    fetcher: &ImportFetcher,
    target: DocsTarget,
) -> Result<ImportCollectionsOutput, CollectionsCommandError> {
    let raw = fetcher
        .fetch_text(url)
        .await
        .map_err(|message| CollectionsCommandError::Storage { message })?;

    run_blocking(move || import_collections_from_content(&raw, &target)).await
}

/// Importa `raw` gravando a documentação em `root` — para testes de outros
/// commands que dependem de uma importação real.
#[cfg(test)]
pub(crate) fn import_collections_for_test(
    raw: &str,
    store: &ApiDocsStore,
    root: &Path,
) -> Vec<CollectionDto> {
    let target = DocsTarget {
        store: store.clone(),
        root: root.to_path_buf(),
    };
    import_collections_from_content(raw, &target)
        .expect("importação de teste válida")
        .collections
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::execute_rest_request::{FormDataFieldInput, RawBodyLanguageInput};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-collections-cmd-test-{nanos}-{count}"))
    }

    fn temp_root_path() -> String {
        temp_root().to_string_lossy().into_owned()
    }

    fn docs_target() -> DocsTarget {
        DocsTarget {
            store: ApiDocsStore::new(),
            root: temp_root(),
        }
    }

    fn sample_saved_request(id: &str, name: &str) -> SavedRequestDto {
        SavedRequestDto {
            id: id.to_string(),
            name: name.to_string(),
            protocol: "graphql".to_string(),
            endpoint: "{{baseUrl}}/graphql".to_string(),
            method: HttpMethodInput::Post,
            body: "query { ping }".to_string(),
            rest_body: None,
            variables: "{}".to_string(),
            route_params: vec![],
            headers: vec![SavedRequestHeaderDto {
                name: "Accept".to_string(),
                value: "application/json".to_string(),
                enabled: true,
            }],
            authentication: SavedRequestAuthenticationDto::Bearer {
                token: "secret".to_string(),
            },
            pre_request_script: String::new(),
            post_response_script: String::new(),
            docs_ref: None,
            grpc: None,
        }
    }

    fn sample_collections() -> Vec<CollectionDto> {
        vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Customer API".to_string(),
            folders: vec![FolderDto {
                variables: vec![],
                authentication: SavedRequestAuthenticationDto::Inherit,
                id: "folder-1".to_string(),
                name: "Authentication".to_string(),
                folders: vec![FolderDto {
                    variables: vec![],
                    authentication: SavedRequestAuthenticationDto::Inherit,
                    id: "folder-2".to_string(),
                    name: "Refresh token".to_string(),
                    folders: vec![],
                    requests: vec![sample_saved_request("request-1", "Refresh")],
                }],
                requests: vec![],
            }],
            requests: vec![sample_saved_request("request-2", "Health check")],
        }]
    }

    #[test]
    fn lists_no_collections_when_nothing_is_persisted() {
        let root = temp_root();

        let collections = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert!(collections.is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_list_round_trips_nested_collections_with_full_request_content() {
        let root = temp_root();

        save_collections_inner(root.clone(), sample_collections()).unwrap();
        let collections = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(collections, sample_collections());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_list_round_trips_a_rest_request_with_its_method_and_body() {
        let root = temp_root();
        let mut request = sample_saved_request("request-1", "Create order");
        request.protocol = "rest".to_string();
        request.method = HttpMethodInput::Put;
        request.body = "{\"status\":\"paid\"}".to_string();
        request.rest_body = Some(BodyInput::Raw {
            content: "{\"status\":\"paid\"}".to_string(),
            raw_language: RawBodyLanguageInput::Json,
        });
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Customer API".to_string(),
            folders: vec![],
            requests: vec![request],
        }];

        save_collections_inner(root.clone(), dtos.clone()).unwrap();
        let collections = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(collections, dtos);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_list_round_trips_a_grpc_request_with_its_call() {
        let root = temp_root();
        let mut request = sample_saved_request("request-1", "Say hello");
        request.protocol = "grpc".to_string();
        request.endpoint = "localhost:50051".to_string();
        request.body = "{\"name\":\"ana\"}".to_string();
        request.grpc = Some(GrpcCallDto {
            service: "helloworld.Greeter".to_string(),
            method: "SayHello".to_string(),
            schema_source: GrpcSchemaSourceDto::ProtoFiles {
                files: vec!["protos/hello.proto".to_string()],
                import_paths: vec!["protos".to_string()],
            },
            deadline_ms: Some(3_000),
        });
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Services".to_string(),
            folders: vec![],
            requests: vec![request],
        }];

        save_collections_inner(root.clone(), dtos.clone()).unwrap();
        let collections = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(collections, dtos);
        let json = serde_json::to_value(&collections[0].requests[0]).unwrap();
        assert_eq!(json["grpc"]["schemaSource"]["type"], "protoFiles");
        assert_eq!(json["grpc"]["schemaSource"]["importPaths"][0], "protos");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_list_round_trips_a_form_data_body_including_disabled_fields() {
        let root = temp_root();
        let mut request = sample_saved_request("request-1", "Upload");
        request.protocol = "rest".to_string();
        request.body = String::new();
        request.rest_body = Some(BodyInput::FormData {
            fields: vec![
                FormDataFieldInput::Text {
                    name: "title".to_string(),
                    enabled: false,
                    value: "photo".to_string(),
                },
                FormDataFieldInput::File {
                    name: "file".to_string(),
                    enabled: true,
                    file_path: "/tmp/photo.png".to_string(),
                },
            ],
        });
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Customer API".to_string(),
            folders: vec![],
            requests: vec![request],
        }];

        save_collections_inner(root.clone(), dtos.clone()).unwrap();
        let collections = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(collections, dtos);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_legacy_rest_dto_without_rest_body_lists_back_as_raw_json() {
        let root = temp_root();
        let mut request = sample_saved_request("request-1", "Create order");
        request.protocol = "rest".to_string();
        request.body = "{}".to_string();
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Customer API".to_string(),
            folders: vec![],
            requests: vec![request],
        }];

        save_collections_inner(root.clone(), dtos).unwrap();
        let collections = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(
            collections[0].requests[0].rest_body,
            Some(BodyInput::Raw {
                content: "{}".to_string(),
                raw_language: RawBodyLanguageInput::Json,
            })
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_rejects_an_empty_collection_name() {
        let root = temp_root();
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "".to_string(),
            folders: vec![],
            requests: vec![],
        }];

        let error = save_collections_inner(root.clone(), dtos).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_list_round_trips_collection_labels() {
        let root = temp_root();
        let mut dtos = sample_collections();
        dtos[0].labels = vec![
            CollectionLabelDto {
                name: "Pagamentos".to_string(),
                color: "green".to_string(),
            },
            CollectionLabelDto {
                name: "Legado".to_string(),
                color: "gray".to_string(),
            },
        ];

        save_collections_inner(root.clone(), dtos.clone()).unwrap();
        let collections = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(collections[0].labels, dtos[0].labels);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_rejects_an_unknown_label_color_or_duplicate_label() {
        let root = temp_root();
        let mut unknown_color = sample_collections();
        unknown_color[0].labels = vec![CollectionLabelDto {
            name: "Pagamentos".to_string(),
            color: "magenta".to_string(),
        }];
        let mut duplicate = sample_collections();
        duplicate[0].labels = vec![
            CollectionLabelDto {
                name: "Pagamentos".to_string(),
                color: "green".to_string(),
            },
            CollectionLabelDto {
                name: "pagamentos".to_string(),
                color: "red".to_string(),
            },
        ];

        for dtos in [unknown_color, duplicate] {
            let error = save_collections_inner(root.clone(), dtos).unwrap_err();
            assert!(matches!(error, CollectionsCommandError::Invalid { .. }));
        }

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_rejects_duplicate_sibling_folder_names() {
        let root = temp_root();
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Customer API".to_string(),
            folders: vec![
                FolderDto {
                    variables: vec![],
                    authentication: SavedRequestAuthenticationDto::Inherit,
                    id: "folder-1".to_string(),
                    name: "Orders".to_string(),
                    folders: vec![],
                    requests: vec![],
                },
                FolderDto {
                    variables: vec![],
                    authentication: SavedRequestAuthenticationDto::Inherit,
                    id: "folder-2".to_string(),
                    name: "Orders".to_string(),
                    folders: vec![],
                    requests: vec![],
                },
            ],
            requests: vec![],
        }];

        let error = save_collections_inner(root.clone(), dtos).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_rejects_an_unknown_protocol() {
        let root = temp_root();
        let mut request = sample_saved_request("request-1", "Ping");
        request.protocol = "soap".to_string();
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Customer API".to_string(),
            folders: vec![],
            requests: vec![request],
        }];

        let error = save_collections_inner(root.clone(), dtos).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));

        fs::remove_dir_all(&root).ok();
    }

    /// Requisição recém-criada nasce sem URL (spec 0089): gravar as coleções
    /// não pode falhar por causa dela — só a execução exige um endereço.
    #[test]
    fn save_accepts_a_request_without_endpoint() {
        let root = temp_root();
        let mut request = sample_saved_request("request-1", "Ping");
        request.endpoint = "".to_string();
        let dtos = vec![CollectionDto {
            variables: vec![],
            labels: vec![],
            authentication: SavedRequestAuthenticationDto::Inherit,
            id: "collection-1".to_string(),
            name: "Customer API".to_string(),
            folders: vec![],
            requests: vec![request],
        }];

        save_collections_inner(root.clone(), dtos).unwrap();
        let loaded = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(loaded[0].requests[0].endpoint, "");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn export_then_import_round_trips_collections_at_an_arbitrary_path() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("export.alcy.json");

        export_collections_inner(path.clone(), sample_collections()).unwrap();
        let imported = import_collections_inner(path, &docs_target()).unwrap();

        assert_eq!(imported.collections, sample_collections());
        assert!(imported.environments.is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn export_can_write_a_single_collection() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("export.alcy.json");
        let mut collections = sample_collections();
        collections.truncate(1);

        export_collections_inner(path.clone(), collections.clone()).unwrap();
        let imported = import_collections_inner(path, &docs_target()).unwrap();

        assert_eq!(imported.collections, collections);
        assert!(imported.environments.is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_fails_with_storage_error_when_the_file_does_not_exist() {
        let root = temp_root();
        let path = root.join("missing.alcy.json");

        let error = import_collections_inner(path, &docs_target()).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Storage { .. }));
    }

    const SAMPLE_OPENAPI_JSON: &str = r#"{
        "openapi": "3.0.3",
        "info": {"title": "Pet Store"},
        "paths": {
            "/pets": {
                "get": {"summary": "List pets"}
            }
        }
    }"#;

    const SAMPLE_OPENAPI_YAML: &str = "
openapi: 3.0.3
info:
  title: Pet Store
paths:
  /pets:
    get:
      summary: List pets
";

    const SAMPLE_NESTED_COLLECTION: &str = r#"{
        "info": {
            "name": "Customer API",
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
        },
        "variable": [{"key": "baseUrl", "value": "https://api.example.com"}],
        "item": [{
            "name": "List customers",
            "request": {"method": "GET", "url": "https://api.example.com/customers"}
        }]
    }"#;

    const SAMPLE_TREE_COLLECTION: &str = "
type: collection.insomnia.rest/5.0
schema_version: \"5.1\"
name: Orders API
meta:
  id: wrk_orders
environments:
  name: Base Environment
  data:
    baseUrl: https://api.example.com
collection:
  - name: List orders
    url: https://api.example.com/orders
    method: GET
";

    #[test]
    fn preparing_an_import_returns_a_summary_without_writing_docs() {
        let root = temp_root();
        let prepared = PreparedImports::default();
        let imported = parse_import_content(SAMPLE_OPENAPI_JSON).unwrap();

        let summary =
            store_prepared_import(&prepared, imported, root.to_string_lossy().into_owned())
                .unwrap();

        assert_eq!(summary.format, "openapi");
        assert_eq!(summary.collection_count, 1);
        assert_eq!(summary.folder_count, 1);
        assert_eq!(summary.request_count, 1);
        assert!(summary.supports_documentation);
        assert!(!root.join("alcy-api-docs.json").exists());
        assert_eq!(summary.collection_names, ["Pet Store"]);
        assert_eq!(
            summary.variables,
            [ImportVariableCandidateDto {
                key: "ref:baseUrl".to_string(),
                name: "baseUrl".to_string(),
                value: String::new(),
                value_truncated: false,
                sensitive: false,
                origin: VariableOriginDto::Referenced,
                included: false,
            }]
        );
    }

    #[test]
    fn committing_with_variable_choices_renames_and_merges() {
        let imported = parse_import_content(
            r#"{
                "info": {"name": "Customer API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
                "variable": [{"key": "baseUrl", "value": "https://api.example.com"}],
                "item": [{"name": "List", "request": {"method": "GET", "url": "{{baseUrl}}/customers?key={{apiKey}}"}}]
            }"#,
        )
        .unwrap();
        let selections: Vec<VariableSelectionDto> = serde_json::from_str(
            r#"[
                {"key": "collection:0:baseUrl", "include": true, "name": "host", "value": null,
                 "sensitive": false, "target": {"kind": "collection", "index": 0}},
                {"key": "ref:apiKey", "include": true, "name": "apiKey", "value": "k",
                 "sensitive": true, "target": {"kind": "existingEnvironment", "id": "env-1"}}
            ]"#,
        )
        .unwrap();

        let output =
            commit_with_variables(imported, &docs_target(), false, Some(selections)).unwrap();

        let collection = &output.collections[0];
        assert_eq!(collection.variables[0].name, "host");
        assert_eq!(
            collection.requests[0].endpoint,
            "{{host}}/customers?key={{apiKey}}"
        );
        assert_eq!(
            output.environment_merges,
            [EnvironmentMergeDto {
                environment_id: "env-1".to_string(),
                variables: vec![EnvironmentVariableDto {
                    name: "apiKey".to_string(),
                    value: "k".to_string(),
                    sensitive: true,
                }],
            }]
        );
    }

    #[test]
    fn preparing_a_har_file_labels_it_as_har() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.har");
        fs::write(
            &path,
            r#"{"log": {"version": "1.2", "creator": {"name": "Browser"}, "entries": [
                {"request": {"method": "GET", "url": "https://api.example.com/users", "headers": []}},
                {"request": {"method": "POST", "url": "https://auth.example.com/token", "headers": []}}
            ]}}"#,
        )
        .unwrap();
        let prepared = PreparedImports::default();
        let imported = read_import_from_path(path).unwrap();

        let summary =
            store_prepared_import(&prepared, imported, root.to_string_lossy().into_owned())
                .unwrap();

        assert_eq!(summary.format, "har");
        assert_eq!(summary.collection_count, 1);
        assert_eq!(summary.folder_count, 2);
        assert_eq!(summary.request_count, 2);
        assert!(!summary.supports_documentation);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn committing_without_documentation_clears_references_and_writes_no_docs() {
        let root = temp_root();
        let target = DocsTarget {
            store: ApiDocsStore::new(),
            root: root.clone(),
        };
        let imported = parse_import_content(SAMPLE_OPENAPI_JSON).unwrap();

        let output = import_collections_from_imported(imported, &target, false).unwrap();

        assert!(
            output.collections[0].folders[0].requests[0]
                .docs_ref
                .is_none()
        );
        assert!(!root.join("alcy-api-docs.json").exists());
    }

    #[test]
    fn imports_a_json_openapi_document_as_a_collection() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("petstore.json");
        fs::write(&path, SAMPLE_OPENAPI_JSON).unwrap();

        let imported = import_collections_inner(path, &docs_target()).unwrap();
        let collections = imported.collections;

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "Pet Store");
        assert_eq!(collections[0].folders[0].name, "pets");
        assert_eq!(collections[0].folders[0].requests.len(), 1);
        assert_eq!(collections[0].folders[0].requests[0].name, "List pets");
        assert_eq!(collections[0].folders[0].requests[0].protocol, "rest");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn imports_a_yaml_openapi_document_as_a_collection() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("petstore.yaml");
        fs::write(&path, SAMPLE_OPENAPI_YAML).unwrap();

        let imported = import_collections_inner(path, &docs_target()).unwrap();
        let collections = imported.collections;

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "Pet Store");
        assert_eq!(collections[0].folders[0].requests.len(), 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn imports_a_nested_collection_document_from_a_file() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("collection.json");
        fs::write(&path, SAMPLE_NESTED_COLLECTION).unwrap();

        let imported = import_collections_inner(path, &docs_target()).unwrap();
        let collections = imported.collections;

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "Customer API");
        assert_eq!(collections[0].requests[0].name, "List customers");
        assert_eq!(collections[0].requests[0].method, HttpMethodInput::Get);
        assert!(imported.environments.is_empty());
        assert_eq!(collections[0].variables[0].name, "baseUrl");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn imports_all_yaml_files_from_an_open_collection_directory() {
        let root = temp_root();
        fs::create_dir_all(root.join("users")).unwrap();
        fs::write(
            root.join("opencollection.yml"),
            "opencollection: \"1.0.0\"\ninfo:\n  name: Demo\nrequest:\n  variables:\n    - name: host\n      value: collection.test\n",
        )
        .unwrap();
        fs::write(
            root.join("users/folder.yml"),
            "info:\n  name: Users\n  type: folder\nrequest:\n  variables:\n    - name: host\n      value: folder.test\n",
        )
        .unwrap();
        fs::write(
            root.join("users/get.yml"),
            "info:\n  name: Get user\n  type: http\nhttp:\n  method: GET\n  url: https://{{host}}/users/1\nruntime:\n  scripts:\n    - type: before-request\n      code: bru.setEnvVar('token', 'abc')\n",
        )
        .unwrap();

        let imported = import_collections_inner(root.clone(), &docs_target()).unwrap();
        let collection = &imported.collections[0];
        let folder = &collection.folders[0];

        assert_eq!(collection.variables[0].value, "collection.test");
        assert_eq!(folder.variables[0].value, "folder.test");
        assert_eq!(folder.requests[0].name, "Get user");
        assert!(
            folder.requests[0]
                .pre_request_script
                .contains("al.environment.set")
        );

        fs::remove_dir_all(&root).ok();
    }

    fn write_bruno_tree(root: &Path) {
        fs::create_dir_all(root.join("users")).unwrap();
        fs::write(root.join("bruno.json"), r#"{"name":"Demo"}"#).unwrap();
        fs::write(
            root.join("users/get.bru"),
            "meta {\n name: Get user\n}\nget {\n url: https://example.test/users\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("users/list.bru"),
            "meta {\n name: List users\n}\nget {\n url: https://example.test/users\n}\n",
        )
        .unwrap();
    }

    #[test]
    fn importing_the_bruno_json_file_imports_the_whole_tree_collection() {
        let root = temp_root();
        write_bruno_tree(&root);

        let imported = import_collections_inner(root.join("bruno.json"), &docs_target()).unwrap();
        let folder = &imported.collections[0].folders[0];

        assert_eq!(imported.collections.len(), 1);
        assert_eq!(folder.requests.len(), 2);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn importing_a_nested_bru_file_imports_the_collection_it_belongs_to() {
        let root = temp_root();
        write_bruno_tree(&root);

        let imported =
            import_collections_inner(root.join("users/get.bru"), &docs_target()).unwrap();

        assert_eq!(imported.collections[0].folders[0].requests.len(), 2);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_bruno_files_resolve_to_a_tree_collection_root() {
        let root = temp_root();
        write_bruno_tree(&root);
        fs::write(root.join("users/openapi.json"), "{}").unwrap();

        assert_eq!(
            bruno_collection_root(&root.join("users/get.bru")),
            Some(root.clone())
        );
        assert_eq!(
            bruno_collection_root(&root.join("users/openapi.json")),
            None
        );

        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn imports_a_tree_collection_document_from_text() {
        let imported = import_collections_from_text_inner(
            ImportCollectionsFromTextInput {
                root_path: temp_root_path(),
                content: SAMPLE_TREE_COLLECTION.to_string(),
            },
            &ApiDocsStore::new(),
        )
        .await
        .unwrap();
        let collections = imported.collections;

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "Orders API");
        assert_eq!(collections[0].requests[0].name, "List orders");
        assert_eq!(collections[0].requests[0].protocol, "rest");
        assert_eq!(imported.environments.len(), 1);
        assert_eq!(imported.environments[0].variables[0].name, "baseUrl");
    }

    #[test]
    fn import_still_reads_the_alcy_format_when_the_file_is_not_openapi() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("export.alcy.json");

        export_collections_inner(path.clone(), sample_collections()).unwrap();
        let imported = import_collections_inner(path, &docs_target()).unwrap();

        assert_eq!(imported.collections, sample_collections());
        assert!(imported.environments.is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_rejects_an_invalid_openapi_document() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("broken.json");
        fs::write(
            &path,
            r#"{"openapi": "3.0.0", "info": {"title": "X"}, "paths": "oops"}"#,
        )
        .unwrap();

        let error = import_collections_inner(path, &docs_target()).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_surfaces_an_unsupported_openapi_version_as_invalid_instead_of_falling_back() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("old-openapi.json");
        fs::write(&path, r#"{"openapi": "2.0", "paths": {}}"#).unwrap();

        let error = import_collections_inner(path, &docs_target()).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_falls_back_to_storage_error_for_a_file_that_is_neither_openapi_nor_alcy_format() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("not-openapi-not-alcy.json");
        fs::write(&path, r#"{"foo": "bar"}"#).unwrap();

        let error = import_collections_inner(path, &docs_target()).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Storage { .. }));

        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn import_from_text_parses_a_pasted_openapi_document() {
        let imported = import_collections_from_text_inner(
            ImportCollectionsFromTextInput {
                root_path: temp_root_path(),
                content: SAMPLE_OPENAPI_JSON.to_string(),
            },
            &ApiDocsStore::new(),
        )
        .await
        .unwrap();
        let collections = imported.collections;

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "Pet Store");
    }

    #[tokio::test]
    async fn import_from_text_parses_pasted_alcy_format_content() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("export.alcy.json");
        export_collections_inner(path.clone(), sample_collections()).unwrap();
        let raw = fs::read_to_string(&path).unwrap();

        let imported = import_collections_from_text_inner(
            ImportCollectionsFromTextInput {
                root_path: temp_root_path(),
                content: raw,
            },
            &ApiDocsStore::new(),
        )
        .await
        .unwrap();

        assert_eq!(imported.collections, sample_collections());
        assert!(imported.environments.is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn import_from_text_rejects_empty_content() {
        let error = import_collections_from_text_inner(
            ImportCollectionsFromTextInput {
                root_path: temp_root_path(),
                content: "   ".to_string(),
            },
            &ApiDocsStore::new(),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));
    }

    /// PNG mínimo com um chunk `iTXt` não comprimido — o que o frontend
    /// grava no "Compartilhar como imagem".
    fn png_with_text(keyword: &str, text: &str) -> Vec<u8> {
        fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(kind);
            out.extend_from_slice(data);
            out.extend_from_slice(&[0; 4]);
        }
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        chunk(&mut out, b"IHDR", &[0; 13]);
        let mut data = keyword.as_bytes().to_vec();
        data.extend_from_slice(&[0, 0, 0, 0, 0]);
        data.extend_from_slice(text.as_bytes());
        chunk(&mut out, b"iTXt", &data);
        chunk(&mut out, b"IEND", &[]);
        out
    }

    #[tokio::test]
    async fn imports_the_request_embedded_in_a_shared_image() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let text = serialize_collections(SerializeCollectionsInput {
            collections: sample_collections(),
        })
        .await
        .unwrap();
        let path = root.join("requisição.png");
        fs::write(
            &path,
            png_with_text(alcy_collection_import::IMPORT_PNG_KEYWORD, &text),
        )
        .unwrap();

        let imported = import_collections_inner(path, &docs_target()).unwrap();

        assert_eq!(imported.collections, sample_collections());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_rejects_an_image_without_alcy_metadata() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("foto.png");
        fs::write(&path, png_with_text("Comment", "qualquer")).unwrap();

        let error = import_collections_inner(path, &docs_target()).unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));
        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn import_from_text_parses_pasted_curl_and_wget_commands() {
        let imported = import_collections_from_text_inner(ImportCollectionsFromTextInput {
            root_path: temp_root_path(),
            content: "curl --request POST \\\n  --url 'https://api.example.com/users' \\\n  --header 'Content-Type: application/json' \\\n  --data-raw '{\"name\": \"Ada\"}'\nwget --quiet --method=GET --output-document=- 'https://api.example.com/users'".to_string(),
        }, &ApiDocsStore::new())
        .await
        .unwrap();
        let collections = imported.collections;

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "api.example.com");
        let requests = &collections[0].requests;
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].name, "POST /users");
        assert_eq!(requests[0].endpoint, "https://api.example.com/users");
        assert_eq!(requests[0].body, "{\"name\": \"Ada\"}");
        assert_eq!(requests[1].name, "GET /users");
        assert!(imported.environments.is_empty());
    }

    #[tokio::test]
    async fn import_from_text_reports_a_broken_curl_command_as_invalid() {
        let error = import_collections_from_text_inner(
            ImportCollectionsFromTextInput {
                root_path: temp_root_path(),
                content: "curl --header 'Accept: */*".to_string(),
            },
            &ApiDocsStore::new(),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Invalid { .. }));
    }

    #[tokio::test]
    async fn import_from_url_fetches_and_parses_an_openapi_document() {
        use wiremock::matchers::{method, path as path_matcher};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_matcher("/openapi.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(SAMPLE_OPENAPI_JSON))
            .mount(&server)
            .await;
        let fetcher = crate::commands::import_fetcher::ImportFetcher::new();

        let imported = import_collections_from_url_inner(
            &format!("{}/openapi.json", server.uri()),
            &fetcher,
            docs_target(),
        )
        .await
        .unwrap();
        let collections = imported.collections;

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "Pet Store");
    }

    #[tokio::test]
    async fn import_from_url_surfaces_a_fetch_error() {
        use wiremock::matchers::{method, path as path_matcher};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_matcher("/missing.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let fetcher = crate::commands::import_fetcher::ImportFetcher::new();

        let error = import_collections_from_url_inner(
            &format!("{}/missing.json", server.uri()),
            &fetcher,
            docs_target(),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, CollectionsCommandError::Storage { .. }));
    }

    #[test]
    fn listing_collections_drops_documentation_no_request_references_anymore() {
        let root = temp_root();
        let store = ApiDocsStore::new();
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "Pet Store"},
            "paths": {"/pets": {"get": {"operationId": "listPets", "summary": "Lista"}}}
        }"#;
        let imported = import_collections_for_test(raw, &store, &root);
        let docs_file = root.join(alcy_domain::API_DOCS_FILE);
        assert!(docs_file.exists());

        // Enquanto a coleção importada existir, a documentação fica.
        save_collections_inner(root.clone(), imported).unwrap();
        list_collections_inner(root.clone(), &store).unwrap();
        assert!(docs_file.exists());

        // Removida a coleção, a documentação órfã some na próxima listagem.
        save_collections_inner(root.clone(), vec![]).unwrap();
        list_collections_inner(root.clone(), &store).unwrap();
        assert!(!docs_file.exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn saving_and_listing_round_trips_the_docs_reference() {
        let root = temp_root();
        let mut collections = sample_collections();
        collections[0].requests[0].docs_ref = Some(DocsRefDto {
            source_id: "abc".to_string(),
            operation_id: "listPets".to_string(),
        });

        save_collections_inner(root.clone(), collections.clone()).unwrap();
        // Sem arquivo de documentação não há o que limpar.
        let listed = list_collections_inner(root.clone(), &ApiDocsStore::new()).unwrap();

        assert_eq!(listed, collections);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn expand_lists_importable_files_of_a_folder_recursively_in_order() {
        let root = temp_root();
        fs::create_dir_all(root.join("nested/deeper")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("b.yaml"), "").unwrap();
        fs::write(root.join("a.json"), "").unwrap();
        fs::write(root.join("notes.md"), "").unwrap();
        fs::write(root.join("shared.png"), "").unwrap();
        fs::write(root.join(".hidden.json"), "").unwrap();
        fs::write(root.join("nested/curl.SH"), "").unwrap();
        fs::write(root.join("nested/deeper/env.yml"), "").unwrap();
        fs::write(root.join("nested/session.har"), "").unwrap();
        fs::write(root.join(".git/config.json"), "").unwrap();
        fs::write(root.join("node_modules/pkg/package.json"), "").unwrap();

        let paths = expand_import_paths_inner(vec![root.clone()]).unwrap();

        let expected: Vec<String> = [
            "a.json",
            "b.yaml",
            "nested/curl.SH",
            "nested/deeper/env.yml",
            "nested/session.har",
        ]
        .iter()
        .map(|relative| root.join(relative).to_string_lossy().into_owned())
        .collect();
        assert_eq!(paths, expected);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn expand_keeps_bruno_collection_roots_whole() {
        let root = temp_root();
        fs::create_dir_all(root.join("bruno/requests")).unwrap();
        fs::write(root.join("bruno/bruno.json"), "{}").unwrap();
        fs::write(root.join("bruno/requests/get.bru"), "").unwrap();
        fs::write(root.join("bruno/requests/extra.json"), "").unwrap();
        fs::write(root.join("postman.json"), "").unwrap();

        let paths = expand_import_paths_inner(vec![root.clone()]).unwrap();
        assert_eq!(
            paths,
            vec![
                root.join("bruno").to_string_lossy().into_owned(),
                root.join("postman.json").to_string_lossy().into_owned(),
            ]
        );

        let direct = expand_import_paths_inner(vec![root.join("bruno")]).unwrap();
        assert_eq!(
            direct,
            vec![root.join("bruno").to_string_lossy().into_owned()]
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn expand_passes_files_through_and_returns_nothing_for_an_empty_folder() {
        let root = temp_root();
        fs::create_dir_all(root.join("empty")).unwrap();
        let file = root.join("image.png");
        fs::write(&file, "").unwrap();

        let paths = expand_import_paths_inner(vec![file.clone(), root.join("empty")]).unwrap();

        assert_eq!(paths, vec![file.to_string_lossy().into_owned()]);

        fs::remove_dir_all(&root).ok();
    }
}
