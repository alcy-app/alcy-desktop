//! Tipos e regras de domínio do Alcy.

mod api_docs;
mod authentication;
mod body_payload;
mod collection;
mod collection_run;
mod document;
mod endpoint;
mod environment;
mod execution_error;
mod flow;
mod general_settings;
mod gitlab;
mod header;
mod history_entry;
mod http_method;
mod mock_server;
mod proxy_settings;
mod request;
mod response;
mod security_settings;
mod update;
mod value_monitor;
mod variable_scope;
mod workspace;

pub use api_docs::{
    ApiDocsSource, ApiDocsSourceKind, BodyDoc, DocsRef, MediaDoc, ParameterDoc, ParameterLocation,
    RequestDocs, ResponseDoc, SchemaNode, reachable_schemas, referenced_docs_sources,
};
pub use authentication::Authentication;
pub use body_payload::{
    BodyPayload, FormDataField, FormDataFieldValue, RawBodyLanguage, UrlEncodedField,
    resolve_file_path,
};
pub use collection::{
    Collection, CollectionError, CollectionLabel, CollectionLabelError, Folder, FolderError,
    LabelColor, SavedRequest, SavedRequestError, effective_authentication, find_saved_request,
};
pub use collection_run::{
    CollectionRunOptions, CollectionRunOptionsError, MAX_RUN_DELAY_MS, MAX_RUN_ITERATIONS,
    RunStepOutcome, RunTestResult,
};
pub use document::{ProtocolId, RequestDocument};
pub use endpoint::{Endpoint, EndpointError};
pub use environment::{
    Environment, EnvironmentError, EnvironmentVariable, EnvironmentVariableError,
};
pub use execution_error::{ExecutionError, NetworkCause, NetworkFailure};
pub use flow::{
    ComparisonOperator, Condition, Flow, FlowEdge, FlowError, FlowExecutionKind, FlowNode,
    FlowNodeKind, FlowPosition, LoadNode, LoadNodeKind, MockCallCountOperator, MockServerSource,
    VariableAssignment, VariableOperation,
};
pub use general_settings::{
    DEFAULT_HISTORY_RETENTION_DAYS, DEFAULT_REQUEST_TIMEOUT_SECONDS,
    DEFAULT_RESPONSE_SIZE_LIMIT_MB, GeneralSettings, HistoryRetention, HistoryRetentionError,
    MAX_HISTORY_RETENTION_DAYS, MAX_REQUEST_TIMEOUT_SECONDS, MAX_RESPONSE_SIZE_LIMIT_MB,
    RequestTimeout, RequestTimeoutError, ResponseSizeLimit, ResponseSizeLimitError,
};
pub use gitlab::{
    API_DOCS_FILE, ENVIRONMENTS_FILE, FileState, GitlabAccount, GitlabAccountError, MANIFEST_FILE,
    VALUE_MONITORS_FILE, VERSIONED_FILES, WorkspaceLink, classify, normalize_instance_url,
};
pub use header::{HeaderEntry, HeaderError};
pub use history_entry::{HistoryEntry, HistoryFailureKind, HistoryOutcome};
pub use http_method::HttpMethod;
pub use mock_server::{
    DEFAULT_MOCK_PORT, MAX_MOCK_BODY_BYTES, MAX_MOCK_DELAY_MS, MockCondition, MockConditionGroup,
    MockConditionOperator, MockConditionSource, MockMatchOperator, MockResponse, MockRoute,
    MockServer,
};
pub use proxy_settings::{ProxySettings, ProxySettingsError};
pub use request::{RedirectPolicy, Request, RouteParameter};
pub use response::{
    BodyEncoding, ConnectionInfo, Cookie, Response, ResponseHeader, ResponseMetadata,
};
pub use security_settings::SecuritySettings;
pub use update::{
    UpdateSettings, UpdateSource, UpdateSourceError, normalize_project_url,
    project_path_in_instance,
};
pub use value_monitor::{
    CaseStyle, FieldPath, FieldPathError, MonitoredValue, RuleKind, RulePattern, TextMatch,
    ValueFormat, ValueMonitor, ValueMonitorError, ValuePathSegment, ValueRule, ValueRuleError,
    ValueType,
};
pub use variable_scope::{
    ScopedVariableChange, VariableScope, VariableScopeKind, apply_scoped_changes, merge_variables,
    record_scoped_change, variable_scopes,
};
pub use workspace::{Workspace, WorkspaceError};
