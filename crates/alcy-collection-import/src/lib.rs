use std::collections::{HashMap, HashSet};

use alcy_domain::{
    ApiDocsSource, ApiDocsSourceKind, Authentication, BodyPayload, Collection, CollectionError,
    Endpoint, EndpointError, Environment, EnvironmentError, EnvironmentVariable,
    EnvironmentVariableError, Folder, FolderError, FormDataField, FormDataFieldValue, HeaderEntry,
    HeaderError, HttpMethod, ProtocolId, RawBodyLanguage, Request, RequestDocument, SavedRequest,
    SavedRequestError, UrlEncodedField, WebSocketCall, WebSocketMessageFormat,
};
use serde_json::Value;
use thiserror::Error;

mod docs;
mod har;
mod insomnia_warnings;
mod load_test;
mod png_text;
mod script_translation;
mod shell_command;
mod variable_review;

use docs::{DocsCollector, ParameterFields};

pub use load_test::{
    LoadImportAnalysis, LoadImportDiagnostic, LoadImportFormat, LoadImportRequest,
    LoadTestImportError, analyze_load_test,
};
pub use png_text::{IMPORT_PNG_KEYWORD, is_png, png_text};
use script_translation::{ScriptDialect, scope_segment, translate};
pub use shell_command::parse_shell_commands;
pub use variable_review::{
    EnvironmentMerge, ImportVariableCandidate, MAX_REVIEW_VALUE_BYTES, VariableOrigin,
    VariableSelection, VariableTarget, apply_variable_selection, variable_candidates,
};

const FALLBACK_COLLECTION_NAME: &str = "Imported Collection";
const FALLBACK_FOLDER_NAME: &str = "Imported Folder";
const FALLBACK_REQUEST_NAME: &str = "Imported Request";
const GLOBALS_NAME: &str = "Globals";
const MAX_TREE_DEPTH: usize = 128;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CollectionImportError {
    #[error("documento não é uma coleção externa reconhecida")]
    NotRecognized,
    #[error("versão do formato de coleção não suportada: {0}")]
    UnsupportedVersion(String),
    #[error("coleção externa inválida: {0}")]
    Invalid(String),
}

impl From<EndpointError> for CollectionImportError {
    fn from(error: EndpointError) -> Self {
        Self::Invalid(error.to_string())
    }
}

impl From<HeaderError> for CollectionImportError {
    fn from(error: HeaderError) -> Self {
        Self::Invalid(error.to_string())
    }
}

impl From<SavedRequestError> for CollectionImportError {
    fn from(error: SavedRequestError) -> Self {
        Self::Invalid(error.to_string())
    }
}

impl From<FolderError> for CollectionImportError {
    fn from(error: FolderError) -> Self {
        Self::Invalid(error.to_string())
    }
}

impl From<CollectionError> for CollectionImportError {
    fn from(error: CollectionError) -> Self {
        Self::Invalid(error.to_string())
    }
}

impl From<EnvironmentError> for CollectionImportError {
    fn from(error: EnvironmentError) -> Self {
        Self::Invalid(error.to_string())
    }
}

impl From<EnvironmentVariableError> for CollectionImportError {
    fn from(error: EnvironmentVariableError) -> Self {
        Self::Invalid(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedCollectionData {
    pub collections: Vec<Collection>,
    pub environments: Vec<Environment>,
    /// Detected format, even when no descriptive documentation exists.
    pub source_kind: Option<ApiDocsSourceKind>,
    /// Detected format that has no documentation source kind, so the import
    /// review can still name it.
    pub format: Option<ImportFormat>,
    /// Imported descriptions (ADR 0035), when present. Documented requests
    /// leave with an empty `docs_ref.source_id`, filled by the workspace writer.
    pub docs: Option<ApiDocsSource>,
    pub script_count: usize,
    pub warnings: Vec<ImportWarning>,
}

/// Formats recognized by this crate that never carry imported
/// documentation (and so have no `ApiDocsSourceKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFormat {
    /// HTTP Archive 1.2 (spec 0127).
    Har,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportWarning {
    pub request_path: String,
    pub phase: String,
    pub line: Option<u32>,
    pub api: String,
    pub reason: String,
}

#[derive(Default)]
struct ScriptImportState {
    script_count: usize,
    warnings: Vec<ImportWarning>,
}

#[derive(Clone, Default)]
struct ScriptContext {
    pre: Vec<String>,
    post: Vec<String>,
    tests: Vec<String>,
    path: Vec<String>,
}

pub fn parse_collection(raw: &str) -> Result<ImportedCollectionData, CollectionImportError> {
    let root: Value = yaml_serde::from_str(raw)
        .map_err(|error| CollectionImportError::Invalid(error.to_string()))?;
    if har::is_har(&root) {
        return har::map_har(&root);
    }
    if root.get("opencollection").is_some() {
        return map_open_collection(&root);
    }

    // The source tool's API wraps collections in `{"collection": {...}}`.
    let value = root
        .get("collection")
        .filter(|inner| inner.get("info").is_some())
        .unwrap_or(&root);

    match value.get("_postman_variable_scope").and_then(Value::as_str) {
        Some("environment") => return map_variable_export(value, "Imported Environment"),
        Some("globals") => return map_variable_export(value, GLOBALS_NAME),
        _ => {}
    }

    if let Some(schema) = check_nested_schema(value) {
        schema?;
        return map_nested_collection(value);
    }
    if is_legacy_collection(value) {
        return Err(legacy_collection_error());
    }
    if is_data_dump(value) {
        return map_data_dump(value);
    }

    if value.get("__export_format").and_then(Value::as_u64) == Some(4)
        && value.get("resources").and_then(Value::as_array).is_some()
    {
        return map_flat_export(value);
    }

    if let Some(format) = value.get("type").and_then(Value::as_str)
        && format.starts_with("collection.insomnia.rest/")
    {
        if format == "collection.insomnia.rest/5.0" {
            return map_tree_export(value);
        }
        return Err(CollectionImportError::UnsupportedVersion(
            format.to_string(),
        ));
    }

    Err(CollectionImportError::NotRecognized)
}

struct IdGenerator {
    next: u64,
}

impl IdGenerator {
    fn new() -> Self {
        Self { next: 1 }
    }

    fn next(&mut self, kind: &str) -> String {
        let id = format!("imported-{kind}-{}", self.next);
        self.next += 1;
        id
    }
}

struct AuthMapping {
    authentication: Authentication,
    header: Option<(String, String, bool)>,
    query: Option<(String, String)>,
}

impl Default for AuthMapping {
    fn default() -> Self {
        Self {
            authentication: Authentication::None,
            header: None,
            query: None,
        }
    }
}

/// Return `None` when no nested collection schema is declared, otherwise
/// whether the declared version (v2.0 or v2.1) is supported.
fn check_nested_schema(value: &Value) -> Option<Result<(), CollectionImportError>> {
    let schema = value.pointer("/info/schema").and_then(Value::as_str)?;
    if !(schema.contains("postman.com") && schema.contains("collection")) {
        return None;
    }
    if schema.contains("/v2.0") || schema.contains("/v2.1") {
        return Some(Ok(()));
    }
    Some(Err(CollectionImportError::UnsupportedVersion(
        schema.to_string(),
    )))
}

/// Legacy v1 format: a flat request list sorted by `order`.
fn is_legacy_collection(value: &Value) -> bool {
    value.get("order").is_some_and(Value::is_array)
        && value.get("requests").is_some_and(Value::is_array)
}

fn legacy_collection_error() -> CollectionImportError {
    CollectionImportError::UnsupportedVersion(
        "coleção v1 (exporte a coleção novamente no formato v2.1)".to_string(),
    )
}

/// Full data backup (`{"version": 1, "collections": [...],
/// "environments": [...], "globals": [...]}`). Alcy shares the root shape,
/// so extra keys or external-format collections identify this format.
fn is_data_dump(value: &Value) -> bool {
    let Some(collections) = value.get("collections").and_then(Value::as_array) else {
        return false;
    };
    ["environments", "globals", "headerPresets"]
        .iter()
        .any(|key| value.get(key).is_some())
        || collections.iter().any(|collection| {
            is_legacy_collection(collection) || check_nested_schema(collection).is_some()
        })
}

fn map_open_collection(value: &Value) -> Result<ImportedCollectionData, CollectionImportError> {
    let version = value
        .get("opencollection")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !version.starts_with("1.") {
        return Err(CollectionImportError::UnsupportedVersion(
            version.to_string(),
        ));
    }
    let mut ids = IdGenerator::new();
    let mut state = ScriptImportState::default();
    let mut docs = DocsCollector::new(ApiDocsSourceKind::Bruno);
    let name = text_or(
        value.pointer("/info/name").or_else(|| value.get("name")),
        FALLBACK_COLLECTION_NAME,
    )
    .to_string();
    let mut scripts = ScriptContext::default();
    scripts.path.push(name.clone());
    append_open_scripts(value, &mut scripts);
    let sequential = value
        .pointer("/extensions/bruno/scripts/flow")
        .and_then(Value::as_str)
        == Some("sequential")
        || value.pointer("/scripts/flow").and_then(Value::as_str) == Some("sequential");
    let items = value
        .get("items")
        .or_else(|| value.get("requests"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let (folders, requests) = map_open_items(
        items, &scripts, sequential, &mut ids, &mut docs, &mut state, 0,
    )?;
    let variables = open_variables(value.pointer("/request/variables"), false)?;
    let collection = Collection::new(ids.next("collection"), name, folders, requests)?
        .with_variables(variables)?;
    let environments = open_environments(value.pointer("/config/environments"), &mut ids)?;
    let source_docs = docs.finish(collection.name());
    Ok(ImportedCollectionData {
        collections: vec![collection],
        environments,
        source_kind: Some(ApiDocsSourceKind::Bruno),
        format: None,
        docs: source_docs,
        script_count: state.script_count,
        warnings: state.warnings,
    })
}

/// A Bruno/OpenCollection WebSocket item (`type: ws`, a `ws`/`websocket`
/// section or a `ws(s)://` URL).
fn open_websocket(item: &Value, request: &Value) -> bool {
    let typed = [item, request].iter().any(|value| {
        value
            .get("type")
            .or_else(|| value.pointer("/info/type"))
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                kind.eq_ignore_ascii_case("ws") || kind.eq_ignore_ascii_case("websocket")
            })
    });
    typed
        || request.get("ws").is_some()
        || request.get("websocket").is_some()
        || request
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(is_websocket_url)
}

fn map_open_items(
    items: &[Value],
    inherited: &ScriptContext,
    sequential: bool,
    ids: &mut IdGenerator,
    docs: &mut DocsCollector,
    state: &mut ScriptImportState,
    depth: usize,
) -> Result<(Vec<Folder>, Vec<SavedRequest>), CollectionImportError> {
    check_depth(depth)?;
    let mut folders = Vec::new();
    let mut requests = Vec::new();
    let mut folder_names = HashSet::new();
    let mut request_names = HashSet::new();
    for item in items {
        let name = text_or(
            item.get("name").or_else(|| item.pointer("/info/name")),
            FALLBACK_REQUEST_NAME,
        );
        let children = item
            .get("items")
            .or_else(|| item.get("children"))
            .and_then(Value::as_array);
        if let Some(children) = children {
            let name = unique_name(name, &mut folder_names);
            let mut scripts = inherited.clone();
            scripts.path.push(name.clone());
            append_open_scripts(item, &mut scripts);
            let (child_folders, child_requests) =
                map_open_items(children, &scripts, sequential, ids, docs, state, depth + 1)?;
            let variables = open_variables(item.pointer("/request/variables"), false)?;
            folders.push(
                Folder::new(ids.next("folder"), name, child_folders, child_requests)?
                    .with_variables(variables)?,
            );
            continue;
        }
        let request = item.get("request").unwrap_or(item);
        if open_websocket(item, request) {
            // The WebSocket item layout of this format is not mapped yet: say
            // so instead of dropping it silently.
            let mut path = inherited.path.clone();
            path.push(name.to_string());
            state.warnings.push(ImportWarning {
                request_path: path.join(" / "),
                phase: "request".into(),
                line: None,
                api: "websocket".into(),
                reason: "skippedProtocol".into(),
            });
            continue;
        }
        let details = request
            .get("http")
            .or_else(|| request.get("graphql"))
            .unwrap_or(request);
        let Some(method) = details.get("method").and_then(Value::as_str) else {
            continue;
        };
        if http_method(method).is_err() {
            state.warnings.push(ImportWarning {
                request_path: inherited.path.join(" / "),
                phase: "request".into(),
                line: None,
                api: method.into(),
                reason: "skippedProtocol".into(),
            });
            continue;
        }
        let name = unique_name(name, &mut request_names);
        let mut scripts = inherited.clone();
        scripts.path.push(name.clone());
        append_open_scripts(item, &mut scripts);
        if item.get("request").is_some() {
            append_open_scripts(request, &mut scripts);
        }
        let url = details
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let headers = open_headers(details.get("headers"))?;
        let body_value = details.get("body");
        let (protocol, body, variables, payload) = if request.get("graphql").is_some()
            || body_value.is_some_and(|value| value.get("query").is_some())
        {
            let graphql = body_value.unwrap_or(&Value::Null);
            (
                ProtocolId::GraphQl,
                graphql
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                json_text(graphql.get("variables"), "{}")?,
                BodyPayload::None,
            )
        } else {
            let (text, language) = open_body(body_value);
            (
                ProtocolId::Rest,
                text,
                String::new(),
                body_value
                    .map(|_| BodyPayload::Raw { language })
                    .unwrap_or(BodyPayload::None),
            )
        };
        let mut saved = build_request(
            ids,
            &name,
            Some(method),
            url,
            headers,
            map_direct_auth(
                details
                    .get("auth")
                    .or_else(|| details.get("authentication")),
            )
            .authentication,
            protocol,
            body,
            variables,
            payload,
        )?;
        let mut post = scripts.post.clone();
        let mut tests = scripts.tests.clone();
        if !sequential {
            post.reverse();
            tests.reverse();
        }
        post.extend(tests);
        let path = scripts.path.join(" / ");
        let pre = translate_segments(
            &scripts.pre,
            "preRequest",
            &path,
            state,
            ScriptDialect::Bruno,
        );
        let post = translate_segments(&post, "postResponse", &path, state, ScriptDialect::Bruno);
        saved.request = saved.request.with_scripts(pre, post);
        requests.push(
            docs.attach(
                saved,
                item.pointer("/info/description")
                    .or_else(|| request.pointer("/info/description"))
                    .or_else(|| request.get("docs"))
                    .or_else(|| details.get("description"))
                    .or_else(|| {
                        request
                            .get("description")
                            .or_else(|| item.get("description"))
                    }),
                ParameterFields {
                    query: details.get("params"),
                    headers: details.get("headers"),
                    path: details.get("pathParameters"),
                    name_key: "name",
                },
            ),
        );
    }
    Ok((folders, requests))
}

fn open_headers(value: Option<&Value>) -> Result<Vec<HeaderEntry>, CollectionImportError> {
    if value.is_some_and(Value::is_array) {
        return map_headers(value, "name");
    }
    let mut headers = Vec::new();
    for (name, value) in value.and_then(Value::as_object).into_iter().flatten() {
        let text = value.as_str().unwrap_or_default();
        if !name.is_empty() {
            headers.push(HeaderEntry::new(name, normalize_templates(text), true)?);
        }
    }
    Ok(headers)
}

fn open_body(value: Option<&Value>) -> (String, RawBodyLanguage) {
    let Some(value) = value else {
        return (String::new(), RawBodyLanguage::Json);
    };
    if let Some(text) = value.as_str() {
        return (text.to_string(), RawBodyLanguage::Json);
    }
    let kind = value.get("type").and_then(Value::as_str);
    let text = value
        .get("data")
        .or_else(|| value.get("text"))
        .or_else(|| value.get("json"))
        .map(value_text)
        .unwrap_or_default();
    let language = match kind {
        Some("text") => RawBodyLanguage::Text,
        Some("xml") => RawBodyLanguage::Xml,
        Some("html") => RawBodyLanguage::Html,
        _ => RawBodyLanguage::Json,
    };
    (text, language)
}

fn open_variables(
    value: Option<&Value>,
    sensitive: bool,
) -> Result<Vec<EnvironmentVariable>, CollectionImportError> {
    let mut variables = Vec::new();
    for entry in value.and_then(Value::as_array).into_iter().flatten() {
        if entry
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(name) = non_empty(entry.get("name").and_then(Value::as_str)) else {
            continue;
        };
        let Some(value) = open_variable_value(entry.get("value")) else {
            continue;
        };
        upsert_variable(
            &mut variables,
            EnvironmentVariable::new(
                name,
                normalize_templates(&value),
                sensitive || entry.get("secret").and_then(Value::as_bool) == Some(true),
            )?,
        );
    }
    Ok(variables)
}

fn open_variable_value(value: Option<&Value>) -> Option<String> {
    let value = match value? {
        Value::Array(variants) => variants
            .iter()
            .find(|variant| variant.get("selected").and_then(Value::as_bool) == Some(true))
            .or_else(|| variants.first())?
            .get("value")?,
        value => value,
    };
    Some(
        value
            .get("data")
            .map(value_text)
            .unwrap_or_else(|| value_text(value)),
    )
}

fn open_environments(
    value: Option<&Value>,
    ids: &mut IdGenerator,
) -> Result<Vec<Environment>, CollectionImportError> {
    let mut environments = Vec::new();
    let mut names = HashSet::new();
    for entry in value.and_then(Value::as_array).into_iter().flatten() {
        let name = unique_name(
            text_or(entry.get("name"), "Imported Environment"),
            &mut names,
        );
        let variables = open_variables(entry.get("variables"), false)?;
        if !variables.is_empty() {
            environments.push(Environment::new(ids.next("environment"), name, variables)?);
        }
    }
    Ok(environments)
}

fn append_open_scripts(value: &Value, target: &mut ScriptContext) {
    for scripts in [
        value.pointer("/request/scripts"),
        value.pointer("/runtime/scripts"),
        value.get("scripts"),
    ]
    .into_iter()
    .flatten()
    {
        append_open_script_list(scripts, target);
    }
}

fn append_open_script_list(scripts: &Value, target: &mut ScriptContext) {
    if let Some(object) = scripts.as_object() {
        for (kind, value) in object {
            let Some(source) = value
                .as_str()
                .or_else(|| value.get("script").and_then(Value::as_str))
            else {
                continue;
            };
            match kind.as_str() {
                "preRequest" | "pre-request" | "before-request" => target.pre.push(source.into()),
                "postResponse" | "post-response" | "after-response" => {
                    target.post.push(source.into())
                }
                "test" | "tests" => target.tests.push(source.into()),
                _ => {}
            }
        }
    }
    if let Some(array) = scripts.as_array() {
        for script in array {
            let kind = script
                .get("type")
                .or_else(|| script.get("event"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let source = script
                .get("script")
                .or_else(|| script.get("code"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            match kind {
                "before-request" | "pre-request" => target.pre.push(source.into()),
                "after-response" | "post-response" => target.post.push(source.into()),
                "tests" | "test" => target.tests.push(source.into()),
                _ => {}
            }
        }
    }
}

fn map_data_dump(value: &Value) -> Result<ImportedCollectionData, CollectionImportError> {
    let entries = value
        .get("collections")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut ids = IdGenerator::new();
    let mut docs = DocsCollector::new(ApiDocsSourceKind::Postman);
    let mut collection_names = HashSet::new();
    let mut script_state = ScriptImportState::default();
    let mut collections = Vec::new();
    let mut environments = Vec::new();

    for entry in entries {
        if is_legacy_collection(entry) {
            return Err(legacy_collection_error());
        }
        check_nested_schema(entry).ok_or_else(|| {
            CollectionImportError::Invalid("coleção do backup não reconhecida".to_string())
        })??;
        let (collection, variables) = nested_collection(
            entry,
            &mut collection_names,
            &mut ids,
            &mut docs,
            &mut script_state,
        )?;
        collections.push(collection);
        environments.extend(variables);
    }

    let mut environment_names = HashSet::new();
    for environment in value
        .get("environments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = unique_name(
            text_or(environment.get("name"), "Imported Environment"),
            &mut environment_names,
        );
        environments.extend(environment_from_pairs(
            name,
            environment.get("values"),
            "key",
            false,
            &mut ids,
        )?);
    }
    environments.extend(environment_from_pairs(
        unique_name(GLOBALS_NAME, &mut environment_names),
        value.get("globals"),
        "key",
        false,
        &mut ids,
    )?);

    if collections.is_empty() && environments.is_empty() {
        return Err(CollectionImportError::Invalid(
            "nenhuma coleção encontrada".to_string(),
        ));
    }
    let title = collections
        .iter()
        .map(Collection::name)
        .collect::<Vec<_>>()
        .join(", ");
    Ok(ImportedCollectionData {
        docs: docs.finish(&title),
        collections,
        environments,
        source_kind: Some(ApiDocsSourceKind::Postman),
        format: None,
        script_count: script_state.script_count,
        warnings: script_state.warnings,
    })
}

fn map_nested_collection(value: &Value) -> Result<ImportedCollectionData, CollectionImportError> {
    let mut ids = IdGenerator::new();
    let mut docs = DocsCollector::new(ApiDocsSourceKind::Postman);
    let mut script_state = ScriptImportState::default();
    let (collection, variables) = nested_collection(
        value,
        &mut HashSet::new(),
        &mut ids,
        &mut docs,
        &mut script_state,
    )?;

    Ok(ImportedCollectionData {
        docs: docs.finish(collection.name()),
        collections: vec![collection],
        environments: variables.into_iter().collect(),
        source_kind: Some(ApiDocsSourceKind::Postman),
        format: None,
        script_count: script_state.script_count,
        warnings: script_state.warnings,
    })
}

/// A nested collection and its variable environment, when present.
fn nested_collection(
    value: &Value,
    names: &mut HashSet<String>,
    ids: &mut IdGenerator,
    docs: &mut DocsCollector,
    script_state: &mut ScriptImportState,
) -> Result<(Collection, Option<Environment>), CollectionImportError> {
    let name = unique_name(
        text_or(value.pointer("/info/name"), FALLBACK_COLLECTION_NAME),
        names,
    );
    let inherited_auth = value.get("auth");
    let items = value
        .get("item")
        .and_then(Value::as_array)
        .ok_or_else(|| CollectionImportError::Invalid("campo 'item' ausente".to_string()))?;
    let mut scripts = ScriptContext::default();
    scripts.path.push(name.clone());
    append_events(value.get("event"), &mut scripts);
    let (folders, requests) =
        map_nested_items(items, inherited_auth, ids, docs, script_state, &scripts, 0)?;

    let variables = environment_from_pairs(
        "Collection Variables",
        value.get("variable"),
        "key",
        false,
        ids,
    )?
    .map(|environment| environment.variables().to_vec())
    .unwrap_or_default();
    let collection = Collection::new(ids.next("collection"), name, folders, requests)?
        .with_variables(variables)?;
    Ok((collection, None))
}

fn map_nested_items(
    items: &[Value],
    inherited_auth: Option<&Value>,
    ids: &mut IdGenerator,
    docs: &mut DocsCollector,
    script_state: &mut ScriptImportState,
    inherited_scripts: &ScriptContext,
    depth: usize,
) -> Result<(Vec<Folder>, Vec<SavedRequest>), CollectionImportError> {
    check_depth(depth)?;
    let mut folders = Vec::new();
    let mut requests = Vec::new();
    let mut folder_names = HashSet::new();
    let mut request_names = HashSet::new();

    for item in items {
        let item_auth = item.get("auth").or(inherited_auth);
        if let Some(children) = item.get("item").and_then(Value::as_array) {
            let name = unique_name(
                text_or(item.get("name"), FALLBACK_FOLDER_NAME),
                &mut folder_names,
            );
            let mut scripts = inherited_scripts.clone();
            scripts.path.push(name.clone());
            append_events(item.get("event"), &mut scripts);
            let (child_folders, child_requests) = map_nested_items(
                children,
                item_auth,
                ids,
                docs,
                script_state,
                &scripts,
                depth + 1,
            )?;
            let variables = environment_from_pairs(
                "Folder Variables",
                item.get("variable").or_else(|| item.get("variables")),
                "key",
                false,
                ids,
            )?
            .map(|environment| environment.variables().to_vec())
            .unwrap_or_default();
            folders.push(
                Folder::new(ids.next("folder"), name, child_folders, child_requests)?
                    .with_variables(variables)?,
            );
            continue;
        }

        let Some(request) = item
            .get("request")
            .filter(|request| request.is_object() && has_supported_method(request))
        else {
            continue;
        };
        let name = unique_name(
            text_or(item.get("name"), FALLBACK_REQUEST_NAME),
            &mut request_names,
        );
        let auth = request.get("auth").or(item_auth);
        let mut scripts = inherited_scripts.clone();
        scripts.path.push(name.clone());
        append_events(item.get("event"), &mut scripts);
        let saved = map_nested_request(request, &name, auth, ids, &scripts, script_state)?;
        let url = request.get("url");
        requests.push(docs.attach(
            saved,
            request.get("description").or(item.get("description")),
            ParameterFields {
                query: url.and_then(|url| url.get("query")),
                headers: request.get("header"),
                path: url.and_then(|url| url.get("variable")),
                name_key: "key",
            },
        ));
    }

    Ok((folders, requests))
}

fn map_nested_request(
    request: &Value,
    name: &str,
    auth: Option<&Value>,
    ids: &mut IdGenerator,
    scripts: &ScriptContext,
    script_state: &mut ScriptImportState,
) -> Result<SavedRequest, CollectionImportError> {
    let mut url = nested_url(request.get("url"));
    let mut headers = map_headers(request.get("header"), "key")?;
    let auth = map_nested_auth(auth);
    apply_auth_mapping(&mut url, &mut headers, &auth)?;

    let body = request.get("body");
    let (protocol, body_text, variables, body_payload) = nested_body(body, &mut headers)?;
    let mut saved = build_request(
        ids,
        name,
        request.get("method").and_then(Value::as_str),
        url,
        headers,
        auth.authentication,
        protocol,
        body_text,
        variables,
        body_payload,
    )?;
    let path = scripts.path.join(" / ");
    let pre = translate_segments(
        &scripts.pre,
        "preRequest",
        &path,
        script_state,
        ScriptDialect::Postman,
    );
    let post = translate_segments(
        &scripts.post,
        "postResponse",
        &path,
        script_state,
        ScriptDialect::Postman,
    );
    saved.request = saved.request.with_scripts(pre, post);
    Ok(saved)
}

fn append_events(events: Option<&Value>, scripts: &mut ScriptContext) {
    for event in events.and_then(Value::as_array).into_iter().flatten() {
        if event
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(listen) = event.get("listen").and_then(Value::as_str) else {
            continue;
        };
        let Some(exec) = event.pointer("/script/exec") else {
            continue;
        };
        let source = match exec {
            Value::String(value) => value.clone(),
            Value::Array(lines) => lines
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(
                    "
",
                ),
            _ => continue,
        };
        if source.trim().is_empty() {
            continue;
        }
        match listen {
            "prerequest" => scripts.pre.push(source),
            "test" => scripts.post.push(source),
            _ => {}
        }
    }
}

fn translate_segments(
    segments: &[String],
    phase: &str,
    path: &str,
    state: &mut ScriptImportState,
    dialect: ScriptDialect,
) -> String {
    let mut translated = Vec::new();
    for segment in segments {
        let result = translate(segment, dialect);
        for warning in result.warnings {
            state.warnings.push(ImportWarning {
                request_path: path.to_string(),
                phase: phase.to_string(),
                line: Some(warning.line),
                api: warning.api,
                reason: warning.reason.to_string(),
            });
        }
        translated.push(scope_segment(&result.source, segments.len() == 1));
    }
    state.script_count += translated.len();
    translated.join(
        "
",
    )
}

/// Request URL, empty for saved drafts without an address, as in Alcy.
fn nested_url(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(raw) = non_empty(value.as_str()) {
        return raw.to_string();
    }
    if let Some(raw) = non_empty(value.get("raw").and_then(Value::as_str)) {
        return raw.to_string();
    }

    let protocol = value
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("https");
    let host = string_or_array(value.get("host"), ".");
    let path = string_or_array(value.get("path"), "/");
    if host.is_empty() {
        return String::new();
    }
    let port = value
        .get("port")
        .and_then(Value::as_str)
        .filter(|port| !port.is_empty())
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let mut url = format!("{protocol}://{host}{port}");
    if !path.is_empty() {
        url.push('/');
        url.push_str(path.trim_start_matches('/'));
    }
    append_query_values(&mut url, value.get("query"), "key");
    url
}

fn nested_body(
    body: Option<&Value>,
    headers: &mut Vec<HeaderEntry>,
) -> Result<(ProtocolId, String, String, BodyPayload), CollectionImportError> {
    let Some(body) = body else {
        return Ok((
            ProtocolId::Rest,
            String::new(),
            String::new(),
            BodyPayload::None,
        ));
    };
    let mode = body.get("mode").and_then(Value::as_str).unwrap_or_default();
    if mode == "graphql" {
        let graphql = body.get("graphql").unwrap_or(&Value::Null);
        let query = graphql
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let variables = json_text(graphql.get("variables"), "{}")?;
        return Ok((ProtocolId::GraphQl, query, variables, BodyPayload::None));
    }

    let (text, payload) = match mode {
        "raw" => {
            let language = body
                .pointer("/options/raw/language")
                .and_then(Value::as_str);
            let content_type = match language {
                Some("json") => Some("application/json"),
                Some("xml") => Some("application/xml"),
                Some("html") => Some("text/html"),
                Some("javascript") => Some("application/javascript"),
                _ => Some("text/plain"),
            };
            if let Some(content_type) = content_type {
                ensure_content_type(headers, content_type)?;
            }
            let text = body
                .get("raw")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let payload = BodyPayload::Raw {
                language: raw_language_from_postman(language),
            };
            (text, payload)
        }
        "urlencoded" => {
            ensure_content_type(headers, "application/x-www-form-urlencoded")?;
            let fields = pairs_fields(body.get("urlencoded"), "key");
            let text = pairs_text(body.get("urlencoded"), "key");
            (text, BodyPayload::UrlEncoded(fields))
        }
        "formdata" => {
            let fields = form_data_fields(body.get("formdata"));
            (String::new(), BodyPayload::FormData(fields))
        }
        _ => (String::new(), BodyPayload::None),
    };
    Ok((ProtocolId::Rest, text, String::new(), payload))
}

/// Postman raw body language (`options.raw.language`), defaulting to JSON
/// when the export does not specify one.
fn raw_language_from_postman(language: Option<&str>) -> RawBodyLanguage {
    match language {
        Some("json") => RawBodyLanguage::Json,
        Some("xml") => RawBodyLanguage::Xml,
        Some("html") => RawBodyLanguage::Html,
        Some("javascript") => RawBodyLanguage::JavaScript,
        None => RawBodyLanguage::Json,
        _ => RawBodyLanguage::Text,
    }
}

/// Like `pairs_text`, but preserve structured pairs, including disabled ones,
/// so `BodyPayload::UrlEncoded` reopens as individually editable rows.
fn pairs_fields(value: Option<&Value>, name_key: &str) -> Vec<UrlEncodedField> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let name = pair.get(name_key).and_then(Value::as_str)?;
            if name.is_empty() {
                return None;
            }
            let value = pair
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let enabled = !pair
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(UrlEncodedField {
                name: normalize_templates(name),
                value: normalize_templates(value),
                enabled,
            })
        })
        .collect()
}

/// Postman form-data fields: text or files (`type: "file"`, path in `src`).
/// Keep the first path in an array because the domain stores one file per field.
fn form_data_fields(value: Option<&Value>) -> Vec<FormDataField> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|field| {
            let name = field.get("key").and_then(Value::as_str)?;
            if name.is_empty() {
                return None;
            }
            let enabled = !field
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_file = field.get("type").and_then(Value::as_str) == Some("file");
            let value = if is_file {
                let file_path = match field.get("src") {
                    Some(Value::String(path)) => path.clone(),
                    Some(Value::Array(paths)) => paths
                        .first()
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    _ => String::new(),
                };
                FormDataFieldValue::File { file_path }
            } else {
                FormDataFieldValue::Text(normalize_templates(
                    field
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ))
            };
            Some(FormDataField {
                name: normalize_templates(name),
                enabled,
                value,
            })
        })
        .collect()
}

fn map_nested_auth(auth: Option<&Value>) -> AuthMapping {
    let Some(auth) = auth.filter(|auth| !auth.is_null()) else {
        return AuthMapping::default();
    };
    let auth_type = auth.get("type").and_then(Value::as_str).unwrap_or_default();
    if auth_type == "noauth" {
        return AuthMapping::default();
    }
    let values = auth.get(auth_type).and_then(Value::as_array);
    let field = |names: &[&str]| -> String {
        names
            .iter()
            .find_map(|name| key_value(values, name))
            .map(|value| normalize_templates(&value))
            .unwrap_or_default()
    };

    match auth_type {
        "bearer" => AuthMapping {
            authentication: Authentication::Bearer {
                token: field(&["token"]),
            },
            ..AuthMapping::default()
        },
        "basic" => AuthMapping {
            authentication: Authentication::Basic {
                username: field(&["username"]),
                password: field(&["password"]),
            },
            ..AuthMapping::default()
        },
        "digest" => AuthMapping {
            authentication: Authentication::Digest {
                username: field(&["username"]),
                password: field(&["password"]),
            },
            ..AuthMapping::default()
        },
        "oauth2" if field(&["grant_type", "grantType"]) == "client_credentials" => AuthMapping {
            authentication: Authentication::OAuth2ClientCredentials {
                client_id: field(&["clientId", "client_id"]),
                client_secret: field(&["clientSecret", "client_secret"]),
                token_url: field(&["accessTokenUrl", "token_url"]),
                scope: field(&["scope"]),
            },
            ..AuthMapping::default()
        },
        "apikey" => {
            let pair = (field(&["key"]), field(&["value"]));
            match field(&["in"]).as_str() {
                "query" => AuthMapping {
                    query: Some(pair),
                    ..AuthMapping::default()
                },
                _ => AuthMapping {
                    header: Some((pair.0, pair.1, true)),
                    ..AuthMapping::default()
                },
            }
        }
        _ => AuthMapping::default(),
    }
}

fn map_tree_export(value: &Value) -> Result<ImportedCollectionData, CollectionImportError> {
    let mut ids = IdGenerator::new();
    let name = text_or(value.get("name"), FALLBACK_COLLECTION_NAME);
    let items = value
        .get("collection")
        .and_then(Value::as_array)
        .ok_or_else(|| CollectionImportError::Invalid("campo 'collection' ausente".to_string()))?;
    let inherited_auth = value.get("authentication");
    let mut docs = DocsCollector::new(ApiDocsSourceKind::Insomnia);
    let (folders, requests) = map_tree_items(items, inherited_auth, &mut ids, &mut docs, 0)?;
    let collection = Collection::new(ids.next("collection"), name, folders, requests)?;
    let environments = map_tree_environments(value.get("environments"), &mut ids)?;
    Ok(ImportedCollectionData {
        docs: docs.finish(collection.name()),
        collections: vec![collection],
        environments,
        source_kind: Some(ApiDocsSourceKind::Insomnia),
        format: None,
        script_count: 0,
        warnings: insomnia_warnings::tree(value)?,
    })
}

fn map_tree_items(
    items: &[Value],
    inherited_auth: Option<&Value>,
    ids: &mut IdGenerator,
    docs: &mut DocsCollector,
    depth: usize,
) -> Result<(Vec<Folder>, Vec<SavedRequest>), CollectionImportError> {
    check_depth(depth)?;
    let mut folders = Vec::new();
    let mut requests = Vec::new();
    let mut folder_names = HashSet::new();
    let mut request_names = HashSet::new();

    for item in items {
        let item_auth = item.get("authentication").or(inherited_auth);
        if insomnia_warnings::is_grpc(item) {
            continue;
        }
        if insomnia_websocket(item) {
            let name = unique_name(
                text_or(item.get("name"), FALLBACK_REQUEST_NAME),
                &mut request_names,
            );
            let saved = map_insomnia_websocket(item, None, &name, item_auth, ids)?;
            requests.push(attach_insomnia_docs(docs, saved, item));
            continue;
        }
        if let Some(children) = item.get("children").and_then(Value::as_array) {
            let name = unique_name(
                text_or(item.get("name"), FALLBACK_FOLDER_NAME),
                &mut folder_names,
            );
            let (child_folders, child_requests) =
                map_tree_items(children, item_auth, ids, docs, depth + 1)?;
            folders.push(Folder::new(
                ids.next("folder"),
                name,
                child_folders,
                child_requests,
            )?);
        } else if item.get("method").and_then(Value::as_str).is_some() && has_supported_method(item)
        {
            let name = unique_name(
                text_or(item.get("name"), FALLBACK_REQUEST_NAME),
                &mut request_names,
            );
            let saved = map_tree_request(item, &name, item_auth, ids)?;
            requests.push(attach_insomnia_docs(docs, saved, item));
        }
    }
    Ok((folders, requests))
}

/// An Insomnia WebSocket request: `websocket_request` in v4 exports, a
/// `ws-req_` id in v5 ones, or a method-less `ws(s)://` item.
fn insomnia_websocket(item: &Value) -> bool {
    item.get("_type").and_then(Value::as_str) == Some("websocket_request")
        || item
            .pointer("/meta/id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("ws-req_"))
        || (item.get("method").is_none()
            && item.get("children").is_none()
            && item
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(is_websocket_url))
}

/// `ws://` or `wss://`, case-insensitively.
pub(crate) fn is_websocket_url(url: &str) -> bool {
    url.trim().split_once("://").is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("ws") || scheme.eq_ignore_ascii_case("wss")
    })
}

/// A WebSocket request; `payload` (an Insomnia `websocket_payload`) becomes
/// the composer message.
fn map_insomnia_websocket(
    request: &Value,
    payload: Option<&Value>,
    name: &str,
    auth: Option<&Value>,
    ids: &mut IdGenerator,
) -> Result<SavedRequest, CollectionImportError> {
    let mut url = text_or(request.get("url"), "").to_string();
    append_query_values(&mut url, request.get("parameters"), "name");
    let mut headers = map_headers(request.get("headers"), "name")?;
    let auth = map_direct_auth(auth);
    apply_auth_mapping(&mut url, &mut headers, &auth)?;
    let message = payload
        .and_then(|payload| payload.get("value"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let is_json = payload
        .and_then(|payload| payload.get("mode"))
        .and_then(Value::as_str)
        .is_some_and(|mode| mode.contains("json"));
    let format = if is_json {
        WebSocketMessageFormat::Json
    } else {
        WebSocketMessageFormat::Text
    };
    websocket_request(
        ids,
        name,
        url,
        headers,
        auth.authentication,
        message,
        format,
        Vec::new(),
    )
}

/// Builds a saved WebSocket request (spec 0140).
#[allow(clippy::too_many_arguments)]
pub(crate) fn websocket_request(
    ids: &mut IdGenerator,
    name: &str,
    url: String,
    headers: Vec<HeaderEntry>,
    authentication: Authentication,
    message: String,
    message_format: WebSocketMessageFormat,
    subprotocols: Vec<String>,
) -> Result<SavedRequest, CollectionImportError> {
    let request = Request::new(
        Endpoint::saved(normalize_templates(&url)),
        RequestDocument::new(ProtocolId::WebSocket, normalize_templates(&message)),
        String::new(),
        headers,
        authentication,
    )
    .with_method(HttpMethod::Get)
    .with_body_payload(BodyPayload::None)
    .with_websocket(WebSocketCall {
        subprotocols,
        message_format,
        ..WebSocketCall::default()
    });
    SavedRequest::new(ids.next("request"), name, request).map_err(Into::into)
}

fn map_tree_request(
    request: &Value,
    name: &str,
    auth: Option<&Value>,
    ids: &mut IdGenerator,
) -> Result<SavedRequest, CollectionImportError> {
    let mut url = text_or(request.get("url"), "").to_string();
    append_query_values(&mut url, request.get("parameters"), "name");
    let mut headers = map_headers(request.get("headers"), "name")?;
    let auth = map_direct_auth(auth);
    apply_auth_mapping(&mut url, &mut headers, &auth)?;
    let (protocol, body, variables, body_payload) = direct_body(request.get("body"), &mut headers)?;

    build_request(
        ids,
        name,
        request.get("method").and_then(Value::as_str),
        url,
        headers,
        auth.authentication,
        protocol,
        body,
        variables,
        body_payload,
    )
}

fn map_flat_export(value: &Value) -> Result<ImportedCollectionData, CollectionImportError> {
    let resources = value
        .get("resources")
        .and_then(Value::as_array)
        .ok_or_else(|| CollectionImportError::Invalid("campo 'resources' ausente".to_string()))?;
    let workspaces: Vec<&Value> = resources
        .iter()
        .filter(|resource| resource.get("_type").and_then(Value::as_str) == Some("workspace"))
        .collect();
    if workspaces.is_empty() {
        return Err(CollectionImportError::Invalid(
            "nenhuma coleção encontrada".to_string(),
        ));
    }
    let workspace_ids: HashSet<&str> = workspaces
        .iter()
        .filter_map(|workspace| workspace.get("_id").and_then(Value::as_str))
        .collect();

    let mut resources_by_parent: HashMap<&str, Vec<&Value>> = HashMap::new();
    for resource in resources {
        if let Some(parent_id) = resource.get("parentId").and_then(Value::as_str) {
            resources_by_parent
                .entry(parent_id)
                .or_default()
                .push(resource);
        }
    }

    let mut ids = IdGenerator::new();
    let mut docs = DocsCollector::new(ApiDocsSourceKind::Insomnia);
    let mut names = HashSet::new();
    let collections = workspaces
        .into_iter()
        .map(|workspace| {
            let workspace_id = required_text(workspace.get("_id"), "coleção sem identificador")?;
            let name = unique_name(
                text_or(workspace.get("name"), FALLBACK_COLLECTION_NAME),
                &mut names,
            );
            let inherited_auth = workspace.get("authentication");
            let mut visited = HashSet::new();
            let (folders, requests) = map_flat_children(
                &resources_by_parent,
                &workspace_id,
                inherited_auth,
                &mut ids,
                &mut docs,
                &mut visited,
                0,
            )?;
            Collection::new(ids.next("collection"), name, folders, requests).map_err(Into::into)
        })
        .collect::<Result<Vec<_>, CollectionImportError>>()?;
    let environments =
        map_flat_environments(resources, &workspace_ids, &resources_by_parent, &mut ids)?;

    let title = collections
        .iter()
        .map(Collection::name)
        .collect::<Vec<_>>()
        .join(", ");
    Ok(ImportedCollectionData {
        docs: docs.finish(&title),
        collections,
        environments,
        source_kind: Some(ApiDocsSourceKind::Insomnia),
        format: None,
        script_count: 0,
        warnings: insomnia_warnings::flat(resources),
    })
}

fn map_flat_children<'a>(
    resources_by_parent: &HashMap<&'a str, Vec<&'a Value>>,
    parent_id: &str,
    inherited_auth: Option<&Value>,
    ids: &mut IdGenerator,
    docs: &mut DocsCollector,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Result<(Vec<Folder>, Vec<SavedRequest>), CollectionImportError> {
    check_depth(depth)?;
    let mut folders = Vec::new();
    let mut requests = Vec::new();
    let mut folder_names = HashSet::new();
    let mut request_names = HashSet::new();

    for resource in resources_by_parent.get(parent_id).into_iter().flatten() {
        match resource.get("_type").and_then(Value::as_str) {
            Some("request_group") => {
                let resource_id = required_text(resource.get("_id"), "pasta sem identificador")?;
                if !visited.insert(resource_id.clone()) {
                    return Err(CollectionImportError::Invalid(
                        "identificador de pasta duplicado".to_string(),
                    ));
                }
                let name = unique_name(
                    text_or(resource.get("name"), FALLBACK_FOLDER_NAME),
                    &mut folder_names,
                );
                let auth = resource.get("authentication").or(inherited_auth);
                let (child_folders, child_requests) = map_flat_children(
                    resources_by_parent,
                    &resource_id,
                    auth,
                    ids,
                    docs,
                    visited,
                    depth + 1,
                )?;
                folders.push(Folder::new(
                    ids.next("folder"),
                    name,
                    child_folders,
                    child_requests,
                )?);
            }
            Some("request") | Some("graphql_request") if has_supported_method(resource) => {
                let name = unique_name(
                    text_or(resource.get("name"), FALLBACK_REQUEST_NAME),
                    &mut request_names,
                );
                let auth = resource.get("authentication").or(inherited_auth);
                let saved = map_tree_request(resource, &name, auth, ids)?;
                requests.push(attach_insomnia_docs(docs, saved, resource));
            }
            Some("websocket_request") => {
                let name = unique_name(
                    text_or(resource.get("name"), FALLBACK_REQUEST_NAME),
                    &mut request_names,
                );
                let auth = resource.get("authentication").or(inherited_auth);
                // The first saved payload becomes the composer message.
                let payload = resource
                    .get("_id")
                    .and_then(Value::as_str)
                    .and_then(|id| resources_by_parent.get(id))
                    .into_iter()
                    .flatten()
                    .find(|child| {
                        child.get("_type").and_then(Value::as_str) == Some("websocket_payload")
                    })
                    .copied();
                let saved = map_insomnia_websocket(resource, payload, &name, auth, ids)?;
                requests.push(attach_insomnia_docs(docs, saved, resource));
            }
            _ => {}
        }
    }
    Ok((folders, requests))
}

/// Insomnia v4 stores descriptions in `description`; v5 uses `meta.description`.
fn attach_insomnia_docs(
    docs: &mut DocsCollector,
    saved: SavedRequest,
    item: &Value,
) -> SavedRequest {
    docs.attach(
        saved,
        item.get("description")
            .or_else(|| item.pointer("/meta/description")),
        ParameterFields {
            query: item.get("parameters"),
            headers: item.get("headers"),
            path: item.get("pathParameters"),
            name_key: "name",
        },
    )
}

fn map_variable_export(
    value: &Value,
    fallback_name: &str,
) -> Result<ImportedCollectionData, CollectionImportError> {
    let mut ids = IdGenerator::new();
    let name = text_or(value.get("name"), fallback_name);
    let environment = environment_from_pairs(name, value.get("values"), "key", false, &mut ids)?
        .ok_or_else(|| CollectionImportError::Invalid("ambiente sem variáveis".to_string()))?;

    Ok(ImportedCollectionData {
        collections: Vec::new(),
        environments: vec![environment],
        source_kind: Some(ApiDocsSourceKind::Postman),
        format: None,
        docs: None,
        script_count: 0,
        warnings: Vec::new(),
    })
}

fn map_tree_environments(
    value: Option<&Value>,
    ids: &mut IdGenerator,
) -> Result<Vec<Environment>, CollectionImportError> {
    let Some(root) = value.filter(|value| value.is_object()) else {
        return Ok(Vec::new());
    };
    let root_private = root
        .pointer("/meta/isPrivate")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let base_variables = variables_from_object(root.get("data"), root_private)?;
    let mut environments = Vec::new();
    let mut names = HashSet::new();

    if !base_variables.is_empty() {
        let name = unique_name(text_or(root.get("name"), "Base Environment"), &mut names);
        environments.push(Environment::new(
            ids.next("environment"),
            name,
            base_variables.clone(),
        )?);
    }

    for child in root
        .get("subEnvironments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let private = child
            .pointer("/meta/isPrivate")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let variables = merge_variables(
            base_variables.clone(),
            variables_from_object(child.get("data"), private)?,
        );
        if variables.is_empty() {
            continue;
        }
        let name = unique_name(
            text_or(child.get("name"), "Imported Environment"),
            &mut names,
        );
        environments.push(Environment::new(ids.next("environment"), name, variables)?);
    }

    Ok(environments)
}

fn map_flat_environments<'a>(
    resources: &'a [Value],
    workspace_ids: &HashSet<&'a str>,
    resources_by_parent: &HashMap<&'a str, Vec<&'a Value>>,
    ids: &mut IdGenerator,
) -> Result<Vec<Environment>, CollectionImportError> {
    let mut environments = Vec::new();
    let mut names = HashSet::new();

    for base in resources.iter().filter(|resource| {
        resource.get("_type").and_then(Value::as_str) == Some("environment")
            && resource
                .get("parentId")
                .and_then(Value::as_str)
                .is_some_and(|parent_id| workspace_ids.contains(parent_id))
    }) {
        let private = base
            .get("isPrivate")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let base_variables = variables_from_object(base.get("data"), private)?;
        if !base_variables.is_empty() {
            let name = unique_name(text_or(base.get("name"), "Base Environment"), &mut names);
            environments.push(Environment::new(
                ids.next("environment"),
                name,
                base_variables.clone(),
            )?);
        }

        let Some(base_id) = base.get("_id").and_then(Value::as_str) else {
            continue;
        };
        for child in resources_by_parent
            .get(base_id)
            .into_iter()
            .flatten()
            .filter(|resource| resource.get("_type").and_then(Value::as_str) == Some("environment"))
        {
            let private = child
                .get("isPrivate")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let variables = merge_variables(
                base_variables.clone(),
                variables_from_object(child.get("data"), private)?,
            );
            if variables.is_empty() {
                continue;
            }
            let name = unique_name(
                text_or(child.get("name"), "Imported Environment"),
                &mut names,
            );
            environments.push(Environment::new(ids.next("environment"), name, variables)?);
        }
    }

    Ok(environments)
}

fn environment_from_pairs(
    name: impl Into<String>,
    value: Option<&Value>,
    name_key: &str,
    private: bool,
    ids: &mut IdGenerator,
) -> Result<Option<Environment>, CollectionImportError> {
    let mut variables = Vec::new();
    for pair in value.and_then(Value::as_array).into_iter().flatten() {
        if pair.get("enabled").and_then(Value::as_bool) == Some(false)
            || pair
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            continue;
        }
        let Some(variable_name) = non_empty(pair.get(name_key).and_then(Value::as_str)) else {
            continue;
        };
        let variable_private =
            private || pair.get("type").and_then(Value::as_str) == Some("secret");
        let variable = EnvironmentVariable::new(
            variable_name,
            normalize_templates(&pair.get("value").map(value_text).unwrap_or_default()),
            variable_private,
        )?;
        upsert_variable(&mut variables, variable);
    }
    if variables.is_empty() {
        return Ok(None);
    }
    Ok(Some(Environment::new(
        ids.next("environment"),
        name,
        variables,
    )?))
}

fn variables_from_object(
    value: Option<&Value>,
    private: bool,
) -> Result<Vec<EnvironmentVariable>, CollectionImportError> {
    let mut variables = Vec::new();
    if let Some(Value::Object(object)) = value {
        flatten_variables(object, "", private, &mut variables)?;
    }
    Ok(variables)
}

fn flatten_variables(
    object: &serde_json::Map<String, Value>,
    prefix: &str,
    private: bool,
    variables: &mut Vec<EnvironmentVariable>,
) -> Result<(), CollectionImportError> {
    for (name, value) in object {
        let full_name = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        if let Value::Object(child) = value {
            flatten_variables(child, &full_name, private, variables)?;
            continue;
        }
        let variable =
            EnvironmentVariable::new(&full_name, normalize_templates(&value_text(value)), private)?;
        upsert_variable(variables, variable);
    }
    Ok(())
}

fn merge_variables(
    mut base: Vec<EnvironmentVariable>,
    overrides: Vec<EnvironmentVariable>,
) -> Vec<EnvironmentVariable> {
    for variable in overrides {
        upsert_variable(&mut base, variable);
    }
    base
}

fn upsert_variable(variables: &mut Vec<EnvironmentVariable>, variable: EnvironmentVariable) {
    if let Some(index) = variables
        .iter()
        .position(|existing| existing.name() == variable.name())
    {
        variables[index] = variable;
    } else {
        variables.push(variable);
    }
}

fn direct_body(
    body: Option<&Value>,
    headers: &mut Vec<HeaderEntry>,
) -> Result<(ProtocolId, String, String, BodyPayload), CollectionImportError> {
    let Some(body) = body else {
        return Ok((
            ProtocolId::Rest,
            String::new(),
            String::new(),
            BodyPayload::None,
        ));
    };
    let mime = body
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = body.get("text").and_then(Value::as_str).unwrap_or_default();
    if mime == "application/graphql" {
        if let Ok(value) = serde_json::from_str::<Value>(text)
            && let Some(query) = value.get("query").and_then(Value::as_str)
        {
            return Ok((
                ProtocolId::GraphQl,
                query.to_string(),
                json_text(value.get("variables"), "{}")?,
                BodyPayload::None,
            ));
        }
        return Ok((
            ProtocolId::GraphQl,
            text.to_string(),
            "{}".to_string(),
            BodyPayload::None,
        ));
    }

    let (text, payload) = if text.is_empty() {
        let fields = pairs_fields(body.get("params"), "name");
        let encoded = pairs_text(body.get("params"), "name");
        if !encoded.is_empty() && !mime.is_empty() {
            ensure_content_type(headers, mime)?;
        }
        if fields.is_empty() {
            (String::new(), BodyPayload::None)
        } else {
            (encoded, BodyPayload::UrlEncoded(fields))
        }
    } else {
        if !mime.is_empty() {
            ensure_content_type(headers, mime)?;
        }
        (
            text.to_string(),
            BodyPayload::Raw {
                language: raw_language_from_mime(mime),
            },
        )
    };
    Ok((ProtocolId::Rest, text, String::new(), payload))
}

fn raw_language_from_mime(mime: &str) -> RawBodyLanguage {
    let mime = mime.split(';').next().unwrap_or(mime).trim();
    match mime {
        "" => RawBodyLanguage::Json,
        "application/json" => RawBodyLanguage::Json,
        "application/xml" | "text/xml" => RawBodyLanguage::Xml,
        "text/html" => RawBodyLanguage::Html,
        "application/javascript" | "text/javascript" => RawBodyLanguage::JavaScript,
        _ => RawBodyLanguage::Text,
    }
}

fn map_direct_auth(auth: Option<&Value>) -> AuthMapping {
    let Some(auth) = auth.filter(|auth| {
        !auth.is_null()
            && !auth
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }) else {
        return AuthMapping::default();
    };
    let field = |name: &str| {
        normalize_templates(auth.get(name).and_then(Value::as_str).unwrap_or_default())
    };
    match auth.get("type").and_then(Value::as_str).unwrap_or_default() {
        "bearer" => AuthMapping {
            authentication: Authentication::Bearer {
                token: field("token"),
            },
            ..AuthMapping::default()
        },
        "basic" => AuthMapping {
            authentication: Authentication::Basic {
                username: field("username"),
                password: field("password"),
            },
            ..AuthMapping::default()
        },
        "digest" => AuthMapping {
            authentication: Authentication::Digest {
                username: field("username"),
                password: field("password"),
            },
            ..AuthMapping::default()
        },
        "oauth2" if field("grantType") == "client_credentials" => AuthMapping {
            authentication: Authentication::OAuth2ClientCredentials {
                client_id: field("clientId"),
                client_secret: field("clientSecret"),
                token_url: field("accessTokenUrl"),
                scope: field("scope"),
            },
            ..AuthMapping::default()
        },
        "apikey" => {
            let pair = (field("key"), field("value"));
            if field("addTo") == "queryParams" {
                AuthMapping {
                    query: Some(pair),
                    ..AuthMapping::default()
                }
            } else {
                AuthMapping {
                    header: Some((pair.0, pair.1, true)),
                    ..AuthMapping::default()
                }
            }
        }
        _ => AuthMapping::default(),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_request(
    ids: &mut IdGenerator,
    name: &str,
    method: Option<&str>,
    url: String,
    headers: Vec<HeaderEntry>,
    authentication: Authentication,
    protocol: ProtocolId,
    body: String,
    variables: String,
    body_payload: BodyPayload,
) -> Result<SavedRequest, CollectionImportError> {
    let method = http_method(method.unwrap_or("POST"))?;
    let request = Request::new(
        Endpoint::saved(normalize_templates(&url)),
        RequestDocument::new(protocol, normalize_templates(&body)),
        normalize_templates(&variables),
        headers,
        authentication,
    )
    .with_method(method)
    .with_body_payload(body_payload);
    SavedRequest::new(ids.next("request"), name, request).map_err(Into::into)
}

/// Skip unsupported methods (such as `PURGE` and `PROPFIND`) while importing
/// the rest. Missing methods use the `build_request` default.
fn has_supported_method(request: &Value) -> bool {
    request
        .get("method")
        .and_then(Value::as_str)
        .is_none_or(|method| http_method(method).is_ok())
}

fn http_method(value: &str) -> Result<HttpMethod, CollectionImportError> {
    match value.to_ascii_uppercase().as_str() {
        "GET" => Ok(HttpMethod::Get),
        "POST" => Ok(HttpMethod::Post),
        "PUT" => Ok(HttpMethod::Put),
        "PATCH" => Ok(HttpMethod::Patch),
        "DELETE" => Ok(HttpMethod::Delete),
        "HEAD" => Ok(HttpMethod::Head),
        "OPTIONS" => Ok(HttpMethod::Options),
        other => Err(CollectionImportError::Invalid(format!(
            "método HTTP não suportado: {other}"
        ))),
    }
}

fn map_headers(
    value: Option<&Value>,
    name_key: &str,
) -> Result<Vec<HeaderEntry>, CollectionImportError> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|header| {
            let name = single_line(header.get(name_key).and_then(Value::as_str)?);
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            let value = header
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let enabled = !header
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(
                HeaderEntry::new(name, normalize_templates(&single_line(value)), enabled)
                    .map_err(Into::into),
            )
        })
        .collect()
}

/// Headers cannot contain newlines; join multiline values with spaces.
fn single_line(value: &str) -> String {
    if !value.contains(['\r', '\n']) {
        return value.to_string();
    }
    value
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn apply_auth_mapping(
    url: &mut String,
    headers: &mut Vec<HeaderEntry>,
    auth: &AuthMapping,
) -> Result<(), CollectionImportError> {
    if let Some((name, value, enabled)) = &auth.header {
        let name = single_line(name);
        let name = name.trim();
        if !name.is_empty()
            && !headers
                .iter()
                .any(|header| header.name().eq_ignore_ascii_case(name))
        {
            headers.push(HeaderEntry::new(
                name,
                normalize_templates(&single_line(value)),
                *enabled,
            )?);
        }
    }
    if let Some((name, value)) = &auth.query
        && !name.trim().is_empty()
    {
        append_query(url, name, value);
    }
    Ok(())
}

fn ensure_content_type(
    headers: &mut Vec<HeaderEntry>,
    value: &str,
) -> Result<(), CollectionImportError> {
    if !headers
        .iter()
        .any(|header| header.name().eq_ignore_ascii_case("content-type"))
    {
        headers.push(HeaderEntry::new("Content-Type", value, true)?);
    }
    Ok(())
}

fn append_query_values(url: &mut String, values: Option<&Value>, name_key: &str) {
    for value in values
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|value| {
            !value
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
    {
        let Some(name) = value.get(name_key).and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        append_query(
            url,
            name,
            value
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
    }
}

fn append_query(url: &mut String, name: &str, value: &str) {
    url.push(if url.contains('?') { '&' } else { '?' });
    url.push_str(name);
    if !value.is_empty() {
        url.push('=');
        url.push_str(value);
    }
}

fn pairs_text(value: Option<&Value>, name_key: &str) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|pair| {
            !pair
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|pair| {
            let name = pair.get(name_key).and_then(Value::as_str)?;
            if name.is_empty() {
                return None;
            }
            let value = pair
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(format!("{name}={value}"))
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn key_value(values: Option<&Vec<Value>>, key: &str) -> Option<String> {
    values?
        .iter()
        .find(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
        .and_then(|entry| entry.get("value"))
        .map(value_text)
}

fn json_text(value: Option<&Value>, fallback: &str) -> Result<String, CollectionImportError> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.clone()),
        Some(Value::String(_)) | None | Some(Value::Null) => Ok(fallback.to_string()),
        Some(value) => serde_json::to_string_pretty(value)
            .map_err(|error| CollectionImportError::Invalid(error.to_string())),
    }
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn string_or_array(value: Option<&Value>, separator: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(separator),
        _ => String::new(),
    }
}

fn required_text(value: Option<&Value>, message: &str) -> Result<String, CollectionImportError> {
    non_empty(value.and_then(Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| CollectionImportError::Invalid(message.to_string()))
}

fn text_or<'a>(value: Option<&'a Value>, fallback: &'a str) -> &'a str {
    non_empty(value.and_then(Value::as_str)).unwrap_or(fallback)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn check_depth(depth: usize) -> Result<(), CollectionImportError> {
    if depth > MAX_TREE_DEPTH {
        return Err(CollectionImportError::Invalid(
            "hierarquia de pastas excede o limite suportado".to_string(),
        ));
    }
    Ok(())
}

fn unique_name(candidate: &str, used: &mut HashSet<String>) -> String {
    if used.insert(candidate.to_string()) {
        return candidate.to_string();
    }
    let mut index = 2;
    loop {
        let candidate = format!("{candidate} ({index})");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        index += 1;
    }
}

fn normalize_templates(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("}}") else {
            result.push_str(&rest[start..]);
            return result;
        };
        let inner = after_start[..end].trim();
        let normalized = inner.strip_prefix("_.").map(str::trim).unwrap_or(inner);
        result.push_str("{{");
        result.push_str(normalized);
        result.push_str("}}");
        rest = &after_start[end + 2..];
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_bodies_without_an_explicit_format_default_to_json() {
        assert_eq!(raw_language_from_postman(None), RawBodyLanguage::Json);
        assert_eq!(
            raw_language_from_postman(Some("text")),
            RawBodyLanguage::Text
        );
        assert_eq!(raw_language_from_mime(""), RawBodyLanguage::Json);
        assert_eq!(raw_language_from_mime("text/plain"), RawBodyLanguage::Text);
    }

    #[test]
    fn maps_a_nested_json_collection_with_rest_graphql_and_authentication() {
        let raw = r#"{
          "info": {"name": "Customer API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{token}}"}]},
          "variable": [
            {"key": "baseUrl", "value": "https://api.example.com"},
            {"key": "token", "value": "secret", "type": "secret"}
          ],
          "item": [
            {"name": "Users", "item": [
              {"name": "List users", "request": {
                "method": "GET",
                "url": {"protocol": "https", "host": ["api", "example", "com"], "path": ["users"], "query": [{"key": "limit", "value": "10"}]},
                "header": [{"key": "Accept", "value": "application/json"}]
              }},
              {"name": "Lookup", "request": {
                "method": "POST", "url": "https://api.example.com/graphql",
                "body": {"mode": "graphql", "graphql": {"query": "query Lookup { user { id } }", "variables": {"id": 1}}}
              }}
            ]}
          ]
        }"#;

        let imported = parse_collection(raw).unwrap();
        let collections = imported.collections;
        let folder = &collections[0].folders()[0];

        assert_eq!(collections[0].name(), "Customer API");
        assert_eq!(folder.name(), "Users");
        assert_eq!(folder.requests()[0].request.method, HttpMethod::Get);
        assert_eq!(folder.requests()[0].request.body_payload, BodyPayload::None);
        assert_eq!(
            folder.requests()[0].request.endpoint.url(),
            "https://api.example.com/users?limit=10"
        );
        assert_eq!(
            folder.requests()[0].request.authentication,
            Authentication::Bearer {
                token: "{{token}}".to_string()
            }
        );
        assert_eq!(
            folder.requests()[1].request.document.protocol,
            ProtocolId::GraphQl
        );
        assert_eq!(folder.requests()[1].request.variables, "{\n  \"id\": 1\n}");
        assert!(imported.environments.is_empty());
        assert_eq!(collections[0].variables().len(), 2);
        assert!(!collections[0].variables()[1].sensitive);
    }

    #[test]
    fn maps_nested_urlencoded_and_formdata_bodies_preserving_structured_fields() {
        let raw = r#"{
          "info": {"name": "Bodies", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item": [
            {"name": "Login", "request": {
              "method": "POST", "url": "https://api.example.com/login",
              "body": {"mode": "urlencoded", "urlencoded": [
                {"key": "user", "value": "ada"},
                {"key": "skip", "value": "x", "disabled": true}
              ]}
            }},
            {"name": "Upload", "request": {
              "method": "POST", "url": "https://api.example.com/upload",
              "body": {"mode": "formdata", "formdata": [
                {"key": "title", "value": "photo", "type": "text"},
                {"key": "file", "type": "file", "src": "/tmp/photo.png"}
              ]}
            }}
          ]
        }"#;

        let imported = parse_collection(raw).unwrap();
        let collection = &imported.collections[0];

        assert_eq!(
            collection.requests()[0].request.body_payload,
            BodyPayload::UrlEncoded(vec![
                UrlEncodedField {
                    name: "user".to_string(),
                    value: "ada".to_string(),
                    enabled: true,
                },
                UrlEncodedField {
                    name: "skip".to_string(),
                    value: "x".to_string(),
                    enabled: false,
                },
            ])
        );
        assert_eq!(
            collection.requests()[1].request.body_payload,
            BodyPayload::FormData(vec![
                FormDataField {
                    name: "title".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::Text("photo".to_string()),
                },
                FormDataField {
                    name: "file".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::File {
                        file_path: "/tmp/photo.png".to_string(),
                    },
                },
            ])
        );
    }

    #[test]
    fn maps_a_flat_json_export_into_multiple_collections() {
        let raw = r#"{
          "__export_format": 4,
          "__export_source": "insomnia.desktop.app:v2023.5.8",
          "resources": [
            {"_id": "wrk_a", "parentId": null, "name": "First", "scope": "collection", "_type": "workspace"},
            {"_id": "fld_a", "parentId": "wrk_a", "name": "Users", "_type": "request_group"},
            {"_id": "req_a", "parentId": "fld_a", "name": "Create", "url": "{{ _.baseUrl }}/users", "method": "POST",
             "body": {"mimeType": "application/json", "text": "{\"name\":\"Ada\"}"},
             "headers": [{"name": "Content-Type", "value": "application/json"}],
             "authentication": {"type": "basic", "username": "ada", "password": "secret"}, "_type": "request"},
            {"_id": "env_base", "parentId": "wrk_a", "name": "Base Environment", "data": {"baseUrl": "https://api.example.com", "nested": {"region": "us"}}, "isPrivate": false, "_type": "environment"},
            {"_id": "env_prod", "parentId": "env_base", "name": "Production", "data": {"baseUrl": "https://prod.example.com", "apiToken": "secret"}, "isPrivate": true, "_type": "environment"},
            {"_id": "wrk_b", "parentId": null, "name": "Second", "scope": "collection", "_type": "workspace"}
          ]
        }"#;

        let imported = parse_collection(raw).unwrap();
        let collections = imported.collections;
        let request = &collections[0].folders()[0].requests()[0].request;

        assert_eq!(collections.len(), 2);
        assert_eq!(request.endpoint.url(), "{{baseUrl}}/users");
        assert_eq!(request.document.body, "{\"name\":\"Ada\"}");
        assert_eq!(
            request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );
        assert_eq!(
            request.authentication,
            Authentication::Basic {
                username: "ada".to_string(),
                password: "secret".to_string()
            }
        );
        assert_eq!(imported.environments.len(), 2);
        assert_eq!(imported.environments[1].name(), "Production");
        assert_eq!(imported.environments[1].variables().len(), 3);
        assert_eq!(
            imported.environments[1].variables()[0].value(),
            "https://prod.example.com"
        );
        assert_eq!(
            imported.environments[1].variables()[1].name(),
            "nested.region"
        );
        assert!(imported.environments[1].variables()[2].sensitive);
    }

    #[test]
    fn maps_a_yaml_tree_export_with_query_body_and_api_key() {
        let raw = r#"
type: collection.insomnia.rest/5.0
schema_version: "5.1"
name: Billing
meta:
  id: wrk_billing
environments:
  name: Base Environment
  meta:
    id: env_base
  data:
    baseUrl: https://api.example.com
  subEnvironments:
    - name: Staging
      meta:
        id: env_staging
        isPrivate: true
      data:
        baseUrl: https://staging.example.com
        clientSecret: top-secret
collection:
  - name: Invoices
    meta:
      id: fld_invoices
    children:
      - name: Create invoice
        url: "{{ _.baseUrl }}/invoices"
        method: POST
        parameters:
          - name: dryRun
            value: "true"
        headers:
          - name: Accept
            value: application/json
        body:
          mimeType: application/x-www-form-urlencoded
          params:
            - name: customer
              value: "42"
        authentication:
          type: apikey
          key: X-API-Key
          value: "{{ _.apiKey }}"
          addTo: header
"#;

        let imported = parse_collection(raw).unwrap();
        let collections = imported.collections;
        let request = &collections[0].folders()[0].requests()[0].request;

        assert_eq!(request.endpoint.url(), "{{baseUrl}}/invoices?dryRun=true");
        assert_eq!(request.document.body, "customer=42");
        assert!(
            request
                .headers
                .iter()
                .any(|header| { header.name() == "X-API-Key" && header.value() == "{{apiKey}}" })
        );
        assert!(request.headers.iter().any(|header| {
            header.name() == "Content-Type" && header.value() == "application/x-www-form-urlencoded"
        }));
        assert_eq!(imported.environments.len(), 2);
        assert_eq!(imported.environments[1].name(), "Staging");
        assert!(imported.environments[1].variables()[1].sensitive);
    }

    #[test]
    fn rejects_an_unknown_document_without_claiming_its_format() {
        assert_eq!(
            parse_collection(r#"{"version": 1, "collections": []}"#),
            Err(CollectionImportError::NotRecognized)
        );
    }

    #[test]
    fn rejects_a_recognized_but_unsupported_version() {
        let error = parse_collection(
            r#"{"info":{"name":"X","schema":"https://schema.postman.com/json/collection/v1.0.0/collection.json"},"item":[]}"#,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            CollectionImportError::UnsupportedVersion(_)
        ));
    }

    #[test]
    fn deduplicates_names_within_each_tree_level() {
        let raw = r#"{
          "info": {"name": "X", "schema": "https://schema.getpostman.com/json/collection/v2.0.0/collection.json"},
          "item": [
            {"name": "Ping", "request": {"method": "GET", "url": "https://example.com/a"}},
            {"name": "Ping", "request": {"method": "GET", "url": "https://example.com/b"}}
          ]
        }"#;

        let collections = parse_collection(raw).unwrap().collections;
        assert_eq!(collections[0].requests()[0].name(), "Ping");
        assert_eq!(collections[0].requests()[1].name(), "Ping (2)");
    }

    #[test]
    fn unwraps_a_collection_nested_under_a_collection_key() {
        let raw = r#"{"collection": {
          "info": {"name": "Wrapped", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item": [{"name": "Ping", "request": {"method": "GET", "url": "https://example.com"}}]
        }}"#;

        let collections = parse_collection(raw).unwrap().collections;

        assert_eq!(collections[0].name(), "Wrapped");
        assert_eq!(collections[0].requests().len(), 1);
    }

    #[test]
    fn maps_a_global_variables_export_as_an_environment() {
        let raw = r#"{
          "id": "globals",
          "values": [{"key": "tenant", "value": "acme", "enabled": true}],
          "_postman_variable_scope": "globals"
        }"#;

        let imported = parse_collection(raw).unwrap();

        assert!(imported.collections.is_empty());
        assert_eq!(imported.environments[0].name(), "Globals");
        assert_eq!(imported.environments[0].variables()[0].value(), "acme");
    }

    #[test]
    fn rejects_the_legacy_v1_format_with_a_clear_version_error() {
        let legacy = r#"{
          "id": "c1", "name": "Old", "order": ["r1"], "folders": [],
          "requests": [{"id": "r1", "name": "Ping", "url": "https://example.com", "method": "GET"}]
        }"#;
        let dump = r#"{
          "version": 1,
          "collections": [{"id": "c1", "name": "Old", "order": [], "folders": [], "requests": []}],
          "environments": []
        }"#;

        for raw in [legacy, dump] {
            let error = parse_collection(raw).unwrap_err();
            assert!(
                matches!(&error, CollectionImportError::UnsupportedVersion(message) if message.contains("v2.1")),
                "{error:?}"
            );
        }
    }

    #[test]
    fn maps_a_data_dump_with_collections_environments_and_globals() {
        let raw = r#"{
          "version": 1,
          "collections": [
            {"info": {"name": "Api", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
             "item": [{"name": "Ping", "request": {"method": "GET", "url": "https://example.com"}}]},
            {"info": {"name": "Api", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
             "item": []}
          ],
          "environments": [{"id": "e1", "name": "Prod", "values": [{"key": "baseUrl", "value": "https://prod.example.com"}]}],
          "globals": [{"key": "tenant", "value": "acme", "enabled": true}]
        }"#;

        let imported = parse_collection(raw).unwrap();

        let names: Vec<_> = imported.collections.iter().map(Collection::name).collect();
        assert_eq!(names, vec!["Api", "Api (2)"]);
        assert_eq!(imported.collections[0].requests().len(), 1);
        let environments: Vec<_> = imported
            .environments
            .iter()
            .map(Environment::name)
            .collect();
        assert_eq!(environments, vec!["Prod", "Globals"]);
    }

    #[test]
    fn leaves_the_native_format_unrecognized_even_with_collections() {
        let raw = r#"{"version": 1, "collections": [{"id": "c1", "name": "X", "folders": [], "requests": []}]}"#;

        assert_eq!(
            parse_collection(raw),
            Err(CollectionImportError::NotRecognized)
        );
    }

    #[test]
    fn maps_a_standalone_variable_export() {
        let raw = r#"{
          "id": "env_1",
          "name": "Production",
          "values": [
            {"key": "baseUrl", "value": "https://api.example.com", "enabled": true},
            {"key": "password", "value": "secret", "enabled": true, "type": "secret"},
            {"key": "disabled", "value": "ignored", "enabled": false}
          ],
          "_postman_variable_scope": "environment"
        }"#;

        let imported = parse_collection(raw).unwrap();

        assert!(imported.collections.is_empty());
        assert_eq!(imported.environments.len(), 1);
        assert_eq!(imported.environments[0].name(), "Production");
        assert_eq!(imported.environments[0].variables().len(), 2);
        assert!(imported.environments[0].variables()[1].sensitive);
    }

    #[test]
    fn keeps_postman_descriptions_and_all_parameters_as_documentation() {
        let raw = r#"{
          "info": {"name": "Docs", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item": [
            {"name": "List", "request": {
              "method": "GET",
              "description": {"content": " Lista pedidos ", "type": "text/markdown"},
              "header": [{"key": "X-Tenant", "value": "acme", "description": "Tenant"}],
              "url": {
                "raw": "https://example.com/orders/:id?page=1",
                "host": ["example", "com"],
                "query": [
                  {"key": "page", "value": "1", "description": "Página"},
                  {"key": "sort", "value": "asc", "disabled": true}
                ],
                "variable": [{"key": "id", "description": "Id do pedido"}]
              }
            }},
            {"name": "Plain", "request": {"method": "GET", "url": "https://example.com"}}
          ]
        }"#;

        let imported = parse_collection(raw).unwrap();
        let docs = imported.docs.unwrap();
        let requests = imported.collections[0].requests();

        assert_eq!(docs.title, "Docs");
        assert_eq!(docs.kind, ApiDocsSourceKind::Postman);
        let operation_id = &requests[0].docs_ref.as_ref().unwrap().operation_id;
        let operation = &docs.operations[operation_id];
        assert_eq!(operation.description, "Lista pedidos");
        let parameters: Vec<_> = operation
            .parameters
            .iter()
            .map(|parameter| {
                (
                    parameter.name.as_str(),
                    parameter.location,
                    parameter.description.as_str(),
                    parameter.example.as_deref(),
                )
            })
            .collect();
        use alcy_domain::ParameterLocation::*;
        assert_eq!(
            parameters,
            vec![
                ("id", Path, "Id do pedido", None),
                ("page", Query, "Página", Some("\"1\"")),
                ("sort", Query, "", Some("\"asc\"")),
                ("X-Tenant", Header, "Tenant", Some("\"acme\"")),
            ]
        );
        assert!(requests[1].docs_ref.is_none());
        assert_eq!(docs.operations.len(), 1);
    }

    #[test]
    fn keeps_insomnia_descriptions_from_both_export_formats() {
        let flat = r#"{
          "__export_format": 4,
          "resources": [
            {"_id": "wrk_1", "_type": "workspace", "name": "Flat"},
            {"_id": "req_1", "_type": "request", "parentId": "wrk_1", "name": "Ping",
             "method": "GET", "url": "https://example.com", "description": "Verifica",
             "parameters": [{"name": "verbose", "value": "true", "description": "Detalhado"}]}
          ]
        }"#;
        let tree = r#"
type: collection.insomnia.rest/5.0
name: Tree
collection:
  - name: Ping
    method: GET
    url: https://example.com
    meta:
      description: Verifica pelo v5
"#;

        let flat = parse_collection(flat).unwrap();
        let tree = parse_collection(tree).unwrap();

        let flat_docs = flat.docs.unwrap();
        assert_eq!(flat_docs.kind, ApiDocsSourceKind::Insomnia);
        let flat_operation = flat_docs.operations.values().next().unwrap();
        assert_eq!(flat_operation.description, "Verifica");
        assert_eq!(flat_operation.parameters[0].description, "Detalhado");
        assert!(flat.collections[0].requests()[0].docs_ref.is_some());

        let tree_docs = tree.docs.unwrap();
        assert_eq!(
            tree_docs.operations.values().next().unwrap().description,
            "Verifica pelo v5"
        );
    }

    #[test]
    fn keeps_nested_requests_without_url_instead_of_rejecting_the_collection() {
        let raw = r#"{
          "info": {"name": "Drafts", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item": [
            {"name": "Ok", "request": {"method": "GET", "url": "https://example.com"}},
            {"name": "Missing", "request": {"method": "GET", "header": []}},
            {"name": "Empty", "request": {"method": "GET", "url": ""}},
            {"name": "Blank object", "request": {"method": "GET", "url": {"raw": "", "host": []}}}
          ]
        }"#;

        let requests = parse_collection(raw).unwrap().collections[0]
            .requests()
            .to_vec();

        let urls: Vec<_> = requests
            .iter()
            .map(|saved| saved.request.endpoint.url())
            .collect();
        assert_eq!(urls, vec!["https://example.com", "", "", ""]);
    }

    #[test]
    fn joins_multi_line_header_values_into_a_single_line() {
        let raw = r#"{
          "info": {"name": "Headers", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item": [{"name": "Ping", "request": {
            "method": "GET", "url": "https://example.com",
            "header": [{"key": "X-Multi", "value": "first\r\n  second\n"}],
            "auth": {"type": "apikey", "apikey": [
              {"key": "key", "value": "X-Key"}, {"key": "value", "value": "a\nb"}
            ]}
          }}]
        }"#;

        let collections = parse_collection(raw).unwrap().collections;
        let headers: Vec<_> = collections[0].requests()[0]
            .request
            .headers
            .iter()
            .map(|header| (header.name(), header.value()))
            .collect();

        assert_eq!(headers, vec![("X-Multi", "first second"), ("X-Key", "a b")]);
    }

    #[test]
    fn keeps_insomnia_requests_without_url_in_both_export_formats() {
        let flat = r#"{
          "__export_format": 4,
          "resources": [
            {"_id": "wrk_1", "_type": "workspace", "name": "Flat"},
            {"_id": "req_1", "_type": "request", "parentId": "wrk_1", "name": "Draft", "method": "GET", "url": ""}
          ]
        }"#;
        let tree = r#"
type: collection.insomnia.rest/5.0
name: Tree
collection:
  - name: Draft
    method: GET
"#;

        for raw in [flat, tree] {
            let collections = parse_collection(raw).unwrap().collections;
            assert_eq!(collections[0].requests()[0].request.endpoint.url(), "");
        }
    }

    #[test]
    fn skips_only_the_requests_with_unsupported_methods() {
        let nested = r#"{
          "info": {"name": "Methods", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item": [
            {"name": "Purge", "request": {"method": "PURGE", "url": "https://example.com"}},
            {"name": "Folder", "item": [
              {"name": "Find", "request": {"method": "PROPFIND", "url": "https://example.com"}},
              {"name": "Get", "request": {"method": "get", "url": "https://example.com"}}
            ]}
          ]
        }"#;
        let flat = r#"{
          "__export_format": 4,
          "resources": [
            {"_id": "wrk_1", "_type": "workspace", "name": "Flat"},
            {"_id": "req_1", "_type": "request", "parentId": "wrk_1", "name": "Custom", "method": "LINK", "url": "https://example.com"},
            {"_id": "req_2", "_type": "request", "parentId": "wrk_1", "name": "Get", "method": "GET", "url": "https://example.com"}
          ]
        }"#;
        let tree = r#"
type: collection.insomnia.rest/5.0
name: Tree
collection:
  - name: Custom
    method: LOCK
    url: https://example.com
  - name: Get
    method: GET
    url: https://example.com
"#;

        let nested = parse_collection(nested).unwrap().collections;
        assert!(nested[0].requests().is_empty());
        assert_eq!(nested[0].folders()[0].requests().len(), 1);
        assert_eq!(nested[0].folders()[0].requests()[0].name(), "Get");
        for raw in [flat, tree] {
            let collections = parse_collection(raw).unwrap().collections;
            let names: Vec<_> = collections[0].requests().iter().map(|r| r.name()).collect();
            assert_eq!(names, vec!["Get"]);
        }
    }

    #[test]
    fn collections_without_descriptions_produce_no_documentation() {
        let raw = r#"{
          "info": {"name": "X", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item": [{"name": "Ping", "request": {"method": "GET", "url": {"raw": "https://example.com", "query": [{"key": "a", "value": "1"}]}}}]
        }"#;

        let imported = parse_collection(raw).unwrap();

        assert!(imported.docs.is_none());
        assert!(imported.collections[0].requests()[0].docs_ref.is_none());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrunoFile {
    pub relative_path: String,
    pub content: String,
}

/// Import a Bruno tree read by the native adapter. Validate relative paths
/// again to prevent traversal.
pub fn parse_bruno_directory(
    root_name: &str,
    files: &[BrunoFile],
) -> Result<ImportedCollectionData, CollectionImportError> {
    if files.iter().any(|file| {
        file.relative_path
            .split('/')
            .any(|part| part == ".." || part.is_empty())
    }) {
        return Err(CollectionImportError::Invalid(
            "caminho inválido na coleção Bruno".into(),
        ));
    }
    if let Some(root_file) = files.iter().find(|file| {
        matches!(
            file.relative_path.as_str(),
            "opencollection.yml" | "opencollection.yaml"
        )
    }) {
        let mut root: Value = yaml_serde::from_str(&root_file.content)
            .map_err(|error| CollectionImportError::Invalid(error.to_string()))?;
        let object = root.as_object_mut().ok_or_else(|| {
            CollectionImportError::Invalid("documento YAML raiz deve ser um objeto".into())
        })?;
        let mut disk_items = open_directory_items("", files, 0)?;
        let items = object
            .entry("items")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| CollectionImportError::Invalid("items deve ser uma lista".into()))?;
        items.append(&mut disk_items);

        let mut disk_environments = open_directory_environments(files)?;
        if !disk_environments.is_empty() {
            let config = object
                .entry("config")
                .or_insert_with(|| Value::Object(Default::default()))
                .as_object_mut()
                .ok_or_else(|| {
                    CollectionImportError::Invalid("config deve ser um objeto".into())
                })?;
            let environments = config
                .entry("environments")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(|| {
                    CollectionImportError::Invalid("environments deve ser uma lista".into())
                })?;
            environments.append(&mut disk_environments);
        }
        return map_open_collection(&root);
    }
    let config = files
        .iter()
        .find(|file| file.relative_path == "bruno.json")
        .and_then(|file| serde_json::from_str::<Value>(&file.content).ok());
    let name = config
        .as_ref()
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(root_name);
    let sequential = config
        .as_ref()
        .and_then(|v| v.pointer("/scripts/flow"))
        .and_then(Value::as_str)
        == Some("sequential");
    let mut ids = IdGenerator::new();
    let mut state = ScriptImportState::default();
    let mut context = ScriptContext::default();
    context.path.push(name.to_string());
    if let Some(file) = files
        .iter()
        .find(|file| file.relative_path == "collection.bru")
    {
        append_bru_scripts(&file.content, &mut context);
    }
    let (folders, requests) =
        map_bru_directory("", files, &context, sequential, &mut ids, &mut state, 0)?;
    let root_variables = files
        .iter()
        .find(|file| file.relative_path == "collection.bru")
        .map(|file| bru_variables(&file.content))
        .transpose()?
        .unwrap_or_default();
    let collection = Collection::new(ids.next("collection"), name, folders, requests)?
        .with_variables(root_variables)?;
    let mut environments = Vec::new();
    for file in files.iter().filter(|file| {
        file.relative_path.starts_with("environments/") && file.relative_path.ends_with(".bru")
    }) {
        let env_name = file
            .relative_path
            .rsplit('/')
            .next()
            .unwrap_or("Environment.bru")
            .trim_end_matches(".bru");
        environments.push(Environment::new(
            ids.next("environment"),
            env_name,
            bru_variables(&file.content)?,
        )?);
    }
    Ok(ImportedCollectionData {
        collections: vec![collection],
        environments,
        source_kind: Some(ApiDocsSourceKind::Bruno),
        format: None,
        docs: None,
        script_count: state.script_count,
        warnings: state.warnings,
    })
}

fn open_directory_items(
    prefix: &str,
    files: &[BrunoFile],
    depth: usize,
) -> Result<Vec<Value>, CollectionImportError> {
    check_depth(depth)?;
    let mut items = Vec::new();
    let mut child_names = HashSet::new();

    for file in files
        .iter()
        .filter(|file| is_yaml_path(&file.relative_path))
    {
        let parent = file
            .relative_path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        if parent == prefix {
            let filename = file.relative_path.rsplit('/').next().unwrap_or_default();
            if matches!(
                filename,
                "opencollection.yml" | "opencollection.yaml" | "folder.yml" | "folder.yaml"
            ) {
                continue;
            }
            let mut item = parse_open_yaml(file)?;
            ensure_open_item_name(&mut item, file_stem(filename));
            // WebSocket items are kept so the import reports them.
            if item.get("http").is_some()
                || item.get("graphql").is_some()
                || item.get("request").is_some()
                || item.get("method").is_some()
                || item.get("items").is_some()
                || open_websocket(&item, &item)
            {
                items.push(item);
            }
            continue;
        }

        let rest = if prefix.is_empty() {
            file.relative_path.as_str()
        } else {
            file.relative_path
                .strip_prefix(&format!("{prefix}/"))
                .unwrap_or_default()
        };
        if let Some((child, _)) = rest.split_once('/')
            && child != "environments"
            && !child.is_empty()
        {
            child_names.insert(child.to_string());
        }
    }

    let mut child_names: Vec<_> = child_names.into_iter().collect();
    child_names.sort();
    for child in child_names {
        let child_prefix = if prefix.is_empty() {
            child.clone()
        } else {
            format!("{prefix}/{child}")
        };
        let metadata = files.iter().find(|file| {
            matches!(
                file.relative_path.strip_prefix(&format!("{child_prefix}/")),
                Some("folder.yml" | "folder.yaml")
            )
        });
        let mut folder = metadata
            .map(parse_open_yaml)
            .transpose()?
            .unwrap_or_else(|| Value::Object(Default::default()));
        ensure_open_item_name(&mut folder, &child);
        let children = open_directory_items(&child_prefix, files, depth + 1)?;
        let object = folder.as_object_mut().ok_or_else(|| {
            CollectionImportError::Invalid("folder.yml deve ser um objeto".into())
        })?;
        let existing = object
            .entry("items")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| CollectionImportError::Invalid("items deve ser uma lista".into()))?;
        existing.extend(children);
        items.push(folder);
    }

    items.sort_by_key(|item| {
        item.pointer("/info/seq")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX)
    });
    Ok(items)
}

fn open_directory_environments(files: &[BrunoFile]) -> Result<Vec<Value>, CollectionImportError> {
    let mut environments = Vec::new();
    for file in files.iter().filter(|file| {
        is_yaml_path(&file.relative_path)
            && file
                .relative_path
                .rsplit_once('/')
                .is_some_and(|(parent, _)| parent == "environments")
    }) {
        let mut environment = parse_open_yaml(file)?;
        let filename = file.relative_path.rsplit('/').next().unwrap_or_default();
        if environment.get("name").is_none()
            && let Some(object) = environment.as_object_mut()
        {
            object.insert("name".into(), Value::String(file_stem(filename).into()));
        }
        environments.push(environment);
    }
    Ok(environments)
}

fn parse_open_yaml(file: &BrunoFile) -> Result<Value, CollectionImportError> {
    yaml_serde::from_str(&file.content)
        .map_err(|error| CollectionImportError::Invalid(format!("{}: {error}", file.relative_path)))
}

fn ensure_open_item_name(item: &mut Value, fallback: &str) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    let info = object
        .entry("info")
        .or_insert_with(|| Value::Object(Default::default()));
    // The declared `info.name` takes precedence over the file/directory name.
    let name = match info.as_object_mut() {
        Some(info) => info
            .entry("name")
            .or_insert_with(|| Value::String(fallback.to_string()))
            .clone(),
        None => Value::String(fallback.to_string()),
    };
    object.entry("name").or_insert(name);
}

fn is_yaml_path(path: &str) -> bool {
    path.ends_with(".yml") || path.ends_with(".yaml")
}

fn file_stem(filename: &str) -> &str {
    filename
        .strip_suffix(".yaml")
        .or_else(|| filename.strip_suffix(".yml"))
        .unwrap_or(filename)
}

fn map_bru_directory(
    prefix: &str,
    files: &[BrunoFile],
    inherited: &ScriptContext,
    sequential: bool,
    ids: &mut IdGenerator,
    state: &mut ScriptImportState,
    depth: usize,
) -> Result<(Vec<Folder>, Vec<SavedRequest>), CollectionImportError> {
    check_depth(depth)?;
    let direct = |path: &str| {
        let parent = path.rsplit_once('/').map(|v| v.0).unwrap_or("");
        parent == prefix
    };
    let mut context = inherited.clone();
    let metadata = if prefix.is_empty() {
        "collection.bru".to_string()
    } else {
        format!("{prefix}/folder.bru")
    };
    if let Some(file) = files.iter().find(|file| file.relative_path == metadata)
        && !prefix.is_empty()
    {
        append_bru_scripts(&file.content, &mut context);
    }
    let mut request_names = HashSet::new();
    let mut requests = Vec::new();
    for file in files.iter().filter(|file| {
        direct(&file.relative_path)
            && file.relative_path.ends_with(".bru")
            && !file.relative_path.ends_with("collection.bru")
            && !file.relative_path.ends_with("folder.bru")
    }) {
        let fallback = file
            .relative_path
            .rsplit('/')
            .next()
            .unwrap_or("request.bru")
            .trim_end_matches(".bru");
        let name = unique_name(
            bru_field(bru_block(&file.content, "meta").unwrap_or_default(), "name")
                .unwrap_or(fallback),
            &mut request_names,
        );
        let mut scripts = context.clone();
        scripts.path.push(name.clone());
        append_bru_scripts(&file.content, &mut scripts);
        let Some((method, request_block)) = bru_method_block(&file.content) else {
            continue;
        };
        let mut url = bru_field(request_block, "url")
            .unwrap_or_default()
            .to_string();
        for line in bru_block(&file.content, "params:query")
            .unwrap_or_default()
            .lines()
        {
            let line = line.trim();
            if line.starts_with('~') {
                continue;
            }
            if let Some((name, value)) = line.split_once(':') {
                url.push(if url.contains('?') { '&' } else { '?' });
                url.push_str(name.trim());
                url.push('=');
                url.push_str(value.trim());
            }
        }
        let headers = bru_headers(bru_block(&file.content, "headers"))?;
        let (protocol, body, variables, payload) =
            if let Some(graphql) = bru_block(&file.content, "body:graphql") {
                let variables = bru_block(&file.content, "body:graphql:vars")
                    .unwrap_or("{}")
                    .trim()
                    .to_string();
                (
                    ProtocolId::GraphQl,
                    graphql.trim().to_string(),
                    variables,
                    BodyPayload::None,
                )
            } else if let Some(json) = bru_block(&file.content, "body:json") {
                (
                    ProtocolId::Rest,
                    json.trim().to_string(),
                    String::new(),
                    BodyPayload::Raw {
                        language: RawBodyLanguage::Json,
                    },
                )
            } else if let Some(text) = bru_block(&file.content, "body:text") {
                (
                    ProtocolId::Rest,
                    text.trim().to_string(),
                    String::new(),
                    BodyPayload::Raw {
                        language: RawBodyLanguage::Text,
                    },
                )
            } else {
                (
                    ProtocolId::Rest,
                    String::new(),
                    String::new(),
                    BodyPayload::None,
                )
            };
        let mut saved = build_request(
            ids,
            &name,
            Some(method),
            url,
            headers,
            bru_auth(&file.content, request_block),
            protocol,
            body,
            variables,
            payload,
        )?;
        let mut post = scripts.post.clone();
        let mut tests = scripts.tests.clone();
        if !sequential {
            post.reverse();
            tests.reverse();
        }
        post.extend(tests);
        let path = scripts.path.join(" / ");
        let pre = translate_segments(
            &scripts.pre,
            "preRequest",
            &path,
            state,
            ScriptDialect::Bruno,
        );
        let post = translate_segments(&post, "postResponse", &path, state, ScriptDialect::Bruno);
        saved.request = saved.request.with_scripts(pre, post);
        requests.push(saved);
    }
    let mut child_names = HashSet::new();
    for file in files {
        let rest = if prefix.is_empty() {
            file.relative_path.as_str()
        } else {
            file.relative_path
                .strip_prefix(&format!("{prefix}/"))
                .unwrap_or("")
        };
        if let Some((child, _)) = rest.split_once('/')
            && !child.is_empty()
            && child != "environments"
        {
            child_names.insert(child.to_string());
        }
    }
    let mut child_names: Vec<_> = child_names.into_iter().collect();
    child_names.sort();
    let mut folders = Vec::new();
    for child in child_names {
        let child_prefix = if prefix.is_empty() {
            child.clone()
        } else {
            format!("{prefix}/{child}")
        };
        let mut child_context = context.clone();
        child_context.path.push(child.clone());
        let (children, child_requests) = map_bru_directory(
            &child_prefix,
            files,
            &child_context,
            sequential,
            ids,
            state,
            depth + 1,
        )?;
        let variables = files
            .iter()
            .find(|file| file.relative_path == format!("{child_prefix}/folder.bru"))
            .map(|file| bru_variables(&file.content))
            .transpose()?
            .unwrap_or_default();
        folders.push(
            Folder::new(ids.next("folder"), child, children, child_requests)?
                .with_variables(variables)?,
        );
    }
    Ok((folders, requests))
}

fn bru_auth(source: &str, request: &str) -> Authentication {
    match bru_field(request, "auth").unwrap_or("none") {
        "bearer" => Authentication::Bearer {
            token: normalize_templates(
                bru_field(
                    bru_block(source, "auth:bearer").unwrap_or_default(),
                    "token",
                )
                .unwrap_or_default(),
            ),
        },
        "basic" => {
            let block = bru_block(source, "auth:basic").unwrap_or_default();
            Authentication::Basic {
                username: normalize_templates(bru_field(block, "username").unwrap_or_default()),
                password: normalize_templates(bru_field(block, "password").unwrap_or_default()),
            }
        }
        _ => Authentication::None,
    }
}

fn bru_variables(source: &str) -> Result<Vec<EnvironmentVariable>, CollectionImportError> {
    let mut variables = Vec::new();
    for (label, sensitive) in [("vars", false), ("vars:secret", true)] {
        for line in bru_block(source, label).unwrap_or_default().lines() {
            let line = line.trim().trim_start_matches('~').trim();
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if !name.trim().is_empty() {
                variables.push(EnvironmentVariable::new(
                    name.trim(),
                    normalize_templates(value.trim()),
                    sensitive,
                )?);
            }
        }
    }
    Ok(variables)
}

fn append_bru_scripts(source: &str, target: &mut ScriptContext) {
    if let Some(value) = bru_block(source, "script:pre-request") {
        target.pre.push(value.trim().to_string());
    }
    if let Some(value) = bru_block(source, "script:post-response") {
        target.post.push(value.trim().to_string());
    }
    if let Some(value) = bru_block(source, "tests") {
        target.tests.push(value.trim().to_string());
    }
}
fn bru_method_block(source: &str) -> Option<(&str, &str)> {
    for method in ["get", "post", "put", "patch", "delete", "head", "options"] {
        if let Some(block) = bru_block(source, method) {
            return Some((method, block));
        }
    }
    None
}
fn bru_field<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    block.lines().find_map(|line| {
        let (key, value) = line.trim().split_once(':')?;
        (key.trim() == name).then_some(value.trim())
    })
}
fn bru_headers(block: Option<&str>) -> Result<Vec<HeaderEntry>, CollectionImportError> {
    let mut out = Vec::new();
    for line in block.unwrap_or_default().lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('~') {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            out.push(HeaderEntry::new(
                name.trim(),
                normalize_templates(value.trim()),
                true,
            )?);
        }
    }
    Ok(out)
}
fn bru_block<'a>(source: &'a str, label: &str) -> Option<&'a str> {
    let needle = format!("{label} {{");
    let start = source.find(&needle)? + needle.len();
    let bytes = source.as_bytes();
    let mut depth = 1usize;
    let mut i = start;
    let mut quote = None;
    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            if b == b'\\' {
                i += 2;
                continue;
            }
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if matches!(b, b'\'' | b'"' | b'`') {
            quote = Some(b);
            i += 1;
            continue;
        }
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(&source[start..i]);
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod imported_script_tests {
    use super::*;

    #[test]
    fn composes_and_translates_inherited_postman_scripts() {
        let raw = r#"{
          "info":{"name":"Scripts","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "event":[{"listen":"prerequest","script":{"exec":["pm.environment.set('root', '1')"]}}],
          "item":[{"name":"Folder","event":[{"listen":"test","script":{"exec":"pm.test('ok', () => pm.expect(1).to.equal(1))"}}],
            "item":[{"name":"Request","event":[{"listen":"prerequest","script":{"exec":"pm.sendRequest('x')"}}],"request":{"method":"GET","url":"https://example.test"}}]}]
        }"#;
        let imported = parse_collection(raw).unwrap();
        let request = &imported.collections[0].folders()[0].requests()[0].request;
        assert!(request.pre_request_script.contains("al.environment.set"));
        assert!(request.pre_request_script.contains("al.unsupportedCommand"));
        assert!(request.post_response_script.contains("al.test"));
        assert_eq!(imported.script_count, 3);
        assert_eq!(imported.warnings[0].api, "pm.sendRequest");
    }

    #[test]
    fn wraps_imported_scripts_only_when_they_need_it() {
        let raw = r#"{
          "info":{"name":"Scripts","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "item":[
            {"name":"Alone","event":[{"listen":"prerequest","script":{"exec":"pm.request.headers.upsert({key:'A',value:'1'});"}}],
             "request":{"method":"GET","url":"https://example.test"}},
            {"name":"Returns","event":[{"listen":"prerequest","script":{"exec":"if (skip) { return; }"}}],
             "request":{"method":"GET","url":"https://example.test"}}
          ]
        }"#;
        let imported = parse_collection(raw).unwrap();
        let requests = imported.collections[0].requests();
        assert_eq!(
            requests[0].request.pre_request_script,
            "al.request.headers.set({key:'A',value:'1'});"
        );
        assert!(
            requests[1]
                .request
                .pre_request_script
                .starts_with("(function () {")
        );
    }

    #[test]
    fn inherited_scripts_share_helpers_but_not_block_scoped_names() {
        let raw = r#"{
          "info":{"name":"Scripts","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "event":[{"listen":"prerequest","script":{"exec":"const a = 1;"}}],
          "item":[{"name":"Request","event":[{"listen":"prerequest","script":{"exec":"const a = 2;"}}],
            "request":{"method":"GET","url":"https://example.test"}}]
        }"#;
        let imported = parse_collection(raw).unwrap();
        assert_eq!(
            imported.collections[0].requests()[0]
                .request
                .pre_request_script,
            "{\nconst a = 1;\n}\n{\nconst a = 2;\n}"
        );
    }

    #[test]
    fn converts_postman_legacy_environment_helpers_and_local_variable_scopes() {
        let raw = r#"{
          "info":{"name":"Scoped","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "variable":[{"key":"baseUrl","value":"https://collection.test"}],
          "item":[{"name":"Users","variable":[{"key":"tenant","value":"folder"}],
            "item":[{"name":"Get","event":[{"listen":"prerequest","script":{"exec":"postman.setEnvironmentVariable('token', 'abc')"}}],
              "request":{"method":"GET","url":"{{baseUrl}}/users"}}]}]
        }"#;

        let imported = parse_collection(raw).unwrap();
        let collection = &imported.collections[0];
        let folder = &collection.folders()[0];
        let request = &folder.requests()[0].request;

        assert_eq!(collection.variables()[0].name(), "baseUrl");
        assert_eq!(collection.variables()[0].value(), "https://collection.test");
        assert_eq!(folder.variables()[0].name(), "tenant");
        assert_eq!(folder.variables()[0].value(), "folder");
        assert!(request.pre_request_script.contains("al.environment.set"));
        assert!(
            !request
                .pre_request_script
                .contains("postman.setEnvironmentVariable")
        );
    }

    #[test]
    fn imports_open_collection_tree_scripts_variables_and_environments() {
        let files = vec![
            BrunoFile {
                relative_path: "opencollection.yml".into(),
                content: r#"opencollection: "1.0.0"
info:
  name: Demo
request:
  variables:
    - name: baseUrl
      value: https://collection.test
  scripts:
    - type: before-request
      code: bru.setCollectionVar('root', '1')
"#
                .into(),
            },
            BrunoFile {
                relative_path: "users/folder.yml".into(),
                content: r#"info:
  name: Users
  type: folder
request:
  variables:
    - name: baseUrl
      value: https://folder.test
    - name: retry
      value:
        type: number
        data: "2"
  scripts:
    - type: after-response
      code: bru.setFolderVar('seen', true)
"#
                .into(),
            },
            BrunoFile {
                relative_path: "users/get-user.yml".into(),
                content: r#"info:
  name: Get user
  type: http
http:
  method: GET
  url: "{{baseUrl}}/users/1"
runtime:
  scripts:
    - type: before-request
      code: bru.setEnvVar('token', 'abc')
"#
                .into(),
            },
            BrunoFile {
                relative_path: "environments/development.yml".into(),
                content: r#"name: Development
variables:
  - name: baseUrl
    value: https://environment.test
  - name: apiToken
    value: secret
    secret: true
"#
                .into(),
            },
        ];

        let imported = parse_bruno_directory("fallback", &files).unwrap();
        let collection = &imported.collections[0];
        let folder = &collection.folders()[0];
        let request = &folder.requests()[0].request;

        assert_eq!(folder.name(), "Users");
        assert_eq!(folder.requests()[0].name(), "Get user");
        assert_eq!(collection.variables()[0].value(), "https://collection.test");
        assert_eq!(folder.variables()[0].value(), "https://folder.test");
        assert_eq!(folder.variables()[1].value(), "2");
        assert!(request.pre_request_script.contains("al.collection.set"));
        assert!(request.pre_request_script.contains("al.environment.set"));
        assert!(request.post_response_script.contains("al.folder.set"));
        assert_eq!(imported.script_count, 3);
        assert_eq!(imported.environments[0].name(), "Development");
        assert_eq!(imported.environments[0].variables().len(), 2);
        assert!(imported.environments[0].variables()[1].sensitive);
    }

    #[test]
    fn warns_about_open_collection_websocket_items_instead_of_dropping_them() {
        let files = vec![
            BrunoFile {
                relative_path: "opencollection.yml".into(),
                content: "opencollection: \"1.0.0\"\ninfo:\n  name: Demo\n".into(),
            },
            BrunoFile {
                relative_path: "live.yml".into(),
                content: "info:\n  name: Live\n  type: websocket\nwebsocket:\n  url: wss://live.test\n"
                    .into(),
            },
            BrunoFile {
                relative_path: "ping.yml".into(),
                content: "info:\n  name: Ping\n  type: http\nhttp:\n  method: GET\n  url: https://api.test/ping\n"
                    .into(),
            },
        ];

        let imported = parse_bruno_directory("fallback", &files).unwrap();

        assert_eq!(imported.collections[0].requests().len(), 1);
        assert_eq!(imported.warnings.len(), 1, "{:?}", imported.warnings);
        assert_eq!(imported.warnings[0].api, "websocket");
        assert_eq!(imported.warnings[0].reason, "skippedProtocol");
        assert!(imported.warnings[0].request_path.ends_with("Live"));
    }

    #[test]
    fn imports_legacy_bruno_tree_with_sandwich_order() {
        let files = vec![
            BrunoFile { relative_path: "bruno.json".into(), content: r#"{"name":"Demo"}"#.into() },
            BrunoFile { relative_path: "collection.bru".into(), content: "script:pre-request {\nconsole.log('collection pre')\n}\nscript:post-response {\nconsole.log('collection post')\n}".into() },
            BrunoFile { relative_path: "users/get.bru".into(), content: "meta {\n name: Get user\n}\nget {\n url: https://example.test/users\n}\nscript:pre-request {\nbru.setVar('id', 1)\n}\nscript:post-response {\nconsole.log('request post')\n}\ntests {\ntest('ok', () => expect(1).equal(1))\n}".into() },
        ];
        let imported = parse_bruno_directory("fallback", &files).unwrap();
        let request = &imported.collections[0].folders()[0].requests()[0].request;
        assert!(
            request.pre_request_script.find("collection pre")
                < request.pre_request_script.find("al.runtime.set")
        );
        assert!(
            request.post_response_script.find("request post")
                < request.post_response_script.find("collection post")
        );
        assert!(
            request.post_response_script.rfind("al.test").unwrap()
                > request
                    .post_response_script
                    .find("collection post")
                    .unwrap()
        );
    }
}
