//! Thin IPC adapters for bounded flow output inspection.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use alcy_app::{FlowOutputPage, content_hash, inspect_flow_output};
use alcy_storage::{
    FlowRunHistoryStore, archived_flow_body_path, flow_body_directory, read_archived_flow_body,
};
use serde::{Deserialize, Serialize};

use super::execute_graphql_request::{ResponseBodyEncodingOutput, ResponseHeaderOutput};
use super::flow_run_outputs::{FlowNodeOutput, FlowRunOutputs, RequestLineOutput};

#[derive(Default)]
pub struct FlowOutputQueries(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl FlowOutputQueries {
    pub(crate) fn begin(&self, query_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut active = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if query_id.is_empty() || query_id.len() > 128 {
            return Err("invalidQuery".into());
        }
        if active.len() >= 4 || active.contains_key(query_id) {
            return Err("busy".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(query_id.into(), cancelled.clone());
        Ok(cancelled)
    }

    pub(crate) fn finish(&self, query_id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(query_id);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectFlowOutputInput {
    root_path: String,
    flow_execution_id: String,
    node_id: String,
    query_id: String,
    revision: Option<String>,
    #[serde(default)]
    pointer: String,
    cursor: Option<String>,
    #[serde(default)]
    query: String,
    #[serde(default)]
    text: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowOutputInspection {
    output: FlowNodeOutput,
    availability: String,
    revision: String,
    page: Option<FlowOutputPage>,
    text: Option<String>,
    next_cursor: Option<String>,
}

#[tauri::command]
pub fn cancel_flow_output_query(query_id: String, queries: tauri::State<'_, FlowOutputQueries>) {
    if let Some(cancelled) = queries
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&query_id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn inspect_flow_node_output(
    input: InspectFlowOutputInput,
    outputs: tauri::State<'_, FlowRunOutputs>,
    queries: tauri::State<'_, FlowOutputQueries>,
) -> Result<FlowOutputInspection, String> {
    if input.query_id.is_empty()
        || input.query_id.len() > 128
        || input.node_id.len() > 4096
        || input.pointer.len() > 4096
        || input.query.len() > 256
        || input.root_path.len() > 4096
        || input
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > 128)
    {
        return Err("invalidQuery".into());
    }
    let cancelled = queries.begin(&input.query_id)?;
    let query_id = input.query_id.clone();
    let (live_output, cache_revision) = outputs.snapshot(&input.flow_execution_id, &input.node_id);
    let archive = outputs.archive(&input.flow_execution_id);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = inspect_inner(input, live_output, archive, &cancelled)?;
        if cache_revision.is_some_and(|revision| revision.to_string() != result.revision) {
            return Err("staleRevision".into());
        }
        Ok(result)
    })
    .await
    .map_err(|_| "unavailable".to_string())
    .and_then(|result| result);
    queries.finish(&query_id);
    result
}

fn inspect_inner(
    input: InspectFlowOutputInput,
    live_output: Option<FlowNodeOutput>,
    archive: Option<alcy_storage::FlowBodyCapture>,
    cancelled: &AtomicBool,
) -> Result<FlowOutputInspection, String> {
    let root = Path::new(&input.root_path);
    let directory = archive
        .as_ref()
        .map(|archive| archive.directory())
        .or_else(|| flow_body_directory(root, &input.flow_execution_id))
        .ok_or("invalidQuery")?;
    let metadata = archive
        .as_ref()
        .and_then(|archive| archive.metadata(&input.node_id))
        .or_else(|| read_archived_flow_body(&directory, &input.node_id));
    let mut output = if let Some(output) = live_output {
        output
    } else {
        let record = FlowRunHistoryStore::new(root.to_path_buf(), Duration::from_secs(7 * 86400))
            .load_record(&input.flow_execution_id)
            .map_err(|_| "unavailable")?
            .ok_or("unavailable")?;
        let output = record
            .outputs
            .into_iter()
            .find(|output| output.node_id == input.node_id)
            .ok_or("unavailable")?;
        FlowNodeOutput {
            status_code: output.status_code,
            duration_ms: output.duration_ms,
            size_bytes: output.size_bytes,
            headers: output
                .headers
                .into_iter()
                .map(|(name, value)| ResponseHeaderOutput { name, value })
                .collect(),
            body: output.body,
            body_encoding: if output.base64 {
                ResponseBodyEncodingOutput::Base64
            } else {
                ResponseBodyEncodingOutput::Text
            },
            truncated: output.truncated,
            request: output.request.map(|line| RequestLineOutput {
                method: line.method,
                path: line.path,
            }),
        }
    };
    let revision = metadata
        .as_ref()
        .map_or_else(|| "legacy".to_string(), |entry| entry.revision.to_string());
    if input
        .revision
        .as_ref()
        .is_some_and(|expected| expected != &revision)
    {
        return Err("staleRevision".into());
    }
    let availability = metadata.as_ref().map_or_else(
        || {
            if output.truncated {
                "preview"
            } else {
                "available"
            }
            .to_string()
        },
        |entry| entry.availability.clone(),
    );
    let signature = content_hash(
        format!(
            "{}:{}:{}:{}:{}:{}",
            input.flow_execution_id,
            input.node_id,
            revision,
            input.pointer,
            input.query,
            input.text
        )
        .as_bytes(),
    );
    let offset = match &input.cursor {
        Some(cursor) => {
            let (hash, offset) = cursor.split_once(':').ok_or("invalidCursor")?;
            if hash != signature {
                return Err("invalidCursor".into());
            }
            offset.parse::<usize>().map_err(|_| "invalidCursor")?
        }
        None => 0,
    };
    let preview_body = std::mem::take(&mut output.body);
    // Metadata is bounded separately from the body pages.
    output.headers.truncate(50);
    for header in &mut output.headers {
        truncate_utf8(&mut header.name, 256);
        truncate_utf8(&mut header.value, 256);
    }
    while serde_json::to_vec(&output.headers)
        .map_err(|_| "unavailable")?
        .len()
        > 8192
    {
        output.headers.pop();
    }
    if let Some(request) = &mut output.request {
        truncate_utf8(&mut request.method, 32);
        truncate_utf8(&mut request.path, 512);
    }
    let mut result = FlowOutputInspection {
        output,
        availability,
        revision,
        page: None,
        text: None,
        next_cursor: None,
    };
    if result.availability == "pending" {
        return Ok(result);
    }
    if result.output.body_encoding == ResponseBodyEncodingOutput::Base64 {
        return Ok(result);
    }
    let path = archived_flow_body_path(&directory, &input.node_id);
    let file = if metadata.is_some() && result.availability == "available" {
        match File::open(&path)
            .and_then(|file| file.metadata().map(|metadata| (file, metadata.len())))
        {
            Ok((file, length)) if length <= alcy_storage::MAX_FLOW_BODY_BYTES as u64 => Some(file),
            Ok(_) => {
                result.availability = "limit".into();
                None
            }
            Err(_) => {
                result.availability = "unavailable".into();
                None
            }
        }
    } else {
        None
    };
    if input.text {
        let mut reader: Box<dyn ReadSeek> = match file {
            Some(file) => Box::new(file),
            None => Box::new(std::io::Cursor::new(preview_body.into_bytes())),
        };
        let (text, total) = if input.pointer.is_empty() {
            let total = reader.seek(SeekFrom::End(0)).map_err(|_| "unavailable")?;
            reader
                .seek(SeekFrom::Start(offset.min(total as usize) as u64))
                .map_err(|_| "unavailable")?;
            let mut bytes = vec![0; 64 * 1024];
            let count = reader.read(&mut bytes).map_err(|_| "unavailable")?;
            bytes.truncate(count);
            while std::str::from_utf8(&bytes).is_err()
                && bytes.len() + 4 > count
                && !bytes.is_empty()
            {
                bytes.pop();
            }
            (String::from_utf8_lossy(&bytes).into_owned(), total as usize)
        } else {
            let page = alcy_app::read_flow_output_value(
                std::io::BufReader::new(reader),
                &input.pointer,
                offset,
                cancelled,
            )?;
            let total = if page.kind == "string" {
                page.total
            } else {
                page.preview.len()
            };
            (page.preview, total)
        };
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        result.text = Some(text);
        while serde_json::to_vec(&result)
            .map_err(|_| "unavailable")?
            .len()
            > 63 * 1024
        {
            if let Some(text) = result.text.as_mut() {
                truncate_utf8(text, text.len() * 3 / 4);
            }
        }
        let next = offset.saturating_add(result.text.as_ref().map_or(0, String::len));
        if next < total {
            result.next_cursor = Some(format!("{signature}:{next}"));
        }
    } else {
        let reader: Box<dyn Read + Send> = match file {
            Some(file) => Box::new(file),
            None => Box::new(std::io::Cursor::new(preview_body.into_bytes())),
        };
        let page = inspect_flow_output(
            std::io::BufReader::new(reader),
            &input.pointer,
            offset,
            &input.query,
            cancelled,
        )?;
        result.next_cursor = page.next_offset.map(|next| format!("{signature}:{next}"));
        result.page = Some(page);
    }
    if archive
        .as_ref()
        .and_then(|capture| capture.metadata(&input.node_id))
        .is_some_and(|entry| entry.revision.to_string() != result.revision)
    {
        return Err("staleRevision".into());
    }
    Ok(result)
}

trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

fn truncate_utf8(value: &mut String, limit: usize) {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> InspectFlowOutputInput {
        InspectFlowOutputInput {
            root_path: "/unused".into(),
            flow_execution_id: "run-1".into(),
            node_id: "response".into(),
            query_id: "query-1".into(),
            revision: None,
            pointer: String::new(),
            cursor: None,
            query: String::new(),
            text: false,
        }
    }

    fn output(body: &str) -> FlowNodeOutput {
        FlowNodeOutput {
            status_code: 200,
            duration_ms: 1,
            size_bytes: body.len(),
            headers: Vec::new(),
            body: body.into(),
            body_encoding: ResponseBodyEncodingOutput::Text,
            truncated: false,
            request: None,
        }
    }

    #[test]
    fn archive_pages_go_beyond_the_legacy_preview_and_reject_foreign_cursors() {
        let body = format!(
            "[{}]",
            (0..100_000)
                .map(|index| index.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let capture = alcy_storage::FlowBodyCapture::new();
        capture.capture("response", &body, false);
        capture.finish(None);
        let cancelled = AtomicBool::new(false);
        let first = inspect_inner(
            input(),
            Some(output("[")),
            Some(capture.clone()),
            &cancelled,
        )
        .unwrap();
        assert_eq!(first.page.as_ref().unwrap().total, 100_000);
        assert!(first.output.body.is_empty());
        let mut next = input();
        next.cursor = first.next_cursor;
        let second =
            inspect_inner(next, Some(output("[")), Some(capture.clone()), &cancelled).unwrap();
        assert_eq!(second.page.unwrap().entries[0].preview, "100");
        let mut invalid = input();
        invalid.cursor = Some("other:100".into());
        assert_eq!(
            inspect_inner(invalid, Some(output("[]")), Some(capture), &cancelled)
                .err()
                .as_deref(),
            Some("invalidCursor")
        );
    }

    #[test]
    fn text_windows_preserve_unicode_and_bound_the_serialized_ipc_payload() {
        let body = "\u{0001}🦀".repeat(100_000);
        let mut request = input();
        request.text = true;
        let cancelled = AtomicBool::new(false);
        let mut reconstructed = String::new();
        loop {
            let page = inspect_inner(request, Some(output(&body)), None, &cancelled).unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= 64 * 1024);
            reconstructed.push_str(page.text.as_deref().unwrap());
            let Some(cursor) = page.next_cursor else {
                break;
            };
            request = input();
            request.text = true;
            request.cursor = Some(cursor);
        }
        assert_eq!(reconstructed, body);
    }

    #[test]
    fn long_scalar_fields_can_be_read_in_windows_without_their_siblings() {
        let value = "界".repeat(100_000);
        let body = format!("{{\"value\":\"{value}\",\"other\":[1,2,3]}}");
        let mut request = input();
        request.text = true;
        request.pointer = "/value".into();
        let page =
            inspect_inner(request, Some(output(&body)), None, &AtomicBool::new(false)).unwrap();
        assert!(value.starts_with(page.text.as_deref().unwrap()));
        assert!(page.next_cursor.is_some());
        assert!(serde_json::to_vec(&page).unwrap().len() <= 64 * 1024);
    }

    #[test]
    fn a_missing_archive_keeps_the_legacy_preview_available() {
        let capture = alcy_storage::FlowBodyCapture::new();
        capture.capture("response", "full response", false);
        capture.finish(None);
        std::fs::remove_file(archived_flow_body_path(&capture.directory(), "response")).unwrap();
        let mut request = input();
        request.text = true;
        let page = inspect_inner(
            request,
            Some(output("preview")),
            Some(capture),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(page.availability, "unavailable");
        assert_eq!(page.text.as_deref(), Some("preview"));
    }
}
