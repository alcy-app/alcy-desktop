//! Document orchestration independent of Tauri and concrete storage.
use crate::{
    DocumentEdit, DocumentResult, DocumentSource, DocumentationError, DocumentationRecord,
    DocumentationRepository, check_document_revision, create_document, document_invalid,
    document_text_page, update_document,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentationInput {
    pub root_path: String,
    pub operation: String,
    #[serde(default)]
    pub document_id: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub edit: DocumentEdit,
    #[serde(default)]
    pub sources: Vec<DocumentSource>,
    #[serde(default)]
    pub source_kind: String,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub asset_id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub job_id: String,
    #[serde(default)]
    pub bytes: Vec<u8>,
    #[serde(default)]
    pub final_chunk: bool,
}

pub trait DocumentationSources {
    fn list(&self) -> DocumentResult<Vec<DocumentSource>>;
    fn read(&self, kind: &str, id: &str) -> DocumentResult<String>;
    fn redact_text(&self, text: &str) -> String;
}
pub trait DocumentationWorkspace: DocumentationRepository {
    fn read_document_page(
        &self,
        id: &str,
        offset: usize,
    ) -> DocumentResult<(DocumentationRecord, crate::DocumentTextPage)>;
    fn read_asset_page(
        &self,
        id: &str,
        asset_id: &str,
        offset: usize,
    ) -> DocumentResult<(Vec<u8>, Option<usize>)>;
    fn snapshot_source(
        &self,
        id: &str,
        kind: &str,
        source_id: &str,
        text: &str,
    ) -> DocumentResult<()>;
    fn source_snapshot(&self, id: &str, kind: &str, source_id: &str) -> DocumentResult<String>;
    fn read_asset(&self, id: &str, asset_id: &str) -> DocumentResult<Vec<u8>>;
    fn add_image(
        &self,
        id: &str,
        caption: String,
        bytes: &[u8],
        expected: u64,
        cancelled: &AtomicBool,
    ) -> DocumentResult<DocumentationRecord>;
    fn import_document_image(
        &self,
        id: &str,
        caption: String,
        path: &str,
        expected: u64,
        cancelled: &AtomicBool,
    ) -> DocumentResult<DocumentationRecord>;
    fn export_document(
        &self,
        doc: &DocumentationRecord,
        path: &str,
        format: &str,
        cancelled: &AtomicBool,
    ) -> DocumentResult<()>;
}
fn fail(error: impl std::fmt::Display) -> DocumentationError {
    DocumentationError::Storage(error.to_string())
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn metadata(mut doc: DocumentationRecord) -> DocumentResult<Value> {
    doc.markdown.clear();
    serde_json::to_value(doc).map_err(fail)
}
pub fn execute_document_operation(
    store: &impl DocumentationWorkspace,
    sources: &impl DocumentationSources,
    mut input: DocumentationInput,
    uploaded: Option<Vec<u8>>,
    cancelled: &AtomicBool,
) -> DocumentResult<Value> {
    input.title = sources.redact_text(&input.title);
    input.caption = sources.redact_text(&input.caption);
    for text in [
        &mut input.edit.title,
        &mut input.edit.markdown,
        &mut input.edit.append,
        &mut input.edit.replacement,
    ]
    .into_iter()
    .flatten()
    {
        *text = sources.redact_text(text);
    }
    let id = &input.document_id;
    match input.operation.as_str() {
        "guide" => Ok(json!({"guide":crate::DOCUMENTATION_GUIDE})),
        "list" => {
            let query = input.query.to_lowercase();
            let docs = store
                .list()?
                .into_iter()
                .filter(|d| d.title.to_lowercase().contains(&query))
                .map(|mut d| {
                    d.sources.clear();
                    d.assets.clear();
                    d
                })
                .collect::<Vec<_>>();
            let next = input.offset.saturating_add(25);
            Ok(
                json!({"documents": docs.iter().skip(input.offset).take(25).collect::<Vec<_>>(), "nextOffset": (next < docs.len()).then_some(next)}),
            )
        }
        "create" => {
            if store.list()?.len() >= 200 {
                return Err(document_invalid(
                    "The workspace already contains 200 documents.",
                ));
            }
            metadata(create_document(store, id.clone(), input.title, now())?)
        }
        "get" => {
            let (doc, page) = store.read_document_page(id, input.offset)?;
            Ok(json!({"document": metadata(doc)?, "page": page}))
        }
        "update" => {
            let size = serde_json::to_vec(&input.edit).map_err(fail)?.len();
            if size > 64 * 1024 {
                return Err(document_invalid(
                    "Use bounded content chunks to save a document.",
                ));
            }
            metadata(update_document(
                store,
                id,
                input.revision,
                input.edit,
                now(),
            )?)
        }
        "contentChunk" => {
            let markdown = sources.redact_text(
                &String::from_utf8(uploaded.ok_or_else(|| document_invalid("Incomplete upload."))?)
                    .map_err(fail)?,
            );
            metadata(update_document(
                store,
                id,
                input.revision,
                DocumentEdit {
                    title: Some(input.title),
                    markdown: Some(markdown),
                    ..Default::default()
                },
                now(),
            )?)
        }
        "delete" => {
            check_document_revision(&store.load(id)?, input.revision)?;
            store.remove(id)?;
            Ok(Value::Null)
        }
        "sources" => {
            let query = input.query.to_lowercase();
            let mut choices = sources
                .list()?
                .into_iter()
                .map(|source| serde_json::to_value(source).map_err(fail))
                .collect::<DocumentResult<Vec<_>>>()?;
            choices.retain(|s| {
                s["label"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&query)
            });
            let next = input.offset.saturating_add(25);
            Ok(
                json!({"sources": choices.iter().skip(input.offset).take(25).collect::<Vec<_>>(), "nextOffset": (next < choices.len()).then_some(next)}),
            )
        }
        "selectSources" => {
            let mut doc = store.load(id)?;
            check_document_revision(&doc, input.revision)?;
            if input.sources.len() > 100 {
                return Err(document_invalid("Select at most 100 sources."));
            }
            let available = sources.list()?;
            let mut selected = Vec::new();
            for source in &input.sources {
                let canonical = available
                    .iter()
                    .find(|candidate| candidate.kind == source.kind && candidate.id == source.id)
                    .or_else(|| {
                        doc.sources.iter().find(|candidate| {
                            candidate.kind == source.kind && candidate.id == source.id
                        })
                    })
                    .ok_or(DocumentationError::NotFound)?;
                if !selected.contains(canonical) {
                    selected.push(canonical.clone());
                }
            }
            doc.sources = selected;
            doc.revision += 1;
            doc.updated_at_ms = now();
            store.write(&doc)?;
            metadata(doc)
        }
        "readSource" | "requestImage" => {
            let doc = store.load(id)?;
            if !doc
                .sources
                .iter()
                .any(|s| s.kind == input.source_kind && s.id == input.source_id)
            {
                return Err(document_invalid("Choose this source in Documents first."));
            }
            let snapshot_id = format!(
                "{}-{}",
                input.source_id,
                if input.operation == "requestImage" {
                    "image".to_string()
                } else {
                    input.offset.to_string()
                }
            );
            let text = sources.read(&input.source_kind, &input.source_id);
            if input.operation == "readSource" {
                return match text {
                    Ok(text) => {
                        let page = document_text_page(&text, input.offset)?;
                        let value = json!({"page":page, "fromSnapshot":false,"sourceRevision":crate::content_hash(text.as_bytes())});
                        store.snapshot_source(
                            id,
                            &input.source_kind,
                            &snapshot_id,
                            &serde_json::to_string(&value).map_err(fail)?,
                        )?;
                        Ok(value)
                    }
                    Err(DocumentationError::NotFound) => {
                        let snapshot =
                            store.source_snapshot(id, &input.source_kind, &snapshot_id)?;
                        let mut value: Value = serde_json::from_str(&snapshot).map_err(fail)?;
                        value["fromSnapshot"] = json!(true);
                        Ok(value)
                    }
                    Err(error) => Err(error),
                };
            }
            if input.operation == "requestImage" {
                if input.source_kind != "request" {
                    return Err(document_invalid("Choose a request execution."));
                }
                let value: Value = match text {
                    Ok(text) => serde_json::from_str(&text).map_err(fail)?,
                    Err(DocumentationError::NotFound) => serde_json::from_str(
                        &store.source_snapshot(id, &input.source_kind, &snapshot_id)?,
                    )
                    .map_err(fail)?,
                    Err(error) => return Err(error),
                };
                let value = project_request_image(value)?;
                store.snapshot_source(
                    id,
                    &input.source_kind,
                    &snapshot_id,
                    &serde_json::to_string(&value).map_err(fail)?,
                )?;
                Ok(value)
            } else {
                Err(document_invalid("Invalid source operation."))
            }
        }
        "importImage" => metadata(store.import_document_image(
            id,
            input.caption,
            &input.path,
            input.revision,
            cancelled,
        )?),
        "imageChunk" => metadata(store.add_image(
            id,
            input.caption,
            &uploaded.ok_or_else(|| document_invalid("Incomplete upload."))?,
            input.revision,
            cancelled,
        )?),
        "asset" => {
            let (bytes, next_offset) = store.read_asset_page(id, &input.asset_id, input.offset)?;
            Ok(json!({"bytes":bytes, "nextOffset":next_offset}))
        }
        "export" => {
            let mut doc = store.load(id)?;
            check_document_revision(&doc, input.revision)?;
            doc.markdown = sources.redact_text(&doc.markdown);
            store.export_document(&doc, &input.path, &input.format, cancelled)?;
            Ok(json!({"exported":true}))
        }
        _ => Err(document_invalid("Unknown documentation operation.")),
    }
}

/// Only the visible, bounded image content crosses IPC; source details stay native.
fn project_request_image(value: Value) -> DocumentResult<Value> {
    fn body(value: &Value) -> DocumentResult<String> {
        if value.is_null() {
            return Ok(String::new());
        }
        if let Some(text) = value.as_str() {
            return Ok(text.to_string());
        }
        serde_json::to_string_pretty(value).map_err(fail)
    }
    fn text(value: &Value, max: usize) -> String {
        value
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(max)
            .collect()
    }
    fn headers(value: &Value) -> Vec<Value> {
        value.as_array().into_iter().flatten().take(30).map(|header| json!({"name":text(&header["name"],64),"value":text(&header["value"],256)})).collect()
    }
    let request = &value["request"];
    let response = &value["response"];
    let mut request_body = body(&request["body"])?;
    let variables = &request["variables"];
    if !variables.is_null() && variables != &json!({}) && variables != &json!("") {
        request_body.push_str(&format!("\n\nVariables:\n{}", body(variables)?));
    }
    let response_body = body(&response["body"])?;
    Ok(json!({
        "request": {
            "method":text(&request["method"],32), "url":text(&request["url"],2048),
            "body":request_body.chars().take(8000).collect::<String>(), "headers":headers(&request["headers"]),
            "bodyTruncated":request_body.chars().count() > 8000 || request["bodyTruncated"].as_bool().unwrap_or(false)
        },
        "response": {
            "statusCode":response["statusCode"].as_u64(), "durationMs":response["durationMs"].as_u64(), "sizeBytes":response["sizeBytes"].as_u64(),
            "body":response_body.chars().take(8000).collect::<String>(), "headers":headers(&response["headers"]),
            "error":response["error"].as_str().map(|_| text(&response["error"],4000)),
            "responseOmitted":response["responseOmitted"].as_bool().unwrap_or(false),
            "bodyTruncated":response_body.chars().count() > 8000 || response["bodyTruncated"].as_bool().unwrap_or(false)
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_projection_bounds_bodies_variables_headers_and_errors() {
        let header =
            json!({"name":"a".repeat(2000),"value":"\t".repeat(10000),"unused":"x".repeat(10000)});
        let source = json!({"request":{"url":"x".repeat(20000),"body":"\0".repeat(100000),"variables":{"large":"x".repeat(1000000)},"authentication":{"token":"masked"},"headers":vec![header.clone();100]},"response":{"body":"\0".repeat(100000),"headers":vec![header;100],"error":"\0".repeat(10000)}});
        let projection = project_request_image(source).unwrap();
        assert!(serde_json::to_vec(&projection).unwrap().len() < 256 * 1024);
        assert!(projection["request"].get("variables").is_none());
        assert!(projection["request"].get("authentication").is_none());
        assert_eq!(projection["request"]["bodyTruncated"], true);
        assert_eq!(projection["response"]["bodyTruncated"], true);
    }
}
