//! HAR (HTTP Archive 1.2) import (spec 0127): every recorded call becomes a
//! REST request of a single collection, grouped into one folder per host
//! when the archive spans more than one. Responses, timings and caches are
//! ignored; only `log.entries[].request` and `log.pages[0].title` are read.
//!
//! Nothing is filtered silently: entries that cannot become a request, and
//! multipart file parts that cannot be recovered, are reported as
//! `ImportWarning`s.

use std::collections::{HashMap, HashSet};

use alcy_domain::{
    Authentication, BodyPayload, Collection, Folder, FormDataField, FormDataFieldValue,
    HeaderEntry, ProtocolId, RawBodyLanguage, SavedRequest, UrlEncodedField,
};
use serde_json::{Map, Value};

use super::shell_command::{form_fields, host_of, is_content_type, request_name, urlencoded_body};
use super::{
    CollectionImportError, FALLBACK_COLLECTION_NAME, FALLBACK_FOLDER_NAME, IdGenerator,
    ImportFormat, ImportWarning, ImportedCollectionData, build_request, ensure_content_type,
    http_method, map_headers, raw_language_from_mime, single_line, unique_name,
};

/// Request names longer than this (in characters) are shortened with `…`.
const MAX_REQUEST_NAME_CHARS: usize = 96;

/// Headers the HTTP client computes on its own. Replaying the browser's
/// values would be wrong (`content-length` of another body, `host` of the
/// recorded connection) or harmful (`accept-encoding` may advertise
/// encodings, such as `zstd`, the client cannot decode).
const CLIENT_COMPUTED_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "te",
    "accept-encoding",
];

/// `true` when `value` has the shape of a HAR document: a root `log` object
/// carrying `entries`, `version` or `creator`. Once detected, a structural
/// problem is an error rather than "not recognized".
pub(crate) fn is_har(value: &Value) -> bool {
    value
        .get("log")
        .and_then(Value::as_object)
        .is_some_and(|log| {
            ["entries", "version", "creator"]
                .iter()
                .any(|key| log.contains_key(*key))
        })
}

pub(crate) fn map_har(value: &Value) -> Result<ImportedCollectionData, CollectionImportError> {
    let log = value
        .get("log")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("HAR without a 'log' object"))?;
    if let Some(version) = log.get("version").and_then(Value::as_str)
        && !version.trim().is_empty()
        && !version.trim().starts_with("1.")
    {
        return Err(CollectionImportError::UnsupportedVersion(format!(
            "HAR {version}"
        )));
    }
    let entries = log
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("HAR without a 'log.entries' list"))?;
    if entries.is_empty() {
        return Err(invalid("HAR has no entries"));
    }

    let mut ids = IdGenerator::new();
    let mut warnings = Vec::new();
    let mut groups: Vec<HostGroup> = Vec::new();
    let mut group_by_host: HashMap<String, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(call) = read_entry(entry, index, &mut warnings) else {
            continue;
        };
        let group_index = *group_by_host.entry(call.host.clone()).or_insert_with(|| {
            groups.push(HostGroup {
                host: call.host.clone(),
                names: HashSet::new(),
                requests: Vec::new(),
            });
            groups.len() - 1
        });
        let group = &mut groups[group_index];
        let name = unique_name(&call.name, &mut group.names);
        let method = call.method.clone();
        // One entry that cannot become a request must not cost the others.
        match call.into_request(&name, &mut ids, &mut warnings) {
            Ok(saved) => group.requests.push(saved),
            Err(_) => warnings.push(request_warning(
                format!("entries[{index}]"),
                &method,
                "invalidEntry",
            )),
        }
    }

    // A host whose only entries failed would leave an empty folder.
    groups.retain(|group| !group.requests.is_empty());
    if groups.is_empty() {
        return Err(invalid("no HAR entry could be imported as a request"));
    }
    let name = collection_name(log, &groups);
    let collection = if groups.len() == 1 {
        let requests = groups.pop().map(|group| group.requests).unwrap_or_default();
        Collection::new(ids.next("collection"), name, Vec::new(), requests)?
    } else {
        let mut folder_names = HashSet::new();
        let folders = groups
            .into_iter()
            .map(|group| {
                let folder_name = if group.host.is_empty() {
                    FALLBACK_FOLDER_NAME
                } else {
                    group.host.as_str()
                };
                let folder_name = unique_name(folder_name, &mut folder_names);
                Folder::new(ids.next("folder"), folder_name, Vec::new(), group.requests)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Collection::new(ids.next("collection"), name, folders, Vec::new())?
    };

    Ok(ImportedCollectionData {
        collections: vec![collection],
        environments: Vec::new(),
        source_kind: None,
        format: Some(ImportFormat::Har),
        docs: None,
        script_count: 0,
        warnings,
    })
}

struct HostGroup {
    host: String,
    names: HashSet<String>,
    requests: Vec<SavedRequest>,
}

/// The fields of one entry's `request` needed to build a saved request.
struct HarCall<'a> {
    method: String,
    url: String,
    host: String,
    name: String,
    request: &'a Map<String, Value>,
}

/// Reads the method and URL of an entry, or records why it is skipped.
fn read_entry<'a>(
    entry: &'a Value,
    index: usize,
    warnings: &mut Vec<ImportWarning>,
) -> Option<HarCall<'a>> {
    let location = format!("entries[{index}]");
    let Some(request) = entry.get("request").and_then(Value::as_object) else {
        warnings.push(request_warning(location, "", "invalidEntry"));
        return None;
    };
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let url = request
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if method.is_empty() || url.is_empty() {
        warnings.push(request_warning(location, method, "invalidEntry"));
        return None;
    }
    if http_method(method).is_err() {
        warnings.push(request_warning(location, method, "unsupportedMethod"));
        return None;
    }

    let mut url = url.to_string();
    if !url.contains('?') {
        append_query_string(&mut url, request.get("queryString"));
    }
    Some(HarCall {
        method: method.to_ascii_uppercase(),
        host: host_of(&url).to_ascii_lowercase(),
        name: short_name(&request_name(method, &url)),
        url,
        request,
    })
}

impl HarCall<'_> {
    fn into_request(
        self,
        name: &str,
        ids: &mut IdGenerator,
        warnings: &mut Vec<ImportWarning>,
    ) -> Result<SavedRequest, CollectionImportError> {
        let mut headers = map_headers(self.request.get("headers"), "name")?;
        headers.retain(|header| !is_dropped_header(header.name()));
        add_cookie_header(&mut headers, self.request.get("cookies"))?;
        let (body, payload) =
            post_data_body(self.request.get("postData"), &mut headers, name, warnings)?;
        build_request(
            ids,
            name,
            Some(&self.method),
            self.url,
            headers,
            Authentication::None,
            ProtocolId::Rest,
            body,
            String::new(),
            payload,
        )
    }
}

fn is_dropped_header(name: &str) -> bool {
    name.starts_with(':')
        || CLIENT_COMPUTED_HEADERS
            .iter()
            .any(|computed| computed.eq_ignore_ascii_case(name))
}

/// `queryString` is only a fallback: the URL already carries the query as
/// it was sent, in the original order and encoding.
fn append_query_string(url: &mut String, query: Option<&Value>) {
    for pair in query.and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = pair.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let value = pair
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(name);
        url.push('=');
        url.push_str(value);
    }
}

/// Browsers usually record the `Cookie` header itself; the `cookies` list
/// only fills it in when the header is missing.
fn add_cookie_header(
    headers: &mut Vec<HeaderEntry>,
    cookies: Option<&Value>,
) -> Result<(), CollectionImportError> {
    if headers
        .iter()
        .any(|header| header.name().eq_ignore_ascii_case("cookie"))
    {
        return Ok(());
    }
    let pairs = cookies
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|cookie| {
            let name = cookie.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            let value = cookie
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(format!("{name}={value}"))
        })
        .collect::<Vec<_>>();
    if !pairs.is_empty() {
        headers.push(HeaderEntry::new(
            "Cookie",
            single_line(&pairs.join("; ")),
            true,
        )?);
    }
    Ok(())
}

fn post_data_body(
    post_data: Option<&Value>,
    headers: &mut Vec<HeaderEntry>,
    request_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Result<(String, BodyPayload), CollectionImportError> {
    let Some(post_data) = post_data.filter(|value| value.is_object()) else {
        return Ok((String::new(), BodyPayload::None));
    };
    // Line breaks would make the `Content-Type` header invalid.
    let mime = single_line(
        post_data
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let mime = mime.trim();
    let essence = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let text = post_data
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = post_data.get("params").and_then(Value::as_array);

    if essence == "multipart/form-data" {
        let parts = match params.filter(|params| !params.is_empty()) {
            Some(params) => Some(params_parts(params)),
            None => multipart_parts(text, mime),
        };
        if let Some(parts) = parts {
            // The boundary is generated on send; the recorded one would
            // no longer match the body.
            headers.retain(|header| !is_content_type(header));
            return Ok((
                String::new(),
                BodyPayload::FormData(form_data_fields(parts, request_name, warnings)),
            ));
        }
    }

    if essence == "application/x-www-form-urlencoded" {
        let fields = form_fields(text).or_else(|| {
            params
                .map(|params| urlencoded_params(params))
                .filter(|fields| !fields.is_empty())
        });
        if let Some(fields) = fields {
            ensure_content_type(headers, mime)?;
            let (_, body, _, payload) = urlencoded_body(fields);
            return Ok((body, payload));
        }
    }

    if text.is_empty() {
        return Ok((String::new(), BodyPayload::None));
    }
    if !mime.is_empty() {
        ensure_content_type(headers, mime)?;
    }
    Ok((
        text.to_string(),
        BodyPayload::Raw {
            language: raw_language(&essence, text),
        },
    ))
}

fn raw_language(essence: &str, text: &str) -> RawBodyLanguage {
    if essence.is_empty() {
        return if serde_json::from_str::<Value>(text).is_ok() {
            RawBodyLanguage::Json
        } else {
            RawBodyLanguage::Text
        };
    }
    if essence.ends_with("/json") || essence.ends_with("+json") {
        return RawBodyLanguage::Json;
    }
    if essence.ends_with("+xml") {
        return RawBodyLanguage::Xml;
    }
    raw_language_from_mime(essence)
}

/// One part of a multipart body: a text value or a file that cannot be
/// recovered from the archive.
struct MultipartPart {
    name: String,
    value: String,
    is_file: bool,
}

fn params_parts(params: &[Value]) -> Vec<MultipartPart> {
    params
        .iter()
        .filter_map(|param| {
            let name = param.get("name").and_then(Value::as_str)?;
            Some(MultipartPart {
                name: name.to_string(),
                value: param
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                is_file: param
                    .get("fileName")
                    .and_then(Value::as_str)
                    .is_some_and(|file| !file.is_empty()),
            })
        })
        .collect()
}

/// Splits a recorded multipart body by the boundary declared in `mime`.
/// `None` when the text does not have that shape, so it stays a raw body.
fn multipart_parts(text: &str, mime: &str) -> Option<Vec<MultipartPart>> {
    let boundary = mime_parameter(mime, "boundary")?;
    let delimiter = format!("--{boundary}");
    let mut sections = text.split(delimiter.as_str());
    sections.next()?;
    let mut parts = Vec::new();
    for section in sections {
        if section.starts_with("--") {
            break;
        }
        let section = section
            .strip_prefix("\r\n")
            .or_else(|| section.strip_prefix('\n'))?;
        let (head, value) = section
            .split_once("\r\n\r\n")
            .or_else(|| section.split_once("\n\n"))?;
        let value = value
            .strip_suffix("\r\n")
            .or_else(|| value.strip_suffix('\n'))
            .unwrap_or(value);
        let disposition = head.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-disposition")
                .then_some(value)
        })?;
        parts.push(MultipartPart {
            name: mime_parameter(disposition, "name")?,
            value: value.to_string(),
            is_file: mime_parameter(disposition, "filename").is_some(),
        });
    }
    (!parts.is_empty()).then_some(parts)
}

/// Value of `key` in a `type; key=value; other="quoted"` header value.
fn mime_parameter(value: &str, key: &str) -> Option<String> {
    value.split(';').find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        name.trim().eq_ignore_ascii_case(key).then(|| {
            let value = value.trim();
            value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .unwrap_or(value)
                .to_string()
        })
    })
}

fn form_data_fields(
    parts: Vec<MultipartPart>,
    request_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Vec<FormDataField> {
    parts
        .into_iter()
        .filter_map(|part| {
            let name = single_line(&part.name).trim().to_string();
            if name.is_empty() {
                return None;
            }
            if part.is_file {
                warnings.push(ImportWarning {
                    request_path: request_name.to_string(),
                    phase: "body".into(),
                    line: None,
                    api: name,
                    reason: "skippedFile".into(),
                });
                return None;
            }
            Some(FormDataField {
                name,
                enabled: true,
                value: FormDataFieldValue::Text(part.value),
            })
        })
        .collect()
}

fn urlencoded_params(params: &[Value]) -> Vec<UrlEncodedField> {
    params
        .iter()
        .filter_map(|param| {
            let name = param.get("name").and_then(Value::as_str)?;
            (!name.is_empty()).then(|| UrlEncodedField {
                name: name.to_string(),
                value: param
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                enabled: true,
            })
        })
        .collect()
}

/// `log.pages[0].title` — browsers often store the page URL there, in which
/// case its host reads better — then the single host, then the fallback.
fn collection_name(log: &Map<String, Value>, groups: &[HostGroup]) -> String {
    let title = log
        .get("pages")
        .and_then(Value::as_array)
        .and_then(|pages| pages.first())
        .and_then(|page| page.get("title"))
        .and_then(Value::as_str)
        .map(|title| single_line(title).trim().to_string())
        .filter(|title| !title.is_empty());
    let title = title.map(|title| {
        if title.contains("://") && !title.contains(char::is_whitespace) {
            let host = host_of(&title);
            if host.is_empty() {
                title.clone()
            } else {
                host.to_string()
            }
        } else {
            title
        }
    });
    let single_host = match groups {
        [group] if !group.host.is_empty() => Some(group.host.clone()),
        _ => None,
    };
    title
        .or(single_host)
        .map(|name| short_name(&name))
        .unwrap_or_else(|| FALLBACK_COLLECTION_NAME.to_string())
}

fn short_name(name: &str) -> String {
    if name.chars().count() <= MAX_REQUEST_NAME_CHARS {
        return name.to_string();
    }
    let mut short: String = name.chars().take(MAX_REQUEST_NAME_CHARS - 1).collect();
    short.push('…');
    short
}

fn request_warning(request_path: String, method: &str, reason: &str) -> ImportWarning {
    ImportWarning {
        request_path,
        phase: "request".into(),
        line: None,
        api: method.to_string(),
        reason: reason.into(),
    }
}

fn invalid(message: &str) -> CollectionImportError {
    CollectionImportError::Invalid(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_collection;
    use alcy_domain::HttpMethod;
    use serde_json::json;

    fn har(entries: Value) -> String {
        json!({
            "log": {
                "version": "1.2",
                "creator": {"name": "Browser", "version": "1"},
                "entries": entries,
            }
        })
        .to_string()
    }

    fn entry(request: Value) -> Value {
        json!({
            "startedDateTime": "2026-10-15T10:00:00.000Z",
            "time": 12,
            "request": request,
            "response": {"status": 200, "content": {"size": 2, "mimeType": "application/json", "text": "{}"}},
        })
    }

    fn get(url: &str) -> Value {
        entry(
            json!({"method": "GET", "url": url, "httpVersion": "HTTP/1.1", "headers": [], "queryString": [], "cookies": []}),
        )
    }

    fn only_request(raw: &str) -> SavedRequest {
        let imported = parse_collection(raw).unwrap();
        let requests = imported.collections[0].requests();
        assert_eq!(requests.len(), 1);
        requests[0].clone()
    }

    fn header_pairs(request: &SavedRequest) -> Vec<(String, String)> {
        request
            .request
            .headers
            .iter()
            .map(|header| (header.name().to_string(), header.value().to_string()))
            .collect()
    }

    #[test]
    fn detects_a_har_by_its_log_object() {
        assert!(is_har(&json!({"log": {"entries": []}})));
        assert!(is_har(&json!({"log": {"version": "1.2"}})));
        assert!(is_har(&json!({"log": {"creator": {"name": "x"}}})));
        assert!(!is_har(&json!({"log": "text"})));
        assert!(!is_har(&json!({"log": {"level": "debug"}})));
        assert!(!is_har(&json!({"info": {}, "item": []})));
    }

    #[test]
    fn imports_a_minimal_har_as_a_flat_collection_named_after_the_host() {
        let imported =
            parse_collection(&har(json!([get("https://api.example.com/users?page=2")]))).unwrap();

        assert_eq!(imported.format, Some(ImportFormat::Har));
        assert_eq!(imported.source_kind, None);
        assert!(imported.docs.is_none());
        assert!(imported.warnings.is_empty());
        let collection = &imported.collections[0];
        assert_eq!(collection.name(), "api.example.com");
        assert!(collection.folders().is_empty());
        let request = &collection.requests()[0];
        assert_eq!(request.name(), "GET /users");
        assert_eq!(request.request.method, HttpMethod::Get);
        assert_eq!(
            request.request.endpoint.url(),
            "https://api.example.com/users?page=2"
        );
        assert_eq!(request.request.body_payload, BodyPayload::None);
    }

    #[test]
    fn names_the_collection_after_the_page_title_or_its_host() {
        let named = |title: &str| {
            let raw = json!({"log": {"pages": [{"id": "page_1", "title": title}], "entries": [get("https://a.test/")]}});
            parse_collection(&raw.to_string()).unwrap().collections[0]
                .name()
                .to_string()
        };
        assert_eq!(named("Checkout"), "Checkout");
        assert_eq!(named("https://shop.example.com/cart"), "shop.example.com");
        assert_eq!(named("  "), "a.test");
    }

    #[test]
    fn groups_requests_by_host_when_the_archive_spans_several_hosts() {
        let imported = parse_collection(&har(json!([
            get("https://api.example.com/users"),
            get("https://cdn.example.com/app.js"),
            get("https://api.example.com/users"),
            get("http://localhost:3000/health"),
        ])))
        .unwrap();

        let collection = &imported.collections[0];
        assert_eq!(collection.name(), "Imported Collection");
        assert!(collection.requests().is_empty());
        let folders: Vec<(&str, Vec<&str>)> = collection
            .folders()
            .iter()
            .map(|folder| {
                (
                    folder.name(),
                    folder.requests().iter().map(SavedRequest::name).collect(),
                )
            })
            .collect();
        assert_eq!(
            folders,
            vec![
                ("api.example.com", vec!["GET /users", "GET /users (2)"]),
                ("cdn.example.com", vec!["GET /app.js"]),
                ("localhost:3000", vec!["GET /health"]),
            ]
        );
    }

    #[test]
    fn drops_pseudo_headers_and_headers_the_client_computes() {
        let request = only_request(&har(json!([entry(json!({
            "method": "post",
            "url": "https://api.example.com/items",
            "headers": [
                {"name": ":authority", "value": "api.example.com"},
                {"name": ":method", "value": "POST"},
                {"name": "Host", "value": "api.example.com"},
                {"name": "content-length", "value": "13"},
                {"name": "Accept-Encoding", "value": "gzip, br, zstd"},
                {"name": "Connection", "value": "keep-alive"},
                {"name": "authorization", "value": "Bearer secret"},
                {"name": "accept", "value": "application/json"},
            ],
            "postData": {"mimeType": "application/json", "text": "{\"name\":\"a\"}"},
        }))])));

        assert_eq!(request.request.method, HttpMethod::Post);
        assert_eq!(
            header_pairs(&request),
            vec![
                ("authorization".to_string(), "Bearer secret".to_string()),
                ("accept".to_string(), "application/json".to_string()),
                ("Content-Type".to_string(), "application/json".to_string()),
            ]
        );
    }

    #[test]
    fn adds_a_cookie_header_only_when_the_request_has_none() {
        let with_cookies = |headers: Value| {
            only_request(&har(json!([entry(json!({
                "method": "GET",
                "url": "https://a.test/",
                "headers": headers,
                "cookies": [{"name": "sid", "value": "1"}, {"name": "theme", "value": "dark"}],
            }))])))
        };

        assert_eq!(
            header_pairs(&with_cookies(json!([]))),
            vec![("Cookie".to_string(), "sid=1; theme=dark".to_string())]
        );
        assert_eq!(
            header_pairs(&with_cookies(json!([{"name": "cookie", "value": "sid=1"}]))),
            vec![("cookie".to_string(), "sid=1".to_string())]
        );
    }

    #[test]
    fn uses_the_query_string_list_only_when_the_url_has_no_query() {
        let request = only_request(&har(json!([entry(json!({
            "method": "GET",
            "url": "https://a.test/search",
            "queryString": [{"name": "q", "value": "rust"}, {"name": "page", "value": "1"}],
        }))])));
        assert_eq!(
            request.request.endpoint.url(),
            "https://a.test/search?q=rust&page=1"
        );

        let request = only_request(&har(json!([entry(json!({
            "method": "GET",
            "url": "https://a.test/search?q=rust",
            "queryString": [{"name": "q", "value": "rust"}],
        }))])));
        assert_eq!(
            request.request.endpoint.url(),
            "https://a.test/search?q=rust"
        );
    }

    #[test]
    fn maps_a_json_body_with_its_content_type() {
        let request = only_request(&har(json!([entry(json!({
            "method": "PUT",
            "url": "https://a.test/items/1",
            "headers": [{"name": "content-type", "value": "application/vnd.api+json"}],
            "postData": {"mimeType": "application/vnd.api+json", "text": "{\"id\":1}"},
        }))])));

        assert_eq!(request.request.document.body, "{\"id\":1}");
        assert_eq!(
            request.request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );
        assert_eq!(
            header_pairs(&request),
            vec![(
                "content-type".to_string(),
                "application/vnd.api+json".to_string()
            )]
        );
    }

    #[test]
    fn maps_a_text_body_and_guesses_json_without_a_mime_type() {
        let text = only_request(&har(json!([entry(json!({
            "method": "POST",
            "url": "https://a.test/log",
            "postData": {"mimeType": "text/plain;charset=UTF-8", "text": "hello"},
        }))])));
        assert_eq!(text.request.document.body, "hello");
        assert_eq!(
            text.request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Text
            }
        );
        assert_eq!(
            header_pairs(&text),
            vec![(
                "Content-Type".to_string(),
                "text/plain;charset=UTF-8".to_string()
            )]
        );

        let untyped = only_request(&har(json!([entry(json!({
            "method": "POST",
            "url": "https://a.test/log",
            "postData": {"text": "[1, 2]"},
        }))])));
        assert_eq!(
            untyped.request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );
        assert!(header_pairs(&untyped).is_empty());
    }

    #[test]
    fn maps_an_urlencoded_body_from_its_text_or_params() {
        let from_text = only_request(&har(json!([entry(json!({
            "method": "POST",
            "url": "https://a.test/login",
            "headers": [{"name": "Content-Type", "value": "application/x-www-form-urlencoded"}],
            "postData": {
                "mimeType": "application/x-www-form-urlencoded",
                "text": "user=ana&note=hello+world%21",
                "params": [{"name": "ignored", "value": "x"}],
            },
        }))])));
        assert_eq!(
            from_text.request.body_payload,
            BodyPayload::UrlEncoded(vec![
                UrlEncodedField {
                    name: "user".into(),
                    value: "ana".into(),
                    enabled: true
                },
                UrlEncodedField {
                    name: "note".into(),
                    value: "hello world!".into(),
                    enabled: true
                },
            ])
        );
        assert_eq!(header_pairs(&from_text).len(), 1);

        let from_params = only_request(&har(json!([entry(json!({
            "method": "POST",
            "url": "https://a.test/login",
            "postData": {
                "mimeType": "application/x-www-form-urlencoded",
                "params": [{"name": "user", "value": "ana"}],
            },
        }))])));
        assert_eq!(
            from_params.request.body_payload,
            BodyPayload::UrlEncoded(vec![UrlEncodedField {
                name: "user".into(),
                value: "ana".into(),
                enabled: true,
            }])
        );
        assert_eq!(
            header_pairs(&from_params),
            vec![(
                "Content-Type".to_string(),
                "application/x-www-form-urlencoded".to_string()
            )]
        );
    }

    #[test]
    fn maps_multipart_params_and_warns_about_files() {
        let imported = parse_collection(&har(json!([entry(json!({
            "method": "POST",
            "url": "https://a.test/upload",
            "headers": [{"name": "Content-Type", "value": "multipart/form-data; boundary=----x"}],
            "postData": {
                "mimeType": "multipart/form-data; boundary=----x",
                "params": [
                    {"name": "title", "value": "Report"},
                    {"name": "file", "fileName": "report.pdf", "contentType": "application/pdf"},
                ],
            },
        }))])))
        .unwrap();

        let request = &imported.collections[0].requests()[0];
        assert_eq!(
            request.request.body_payload,
            BodyPayload::FormData(vec![FormDataField {
                name: "title".into(),
                enabled: true,
                value: FormDataFieldValue::Text("Report".into()),
            }])
        );
        assert!(header_pairs(request).is_empty());
        assert_eq!(
            imported.warnings,
            vec![ImportWarning {
                request_path: "POST /upload".into(),
                phase: "body".into(),
                line: None,
                api: "file".into(),
                reason: "skippedFile".into(),
            }]
        );
    }

    #[test]
    fn parses_a_recorded_multipart_text_when_there_are_no_params() {
        let text = "------b\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nReport\r\n\
                    ------b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n\r\n\
                    ------b--\r\n";
        let imported = parse_collection(&har(json!([entry(json!({
            "method": "POST",
            "url": "https://a.test/upload",
            "postData": {"mimeType": "multipart/form-data; boundary=----b", "text": text},
        }))])))
        .unwrap();

        assert_eq!(
            imported.collections[0].requests()[0].request.body_payload,
            BodyPayload::FormData(vec![FormDataField {
                name: "title".into(),
                enabled: true,
                value: FormDataFieldValue::Text("Report".into()),
            }])
        );
        assert_eq!(imported.warnings.len(), 1);
        assert_eq!(imported.warnings[0].reason, "skippedFile");
    }

    #[test]
    fn keeps_an_unparseable_multipart_text_as_a_raw_body() {
        let request = only_request(&har(json!([entry(json!({
            "method": "POST",
            "url": "https://a.test/upload",
            "postData": {"mimeType": "multipart/form-data", "text": "opaque"},
        }))])));

        assert_eq!(request.request.document.body, "opaque");
        assert_eq!(
            request.request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Text
            }
        );
        assert_eq!(
            header_pairs(&request),
            vec![(
                "Content-Type".to_string(),
                "multipart/form-data".to_string()
            )]
        );
    }

    #[test]
    fn skips_entries_that_cannot_become_requests_with_warnings() {
        let imported = parse_collection(&har(json!([
            get("https://a.test/ok"),
            entry(json!({"method": "PROPFIND", "url": "https://a.test/dav"})),
            entry(json!({"method": "GET"})),
            json!("not an entry"),
        ])))
        .unwrap();

        assert_eq!(imported.collections[0].requests().len(), 1);
        let reasons: Vec<(&str, &str, &str)> = imported
            .warnings
            .iter()
            .map(|warning| {
                (
                    warning.request_path.as_str(),
                    warning.api.as_str(),
                    warning.reason.as_str(),
                )
            })
            .collect();
        assert_eq!(
            reasons,
            vec![
                ("entries[1]", "PROPFIND", "unsupportedMethod"),
                ("entries[2]", "GET", "invalidEntry"),
                ("entries[3]", "", "invalidEntry"),
            ]
        );
    }

    #[test]
    fn a_mime_type_with_line_breaks_still_imports_the_entry() {
        let imported = parse_collection(&har(json!([
            entry(json!({
                "method": "POST",
                "url": "https://a.test/broken",
                "headers": [],
                "postData": {"mimeType": "application/json\r\nX-Injected: 1", "text": "{}"},
            })),
            get("https://a.test/ok"),
        ])))
        .unwrap();

        let requests = imported.collections[0].requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            header_pairs(&requests[0]),
            vec![(
                "Content-Type".to_string(),
                "application/json X-Injected: 1".to_string()
            )]
        );
        assert!(imported.warnings.is_empty());
    }

    #[test]
    fn rejects_malformed_archives_with_structured_errors() {
        let invalid = |raw: Value| parse_collection(&raw.to_string()).unwrap_err();

        assert!(matches!(
            invalid(json!({"log": {"version": "1.2", "entries": {}}})),
            CollectionImportError::Invalid(_)
        ));
        assert!(matches!(
            invalid(json!({"log": {"version": "1.2", "creator": {}}})),
            CollectionImportError::Invalid(_)
        ));
        assert!(matches!(
            invalid(json!({"log": {"entries": []}})),
            CollectionImportError::Invalid(_)
        ));
        assert!(matches!(
            invalid(json!({"log": {"entries": [1, {"request": "x"}]}})),
            CollectionImportError::Invalid(_)
        ));
        assert_eq!(
            invalid(json!({"log": {"version": "2.0", "entries": [get("https://a.test/")]}})),
            CollectionImportError::UnsupportedVersion("HAR 2.0".into())
        );
    }

    #[test]
    fn shortens_long_request_names() {
        let path = "segment/".repeat(30);
        let request = only_request(&har(json!([get(&format!("https://a.test/{path}"))])));

        assert_eq!(request.name().chars().count(), MAX_REQUEST_NAME_CHARS);
        assert!(request.name().starts_with("GET /segment/"));
        assert!(request.name().ends_with('…'));
    }

    #[test]
    fn imports_a_large_archive_and_ignores_response_bodies() {
        let response_body = "x".repeat(4 * 1024);
        let entries: Vec<Value> = (0..3_000)
            .map(|index| {
                json!({
                    "request": {
                        "method": "GET",
                        "url": format!("https://host{}.test/items/{index}", index % 3),
                        "headers": [{"name": "accept", "value": "*/*"}],
                    },
                    "response": {"status": 200, "content": {"text": response_body}},
                })
            })
            .collect();

        let imported = parse_collection(&har(Value::Array(entries))).unwrap();

        let folders = imported.collections[0].folders();
        assert_eq!(folders.len(), 3);
        assert_eq!(
            folders
                .iter()
                .map(|folder| folder.requests().len())
                .sum::<usize>(),
            3_000
        );
        assert!(imported.warnings.is_empty());
    }
}
