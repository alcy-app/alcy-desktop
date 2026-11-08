//! Alcy domain types and rules.

mod agent_settings;
mod api_docs;
mod authentication;
mod body_payload;
mod collection;
mod collection_run;
mod document;
mod documentation;
pub use documentation::*;
mod endpoint;
mod environment;
mod execution_error;
mod flow;
mod flow_form;
pub use flow_form::*;
mod flow_folder;
mod general_settings;
mod git_identity;
mod grpc_call;
mod header;
mod history_entry;
mod http_method;
mod json_comments;
mod mock_server;
mod proxy_settings;
mod request;
mod response;
mod security_settings;
mod update;
mod value_monitor;
mod variable_scope;
mod websocket_call;
mod workspace;
mod workspace_link;

pub use agent_settings::{
    AgentProvider, AgentProviderKind, AgentSettings, AgentSettingsError, MAX_AGENT_PROVIDERS,
    agent_credential_key,
};
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
pub use flow_folder::{FlowFolder, FlowFoldersError, validate_flow_folders};
pub use general_settings::{
    DEFAULT_HISTORY_RETENTION_DAYS, DEFAULT_REQUEST_TIMEOUT_SECONDS,
    DEFAULT_RESPONSE_SIZE_LIMIT_MB, GeneralSettings, HistoryRetention, HistoryRetentionError,
    MAX_HISTORY_RETENTION_DAYS, MAX_REQUEST_TIMEOUT_SECONDS, MAX_RESPONSE_SIZE_LIMIT_MB,
    RequestTimeout, RequestTimeoutError, ResponseSizeLimit, ResponseSizeLimitError,
};
pub use git_identity::{GitIdentity, GitIdentityError, GitIdentitySettings};
pub use grpc_call::{GrpcCall, GrpcSchemaSource};
pub use header::{HeaderEntry, HeaderError};
pub use history_entry::{HistoryEntry, HistoryFailureKind, HistoryOutcome};
pub use http_method::HttpMethod;
pub use json_comments::strip_json_comments;
pub use mock_server::{
    DEFAULT_MOCK_PORT, MAX_MOCK_BODY_BYTES, MAX_MOCK_DELAY_MS, MockCondition, MockConditionGroup,
    MockConditionOperator, MockConditionSource, MockMatchOperator, MockResponse, MockRoute,
    MockServer,
};
pub use proxy_settings::{ProxySettings, ProxySettingsError};
pub use request::{RedirectPolicy, Request, RouteParameter};
pub use response::{
    BodyEncoding, ConnectionInfo, Cookie, GrpcResponseStatus, Response, ResponseHeader,
    ResponseMetadata, WebSocketClosedBy, WebSocketOutcome,
};
pub use security_settings::SecuritySettings;
pub use update::{UpdateSettings, UpdateSource, UpdateSourceError, is_prerelease_tag};
pub use value_monitor::{
    CaseStyle, DateTimePattern, FieldPath, FieldPathError, MonitoredValue, RuleKind, RulePattern,
    TextMatch, ValueFormat, ValueMonitor, ValueMonitorError, ValuePathSegment, ValueRule,
    ValueRuleError, ValueType,
};
pub use variable_scope::{
    ScopedVariableChange, VariableScope, VariableScopeKind, apply_scoped_changes, merge_variables,
    record_scoped_change, variable_scopes,
};
pub use websocket_call::{WebSocketCall, WebSocketCollect, WebSocketMessageFormat};
pub use workspace::{Workspace, WorkspaceError};
pub use workspace_link::{
    API_DOCS_FILE, ENVIRONMENTS_FILE, FileState, MANIFEST_FILE, VALUE_MONITORS_FILE,
    VERSIONED_FILES, WorkspaceLink, classify, is_valid_branch_name,
};
