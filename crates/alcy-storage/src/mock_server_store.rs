use std::fs;
use std::path::PathBuf;

use alcy_domain::{
    HttpMethod, MockCondition, MockConditionGroup, MockConditionOperator, MockConditionSource,
    MockMatchOperator, MockResponse, MockRoute, MockServer,
};
use serde::{Deserialize, Serialize};

use crate::StorageError;

pub const MOCK_SERVERS_FILE: &str = "alcy-mock-servers.json";
const VERSION: u32 = 1;

pub struct MockServerStore {
    path: PathBuf,
}

impl MockServerStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join(MOCK_SERVERS_FILE),
        }
    }
    pub fn load(&self) -> Result<Vec<MockServer>, StorageError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let input =
            fs::read_to_string(&self.path).map_err(|e| StorageError::Read(e.to_string()))?;
        let file: File =
            serde_json::from_str(&input).map_err(|e| StorageError::Corrupted(e.to_string()))?;
        if file.version != VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        file.servers.into_iter().map(server_from).collect()
    }
    pub fn save(&self, servers: &[MockServer]) -> Result<(), StorageError> {
        let file = File {
            version: VERSION,
            servers: servers.iter().map(server_to).collect(),
        };
        let json =
            serde_json::to_vec_pretty(&file).map_err(|e| StorageError::Write(e.to_string()))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| StorageError::Write(e.to_string()))?;
        }
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, json).map_err(|e| StorageError::Write(e.to_string()))?;
        fs::rename(&temporary, &self.path).map_err(|e| StorageError::Write(e.to_string()))
    }
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    servers: Vec<Server>,
}
/// Forma em disco de um mock server — também usada por `flow_store` para o
/// mock avulso de um node `MockStart` (spec 0121).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Server {
    id: String,
    name: String,
    port: u16,
    cors_enabled: bool,
    routes: Vec<Route>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    id: String,
    name: String,
    enabled: bool,
    method: String,
    path: String,
    default_response: Response,
    alternatives: Vec<Response>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: String,
    name: String,
    enabled: bool,
    status: u16,
    headers: Vec<Header>,
    body: String,
    delay_ms: u64,
    condition: Option<Group>,
}
#[derive(Serialize, Deserialize)]
struct Header {
    name: String,
    value: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    operator: String,
    conditions: Vec<Condition>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Condition {
    Group {
        group: Group,
    },
    Match {
        source: String,
        key: String,
        operator: String,
        value: String,
    },
}

pub(crate) fn server_to(value: &MockServer) -> Server {
    Server {
        id: value.id.clone(),
        name: value.name.clone(),
        port: value.port,
        cors_enabled: value.cors_enabled,
        routes: value.routes.iter().map(route_to).collect(),
    }
}
fn route_to(value: &MockRoute) -> Route {
    Route {
        id: value.id.clone(),
        name: value.name.clone(),
        enabled: value.enabled,
        method: method_to(value.method).to_string(),
        path: value.path.clone(),
        default_response: response_to(&value.default_response),
        alternatives: value.alternatives.iter().map(response_to).collect(),
    }
}
fn response_to(value: &MockResponse) -> Response {
    Response {
        id: value.id.clone(),
        name: value.name.clone(),
        enabled: value.enabled,
        status: value.status,
        headers: value
            .headers
            .iter()
            .map(|(name, value)| Header {
                name: name.clone(),
                value: value.clone(),
            })
            .collect(),
        body: value.body.clone(),
        delay_ms: value.delay_ms,
        condition: value.condition.as_ref().map(group_to),
    }
}
fn group_to(value: &MockConditionGroup) -> Group {
    Group {
        operator: match value.operator {
            MockConditionOperator::All => "all",
            MockConditionOperator::Any => "any",
        }
        .into(),
        conditions: value.conditions.iter().map(condition_to).collect(),
    }
}
fn condition_to(value: &MockCondition) -> Condition {
    match value {
        MockCondition::Group(group) => Condition::Group {
            group: group_to(group),
        },
        MockCondition::Match {
            source,
            key,
            operator,
            value,
        } => Condition::Match {
            source: source_to(*source).into(),
            key: key.clone(),
            operator: operator_to(*operator).into(),
            value: value.clone(),
        },
    }
}
pub(crate) fn server_from(value: Server) -> Result<MockServer, StorageError> {
    Ok(MockServer {
        id: value.id,
        name: value.name,
        port: value.port,
        cors_enabled: value.cors_enabled,
        routes: value
            .routes
            .into_iter()
            .map(route_from)
            .collect::<Result<_, _>>()?,
    })
}
fn route_from(value: Route) -> Result<MockRoute, StorageError> {
    Ok(MockRoute {
        id: value.id,
        name: value.name,
        enabled: value.enabled,
        method: method_from(&value.method)?,
        path: value.path,
        default_response: response_from(value.default_response)?,
        alternatives: value
            .alternatives
            .into_iter()
            .map(response_from)
            .collect::<Result<_, _>>()?,
    })
}
fn response_from(value: Response) -> Result<MockResponse, StorageError> {
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
        condition: value.condition.map(group_from).transpose()?,
    })
}
fn group_from(value: Group) -> Result<MockConditionGroup, StorageError> {
    Ok(MockConditionGroup {
        operator: match value.operator.as_str() {
            "all" => MockConditionOperator::All,
            "any" => MockConditionOperator::Any,
            _ => return Err(invalid("operador de grupo")),
        },
        conditions: value
            .conditions
            .into_iter()
            .map(condition_from)
            .collect::<Result<_, _>>()?,
    })
}
fn condition_from(value: Condition) -> Result<MockCondition, StorageError> {
    match value {
        Condition::Group { group } => Ok(MockCondition::Group(group_from(group)?)),
        Condition::Match {
            source,
            key,
            operator,
            value,
        } => Ok(MockCondition::Match {
            source: source_from(&source)?,
            key,
            operator: operator_from(&operator)?,
            value,
        }),
    }
}
fn invalid(field: &str) -> StorageError {
    StorageError::Corrupted(format!("mock server com {field} inválido"))
}
fn method_to(value: HttpMethod) -> &'static str {
    match value {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Put => "PUT",
        HttpMethod::Patch => "PATCH",
        HttpMethod::Delete => "DELETE",
        HttpMethod::Head => "HEAD",
        HttpMethod::Options => "OPTIONS",
    }
}
fn method_from(value: &str) -> Result<HttpMethod, StorageError> {
    match value {
        "GET" => Ok(HttpMethod::Get),
        "POST" => Ok(HttpMethod::Post),
        "PUT" => Ok(HttpMethod::Put),
        "PATCH" => Ok(HttpMethod::Patch),
        "DELETE" => Ok(HttpMethod::Delete),
        "HEAD" => Ok(HttpMethod::Head),
        "OPTIONS" => Ok(HttpMethod::Options),
        _ => Err(invalid("método")),
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
fn source_from(value: &str) -> Result<MockConditionSource, StorageError> {
    match value {
        "pathParameter" => Ok(MockConditionSource::PathParameter),
        "query" => Ok(MockConditionSource::Query),
        "header" => Ok(MockConditionSource::Header),
        "bodyText" => Ok(MockConditionSource::BodyText),
        "jsonPointer" => Ok(MockConditionSource::JsonPointer),
        _ => Err(invalid("origem da condição")),
    }
}
fn operator_to(value: MockMatchOperator) -> &'static str {
    match value {
        MockMatchOperator::Equals => "equals",
        MockMatchOperator::NotEquals => "notEquals",
        MockMatchOperator::Contains => "contains",
        MockMatchOperator::Exists => "exists",
        MockMatchOperator::NotExists => "notExists",
    }
}
fn operator_from(value: &str) -> Result<MockMatchOperator, StorageError> {
    match value {
        "equals" => Ok(MockMatchOperator::Equals),
        "notEquals" => Ok(MockMatchOperator::NotEquals),
        "contains" => Ok(MockMatchOperator::Contains),
        "exists" => Ok(MockMatchOperator::Exists),
        "notExists" => Ok(MockMatchOperator::NotExists),
        _ => Err(invalid("operador da condição")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_file_is_empty() {
        let root = std::env::temp_dir().join(format!("alcy-mock-store-{}", std::process::id()));
        let store = MockServerStore::new(root.clone());
        assert!(store.load().unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
