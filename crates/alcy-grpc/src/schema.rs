//! Services, methods and message types: compiled from `.proto` files or
//! asked to the server through reflection, then summarized for the editor.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use prost::Message as _;
use prost_reflect::{
    DescriptorPool, DeserializeOptions, DynamicMessage, FieldDescriptor, Kind, MessageDescriptor,
    MethodDescriptor, SerializeOptions,
};
use prost_types::{FileDescriptorProto, FileDescriptorSet};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;

use crate::GrpcError;
use crate::call::{MetadataEntry, apply_metadata};

/// Message nesting expanded in templates and schemas; deeper (or recursive)
/// messages appear as `{}`.
const MAX_EXPANSION_DEPTH: usize = 6;
/// Files a reflection exchange may fetch before giving up.
const MAX_REFLECTED_FILES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MethodKind {
    Unary,
    ServerStreaming,
    ClientStreaming,
    BidiStreaming,
}

impl MethodKind {
    pub fn of(method: &MethodDescriptor) -> Self {
        match (method.is_client_streaming(), method.is_server_streaming()) {
            (false, false) => Self::Unary,
            (false, true) => Self::ServerStreaming,
            (true, false) => Self::ClientStreaming,
            (true, true) => Self::BidiStreaming,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodSummary {
    pub name: String,
    pub kind: MethodKind,
    pub input_type: String,
    pub output_type: String,
    /// The input message with every field at its default value, as JSON.
    pub input_template: String,
    /// JSON Schema of the input message, for completion in the editor.
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSummary {
    /// Fully qualified (`package.Service`).
    pub name: String,
    pub methods: Vec<MethodSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSummary {
    pub services: Vec<ServiceSummary>,
}

/// Compiles `.proto` files. Each file's folder is searched for imports too,
/// besides `import_paths`.
pub fn compile_proto_files(
    files: &[PathBuf],
    import_paths: &[PathBuf],
) -> Result<DescriptorPool, GrpcError> {
    if files.is_empty() {
        return Err(GrpcError::ProtoFiles(
            "nenhum arquivo .proto escolhido".to_string(),
        ));
    }
    let mut includes: Vec<PathBuf> = import_paths.to_vec();
    for file in files {
        let covered = includes.iter().any(|include| file.starts_with(include));
        if let Some(parent) = file.parent().filter(|_| !covered) {
            includes.push(parent.to_path_buf());
        }
    }
    let mut compiler = protox::Compiler::new(&includes)
        .map_err(|error| GrpcError::ProtoFiles(error.to_string()))?;
    compiler
        .include_imports(true)
        .open_files(files)
        .map_err(|error| GrpcError::ProtoFiles(error.to_string()))?;
    Ok(compiler.descriptor_pool())
}

/// Resolves saved proto paths at execution time, including grpcurl's virtual
/// filenames relative to an import path. Importing a command does not read files.
pub fn compile_workspace_proto_files(
    root: &Path,
    files: &[String],
    import_paths: &[String],
) -> Result<DescriptorPool, GrpcError> {
    let import_paths = resolve_against(root, import_paths);
    let files = files
        .iter()
        .map(|file| {
            let path = Path::new(file);
            let workspace_path = root.join(path);
            if path.is_absolute() || workspace_path.is_file() {
                return workspace_path;
            }
            import_paths
                .iter()
                .map(|directory| directory.join(path))
                .find(|candidate| candidate.is_file())
                .unwrap_or(workspace_path)
        })
        .collect::<Vec<_>>();
    compile_proto_files(&files, &import_paths)
}

/// Asks the server for its services and their files (reflection v1, then
/// v1alpha for older servers).
pub async fn reflect(
    channel: Channel,
    metadata: &[MetadataEntry],
) -> Result<DescriptorPool, GrpcError> {
    match reflect_v1(channel.clone(), metadata).await {
        Err(ReflectError::Unimplemented) => match reflect_v1alpha(channel, metadata).await {
            Err(ReflectError::Unimplemented) => Err(GrpcError::Reflection(
                "o servidor não expõe o serviço de reflection; escolha os arquivos .proto"
                    .to_string(),
            )),
            other => other.map_err(ReflectError::into_grpc),
        },
        other => other.map_err(ReflectError::into_grpc),
    }
}

enum ReflectError {
    Unimplemented,
    Failed(GrpcError),
}

impl ReflectError {
    fn into_grpc(self) -> GrpcError {
        match self {
            Self::Unimplemented => {
                GrpcError::Reflection("serviço de reflection indisponível".to_string())
            }
            Self::Failed(error) => error,
        }
    }

    fn from_status(status: tonic::Status) -> Self {
        if status.code() == tonic::Code::Unimplemented {
            Self::Unimplemented
        } else {
            Self::Failed(GrpcError::Reflection(format!(
                "{:?}: {}",
                status.code(),
                status.message()
            )))
        }
    }
}

/// The two reflection versions share their messages field for field; this
/// generates one exchange per version.
macro_rules! reflect_version {
    ($name:ident, $pb:path) => {
        async fn $name(channel: Channel, metadata: &[MetadataEntry]) -> Result<DescriptorPool, ReflectError> {
            use $pb as pb;
            use pb::server_reflection_client::ServerReflectionClient;
            use pb::server_reflection_request::MessageRequest;
            use pb::server_reflection_response::MessageResponse;

            let (sender, receiver) = mpsc::channel(4);
            let mut request = tonic::Request::new(ReceiverStream::new(receiver));
            apply_metadata(request.metadata_mut(), metadata).map_err(ReflectError::Failed)?;
            let ask = |message: MessageRequest| pb::ServerReflectionRequest {
                host: String::new(),
                message_request: Some(message),
            };
            let closed = || ReflectError::Failed(GrpcError::Reflection("a conexão foi encerrada".to_string()));
            sender
                .send(ask(MessageRequest::ListServices(String::new())))
                .await
                .map_err(|_| closed())?;
            let mut responses = ServerReflectionClient::new(channel)
                .server_reflection_info(request)
                .await
                .map_err(ReflectError::from_status)?
                .into_inner();
            async fn next(
                responses: &mut tonic::Streaming<pb::ServerReflectionResponse>,
            ) -> Result<MessageResponse, ReflectError> {
                match responses.message().await {
                    Ok(Some(response)) => match response.message_response {
                        Some(MessageResponse::ErrorResponse(error)) => Err(ReflectError::Failed(
                            GrpcError::Reflection(error.error_message),
                        )),
                        Some(other) => Ok(other),
                        None => Err(ReflectError::Failed(GrpcError::Reflection("resposta vazia".to_string()))),
                    },
                    Ok(None) => Err(ReflectError::Failed(GrpcError::Reflection(
                        "a conexão foi encerrada".to_string(),
                    ))),
                    Err(status) => Err(ReflectError::from_status(status)),
                }
            }

            let services = match next(&mut responses).await? {
                MessageResponse::ListServicesResponse(list) => list.service,
                _ => return Err(ReflectError::Failed(GrpcError::Reflection("resposta inesperada".to_string()))),
            };
            let mut files: HashMap<String, FileDescriptorProto> = HashMap::new();
            let mut pending: Vec<MessageRequest> = services
                .into_iter()
                .filter(|service| !is_reflection_service(&service.name))
                .map(|service| MessageRequest::FileContainingSymbol(service.name))
                .collect();
            while let Some(message) = pending.pop() {
                if files.len() > MAX_REFLECTED_FILES {
                    return Err(ReflectError::Failed(GrpcError::Reflection(
                        "o servidor descreveu arquivos demais".to_string(),
                    )));
                }
                sender.send(ask(message)).await.map_err(|_| closed())?;
                let MessageResponse::FileDescriptorResponse(found) = next(&mut responses).await? else {
                    return Err(ReflectError::Failed(GrpcError::Reflection("resposta inesperada".to_string())));
                };
                for bytes in found.file_descriptor_proto {
                    let file = FileDescriptorProto::decode(bytes.as_slice()).map_err(|error| {
                        ReflectError::Failed(GrpcError::Reflection(error.to_string()))
                    })?;
                    for dependency in &file.dependency {
                        let known = files.contains_key(dependency)
                            || pending.iter().any(|queued| {
                                matches!(queued, MessageRequest::FileByFilename(name) if name == dependency)
                            });
                        if !known {
                            pending.push(MessageRequest::FileByFilename(dependency.clone()));
                        }
                    }
                    files.insert(file.name().to_string(), file);
                }
            }
            drop(sender);
            pool_from_files(files).map_err(ReflectError::Failed)
        }
    };
}

reflect_version!(reflect_v1, tonic_reflection::pb::v1);
reflect_version!(reflect_v1alpha, tonic_reflection::pb::v1alpha);

fn is_reflection_service(name: &str) -> bool {
    name.starts_with("grpc.reflection.")
}

/// Builds a pool from files in any order: dependencies are added first.
fn pool_from_files(
    mut files: HashMap<String, FileDescriptorProto>,
) -> Result<DescriptorPool, GrpcError> {
    let mut ordered = Vec::with_capacity(files.len());
    let mut done = HashSet::new();
    let names: Vec<String> = files.keys().cloned().collect();
    for name in names {
        visit(&name, &mut files, &mut done, &mut ordered);
    }
    DescriptorPool::from_file_descriptor_set(FileDescriptorSet { file: ordered })
        .map_err(|error| GrpcError::Reflection(error.to_string()))
}

fn visit(
    name: &str,
    files: &mut HashMap<String, FileDescriptorProto>,
    done: &mut HashSet<String>,
    ordered: &mut Vec<FileDescriptorProto>,
) {
    if !done.insert(name.to_string()) {
        return;
    }
    let Some(file) = files.remove(name) else {
        return;
    };
    for dependency in &file.dependency {
        visit(dependency, files, done, ordered);
    }
    ordered.push(file);
}

/// The services a pool declares (reflection itself excluded), sorted.
pub fn describe(pool: &DescriptorPool) -> SchemaSummary {
    let mut services: Vec<ServiceSummary> = pool
        .services()
        .filter(|service| !is_reflection_service(service.full_name()))
        .map(|service| ServiceSummary {
            name: service.full_name().to_string(),
            methods: service
                .methods()
                .map(|method| MethodSummary {
                    name: method.name().to_string(),
                    kind: MethodKind::of(&method),
                    input_type: method.input().full_name().to_string(),
                    output_type: method.output().full_name().to_string(),
                    input_template: serde_json::to_string_pretty(&template(&method.input(), 0))
                        .unwrap_or_else(|_| "{}".to_string()),
                    input_schema: schema(&method.input(), 0),
                })
                .collect(),
        })
        .collect();
    services.sort_by(|a, b| a.name.cmp(&b.name));
    SchemaSummary { services }
}

pub fn find_method(
    pool: &DescriptorPool,
    service: &str,
    method: &str,
) -> Result<MethodDescriptor, GrpcError> {
    let not_found = || GrpcError::MethodNotFound(format!("{service}/{method}"));
    pool.get_service_by_name(service.trim())
        .ok_or_else(not_found)?
        .methods()
        .find(|candidate| candidate.name() == method.trim())
        .ok_or_else(not_found)
}

/// Parses a message from JSON (protobuf's JSON mapping). Blank text is the
/// empty message; unknown fields are rejected so typos do not go unnoticed.
pub fn message_from_json(
    descriptor: &MessageDescriptor,
    json: &str,
) -> Result<DynamicMessage, GrpcError> {
    if json.trim().is_empty() {
        return Ok(DynamicMessage::new(descriptor.clone()));
    }
    let mut deserializer = serde_json::Deserializer::from_str(json);
    let message = DynamicMessage::deserialize_with_options(
        descriptor.clone(),
        &mut deserializer,
        &DeserializeOptions::new().deny_unknown_fields(true),
    )
    .and_then(|message| deserializer.end().map(|()| message))
    .map_err(|error| GrpcError::InvalidMessage {
        message_type: descriptor.full_name().to_string(),
        detail: error.to_string(),
    })?;
    Ok(message)
}

/// A message as pretty JSON, default values included so every field shows.
pub fn message_to_json(message: &DynamicMessage) -> String {
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::pretty(&mut out);
    let options = SerializeOptions::new().skip_default_fields(false);
    match message.serialize_with_options(&mut serializer, &options) {
        Ok(()) => String::from_utf8(out).unwrap_or_default(),
        Err(error) => json!({ "error": error.to_string() }).to_string(),
    }
}

/// Default JSON value of a message, one field per oneof.
fn template(message: &MessageDescriptor, depth: usize) -> Value {
    if let Some(value) = well_known_template(message.full_name()) {
        return value;
    }
    if depth >= MAX_EXPANSION_DEPTH {
        return json!({});
    }
    let mut object = serde_json::Map::new();
    let mut oneofs_seen = HashSet::new();
    for field in message.fields() {
        if let Some(oneof) = field
            .containing_oneof()
            .filter(|oneof| !oneof.is_synthetic())
            && !oneofs_seen.insert(oneof.full_name().to_string())
        {
            continue;
        }
        object.insert(field.json_name().to_string(), field_template(&field, depth));
    }
    Value::Object(object)
}

fn field_template(field: &FieldDescriptor, depth: usize) -> Value {
    if field.is_map() {
        return json!({});
    }
    let single = match field.kind() {
        Kind::Message(message) => template(&message, depth + 1),
        Kind::Enum(enumeration) => enumeration
            .values()
            .next()
            .map(|value| Value::String(value.name().to_string()))
            .unwrap_or(Value::Null),
        Kind::Bool => json!(false),
        Kind::String | Kind::Bytes => json!(""),
        Kind::Double | Kind::Float => json!(0.0),
        _ => json!(0),
    };
    if field.is_list() {
        json!([single])
    } else {
        single
    }
}

fn well_known_template(full_name: &str) -> Option<Value> {
    Some(match full_name {
        "google.protobuf.Timestamp" => json!("1970-01-01T00:00:00Z"),
        "google.protobuf.Duration" => json!("0s"),
        "google.protobuf.FieldMask" => json!(""),
        "google.protobuf.Struct" | "google.protobuf.Any" | "google.protobuf.Empty" => json!({}),
        "google.protobuf.ListValue" => json!([]),
        "google.protobuf.Value" => Value::Null,
        "google.protobuf.StringValue" | "google.protobuf.BytesValue" => json!(""),
        "google.protobuf.BoolValue" => json!(false),
        "google.protobuf.DoubleValue" | "google.protobuf.FloatValue" => json!(0.0),
        "google.protobuf.Int32Value"
        | "google.protobuf.UInt32Value"
        | "google.protobuf.Int64Value"
        | "google.protobuf.UInt64Value" => json!(0),
        _ => return None,
    })
}

/// JSON Schema of a message, as protobuf's JSON mapping accepts it.
fn schema(message: &MessageDescriptor, depth: usize) -> Value {
    if let Some(value) = well_known_schema(message.full_name()) {
        return value;
    }
    if depth >= MAX_EXPANSION_DEPTH {
        return json!({ "type": "object" });
    }
    let properties: serde_json::Map<String, Value> = message
        .fields()
        .map(|field| (field.json_name().to_string(), field_schema(&field, depth)))
        .collect();
    json!({ "type": "object", "properties": properties, "additionalProperties": false })
}

fn field_schema(field: &FieldDescriptor, depth: usize) -> Value {
    let single = |kind: Kind| match kind {
        Kind::Message(message) => schema(&message, depth + 1),
        Kind::Enum(enumeration) => {
            let names: Vec<String> = enumeration
                .values()
                .map(|value| value.name().to_string())
                .collect();
            json!({ "enum": names })
        }
        Kind::Bool => json!({ "type": "boolean" }),
        Kind::String => json!({ "type": "string" }),
        Kind::Bytes => json!({ "type": "string", "contentEncoding": "base64" }),
        Kind::Double | Kind::Float => json!({ "type": "number" }),
        // 64-bit integers are strings in protobuf JSON; numbers are accepted too.
        Kind::Int64 | Kind::Uint64 | Kind::Sint64 | Kind::Fixed64 | Kind::Sfixed64 => {
            json!({ "type": ["integer", "string"] })
        }
        _ => json!({ "type": "integer" }),
    };
    if field.is_map() {
        let value_kind = match field.kind() {
            Kind::Message(entry) => entry.map_entry_value_field().kind(),
            other => other,
        };
        return json!({ "type": "object", "additionalProperties": single(value_kind) });
    }
    let schema = single(field.kind());
    if field.is_list() {
        json!({ "type": "array", "items": schema })
    } else {
        schema
    }
}

fn well_known_schema(full_name: &str) -> Option<Value> {
    Some(match full_name {
        "google.protobuf.Timestamp" | "google.protobuf.Duration" | "google.protobuf.FieldMask" => {
            json!({ "type": "string" })
        }
        "google.protobuf.Struct" | "google.protobuf.Any" | "google.protobuf.Empty" => {
            json!({ "type": "object" })
        }
        "google.protobuf.ListValue" => json!({ "type": "array" }),
        "google.protobuf.Value" => json!({}),
        "google.protobuf.StringValue" => json!({ "type": "string" }),
        "google.protobuf.BytesValue" => json!({ "type": "string", "contentEncoding": "base64" }),
        "google.protobuf.BoolValue" => json!({ "type": "boolean" }),
        "google.protobuf.DoubleValue" | "google.protobuf.FloatValue" => json!({ "type": "number" }),
        "google.protobuf.Int32Value" | "google.protobuf.UInt32Value" => {
            json!({ "type": "integer" })
        }
        "google.protobuf.Int64Value" | "google.protobuf.UInt64Value" => {
            json!({ "type": ["integer", "string"] })
        }
        _ => return None,
    })
}

/// Resolves workspace-relative paths against `root`; absolute ones stay.
pub fn resolve_against(root: &Path, paths: &[String]) -> Vec<PathBuf> {
    paths
        .iter()
        .map(|path| {
            let path = Path::new(path);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            }
        })
        .collect()
}
