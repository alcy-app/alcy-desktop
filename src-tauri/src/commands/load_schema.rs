use alcy_app::{TemplateError, execute_request, resolve_variables};
use alcy_domain::{
    Authentication, Endpoint, EndpointError, EnvironmentVariable, EnvironmentVariableError,
    ExecutionError, HeaderEntry, HeaderError, Request,
};
use alcy_graphql::{
    GraphqlDirective, GraphqlEnumValue, GraphqlField, GraphqlInputValue, GraphqlNamedType,
    GraphqlSchema, GraphqlTypeKind, ReqwestGraphqlExecutor, SchemaError, introspection_request,
    parse_schema,
};
use alcy_storage::SchemaStore;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::commands::environments::EnvironmentVariableDto;
use crate::commands::execute_graphql_request::{
    AuthenticationInput, HeaderInput, resolve_inherited_authentication,
};
use crate::commands::execution_registry::ExecutionRegistry;
use crate::commands::failure_cause::{InvalidRequestCause, NetworkCauseOutput};
use crate::commands::variable_scopes::{VariableScopeDto, scopes_from_dto, with_scoped_variables};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSchemaInput {
    pub execution_id: String,
    pub endpoint_url: String,
    pub headers: Vec<HeaderInput>,
    pub authentication: AuthenticationInput,
    /// Workspace e requisição salva de origem, usados para resolver `Inherit`.
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    pub environment_variables: Vec<EnvironmentVariableDto>,
    /// Camadas de variáveis da coleção/pastas da requisição (ADR 0031).
    #[serde(default)]
    pub variable_scopes: Vec<VariableScopeDto>,
    pub force_refresh: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoadSchemaError {
    InvalidRequest {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cause: Option<InvalidRequestCause>,
    },
    Network {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cause: Option<NetworkCauseOutput>,
    },
    Timeout,
    Cancelled,
    /// `message` é o detalhe técnico: as mensagens de erro do servidor ou o
    /// erro de leitura do JSON (vazio quando falta `__schema`).
    InvalidResponse {
        message: String,
        cause: SchemaResponseCause,
    },
}

/// Por que a resposta de introspection não serve como schema (ADR 0044).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SchemaResponseCause {
    /// O servidor respondeu com `errors` (ex.: introspection desabilitada).
    ServerErrors,
    NotJson,
    MissingSchema,
}

impl From<ExecutionError> for LoadSchemaError {
    fn from(error: ExecutionError) -> Self {
        match error {
            ExecutionError::Network(failure) => Self::Network {
                cause: failure.cause.map(NetworkCauseOutput::from),
                message: failure.detail,
            },
            ExecutionError::Timeout => Self::Timeout,
            // Introspection não envia `variables`, corpo (form-data/binary)
            // nem executa scripts: estes ramos não são alcançáveis na
            // prática, mas o match precisa ser exaustivo.
            ExecutionError::InvalidVariables(message)
            | ExecutionError::InvalidRequest(message)
            | ExecutionError::Script(message) => Self::InvalidRequest {
                message,
                cause: None,
            },
            ExecutionError::BodyFileUnreadable { path, detail } => Self::InvalidRequest {
                message: detail,
                cause: Some(InvalidRequestCause::BodyFileUnreadable { path }),
            },
            // A introspection é enviada sem limite de tamanho (ver
            // `build_introspection_request`): o schema é necessário inteiro.
            error @ ExecutionError::ResponseTooLarge { .. } => Self::InvalidRequest {
                message: error.to_string(),
                cause: None,
            },
            ExecutionError::Cancelled => Self::Cancelled,
        }
    }
}

impl LoadSchemaError {
    fn header(name: &str, error: HeaderError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::header(name, &error)),
            message: error.to_string(),
        }
    }
}

impl From<EndpointError> for LoadSchemaError {
    fn from(error: EndpointError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

impl From<TemplateError> for LoadSchemaError {
    fn from(error: TemplateError) -> Self {
        Self::InvalidRequest {
            cause: InvalidRequestCause::template(&error),
            message: error.to_string(),
        }
    }
}

impl From<EnvironmentVariableError> for LoadSchemaError {
    fn from(error: EnvironmentVariableError) -> Self {
        Self::InvalidRequest {
            cause: Some(InvalidRequestCause::from(&error)),
            message: error.to_string(),
        }
    }
}

impl From<SchemaError> for LoadSchemaError {
    fn from(error: SchemaError) -> Self {
        let (cause, message) = match error {
            SchemaError::GraphqlError(message) => (SchemaResponseCause::ServerErrors, message),
            SchemaError::InvalidJson(message) => (SchemaResponseCause::NotJson, message),
            SchemaError::MissingSchema => (SchemaResponseCause::MissingSchema, String::new()),
        };
        Self::InvalidResponse { message, cause }
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadSchemaOutput {
    pub query_type: Option<String>,
    pub mutation_type: Option<String>,
    pub subscription_type: Option<String>,
    pub types: Vec<SchemaTypeOutput>,
    pub directives: Vec<SchemaDirectiveOutput>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTypeOutput {
    pub name: String,
    pub kind: String,
    pub description: Option<String>,
    pub fields: Vec<SchemaFieldOutput>,
    pub input_fields: Vec<SchemaInputValueOutput>,
    pub enum_values: Vec<SchemaEnumValueOutput>,
    pub interfaces: Vec<String>,
    pub possible_types: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaFieldOutput {
    pub name: String,
    pub description: Option<String>,
    pub args: Vec<SchemaInputValueOutput>,
    pub type_display: String,
    pub type_name: Option<String>,
    pub is_deprecated: bool,
    pub deprecation_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInputValueOutput {
    pub name: String,
    pub description: Option<String>,
    pub type_display: String,
    pub type_name: Option<String>,
    pub default_value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaEnumValueOutput {
    pub name: String,
    pub description: Option<String>,
    pub is_deprecated: bool,
    pub deprecation_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDirectiveOutput {
    pub name: String,
    pub description: Option<String>,
    pub locations: Vec<String>,
    pub args: Vec<SchemaInputValueOutput>,
}

fn kind_to_string(kind: &GraphqlTypeKind) -> String {
    match kind {
        GraphqlTypeKind::Scalar => "SCALAR".to_string(),
        GraphqlTypeKind::Object => "OBJECT".to_string(),
        GraphqlTypeKind::Interface => "INTERFACE".to_string(),
        GraphqlTypeKind::Union => "UNION".to_string(),
        GraphqlTypeKind::Enum => "ENUM".to_string(),
        GraphqlTypeKind::InputObject => "INPUT_OBJECT".to_string(),
        GraphqlTypeKind::Other(raw) => raw.clone(),
    }
}

impl From<GraphqlEnumValue> for SchemaEnumValueOutput {
    fn from(value: GraphqlEnumValue) -> Self {
        Self {
            name: value.name,
            description: value.description,
            is_deprecated: value.is_deprecated,
            deprecation_reason: value.deprecation_reason,
        }
    }
}

impl From<GraphqlInputValue> for SchemaInputValueOutput {
    fn from(value: GraphqlInputValue) -> Self {
        Self {
            name: value.name,
            description: value.description,
            type_display: value.type_display,
            type_name: value.type_name,
            default_value: value.default_value,
        }
    }
}

impl From<GraphqlField> for SchemaFieldOutput {
    fn from(field: GraphqlField) -> Self {
        Self {
            name: field.name,
            description: field.description,
            args: field
                .args
                .into_iter()
                .map(SchemaInputValueOutput::from)
                .collect(),
            type_display: field.type_display,
            type_name: field.type_name,
            is_deprecated: field.is_deprecated,
            deprecation_reason: field.deprecation_reason,
        }
    }
}

impl From<GraphqlNamedType> for SchemaTypeOutput {
    fn from(named_type: GraphqlNamedType) -> Self {
        Self {
            name: named_type.name,
            kind: kind_to_string(&named_type.kind),
            description: named_type.description,
            fields: named_type
                .fields
                .into_iter()
                .map(SchemaFieldOutput::from)
                .collect(),
            input_fields: named_type
                .input_fields
                .into_iter()
                .map(SchemaInputValueOutput::from)
                .collect(),
            enum_values: named_type
                .enum_values
                .into_iter()
                .map(SchemaEnumValueOutput::from)
                .collect(),
            interfaces: named_type.interfaces,
            possible_types: named_type.possible_types,
        }
    }
}

impl From<GraphqlDirective> for SchemaDirectiveOutput {
    fn from(directive: GraphqlDirective) -> Self {
        Self {
            name: directive.name,
            description: directive.description,
            locations: directive.locations,
            args: directive
                .args
                .into_iter()
                .map(SchemaInputValueOutput::from)
                .collect(),
        }
    }
}

impl From<GraphqlSchema> for LoadSchemaOutput {
    fn from(schema: GraphqlSchema) -> Self {
        Self {
            query_type: schema.query_type,
            mutation_type: schema.mutation_type,
            subscription_type: schema.subscription_type,
            types: schema
                .types
                .into_iter()
                .map(SchemaTypeOutput::from)
                .collect(),
            directives: schema
                .directives
                .into_iter()
                .map(SchemaDirectiveOutput::from)
                .collect(),
        }
    }
}

fn resolve(template: &str, variables: &[EnvironmentVariable]) -> Result<String, LoadSchemaError> {
    Ok(resolve_variables(template, variables)?)
}

fn build_introspection_request(
    input: &LoadSchemaInput,
    environment_variables: &[EnvironmentVariable],
) -> Result<Request, LoadSchemaError> {
    let endpoint_url = resolve(&input.endpoint_url, environment_variables)?;
    let endpoint = Endpoint::new(endpoint_url)?;

    let headers = input
        .headers
        .iter()
        .map(|header| -> Result<HeaderEntry, LoadSchemaError> {
            let value = resolve(&header.value, environment_variables)?;
            HeaderEntry::new(&header.name, value, header.enabled)
                .map_err(|error| LoadSchemaError::header(&header.name, error))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let authentication = match &input.authentication {
        AuthenticationInput::None | AuthenticationInput::Inherit => Authentication::None,
        AuthenticationInput::CustomHeader { name, value } => Authentication::CustomHeader {
            name: resolve(name, environment_variables)?,
            value: resolve(value, environment_variables)?,
        },
        AuthenticationInput::Bearer { token } => Authentication::Bearer {
            token: resolve(token, environment_variables)?,
        },
        AuthenticationInput::Basic { username, password } => Authentication::Basic {
            username: resolve(username, environment_variables)?,
            password: resolve(password, environment_variables)?,
        },
        AuthenticationInput::Digest { username, password } => Authentication::Digest {
            username: resolve(username, environment_variables)?,
            password: resolve(password, environment_variables)?,
        },
        AuthenticationInput::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => Authentication::OAuth2ClientCredentials {
            client_id: resolve(client_id, environment_variables)?,
            client_secret: resolve(client_secret, environment_variables)?,
            token_url: resolve(token_url, environment_variables)?,
            scope: resolve(scope, environment_variables)?,
        },
    };

    // O schema só serve inteiro (um corte quebraria o parse), e o que
    // fica em memória é o schema já interpretado: a introspection ignora o
    // limite de tamanho de resposta.
    Ok(introspection_request(endpoint, headers, authentication).with_unlimited_response_size(true))
}

async fn cancellation_signal(receiver: oneshot::Receiver<()>) {
    let _ = receiver.await;
}

/// Busca e interpreta o schema GraphQL via introspection. Cancelável via
/// `cancel_graphql_request` com o mesmo `execution_id` (mesmo registro
/// usado por `execute_graphql_request` — introspection é só mais uma
/// requisição GraphQL do ponto de vista de transporte). Em sucesso, o
/// resultado fica em `SchemaStore` (disco) até o próximo `force_refresh`;
/// uma entrada em disco corrompida ou de um formato antigo é tratada como
/// cache ausente, não como erro — só significa buscar de novo.
#[tauri::command]
pub async fn load_schema(
    input: LoadSchemaInput,
    registry: tauri::State<'_, ExecutionRegistry>,
    store: tauri::State<'_, SchemaStore>,
    executor: tauri::State<'_, ReqwestGraphqlExecutor>,
) -> Result<LoadSchemaOutput, LoadSchemaError> {
    let result: Result<LoadSchemaOutput, LoadSchemaError> =
        async { load_schema_inner(input, &registry, &store, &executor).await }.await;
    crate::logging::logged("alcy::schema", "carregar schema", result)
}

async fn load_schema_inner(
    input: LoadSchemaInput,
    registry: &ExecutionRegistry,
    store: &SchemaStore,
    executor: &ReqwestGraphqlExecutor,
) -> Result<LoadSchemaOutput, LoadSchemaError> {
    let mut input = input;
    let execution_id = input.execution_id.clone();
    let force_refresh = input.force_refresh;
    input.authentication = resolve_inherited_authentication(
        input.authentication,
        input.request_id.as_deref(),
        input.root_path.as_deref(),
    )
    .await;

    let scopes = scopes_from_dto(std::mem::take(&mut input.variable_scopes))?;
    let environment_variables = with_scoped_variables(&input.environment_variables, &scopes)
        .into_iter()
        .map(|variable| EnvironmentVariable::new(variable.name, variable.value, variable.sensitive))
        .collect::<Result<Vec<_>, _>>()?;

    let request = build_introspection_request(&input, &environment_variables)?;
    let cache_key = request.endpoint.url().to_string();

    if !force_refresh {
        if let Some(cached) = cached_output(store.clone(), cache_key.clone()).await {
            return Ok(cached);
        }
    }

    let (sender, receiver) = oneshot::channel();
    registry.register(execution_id.clone(), sender);

    let outcome = execute_request(executor, &request, cancellation_signal(receiver)).await;
    registry.remove(&execution_id);

    let response = outcome?;
    let schema = parse_schema(&response.body)?;
    let output = LoadSchemaOutput::from(schema);

    if let Ok(value) = serde_json::to_value(&output) {
        // Falha ao persistir o cache (disco cheio, permissão, etc.) não
        // deveria derrubar uma introspection que já teve sucesso — só
        // significa que a próxima chamada vai buscar de novo. Roda em
        // `spawn_blocking` (I/O de disco síncrono) mas aguardado: uma
        // leitura subsequente do cache precisa enxergar esta escrita já
        // concluída, então não pode ser fire-and-forget.
        let store = store.clone();
        let cache_key = cache_key.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || store.save(&cache_key, value)).await;
    }

    Ok(output)
}

/// `None` tanto para "sem entrada" quanto para "entrada não decodifica mais
/// no formato atual" (ou o `spawn_blocking` abaixo falhar) — todos os casos
/// são resolvidos buscando de novo, não propagando um erro de storage por
/// um cache que é só uma otimização. A leitura roda em `spawn_blocking`
/// (I/O de disco síncrono) mas aguardada: o resultado decide se uma
/// requisição de rede é disparada.
async fn cached_output(store: SchemaStore, cache_key: String) -> Option<LoadSchemaOutput> {
    let value = tauri::async_runtime::spawn_blocking(move || store.get(&cache_key).ok().flatten())
        .await
        .ok()
        .flatten()?;
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_store() -> (SchemaStore, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("alcy-schema-cmd-test-{nanos}-{count}"));
        (SchemaStore::new(path.clone()), path)
    }

    fn valid_input(endpoint_url: &str, execution_id: &str) -> LoadSchemaInput {
        LoadSchemaInput {
            request_id: None,
            root_path: None,
            execution_id: execution_id.to_string(),
            endpoint_url: endpoint_url.to_string(),
            headers: vec![],
            authentication: AuthenticationInput::None,
            environment_variables: vec![],
            variable_scopes: vec![],
            force_refresh: false,
        }
    }

    fn schema_response_body() -> String {
        r#"{
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
                                    "name": "ping",
                                    "description": null,
                                    "isDeprecated": false,
                                    "deprecationReason": null,
                                    "args": [],
                                    "type": {"kind": "SCALAR", "name": "Boolean", "ofType": null}
                                }
                            ],
                            "inputFields": [],
                            "interfaces": [],
                            "possibleTypes": [],
                            "enumValues": []
                        }
                    ],
                    "directives": []
                }
            }
        }"#
        .to_string()
    }

    #[tokio::test]
    async fn maps_a_successful_introspection_to_the_output_dto() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(schema_response_body()))
            .mount(&server)
            .await;

        let input = valid_input(&server.uri(), "exec-1");
        let registry = ExecutionRegistry::default();
        let (store, path) = temp_store();
        let executor = ReqwestGraphqlExecutor::new();

        let output = load_schema_inner(input, &registry, &store, &executor)
            .await
            .unwrap();

        assert_eq!(output.query_type, Some("Query".to_string()));
        assert_eq!(output.types.len(), 1);
        assert_eq!(output.types[0].fields[0].type_display, "Boolean");
        assert!(!output.types[0].fields[0].is_deprecated);

        std::fs::remove_dir_all(&path).ok();
    }

    #[tokio::test]
    async fn reuses_the_disk_cache_without_a_second_network_call() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(schema_response_body()))
            .expect(1)
            .mount(&server)
            .await;

        let registry = ExecutionRegistry::default();
        let (store, path) = temp_store();
        let executor = ReqwestGraphqlExecutor::new();

        load_schema_inner(
            valid_input(&server.uri(), "exec-1"),
            &registry,
            &store,
            &executor,
        )
        .await
        .unwrap();
        let second = load_schema_inner(
            valid_input(&server.uri(), "exec-2"),
            &registry,
            &store,
            &executor,
        )
        .await
        .unwrap();

        assert_eq!(second.query_type, Some("Query".to_string()));
        // A expectativa `.expect(1)` do mock é verificada ao cair de escopo
        // (drop do `MockServer`), garantindo que a segunda chamada não
        // bateu na rede — veio do cache em disco.

        std::fs::remove_dir_all(&path).ok();
    }

    #[tokio::test]
    async fn cache_survives_a_new_store_instance_pointed_at_the_same_dir() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(schema_response_body()))
            .expect(1)
            .mount(&server)
            .await;

        let registry = ExecutionRegistry::default();
        let (store, path) = temp_store();
        let executor = ReqwestGraphqlExecutor::new();

        load_schema_inner(
            valid_input(&server.uri(), "exec-1"),
            &registry,
            &store,
            &executor,
        )
        .await
        .unwrap();

        // Simula reabrir o app: uma nova instância de `SchemaStore` sobre o
        // mesmo diretório ainda enxerga o cache.
        let reopened_store = SchemaStore::new(path.clone());
        let second = load_schema_inner(
            valid_input(&server.uri(), "exec-2"),
            &registry,
            &reopened_store,
            &executor,
        )
        .await
        .unwrap();

        assert_eq!(second.query_type, Some("Query".to_string()));

        std::fs::remove_dir_all(&path).ok();
    }

    #[tokio::test]
    async fn force_refresh_bypasses_the_cache() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(schema_response_body()))
            .expect(2)
            .mount(&server)
            .await;

        let registry = ExecutionRegistry::default();
        let (store, path) = temp_store();
        let executor = ReqwestGraphqlExecutor::new();

        load_schema_inner(
            valid_input(&server.uri(), "exec-1"),
            &registry,
            &store,
            &executor,
        )
        .await
        .unwrap();

        let mut refresh_input = valid_input(&server.uri(), "exec-2");
        refresh_input.force_refresh = true;
        load_schema_inner(refresh_input, &registry, &store, &executor)
            .await
            .unwrap();

        std::fs::remove_dir_all(&path).ok();
    }

    #[tokio::test]
    async fn maps_introspection_disabled_to_invalid_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "{\"data\":null,\"errors\":[{\"message\":\"Introspection is disabled\"}]}",
            ))
            .mount(&server)
            .await;

        let input = valid_input(&server.uri(), "exec-1");
        let registry = ExecutionRegistry::default();
        let (store, path) = temp_store();
        let executor = ReqwestGraphqlExecutor::new();

        let error = load_schema_inner(input, &registry, &store, &executor)
            .await
            .unwrap_err();

        assert_eq!(
            error,
            LoadSchemaError::InvalidResponse {
                message: "Introspection is disabled".to_string(),
                cause: SchemaResponseCause::ServerErrors,
            }
        );

        std::fs::remove_dir_all(&path).ok();
    }

    #[tokio::test]
    async fn rejects_an_empty_endpoint_without_touching_the_network() {
        let mut input = valid_input("https://api.example.com/graphql", "exec-1");
        input.endpoint_url = "".to_string();
        let registry = ExecutionRegistry::default();
        let (store, path) = temp_store();
        let executor = ReqwestGraphqlExecutor::new();

        let error = load_schema_inner(input, &registry, &store, &executor)
            .await
            .unwrap_err();

        assert_eq!(
            error,
            LoadSchemaError::InvalidRequest {
                message: EndpointError::Empty.to_string(),
                cause: Some(InvalidRequestCause::EmptyEndpoint),
            }
        );

        std::fs::remove_dir_all(&path).ok();
    }

    #[tokio::test]
    async fn cancelling_before_the_response_arrives_yields_a_cancelled_error() {
        use std::sync::Arc;
        use std::time::Duration;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;

        let input = valid_input(&server.uri(), "exec-cancel");
        let registry = Arc::new(ExecutionRegistry::default());
        let (store, path) = temp_store();
        let store = Arc::new(store);
        let executor = Arc::new(ReqwestGraphqlExecutor::new());
        let registry_for_task = registry.clone();
        let store_for_task = store.clone();
        let executor_for_task = executor.clone();

        let handle = tokio::spawn(async move {
            load_schema_inner(
                input,
                &registry_for_task,
                &store_for_task,
                &executor_for_task,
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        registry.cancel("exec-cancel");

        let error = handle.await.unwrap().unwrap_err();

        assert_eq!(error, LoadSchemaError::Cancelled);

        std::fs::remove_dir_all(&path).ok();
    }
}
