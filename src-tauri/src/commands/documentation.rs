//! Typed native adapter for workspace documents and selected historical sources.
use super::agent::{AgentPaths, AgentRuns};
use alcy_app::{
    DocumentResult, DocumentSource, DocumentationError, document_invalid, redact_document_value,
};
use alcy_domain::{Authentication, HistoryOutcome};
use alcy_storage::{AgentSessionStore, DocumentationStore, HistoryStore};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};
use tauri::State;

#[derive(Default)]
pub struct DocumentationState {
    gate: Arc<Mutex<()>>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    uploads: Mutex<HashMap<String, Upload>>,
}
struct Upload {
    root: String,
    document: String,
    revision: u64,
    caption: String,
    title: String,
    operation: String,
    bytes: Vec<u8>,
    updated: SystemTime,
}

pub use alcy_app::DocumentationInput;
fn fail(error: impl std::fmt::Display) -> DocumentationError {
    DocumentationError::Storage(error.to_string())
}
#[tauri::command]
pub fn cancel_documentation_job(job_id: String, state: State<'_, DocumentationState>) {
    if let Ok(jobs) = state.jobs.lock() {
        if let Some(job) = jobs.get(&job_id) {
            job.store(true, Ordering::Relaxed);
        }
    }
    if let Ok(mut uploads) = state.uploads.lock() {
        uploads.remove(&job_id);
    }
}

#[tauri::command]
pub async fn documentation(
    input: DocumentationInput,
    state: State<'_, DocumentationState>,
    paths: State<'_, AgentPaths>,
    runs: State<'_, AgentRuns>,
    local_secrets: State<'_, alcy_storage::LocalSecrets>,
) -> DocumentResult<Value> {
    let live = if matches!(
        input.operation.as_str(),
        "readSource" | "sources" | "selectSources" | "requestImage"
    ) {
        runs.document_transcripts
            .lock()
            .map_err(fail)?
            .iter()
            .filter(|(_, (root, _))| *root == input.root_path)
            .map(|(id, (_, messages))| (id.clone(), messages.clone()))
            .collect()
    } else {
        HashMap::new()
    };
    let mut uploaded = None;
    if matches!(input.operation.as_str(), "imageChunk" | "contentChunk") {
        if input.bytes.len() > 64 * 1024 || input.job_id.is_empty() {
            return Err(document_invalid("Invalid image chunk."));
        }
        let mut uploads = state.uploads.lock().map_err(fail)?;
        uploads.retain(|_, upload| {
            upload.updated.elapsed().unwrap_or_default() < Duration::from_secs(120)
        });
        if !uploads.contains_key(&input.job_id) && (uploads.len() >= 2 || input.offset != 0) {
            return Err(document_invalid("Image upload is unavailable; retry."));
        }
        let upload = uploads
            .entry(input.job_id.clone())
            .or_insert_with(|| Upload {
                root: input.root_path.clone(),
                document: input.document_id.clone(),
                revision: input.revision,
                caption: input.caption.clone(),
                title: input.title.clone(),
                operation: input.operation.clone(),
                bytes: vec![],
                updated: SystemTime::now(),
            });
        let limit = if input.operation == "contentChunk" {
            alcy_domain::MAX_DOCUMENT_BYTES
        } else {
            alcy_domain::MAX_DOCUMENT_ASSET_BYTES
        };
        if upload.root != input.root_path
            || upload.document != input.document_id
            || upload.revision != input.revision
            || upload.caption != input.caption
            || upload.title != input.title
            || upload.operation != input.operation
            || upload.bytes.len() != input.offset
            || upload.bytes.len() + input.bytes.len() > limit
        {
            return Err(document_invalid("Invalid upload cursor."));
        }
        upload.bytes.extend_from_slice(&input.bytes);
        upload.updated = SystemTime::now();
        if !input.final_chunk {
            return Ok(json!({"offset": upload.bytes.len()}));
        }
        uploaded = uploads.remove(&input.job_id).map(|u| u.bytes);
    }
    let cancellation = Arc::new(AtomicBool::new(false));
    if !input.job_id.is_empty() {
        state
            .jobs
            .lock()
            .map_err(fail)?
            .insert(input.job_id.clone(), cancellation.clone());
    }
    let job_id = input.job_id.clone();
    let gate = state.gate.clone();
    let sessions = paths.sessions.clone();
    let secret_store = local_secrets.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().map_err(fail)?;
        if cancellation.load(Ordering::Relaxed) {
            return Err(DocumentationError::Cancelled);
        }
        execute(input, sessions, live, uploaded, &cancellation, secret_store)
    })
    .await
    .map_err(fail)?;
    state.jobs.lock().map_err(fail)?.remove(&job_id);
    result
}

struct NativeDocumentSources {
    root: String,
    sessions: PathBuf,
    live: HashMap<String, Vec<alcy_app::AgentMessage>>,
    redaction: Vec<String>,
}
impl alcy_app::DocumentationSources for NativeDocumentSources {
    fn list(&self) -> DocumentResult<Vec<DocumentSource>> {
        let mut choices = AgentSessionStore::new(self.sessions.clone())
            .list(&self.root)
            .map_err(fail)?
            .into_iter()
            .map(|s| DocumentSource {
                kind: "chat".into(),
                id: s.id,
                label: s.title,
                at_ms: Some(s.updated_at_ms),
            })
            .collect::<Vec<_>>();
        for session in self.live.keys() {
            if !choices.iter().any(|s| s.id == *session) {
                choices.insert(
                    0,
                    DocumentSource {
                        kind: "chat".into(),
                        id: session.clone(),
                        label: "Current conversation".into(),
                        at_ms: None,
                    },
                );
            }
        }
        for entry in HistoryStore::new(PathBuf::from(&self.root), Duration::from_secs(604800))
            .load_summaries()
            .map_err(fail)?
        {
            choices.push(DocumentSource {
                kind: "request".into(),
                id: entry.id,
                label: redact_url(&entry.endpoint),
                at_ms: Some(
                    entry
                        .executed_at
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                ),
            });
        }
        for source in &mut choices {
            source.label = self
                .redact_text(&source.label)
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .take(120)
                .collect();
        }
        Ok(choices)
    }
    fn read(&self, kind: &str, id: &str) -> DocumentResult<String> {
        let text = source_text(&self.root, &self.sessions, &self.live, kind, id)?;
        Ok(self.redact_text(&text))
    }
    fn redact_text(&self, text: &str) -> String {
        let mut value = json!({"text":text, "known":self.redaction.iter().map(|value| json!({"name":"password", "value":value})).collect::<Vec<_>>()});
        redact_document_value(&mut value);
        value["text"].as_str().unwrap_or_default().to_string()
    }
}
fn execute(
    input: DocumentationInput,
    sessions: PathBuf,
    live: HashMap<String, Vec<alcy_app::AgentMessage>>,
    uploaded: Option<Vec<u8>>,
    cancelled: &AtomicBool,
    secret_store: alcy_storage::LocalSecrets,
) -> DocumentResult<Value> {
    let store = DocumentationStore::new(PathBuf::from(&input.root_path));
    let needs_redaction = !matches!(
        input.operation.as_str(),
        "get" | "list" | "asset" | "delete" | "guide"
    );
    let redaction = if needs_redaction {
        let loaded =
            alcy_storage::EnvironmentStore::new(PathBuf::from(&input.root_path), secret_store)
                .load()
                .map_err(fail)?;
        loaded
            .snapshot
            .environments
            .iter()
            .flat_map(|environment| environment.variables())
            .filter(|variable| variable.sensitive)
            .map(|variable| variable.value().to_string())
            .collect()
    } else {
        vec![]
    };
    let sources = NativeDocumentSources {
        root: input.root_path.clone(),
        sessions,
        live,
        redaction,
    };
    alcy_app::execute_document_operation(&store, &sources, input, uploaded, cancelled)
}

fn source_text(
    root: &str,
    sessions: &std::path::Path,
    live: &HashMap<String, Vec<alcy_app::AgentMessage>>,
    kind: &str,
    id: &str,
) -> DocumentResult<String> {
    if !alcy_domain::valid_document_id(id) {
        return Err(document_invalid("Invalid source id."));
    }
    let mut value = if kind == "chat" {
        let stored;
        let messages = if let Some(messages) = live.get(id) {
            messages
        } else {
            stored = AgentSessionStore::new(sessions.to_path_buf())
                .load(root, id)
                .map_err(fail)?
                .ok_or(DocumentationError::NotFound)?;
            &stored.messages
        };
        json!(messages.iter().map(|m| json!({"role": if m.role == alcy_app::AgentRole::User { "user" } else { "assistant" }, "content":m.content.iter().map(|b| match b {
            alcy_app::ContentBlock::Text { text } => json!({"text":text}),
            alcy_app::ContentBlock::ToolUse { name, input, .. } => json!({"tool":name,"input":input}),
            alcy_app::ContentBlock::ToolResult { content, is_error, .. } => json!({"result":serde_json::from_str::<Value>(content).unwrap_or_else(|_| json!(content)),"isError":is_error}),
        }).collect::<Vec<_>>()})).collect::<Vec<_>>())
    } else if kind == "request" {
        let entry = HistoryStore::new(PathBuf::from(root), Duration::from_secs(604800))
            .load_entry(id)
            .map_err(|error| match error {
                alcy_storage::StorageError::NotFound(_) => DocumentationError::NotFound,
                _ => fail(error),
            })?
            .ok_or(DocumentationError::NotFound)?;
        let auth = match &entry.request.authentication {
            Authentication::Bearer { token } => json!({"token":token}),
            Authentication::Basic { username, password }
            | Authentication::Digest { username, password } => {
                json!({"username":username,"password":password})
            }
            Authentication::CustomHeader { name, value } => {
                json!({"name":name,"value":value,"sensitive":true})
            }
            Authentication::OAuth2ClientCredentials { client_secret, .. } => {
                json!({"clientSecret":client_secret})
            }
            _ => Value::Null,
        };
        let response = match entry.outcome {
            HistoryOutcome::Success(r) => {
                json!({"statusCode":r.status_code,"durationMs":r.duration_ms,"sizeBytes":r.size_bytes,"body":serde_json::from_str::<Value>(&r.body).unwrap_or_else(|_| json!(r.body)),"headers":r.headers.iter().map(|h| json!({"name":h.name,"value":h.value})).collect::<Vec<_>>(),"bodyTruncated":entry.response_body_truncated,"responseOmitted":entry.response_omitted})
            }
            HistoryOutcome::Failed { message, .. } => json!({"error":message}),
        };
        json!({"executedAtMs":entry.executed_at.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,"requestId":entry.request_id,"request":{"method":format!("{:?}",entry.request.method).to_uppercase(),"url":redact_url(entry.request.endpoint.url()),"body":serde_json::from_str::<Value>(&entry.request.document.body).unwrap_or_else(|_| json!(entry.request.document.body)),"variables":serde_json::from_str::<Value>(&entry.request.variables).unwrap_or_else(|_| json!(entry.request.variables)),"headers":entry.request.headers.iter().map(|h| json!({"name":h.name(),"value":h.value()})).collect::<Vec<_>>(),"authentication":auth},"response":response})
    } else {
        return Err(document_invalid("Unknown source kind."));
    };
    redact_document_value(&mut value);
    serde_json::to_string_pretty(&value).map_err(fail)
}

fn redact_url(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value) else {
        return value.to_string();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    let pairs = url
        .query_pairs()
        .map(|(name, value)| {
            let lower = name.to_lowercase();
            let secret = [
                "token",
                "password",
                "secret",
                "api_key",
                "api-key",
                "apikey",
                "authorization",
                "cookie",
            ]
            .iter()
            .any(|key| lower.contains(key));
            (
                name.into_owned(),
                if secret {
                    "••••".into()
                } else {
                    value.into_owned()
                },
            )
        })
        .collect::<Vec<_>>();
    if !pairs.is_empty() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_app::DocumentationSources;
    #[test]
    fn live_sources_include_unsaved_history_and_mask_known_values() {
        let source = NativeDocumentSources {
            root: "/missing-workspace".into(),
            sessions: PathBuf::from("/missing-sessions"),
            live: HashMap::from([(
                "live".into(),
                vec![
                    alcy_app::AgentMessage::user_text("Earlier message"),
                    alcy_app::AgentMessage::user_text(
                        "Latest unsaved message: example-sensitive-value",
                    ),
                ],
            )]),
            redaction: vec!["example-sensitive-value".into()],
        };
        let text = source.read("chat", "live").unwrap();
        assert!(text.contains("Earlier message"));
        assert!(text.contains("Latest unsaved message"));
        assert!(!text.contains("example-sensitive-value"));
        assert!(matches!(
            source.read("chat", "../live"),
            Err(DocumentationError::Invalid(_))
        ));
    }
    #[test]
    fn request_source_labels_remove_url_credentials() {
        let text = redact_url(
            "https://user:example-password@example.com/api?token=example-token&limit=10",
        );
        assert!(!text.contains("example-password"));
        assert!(!text.contains("example-token"));
        assert!(text.contains("limit=10"));
    }
}
