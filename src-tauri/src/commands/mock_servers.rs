use std::path::PathBuf;

use alcy_domain::{
    HttpMethod, MockCondition, MockConditionGroup, MockConditionOperator, MockConditionSource,
    MockMatchOperator, MockResponse, MockRoute, MockServer,
};
use alcy_storage::{MockServerStore, StorageError};
use serde::{Deserialize, Serialize};

use crate::commands::ordered_save::OrderedSaves;
pub use crate::mock_runtime::{MockCallLogDto, MockServerRuntime};
use crate::mock_runtime::{StartError, method_to};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockServerSummaryDto {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub running: bool,
    pub routes_count: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockServersDto {
    pub servers: Vec<MockServerSummaryDto>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockServerDto {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub cors_enabled: bool,
    pub routes: Vec<MockRouteDto>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockRouteDto {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub method: String,
    pub path: String,
    pub default_response: MockResponseDto,
    pub alternatives: Vec<MockResponseDto>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockResponseDto {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub status: u16,
    pub headers: Vec<MockHeaderDto>,
    pub body: String,
    pub delay_ms: u64,
    pub condition: Option<MockConditionGroupDto>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MockHeaderDto {
    pub name: String,
    pub value: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockConditionGroupDto {
    pub operator: String,
    pub conditions: Vec<MockConditionDto>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MockConditionDto {
    Group {
        group: MockConditionGroupDto,
    },
    Match {
        source: String,
        key: String,
        operator: String,
        value: String,
    },
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMockServersInput {
    pub root_path: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMockServerInput {
    pub root_path: String,
    pub server_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMockServerInput {
    pub root_path: String,
    pub server: MockServerDto,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateMockServerInput {
    pub server: MockServerDto,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMockServerInput {
    pub root_path: String,
    pub server_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockCallsInput {
    pub server_id: String,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MockServersError {
    #[error("invalid configuration: {message}")]
    Invalid { message: String },
    #[error("storage failure: {message}")]
    Storage { message: String },
    #[error("mock server not found")]
    NotFound,
}
impl From<StorageError> for MockServersError {
    fn from(value: StorageError) -> Self {
        Self::Storage {
            message: value.to_string(),
        }
    }
}

#[tauri::command]
pub async fn list_mock_servers(
    input: ListMockServersInput,
    runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<MockServersDto, MockServersError> {
    let running = runtime.running_ids();
    run(move || {
        let servers = MockServerStore::new(PathBuf::from(input.root_path)).load()?;
        Ok(MockServersDto {
            servers: servers
                .into_iter()
                .map(|server| MockServerSummaryDto {
                    running: running.contains(&server.id),
                    id: server.id,
                    name: server.name,
                    port: server.port,
                    routes_count: server.routes.len(),
                })
                .collect(),
        })
    })
    .await
}
#[tauri::command]
pub async fn get_mock_server(input: GetMockServerInput) -> Result<MockServerDto, MockServersError> {
    run(move || {
        MockServerStore::new(PathBuf::from(input.root_path))
            .load()?
            .into_iter()
            .find(|server| server.id == input.server_id)
            .map(server_to_dto)
            .ok_or(MockServersError::NotFound)
    })
    .await
}
static SAVES: OrderedSaves = OrderedSaves::new();
/// Validate an editor draft through the same domain conversion as persistence, without saving.
#[tauri::command]
pub async fn validate_mock_server(input: ValidateMockServerInput) -> Result<(), MockServersError> {
    run(move || server_from_dto(input.server).map(|_| ())).await
}

#[tauri::command]
pub async fn save_mock_server(
    input: SaveMockServerInput,
    runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<(), MockServersError> {
    let ticket = SAVES.ticket();
    let server = server_from_dto(input.server)?;
    if runtime
        .running_port(&server.id)
        .is_some_and(|port| port != server.port)
    {
        return Err(invalid("stop the server before changing its port"));
    }
    let saved = server.clone();
    run(move || {
        let root = PathBuf::from(&input.root_path);
        let store_root = root.clone();
        SAVES.run(ticket, &root, || -> Result<(), MockServersError> {
            let store = MockServerStore::new(store_root);
            let mut servers = store.load()?;
            if let Some(current) = servers.iter_mut().find(|current| current.id == server.id) {
                *current = server;
            } else {
                servers.push(server);
            }
            store.save(&servers)?;
            Ok(())
        })
    })
    .await?;
    runtime.update(&saved);
    Ok(())
}
#[tauri::command]
pub async fn delete_mock_server(
    input: DeleteMockServerInput,
    runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<(), MockServersError> {
    let server_id = input.server_id.clone();
    run(move || {
        let root = PathBuf::from(input.root_path);
        let store = MockServerStore::new(root);
        let mut servers = store.load()?;
        let before = servers.len();
        servers.retain(|server| server.id != input.server_id);
        if before == servers.len() {
            return Err(MockServersError::NotFound);
        }
        store.save(&servers)?;
        Ok(())
    })
    .await?;
    runtime.stop(&server_id);
    Ok(())
}
#[tauri::command]
pub async fn start_mock_server(
    input: GetMockServerInput,
    runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<(), MockServersError> {
    let server = run(move || {
        MockServerStore::new(PathBuf::from(input.root_path))
            .load()?
            .into_iter()
            .find(|server| server.id == input.server_id)
            .ok_or(MockServersError::NotFound)
    })
    .await?;
    runtime.start(server).map_err(|error| match error {
        StartError::PortUnavailable { .. } => MockServersError::Invalid {
            message: error.to_string(),
        },
        StartError::Io(message) => MockServersError::Storage { message },
    })
}
#[tauri::command]
pub fn stop_mock_server(
    input: GetMockServerInput,
    runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<(), MockServersError> {
    runtime.stop(&input.server_id);
    Ok(())
}
#[tauri::command]
pub fn list_mock_calls(
    input: MockCallsInput,
    runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<Vec<MockCallLogDto>, MockServersError> {
    Ok(runtime.logs(&input.server_id, input.offset, input.limit))
}
#[tauri::command]
pub fn clear_mock_calls(
    input: GetMockServerInput,
    runtime: tauri::State<'_, MockServerRuntime>,
) -> Result<(), MockServersError> {
    runtime.clear_logs(&input.server_id);
    Ok(())
}
async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, MockServersError> + Send + 'static,
) -> Result<T, MockServersError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(MockServersError::Storage {
                message: error.to_string(),
            })
        })
}

pub(crate) fn server_to_dto(value: MockServer) -> MockServerDto {
    MockServerDto {
        id: value.id,
        name: value.name,
        port: value.port,
        cors_enabled: value.cors_enabled,
        routes: value.routes.into_iter().map(route_to_dto).collect(),
    }
}
fn route_to_dto(value: MockRoute) -> MockRouteDto {
    MockRouteDto {
        id: value.id,
        name: value.name,
        enabled: value.enabled,
        method: method_to(value.method).into(),
        path: value.path,
        default_response: response_to_dto(value.default_response),
        alternatives: value
            .alternatives
            .into_iter()
            .map(response_to_dto)
            .collect(),
    }
}
fn response_to_dto(value: MockResponse) -> MockResponseDto {
    MockResponseDto {
        id: value.id,
        name: value.name,
        enabled: value.enabled,
        status: value.status,
        headers: value
            .headers
            .into_iter()
            .map(|(name, value)| MockHeaderDto { name, value })
            .collect(),
        body: value.body,
        delay_ms: value.delay_ms,
        condition: value.condition.map(group_to_dto),
    }
}
fn group_to_dto(value: MockConditionGroup) -> MockConditionGroupDto {
    MockConditionGroupDto {
        operator: match value.operator {
            MockConditionOperator::All => "all",
            MockConditionOperator::Any => "any",
        }
        .into(),
        conditions: value.conditions.into_iter().map(condition_to_dto).collect(),
    }
}
fn condition_to_dto(value: MockCondition) -> MockConditionDto {
    match value {
        MockCondition::Group(group) => MockConditionDto::Group {
            group: group_to_dto(group),
        },
        MockCondition::Match {
            source,
            key,
            operator,
            value,
        } => MockConditionDto::Match {
            source: source_to(source).into(),
            key,
            operator: match_to(operator).into(),
            value,
        },
    }
}
pub(crate) fn server_from_dto(value: MockServerDto) -> Result<MockServer, MockServersError> {
    if value.name.trim().is_empty() {
        return Err(invalid("empty name"));
    }
    if value.port == 0 {
        return Err(invalid("invalid port"));
    }
    Ok(MockServer {
        id: value.id,
        name: value.name,
        port: value.port,
        cors_enabled: value.cors_enabled,
        routes: value
            .routes
            .into_iter()
            .map(route_from_dto)
            .collect::<Result<_, _>>()?,
    })
}
fn route_from_dto(value: MockRouteDto) -> Result<MockRoute, MockServersError> {
    if !value.path.starts_with('/') {
        return Err(invalid("route paths must start with /"));
    }
    Ok(MockRoute {
        id: value.id,
        name: value.name,
        enabled: value.enabled,
        method: method_from(&value.method)?,
        path: value.path,
        default_response: response_from_dto(value.default_response)?,
        alternatives: value
            .alternatives
            .into_iter()
            .map(response_from_dto)
            .collect::<Result<_, _>>()?,
    })
}
fn response_from_dto(value: MockResponseDto) -> Result<MockResponse, MockServersError> {
    if !(100..=599).contains(&value.status)
        || value.delay_ms > 60_000
        || value.body.len() > 1024 * 1024
    {
        return Err(invalid("invalid response"));
    }
    Ok(MockResponse {
        id: value.id,
        name: value.name,
        enabled: value.enabled,
        status: value.status,
        headers: value
            .headers
            .into_iter()
            .map(|header| (header.name, header.value))
            .collect(),
        body: value.body,
        delay_ms: value.delay_ms,
        condition: value.condition.map(group_from_dto).transpose()?,
    })
}
fn group_from_dto(value: MockConditionGroupDto) -> Result<MockConditionGroup, MockServersError> {
    Ok(MockConditionGroup {
        operator: match value.operator.as_str() {
            "all" => MockConditionOperator::All,
            "any" => MockConditionOperator::Any,
            _ => return Err(invalid("invalid group")),
        },
        conditions: value
            .conditions
            .into_iter()
            .map(condition_from_dto)
            .collect::<Result<_, _>>()?,
    })
}
fn condition_from_dto(value: MockConditionDto) -> Result<MockCondition, MockServersError> {
    match value {
        MockConditionDto::Group { group } => Ok(MockCondition::Group(group_from_dto(group)?)),
        MockConditionDto::Match {
            source,
            key,
            operator,
            value,
        } => Ok(MockCondition::Match {
            source: source_from(&source)?,
            key,
            operator: match_from(&operator)?,
            value,
        }),
    }
}
fn invalid(message: &str) -> MockServersError {
    MockServersError::Invalid {
        message: message.into(),
    }
}
fn method_from(value: &str) -> Result<HttpMethod, MockServersError> {
    match value {
        "GET" => Ok(HttpMethod::Get),
        "POST" => Ok(HttpMethod::Post),
        "PUT" => Ok(HttpMethod::Put),
        "PATCH" => Ok(HttpMethod::Patch),
        "DELETE" => Ok(HttpMethod::Delete),
        "HEAD" => Ok(HttpMethod::Head),
        "OPTIONS" => Ok(HttpMethod::Options),
        _ => Err(invalid("invalid method")),
    }
}
fn source_to(value: MockConditionSource) -> &'static str {
    match value {
        MockConditionSource::PathParameter => "pathParameter",
        MockConditionSource::Query => "query",
        MockConditionSource::Header => "header",
        MockConditionSource::BodyText => "bodyText",
        MockConditionSource::JsonPointer => "jsonPointer",
    }
}
fn source_from(value: &str) -> Result<MockConditionSource, MockServersError> {
    match value {
        "pathParameter" => Ok(MockConditionSource::PathParameter),
        "query" => Ok(MockConditionSource::Query),
        "header" => Ok(MockConditionSource::Header),
        "bodyText" => Ok(MockConditionSource::BodyText),
        "jsonPointer" => Ok(MockConditionSource::JsonPointer),
        _ => Err(invalid("invalid source")),
    }
}
fn match_to(value: MockMatchOperator) -> &'static str {
    match value {
        MockMatchOperator::Equals => "equals",
        MockMatchOperator::NotEquals => "notEquals",
        MockMatchOperator::Contains => "contains",
        MockMatchOperator::Exists => "exists",
        MockMatchOperator::NotExists => "notExists",
    }
}
fn match_from(value: &str) -> Result<MockMatchOperator, MockServersError> {
    match value {
        "equals" => Ok(MockMatchOperator::Equals),
        "notEquals" => Ok(MockMatchOperator::NotEquals),
        "contains" => Ok(MockMatchOperator::Contains),
        "exists" => Ok(MockMatchOperator::Exists),
        "notExists" => Ok(MockMatchOperator::NotExists),
        _ => Err(invalid("invalid operator")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> MockServerDto {
        MockServerDto {
            id: "mock".into(),
            name: "Example".into(),
            port: 3001,
            cors_enabled: true,
            routes: vec![],
        }
    }

    #[tokio::test]
    async fn validates_a_draft_without_a_workspace_or_runtime() {
        assert!(
            validate_mock_server(ValidateMockServerInput { server: server() })
                .await
                .is_ok()
        );
        let mut draft = server();
        draft.port = 0;
        assert!(matches!(
            validate_mock_server(ValidateMockServerInput { server: draft }).await,
            Err(MockServersError::Invalid { .. })
        ));
    }

    #[tokio::test]
    async fn rejects_invalid_nested_response_conditions_before_publishing_a_draft() {
        let draft = MockServerDto {
            routes: vec![MockRouteDto {
                id: "route".into(),
                name: "Users".into(),
                enabled: true,
                method: "GET".into(),
                path: "/users".into(),
                alternatives: vec![],
                default_response: MockResponseDto {
                    id: "response".into(),
                    name: "OK".into(),
                    enabled: true,
                    status: 200,
                    headers: vec![],
                    body: "{}".into(),
                    delay_ms: 0,
                    condition: Some(MockConditionGroupDto {
                        operator: "invalid".into(),
                        conditions: vec![],
                    }),
                },
            }],
            ..server()
        };
        assert!(matches!(
            validate_mock_server(ValidateMockServerInput { server: draft }).await,
            Err(MockServersError::Invalid { .. })
        ));
    }
}
