use std::fs;
use std::path::{Path, PathBuf};

use alcy_domain::{
    Authentication, BodyPayload, Collection, CollectionLabel, DocsRef, Endpoint,
    EnvironmentVariable, Folder, FormDataField, FormDataFieldValue, GrpcCall, GrpcSchemaSource,
    HeaderEntry, HttpMethod, LabelColor, ProtocolId, RawBodyLanguage, Request, RequestDocument,
    RouteParameter, SavedRequest, UrlEncodedField, WebSocketCall, WebSocketCollect,
    WebSocketMessageFormat,
};
use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;
const MANIFEST_FILE_NAME: &str = "alcy-collections.json";

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    collections: Vec<PersistedCollection>,
}

#[derive(Serialize, Deserialize)]
struct PersistedCollection {
    id: String,
    name: String,
    folders: Vec<PersistedFolder>,
    #[serde(default)]
    requests: Vec<PersistedRequest>,
    #[serde(default = "inherit_authentication")]
    authentication: PersistedAuthentication,
    /// Aditivo (ADR 0031): omitido quando vazio, para que coleções sem
    /// variáveis não mudem no disco.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    variables: Vec<PersistedScopedVariable>,
    /// Aditivo (ADR 0060): omitido quando vazio, como `variables`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    labels: Vec<PersistedLabel>,
}

/// Rótulo de coleção. A cor é a chave da paleta; uma chave desconhecida
/// (gravada por uma versão mais nova) carrega como cinza (ADR 0060).
#[derive(Serialize, Deserialize)]
struct PersistedLabel {
    name: String,
    color: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedFolder {
    id: String,
    name: String,
    folders: Vec<PersistedFolder>,
    #[serde(default)]
    requests: Vec<PersistedRequest>,
    #[serde(default = "inherit_authentication")]
    authentication: PersistedAuthentication,
    /// Aditivo (ADR 0031): omitido quando vazio, para que coleções sem
    /// variáveis não mudem no disco.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    variables: Vec<PersistedScopedVariable>,
}

/// Também usado pelo node de requisição avulsa de um flow (`flow_store.rs`,
/// spec 0086) — mesmo formato no disco.
#[derive(Serialize, Deserialize)]
pub(crate) struct PersistedRequest {
    id: String,
    name: String,
    protocol: String,
    endpoint: String,
    body: String,
    variables: String,
    headers: Vec<PersistedHeader>,
    authentication: PersistedAuthentication,
    #[serde(default = "default_persisted_method")]
    method: String,
    #[serde(default)]
    pre_request_script: String,
    #[serde(default)]
    post_response_script: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    route_parameters: Vec<PersistedRouteParameter>,
    /// Aditivo (tipos de corpo REST) — requisições gravadas antes desta
    /// mudança sempre tratavam `body` como texto "raw", então é o único
    /// default coerente com o comportamento anterior.
    #[serde(default = "default_persisted_body_type")]
    body_type: String,
    #[serde(default = "default_persisted_raw_language")]
    raw_body_language: String,
    #[serde(default)]
    form_data: Vec<PersistedFormDataField>,
    #[serde(default)]
    url_encoded: Vec<PersistedUrlEncodedField>,
    #[serde(default)]
    binary_file_path: String,
    /// Aditivo (ADR 0035): omitido quando a requisição não tem documentação
    /// importada, para que requisições comuns não mudem no disco.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    docs_ref: Option<PersistedDocsRef>,
    /// Additive (spec 0129): only gRPC requests write it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grpc: Option<PersistedGrpcCall>,
    /// Additive (spec 0140): only WebSocket requests write it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    websocket: Option<PersistedWebSocketCall>,
}

/// Also stored in history details (`history_store.rs`).
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedWebSocketCall {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subprotocols: Vec<String>,
    /// `text`, `json` or `binary`; an unknown value reads as text so a newer
    /// format never makes a request unreadable.
    #[serde(default)]
    message_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_messages: Option<u32>,
}

pub(crate) fn websocket_from_persisted(persisted: PersistedWebSocketCall) -> WebSocketCall {
    WebSocketCall {
        subprotocols: persisted.subprotocols,
        message_format: match persisted.message_format.as_str() {
            "json" => WebSocketMessageFormat::Json,
            "binary" => WebSocketMessageFormat::Binary,
            _ => WebSocketMessageFormat::Text,
        },
        collect: WebSocketCollect {
            wait_ms: persisted.wait_ms,
            expected_messages: persisted.expected_messages,
        },
    }
}

pub(crate) fn persisted_from_websocket(call: &WebSocketCall) -> PersistedWebSocketCall {
    PersistedWebSocketCall {
        subprotocols: call.subprotocols.clone(),
        message_format: match call.message_format {
            WebSocketMessageFormat::Text => "text",
            WebSocketMessageFormat::Json => "json",
            WebSocketMessageFormat::Binary => "binary",
        }
        .to_string(),
        wait_ms: call.collect.wait_ms,
        expected_messages: call.collect.expected_messages,
    }
}

/// Also stored in history details (`history_store.rs`).
#[derive(Serialize, Deserialize)]
pub(crate) struct PersistedGrpcCall {
    service: String,
    method: String,
    #[serde(default)]
    schema_source: PersistedGrpcSchemaSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deadline_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedGrpcSchemaSource {
    #[default]
    Reflection,
    ProtoFiles {
        files: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        import_paths: Vec<String>,
    },
}

pub(crate) fn grpc_from_persisted(persisted: PersistedGrpcCall) -> GrpcCall {
    GrpcCall {
        service: persisted.service,
        method: persisted.method,
        schema_source: match persisted.schema_source {
            PersistedGrpcSchemaSource::Reflection => GrpcSchemaSource::Reflection,
            PersistedGrpcSchemaSource::ProtoFiles {
                files,
                import_paths,
            } => GrpcSchemaSource::ProtoFiles {
                files,
                import_paths,
            },
        },
        deadline_ms: persisted.deadline_ms,
    }
}

pub(crate) fn persisted_from_grpc(call: &GrpcCall) -> PersistedGrpcCall {
    PersistedGrpcCall {
        service: call.service.clone(),
        method: call.method.clone(),
        schema_source: match &call.schema_source {
            GrpcSchemaSource::Reflection => PersistedGrpcSchemaSource::Reflection,
            GrpcSchemaSource::ProtoFiles {
                files,
                import_paths,
            } => PersistedGrpcSchemaSource::ProtoFiles {
                files: files.clone(),
                import_paths: import_paths.clone(),
            },
        },
        deadline_ms: call.deadline_ms,
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedRouteParameter {
    name: String,
    value: String,
}

/// Referência à documentação importada em `alcy-api-docs.json` (ADR 0035).
#[derive(Serialize, Deserialize)]
struct PersistedDocsRef {
    source_id: String,
    operation_id: String,
}

/// Pastas e coleções gravadas antes da herança não têm o campo; `Inherit`
/// preserva o comportamento anterior (nada é aplicado pelos ancestrais).
fn inherit_authentication() -> PersistedAuthentication {
    PersistedAuthentication::Inherit
}

fn default_persisted_method() -> String {
    "post".to_string()
}

fn default_persisted_body_type() -> String {
    "raw".to_string()
}

fn default_persisted_raw_language() -> String {
    "json".to_string()
}

/// Variável de coleção/pasta: sem `sensitive`, o escopo local não guarda
/// segredos (ADR 0031).
#[derive(Serialize, Deserialize)]
struct PersistedScopedVariable {
    name: String,
    value: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedHeader {
    name: String,
    value: String,
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
struct PersistedUrlEncodedField {
    name: String,
    value: String,
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
struct PersistedFormDataField {
    name: String,
    enabled: bool,
    value: PersistedFormDataFieldValue,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedFormDataFieldValue {
    Text { value: String },
    File { file_path: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedAuthentication {
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

/// Lê e grava as coleções de um workspace (`alcy-collections.json`) na
/// raiz da pasta do workspace, com escrita atômica (arquivo temporário +
/// rename) e formato versionado.
pub struct CollectionsStore {
    manifest_path: PathBuf,
}

impl CollectionsStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            manifest_path: root.join(MANIFEST_FILE_NAME),
        }
    }

    pub fn load(&self) -> Result<Vec<Collection>, StorageError> {
        if !self.manifest_path.exists() {
            return Ok(Vec::new());
        }

        import_collections(&self.manifest_path)
    }

    pub fn save(&self, collections: &[Collection]) -> Result<(), StorageError> {
        write_collections_file(&self.manifest_path, collections)
    }
}

/// Exporta coleções (uma ou todas) para um caminho de arquivo escolhido
/// pelo usuário, no mesmo formato versionado de `alcy-collections.json`
/// (backup/portabilidade — "formato Alcy").
pub fn export_collections(path: &Path, collections: &[Collection]) -> Result<(), StorageError> {
    write_collections_file(path, collections)
}

/// Importa coleções de um arquivo no "formato Alcy". Diferente de
/// `CollectionsStore::load`, um caminho inexistente é um erro real (o
/// caminho vem de um diálogo de abrir arquivo, não da raiz de um
/// workspace que pode ainda não ter coleções).
pub fn import_collections(path: &Path) -> Result<Vec<Collection>, StorageError> {
    let raw = fs::read_to_string(path).map_err(|error| StorageError::Read(error.to_string()))?;
    import_collections_from_str(&raw)
}

/// Importa coleções a partir do conteúdo já em memória (colado pelo usuário
/// ou baixado de uma URL, spec de importação por modal), no mesmo "formato
/// Alcy" — mesmas regras de erro de `import_collections`, exceto que não há
/// caminho de arquivo, então nunca há `StorageError::Read`.
pub fn import_collections_from_str(raw: &str) -> Result<Vec<Collection>, StorageError> {
    let persisted: PersistedFile =
        serde_json::from_str(raw).map_err(|error| StorageError::Corrupted(error.to_string()))?;

    if persisted.version != CURRENT_VERSION {
        return Err(StorageError::UnsupportedVersion(persisted.version));
    }

    persisted
        .collections
        .into_iter()
        .map(collection_from_persisted)
        .collect()
}

/// Coleções no "formato Alcy" compacto, sem gravar em disco — usado para
/// embutir uma requisição na imagem de compartilhamento (ADR 0032). O texto
/// volta pelo mesmo `import_collections_from_str`.
pub fn export_collections_to_string(collections: &[Collection]) -> Result<String, StorageError> {
    serde_json::to_string(&persisted_file(collections))
        .map_err(|error| StorageError::Write(error.to_string()))
}

fn persisted_file(collections: &[Collection]) -> PersistedFile {
    PersistedFile {
        version: CURRENT_VERSION,
        collections: collections.iter().map(persisted_from_collection).collect(),
    }
}

fn write_collections_file(path: &Path, collections: &[Collection]) -> Result<(), StorageError> {
    let json = serde_json::to_string_pretty(&persisted_file(collections))
        .map_err(|error| StorageError::Write(error.to_string()))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
    }

    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
    fs::rename(&tmp_path, path).map_err(|error| StorageError::Write(error.to_string()))?;

    Ok(())
}

pub(crate) fn protocol_to_str(protocol: ProtocolId) -> &'static str {
    match protocol {
        ProtocolId::GraphQl => "graphql",
        ProtocolId::Rest => "rest",
        ProtocolId::Grpc => "grpc",
        ProtocolId::WebSocket => "websocket",
    }
}

pub(crate) fn protocol_from_str(value: &str) -> Result<ProtocolId, StorageError> {
    match value {
        "graphql" => Ok(ProtocolId::GraphQl),
        "rest" => Ok(ProtocolId::Rest),
        "grpc" => Ok(ProtocolId::Grpc),
        "websocket" => Ok(ProtocolId::WebSocket),
        other => Err(StorageError::UnsupportedProtocol(other.to_string())),
    }
}

fn method_to_str(method: HttpMethod) -> &'static str {
    match method {
        HttpMethod::Get => "get",
        HttpMethod::Post => "post",
        HttpMethod::Put => "put",
        HttpMethod::Patch => "patch",
        HttpMethod::Delete => "delete",
        HttpMethod::Head => "head",
        HttpMethod::Options => "options",
    }
}

fn method_from_str(value: &str) -> Result<HttpMethod, StorageError> {
    match value {
        "get" => Ok(HttpMethod::Get),
        "post" => Ok(HttpMethod::Post),
        "put" => Ok(HttpMethod::Put),
        "patch" => Ok(HttpMethod::Patch),
        "delete" => Ok(HttpMethod::Delete),
        "head" => Ok(HttpMethod::Head),
        "options" => Ok(HttpMethod::Options),
        other => Err(StorageError::Corrupted(format!(
            "método HTTP desconhecido: {other}"
        ))),
    }
}

fn raw_language_to_str(language: RawBodyLanguage) -> &'static str {
    match language {
        RawBodyLanguage::Text => "text",
        RawBodyLanguage::JavaScript => "javascript",
        RawBodyLanguage::Json => "json",
        RawBodyLanguage::Html => "html",
        RawBodyLanguage::Xml => "xml",
    }
}

fn raw_language_from_str(value: &str) -> Result<RawBodyLanguage, StorageError> {
    match value {
        "text" => Ok(RawBodyLanguage::Text),
        "javascript" => Ok(RawBodyLanguage::JavaScript),
        "json" => Ok(RawBodyLanguage::Json),
        "html" => Ok(RawBodyLanguage::Html),
        "xml" => Ok(RawBodyLanguage::Xml),
        other => Err(StorageError::Corrupted(format!(
            "linguagem de corpo raw desconhecida: {other}"
        ))),
    }
}

fn form_data_field_from_persisted(persisted: &PersistedFormDataField) -> FormDataField {
    FormDataField {
        name: persisted.name.clone(),
        enabled: persisted.enabled,
        value: match &persisted.value {
            PersistedFormDataFieldValue::Text { value } => FormDataFieldValue::Text(value.clone()),
            PersistedFormDataFieldValue::File { file_path } => FormDataFieldValue::File {
                file_path: file_path.clone(),
            },
        },
    }
}

fn persisted_from_form_data_field(field: &FormDataField) -> PersistedFormDataField {
    PersistedFormDataField {
        name: field.name.clone(),
        enabled: field.enabled,
        value: match &field.value {
            FormDataFieldValue::Text(value) => PersistedFormDataFieldValue::Text {
                value: value.clone(),
            },
            FormDataFieldValue::File { file_path } => PersistedFormDataFieldValue::File {
                file_path: file_path.clone(),
            },
        },
    }
}

fn body_payload_from_persisted(persisted: &PersistedRequest) -> Result<BodyPayload, StorageError> {
    match persisted.body_type.as_str() {
        "none" => Ok(BodyPayload::None),
        "raw" => Ok(BodyPayload::Raw {
            language: raw_language_from_str(&persisted.raw_body_language)?,
        }),
        "urlencoded" => Ok(BodyPayload::UrlEncoded(
            persisted
                .url_encoded
                .iter()
                .map(|field| UrlEncodedField {
                    name: field.name.clone(),
                    value: field.value.clone(),
                    enabled: field.enabled,
                })
                .collect(),
        )),
        "formData" => Ok(BodyPayload::FormData(
            persisted
                .form_data
                .iter()
                .map(form_data_field_from_persisted)
                .collect(),
        )),
        "binary" => Ok(BodyPayload::Binary {
            file_path: persisted.binary_file_path.clone(),
        }),
        other => Err(StorageError::Corrupted(format!(
            "tipo de corpo desconhecido: {other}"
        ))),
    }
}

/// Decompõe `BodyPayload` nos campos planos persistidos — o inverso de
/// `body_payload_from_persisted`. Retorna todos os campos de uma vez porque
/// `PersistedRequest` os mantém em paralelo (só um conjunto é relevante por
/// vez, de acordo com `body_type`), igual ao padrão já usado para
/// `query`/`variables`/`method`/`body` no frontend (spec 0028).
struct PersistedBodyFields {
    body_type: String,
    raw_body_language: String,
    form_data: Vec<PersistedFormDataField>,
    url_encoded: Vec<PersistedUrlEncodedField>,
    binary_file_path: String,
}

fn persisted_from_body_payload(payload: &BodyPayload) -> PersistedBodyFields {
    let empty = PersistedBodyFields {
        body_type: String::new(),
        raw_body_language: default_persisted_raw_language(),
        form_data: Vec::new(),
        url_encoded: Vec::new(),
        binary_file_path: String::new(),
    };

    match payload {
        BodyPayload::None => PersistedBodyFields {
            body_type: "none".to_string(),
            ..empty
        },
        BodyPayload::Raw { language } => PersistedBodyFields {
            body_type: "raw".to_string(),
            raw_body_language: raw_language_to_str(*language).to_string(),
            ..empty
        },
        BodyPayload::UrlEncoded(fields) => PersistedBodyFields {
            body_type: "urlencoded".to_string(),
            url_encoded: fields
                .iter()
                .map(|field| PersistedUrlEncodedField {
                    name: field.name.clone(),
                    value: field.value.clone(),
                    enabled: field.enabled,
                })
                .collect(),
            ..empty
        },
        BodyPayload::FormData(fields) => PersistedBodyFields {
            body_type: "formData".to_string(),
            form_data: fields.iter().map(persisted_from_form_data_field).collect(),
            ..empty
        },
        BodyPayload::Binary { file_path } => PersistedBodyFields {
            body_type: "binary".to_string(),
            binary_file_path: file_path.clone(),
            ..empty
        },
    }
}

pub(crate) fn request_from_persisted(
    persisted: PersistedRequest,
) -> Result<SavedRequest, StorageError> {
    let body_payload = body_payload_from_persisted(&persisted)?;
    let protocol = protocol_from_str(&persisted.protocol)?;
    let endpoint = Endpoint::saved(persisted.endpoint);
    let document = RequestDocument::new(protocol, persisted.body);
    let headers = persisted
        .headers
        .into_iter()
        .map(|header| {
            HeaderEntry::new(header.name, header.value, header.enabled)
                .map_err(|error| StorageError::Corrupted(error.to_string()))
        })
        .collect::<Result<Vec<_>, StorageError>>()?;
    let authentication = authentication_from_persisted(persisted.authentication);

    let method = method_from_str(&persisted.method)?;
    let request = Request::new(
        endpoint,
        document,
        persisted.variables,
        headers,
        authentication,
    )
    .with_method(method)
    .with_body_payload(body_payload)
    .with_route_parameters(
        persisted
            .route_parameters
            .into_iter()
            .map(|parameter| RouteParameter {
                name: parameter.name,
                value: parameter.value,
            })
            .collect(),
    )
    .with_scripts(persisted.pre_request_script, persisted.post_response_script)
    .with_grpc(persisted.grpc.map(grpc_from_persisted).unwrap_or_default())
    .with_websocket(
        persisted
            .websocket
            .map(websocket_from_persisted)
            .unwrap_or_default(),
    );

    let saved = SavedRequest::new(persisted.id, persisted.name, request)
        .map_err(|error| StorageError::Corrupted(error.to_string()))?;
    Ok(match persisted.docs_ref {
        Some(docs_ref) => saved.with_docs_ref(DocsRef {
            source_id: docs_ref.source_id,
            operation_id: docs_ref.operation_id,
        }),
        None => saved,
    })
}

pub(crate) fn persisted_from_request(request: &SavedRequest) -> PersistedRequest {
    let authentication = persisted_from_authentication(&request.request.authentication);
    let body_fields = persisted_from_body_payload(&request.request.body_payload);

    PersistedRequest {
        id: request.id.clone(),
        name: request.name().to_string(),
        protocol: protocol_to_str(request.request.document.protocol).to_string(),
        endpoint: request.request.endpoint.url().to_string(),
        body: request.request.document.body.clone(),
        variables: request.request.variables.clone(),
        headers: request
            .request
            .headers
            .iter()
            .map(|header| PersistedHeader {
                name: header.name().to_string(),
                value: header.value().to_string(),
                enabled: header.enabled,
            })
            .collect(),
        authentication,
        method: method_to_str(request.request.method).to_string(),
        pre_request_script: request.request.pre_request_script.clone(),
        post_response_script: request.request.post_response_script.clone(),
        route_parameters: request
            .request
            .route_parameters
            .iter()
            .map(|parameter| PersistedRouteParameter {
                name: parameter.name.clone(),
                value: parameter.value.clone(),
            })
            .collect(),
        body_type: body_fields.body_type,
        raw_body_language: body_fields.raw_body_language,
        form_data: body_fields.form_data,
        url_encoded: body_fields.url_encoded,
        binary_file_path: body_fields.binary_file_path,
        docs_ref: request.docs_ref.as_ref().map(|docs_ref| PersistedDocsRef {
            source_id: docs_ref.source_id.clone(),
            operation_id: docs_ref.operation_id.clone(),
        }),
        grpc: (request.request.document.protocol == ProtocolId::Grpc)
            .then(|| persisted_from_grpc(&request.request.grpc)),
        websocket: (request.request.document.protocol == ProtocolId::WebSocket)
            .then(|| persisted_from_websocket(&request.request.websocket)),
    }
}

fn authentication_from_persisted(persisted: PersistedAuthentication) -> Authentication {
    match persisted {
        PersistedAuthentication::None => Authentication::None,
        PersistedAuthentication::Inherit => Authentication::Inherit,
        PersistedAuthentication::CustomHeader { name, value } => {
            Authentication::CustomHeader { name, value }
        }
        PersistedAuthentication::Bearer { token } => Authentication::Bearer { token },
        PersistedAuthentication::Basic { username, password } => {
            Authentication::Basic { username, password }
        }
        PersistedAuthentication::Digest { username, password } => {
            Authentication::Digest { username, password }
        }
        PersistedAuthentication::OAuth2ClientCredentials {
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

fn persisted_from_authentication(authentication: &Authentication) -> PersistedAuthentication {
    match authentication {
        Authentication::None => PersistedAuthentication::None,
        Authentication::Inherit => PersistedAuthentication::Inherit,
        Authentication::CustomHeader { name, value } => PersistedAuthentication::CustomHeader {
            name: name.clone(),
            value: value.clone(),
        },
        Authentication::Bearer { token } => PersistedAuthentication::Bearer {
            token: token.clone(),
        },
        Authentication::Basic { username, password } => PersistedAuthentication::Basic {
            username: username.clone(),
            password: password.clone(),
        },
        Authentication::Digest { username, password } => PersistedAuthentication::Digest {
            username: username.clone(),
            password: password.clone(),
        },
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => PersistedAuthentication::OAuth2ClientCredentials {
            client_id: client_id.clone(),
            client_secret: client_secret.clone(),
            token_url: token_url.clone(),
            scope: scope.clone(),
        },
    }
}

fn collection_from_persisted(persisted: PersistedCollection) -> Result<Collection, StorageError> {
    let folders = persisted
        .folders
        .into_iter()
        .map(folder_from_persisted)
        .collect::<Result<Vec<_>, StorageError>>()?;
    let requests = persisted
        .requests
        .into_iter()
        .map(request_from_persisted)
        .collect::<Result<Vec<_>, StorageError>>()?;

    let variables = variables_from_persisted(persisted.variables)?;
    let labels = labels_from_persisted(persisted.labels)?;
    Collection::new(persisted.id, persisted.name, folders, requests)
        .and_then(|collection| {
            collection
                .with_authentication(authentication_from_persisted(persisted.authentication))
                .with_variables(variables)
        })
        .and_then(|collection| collection.with_labels(labels))
        .map_err(|error| StorageError::Corrupted(error.to_string()))
}

fn folder_from_persisted(persisted: PersistedFolder) -> Result<Folder, StorageError> {
    let folders = persisted
        .folders
        .into_iter()
        .map(folder_from_persisted)
        .collect::<Result<Vec<_>, StorageError>>()?;
    let requests = persisted
        .requests
        .into_iter()
        .map(request_from_persisted)
        .collect::<Result<Vec<_>, StorageError>>()?;

    let variables = variables_from_persisted(persisted.variables)?;
    Folder::new(persisted.id, persisted.name, folders, requests)
        .and_then(|folder| {
            folder
                .with_authentication(authentication_from_persisted(persisted.authentication))
                .with_variables(variables)
        })
        .map_err(|error| StorageError::Corrupted(error.to_string()))
}

fn variables_from_persisted(
    persisted: Vec<PersistedScopedVariable>,
) -> Result<Vec<EnvironmentVariable>, StorageError> {
    persisted
        .into_iter()
        .map(|variable| {
            EnvironmentVariable::new(variable.name, variable.value, false)
                .map_err(|error| StorageError::Corrupted(error.to_string()))
        })
        .collect()
}

fn persisted_from_variables(variables: &[EnvironmentVariable]) -> Vec<PersistedScopedVariable> {
    variables
        .iter()
        .map(|variable| PersistedScopedVariable {
            name: variable.name().to_string(),
            value: variable.value().to_string(),
        })
        .collect()
}

fn labels_from_persisted(
    persisted: Vec<PersistedLabel>,
) -> Result<Vec<CollectionLabel>, StorageError> {
    persisted
        .into_iter()
        .map(|label| {
            let color = LabelColor::from_key(&label.color).unwrap_or(LabelColor::Gray);
            CollectionLabel::new(label.name, color)
                .map_err(|error| StorageError::Corrupted(error.to_string()))
        })
        .collect()
}

fn persisted_from_labels(labels: &[CollectionLabel]) -> Vec<PersistedLabel> {
    labels
        .iter()
        .map(|label| PersistedLabel {
            name: label.name().to_string(),
            color: label.color.as_key().to_string(),
        })
        .collect()
}

fn persisted_from_collection(collection: &Collection) -> PersistedCollection {
    PersistedCollection {
        id: collection.id.clone(),
        name: collection.name().to_string(),
        folders: collection
            .folders()
            .iter()
            .map(persisted_from_folder)
            .collect(),
        requests: collection
            .requests()
            .iter()
            .map(persisted_from_request)
            .collect(),
        authentication: persisted_from_authentication(&collection.authentication),
        variables: persisted_from_variables(collection.variables()),
        labels: persisted_from_labels(collection.labels()),
    }
}

fn persisted_from_folder(folder: &Folder) -> PersistedFolder {
    PersistedFolder {
        id: folder.id.clone(),
        name: folder.name().to_string(),
        folders: folder.folders().iter().map(persisted_from_folder).collect(),
        requests: folder
            .requests()
            .iter()
            .map(persisted_from_request)
            .collect(),
        authentication: persisted_from_authentication(&folder.authentication),
        variables: persisted_from_variables(folder.variables()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-collections-store-test-{nanos}-{count}"))
    }

    fn sample_request(body: &str) -> Request {
        Request::new(
            Endpoint::new("{{baseUrl}}/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, body),
            "{}",
            vec![HeaderEntry::new("Accept", "application/json", true).unwrap()],
            Authentication::Bearer {
                token: "secret".to_string(),
            },
        )
    }

    fn sample_collections() -> Vec<Collection> {
        let refresh_token = Folder::new("folder-3", "Refresh token", vec![], vec![]).unwrap();
        let authentication =
            Folder::new("folder-2", "Authentication", vec![refresh_token], vec![]).unwrap();
        let orders_requests = vec![
            SavedRequest::new(
                "request-1",
                "List orders",
                sample_request("query { orders { id } }"),
            )
            .unwrap(),
        ];
        let orders = Folder::new("folder-4", "Orders", vec![], orders_requests).unwrap();

        vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![authentication, orders],
                vec![
                    SavedRequest::new(
                        "request-2",
                        "Health check",
                        sample_request("query { ping }"),
                    )
                    .unwrap(),
                ],
            )
            .unwrap(),
        ]
    }

    #[test]
    fn load_returns_an_empty_list_when_the_manifest_does_not_exist() {
        let store = CollectionsStore::new(temp_root());

        let collections = store.load().unwrap();

        assert!(collections.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_nested_collections_with_full_request_content() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let collections = sample_collections();

        store.save(&collections).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, collections);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_creates_the_root_directory_when_it_does_not_exist() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());

        assert!(!root.exists());
        store.save(&sample_collections()).unwrap();

        assert!(root.join(MANIFEST_FILE_NAME).exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_does_not_leave_a_temporary_file_behind() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());

        store.save(&sample_collections()).unwrap();

        assert!(!root.join(MANIFEST_FILE_NAME).with_extension("tmp").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_reads_a_manifest_without_a_requests_field() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": []}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let collections = store.load().unwrap();

        assert!(collections[0].requests().is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), "not json").unwrap();
        let store = CollectionsStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_naming_a_protocol_this_build_does_not_support() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "requests": [{"id": "request-1", "name": "Ping", "protocol": "soap", "endpoint": "https://api.example.com", "body": "", "variables": "{}", "headers": [], "authentication": {"type": "none"}}]}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::UnsupportedProtocol(ref name) if name == "soap"));
        assert!(error.to_string().contains("atualize o app"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_grpc_requests_and_omits_grpc_for_other_protocols() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let reflected = Request::new(
            Endpoint::new("grpcs://{{host}}:443").unwrap(),
            RequestDocument::new(ProtocolId::Grpc, r#"{"name": "{{user}}"}"#),
            "",
            vec![HeaderEntry::new("x-tenant", "acme", true).unwrap()],
            Authentication::Inherit,
        )
        .with_grpc(GrpcCall {
            service: "helloworld.Greeter".to_string(),
            method: "SayHello".to_string(),
            schema_source: GrpcSchemaSource::Reflection,
            deadline_ms: Some(5_000),
        });
        let from_files = Request::new(
            Endpoint::saved("localhost:50051"),
            RequestDocument::new(ProtocolId::Grpc, "{}"),
            "",
            vec![],
            Authentication::None,
        )
        .with_grpc(GrpcCall {
            service: "routeguide.RouteGuide".to_string(),
            method: "RouteChat".to_string(),
            schema_source: GrpcSchemaSource::ProtoFiles {
                files: vec!["protos/route_guide.proto".to_string()],
                import_paths: vec!["protos".to_string(), "third_party".to_string()],
            },
            deadline_ms: None,
        });
        let collections = vec![
            Collection::new(
                "collection-1",
                "Services",
                vec![],
                vec![
                    SavedRequest::new("request-1", "Say hello", reflected).unwrap(),
                    SavedRequest::new("request-2", "Route chat", from_files).unwrap(),
                    SavedRequest::new("request-3", "Ping", sample_request("query { ping }"))
                        .unwrap(),
                ],
            )
            .unwrap(),
        ];

        store.save(&collections).unwrap();

        assert_eq!(store.load().unwrap(), collections);
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert_eq!(raw.matches("\"grpc\":").count(), 2, "{raw}");
        assert!(raw.contains("\"protocol\": \"grpc\""), "{raw}");
        assert!(raw.contains("\"type\": \"protoFiles\""), "{raw}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_websocket_requests_and_omits_websocket_for_other_protocols() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let chat = Request::new(
            Endpoint::saved("wss://{{host}}/chat"),
            RequestDocument::new(ProtocolId::WebSocket, r#"{"join": "{{room}}"}"#),
            "",
            vec![HeaderEntry::new("x-tenant", "acme", true).unwrap()],
            Authentication::Inherit,
        )
        .with_websocket(WebSocketCall {
            subprotocols: vec!["chat.v2".to_string(), "chat".to_string()],
            message_format: WebSocketMessageFormat::Json,
            collect: WebSocketCollect {
                wait_ms: Some(3_000),
                expected_messages: Some(0),
            },
        });
        let plain = Request::new(
            Endpoint::saved("ws://localhost:8080"),
            RequestDocument::new(ProtocolId::WebSocket, ""),
            "",
            vec![],
            Authentication::None,
        );
        let collections = vec![
            Collection::new(
                "collection-1",
                "Sockets",
                vec![],
                vec![
                    SavedRequest::new("request-1", "Chat", chat).unwrap(),
                    SavedRequest::new("request-2", "Plain", plain).unwrap(),
                    SavedRequest::new("request-3", "Ping", sample_request("query { ping }"))
                        .unwrap(),
                ],
            )
            .unwrap(),
        ];

        store.save(&collections).unwrap();

        assert_eq!(store.load().unwrap(), collections);
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert_eq!(raw.matches("\"websocket\": {").count(), 2, "{raw}");
        assert!(raw.contains("\"protocol\": \"websocket\""), "{raw}");
        assert!(raw.contains("\"messageFormat\": \"json\""), "{raw}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 99, "collections": []}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_data_that_violates_domain_invariants() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "", "folders": []}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_nested_data_that_violates_domain_invariants() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [{"id": "folder-1", "name": "", "folders": []}]}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    /// Requisição recém-criada nasce sem URL (spec 0089): o endereço vazio é
    /// gravado e lido como está — só a execução exige um endereço.
    #[test]
    fn load_keeps_a_request_without_endpoint() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "requests": [{"id": "request-1", "name": "Ping", "protocol": "graphql", "endpoint": "", "body": "", "variables": "{}", "headers": [], "authentication": {"type": "none"}}]}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let collections = store.load().unwrap();

        assert_eq!(collections[0].requests()[0].request.endpoint.url(), "");
        store.save(&collections).unwrap();
        assert_eq!(store.load().unwrap(), collections);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_a_rest_request_with_a_non_post_method() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Get)
        .with_route_parameters(vec![RouteParameter {
            name: "userId".to_string(),
            value: "{{selectedUser}}".to_string(),
        }]);
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![SavedRequest::new("request-1", "List users", request.clone()).unwrap()],
            )
            .unwrap(),
        ];

        store.save(&collections).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, collections);
        assert_eq!(
            loaded[0].requests()[0].request.document.protocol,
            ProtocolId::Rest
        );
        assert_eq!(loaded[0].requests()[0].request.method, HttpMethod::Get);
        assert_eq!(
            loaded[0].requests()[0].request.route_parameters,
            vec![RouteParameter {
                name: "userId".to_string(),
                value: "{{selectedUser}}".to_string(),
            }]
        );
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(raw.contains("route_parameters"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_the_docs_reference_and_omits_it_when_absent() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let documented = SavedRequest::new("request-1", "List pets", sample_request(""))
            .unwrap()
            .with_docs_ref(DocsRef {
                source_id: "abc".to_string(),
                operation_id: "listPets".to_string(),
            });
        let plain = SavedRequest::new("request-2", "Ping", sample_request("")).unwrap();
        let collections =
            vec![Collection::new("collection-1", "Pets", vec![], vec![documented, plain]).unwrap()];

        store.save(&collections).unwrap();

        assert_eq!(store.load().unwrap(), collections);
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert_eq!(raw.matches("docs_ref").count(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_scripts_and_old_files_load_with_empty_scripts() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_scripts("al.request.body = 'x';", "al.console.log(1);");
        let collections = vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![SavedRequest::new("request-1", "List users", request).unwrap()],
            )
            .unwrap(),
        ];

        store.save(&collections).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, collections);
        assert_eq!(
            loaded[0].requests()[0].request.pre_request_script,
            "al.request.body = 'x';"
        );
        fs::remove_dir_all(&root).ok();

        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "requests": [{"id": "request-1", "name": "Ping", "protocol": "graphql", "endpoint": "https://api.example.com", "body": "", "variables": "{}", "headers": [], "authentication": {"type": "none"}}]}]}"#,
        )
        .unwrap();
        let loaded = CollectionsStore::new(root.clone()).load().unwrap();
        assert_eq!(loaded[0].requests()[0].request.pre_request_script, "");
        assert_eq!(loaded[0].requests()[0].request.post_response_script, "");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_folder_and_collection_authentication() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let folder = Folder::new("folder-1", "Orders", vec![], vec![])
            .unwrap()
            .with_authentication(Authentication::CustomHeader {
                name: "X-Api-Key".to_string(),
                value: "k".to_string(),
            });
        let collections = vec![
            Collection::new("collection-1", "Customer API", vec![folder], vec![])
                .unwrap()
                .with_authentication(Authentication::Bearer {
                    token: "t".to_string(),
                }),
        ];

        store.save(&collections).unwrap();

        assert_eq!(store.load().unwrap(), collections);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn old_files_without_folder_authentication_load_as_inherit() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "c", "name": "API", "folders": [{"id": "f", "name": "Orders", "folders": []}]}]}"#,
        )
        .unwrap();

        let loaded = CollectionsStore::new(root.clone()).load().unwrap();

        assert_eq!(loaded[0].authentication, Authentication::Inherit);
        assert_eq!(
            loaded[0].folders()[0].authentication,
            Authentication::Inherit
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_folder_and_collection_variables() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let folder = Folder::new("folder-1", "Orders", vec![], vec![])
            .unwrap()
            .with_variables(vec![EnvironmentVariable::new("id", "42", false).unwrap()])
            .unwrap();
        let collections = vec![
            Collection::new("collection-1", "Customer API", vec![folder], vec![])
                .unwrap()
                .with_variables(vec![
                    EnvironmentVariable::new("baseUrl", "https://api", false).unwrap(),
                ])
                .unwrap(),
        ];

        store.save(&collections).unwrap();

        assert_eq!(store.load().unwrap(), collections);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collections_without_variables_do_not_write_the_field() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());

        store.save(&sample_collections()).unwrap();

        let written = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(!written.contains("\"variables\": ["));
        assert!(store.load().unwrap()[0].variables().is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_then_load_round_trips_collection_labels() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());
        let collections = vec![
            Collection::new("collection-1", "Customer API", vec![], vec![])
                .unwrap()
                .with_labels(vec![
                    CollectionLabel::new("Pagamentos", LabelColor::Green).unwrap(),
                    CollectionLabel::new("Legado", LabelColor::Gray).unwrap(),
                ])
                .unwrap(),
        ];

        store.save(&collections).unwrap();

        let written = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(written.contains("\"color\": \"green\""));
        assert_eq!(store.load().unwrap(), collections);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collections_without_labels_do_not_write_the_field() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone());

        store.save(&sample_collections()).unwrap();

        let written = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(!written.contains("\"labels\""));
        assert!(store.load().unwrap()[0].labels().is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_maps_an_unknown_label_color_to_gray() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "labels": [{"name": "Novo", "color": "magenta"}]}]}"#,
        )
        .unwrap();

        let collections = CollectionsStore::new(root.clone()).load().unwrap();

        assert_eq!(collections[0].labels()[0].name(), "Novo");
        assert_eq!(collections[0].labels()[0].color, LabelColor::Gray);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_defaults_to_post_for_a_persisted_request_without_a_method_field() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "requests": [{"id": "request-1", "name": "Ping", "protocol": "graphql", "endpoint": "https://api.example.com", "body": "", "variables": "{}", "headers": [], "authentication": {"type": "none"}}]}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let collections = store.load().unwrap();

        assert_eq!(
            collections[0].requests()[0].request.method,
            HttpMethod::Post
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_an_unknown_method() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "requests": [{"id": "request-1", "name": "Ping", "protocol": "rest", "endpoint": "https://api.example.com", "body": "", "variables": "", "headers": [], "authentication": {"type": "none"}, "method": "trace"}]}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn export_then_import_round_trips_collections_at_an_arbitrary_path() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("export.alcy.json");
        let collections = sample_collections();

        export_collections(&path, &collections).unwrap();
        let imported = import_collections(&path).unwrap();

        assert_eq!(imported, collections);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn export_can_write_a_single_collection() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("export.alcy.json");
        let collections = sample_collections();

        export_collections(&path, &collections[..1]).unwrap();
        let imported = import_collections(&path).unwrap();

        assert_eq!(imported, collections);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_fails_with_read_error_when_the_file_does_not_exist() {
        let root = temp_root();
        let path = root.join("missing.alcy.json");

        let error = import_collections(&path).unwrap_err();

        assert!(matches!(error, StorageError::Read(_)));
    }

    #[test]
    fn import_from_str_parses_the_same_content_a_file_would() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("export.alcy.json");
        let collections = sample_collections();
        export_collections(&path, &collections).unwrap();
        let raw = fs::read_to_string(&path).unwrap();

        let imported = import_collections_from_str(&raw).unwrap();

        assert_eq!(imported, collections);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_from_str_fails_with_corrupted_for_invalid_json() {
        let error = import_collections_from_str("not json").unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));
    }

    fn request_with_body(body_payload: BodyPayload) -> Request {
        Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_body_payload(body_payload)
    }

    fn collection_with_request(request: Request) -> Vec<Collection> {
        vec![
            Collection::new(
                "collection-1",
                "Customer API",
                vec![],
                vec![SavedRequest::new("request-1", "Body", request).unwrap()],
            )
            .unwrap(),
        ]
    }

    #[test]
    fn save_then_load_round_trips_every_body_type() {
        let bodies = vec![
            BodyPayload::None,
            BodyPayload::Raw {
                language: RawBodyLanguage::Html,
            },
            BodyPayload::UrlEncoded(vec![
                UrlEncodedField {
                    name: "a".to_string(),
                    value: "1".to_string(),
                    enabled: true,
                },
                UrlEncodedField {
                    name: "b".to_string(),
                    value: "2".to_string(),
                    enabled: false,
                },
            ]),
            BodyPayload::FormData(vec![
                FormDataField {
                    name: "field".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::Text("value".to_string()),
                },
                FormDataField {
                    name: "attachment".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::File {
                        file_path: "/tmp/photo.png".to_string(),
                    },
                },
            ]),
            BodyPayload::Binary {
                file_path: "/tmp/archive.zip".to_string(),
            },
        ];

        for body in bodies {
            let root = temp_root();
            let store = CollectionsStore::new(root.clone());
            let collections = collection_with_request(request_with_body(body.clone()));

            store.save(&collections).unwrap();
            let loaded = store.load().unwrap();

            assert_eq!(
                loaded[0].requests()[0].request.body_payload,
                body,
                "não fez round-trip: {body:?}"
            );

            fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn load_defaults_to_raw_json_for_a_persisted_request_without_a_body_type_field() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "requests": [{"id": "request-1", "name": "Ping", "protocol": "rest", "endpoint": "https://api.example.com", "body": "{}", "variables": "", "headers": [], "authentication": {"type": "none"}}]}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let collections = store.load().unwrap();

        assert_eq!(
            collections[0].requests()[0].request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_an_unknown_body_type() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 1, "collections": [{"id": "collection-1", "name": "Customer API", "folders": [], "requests": [{"id": "request-1", "name": "Ping", "protocol": "rest", "endpoint": "https://api.example.com", "body": "", "variables": "", "headers": [], "authentication": {"type": "none"}, "body_type": "graphql"}]}]}"#,
        )
        .unwrap();
        let store = CollectionsStore::new(root.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }
}
