use crate::HttpMethod;

pub const DEFAULT_MOCK_PORT: u16 = 3001;
pub const MAX_MOCK_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_MOCK_DELAY_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockServer {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub cors_enabled: bool,
    pub routes: Vec<MockRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockRoute {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub method: HttpMethod,
    pub path: String,
    pub default_response: MockResponse,
    pub alternatives: Vec<MockResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockResponse {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub delay_ms: u64,
    pub condition: Option<MockConditionGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockConditionGroup {
    pub operator: MockConditionOperator,
    pub conditions: Vec<MockCondition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockConditionOperator {
    All,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockCondition {
    Group(MockConditionGroup),
    Match {
        source: MockConditionSource,
        key: String,
        operator: MockMatchOperator,
        value: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockConditionSource {
    PathParameter,
    Query,
    Header,
    BodyText,
    JsonPointer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockMatchOperator {
    Equals,
    NotEquals,
    Contains,
    Exists,
    NotExists,
}

impl MockServer {
    pub fn new(id: String, name: String, port: u16) -> Self {
        Self {
            id,
            name,
            port,
            cors_enabled: true,
            routes: Vec::new(),
        }
    }
}
