use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use alcy_app::{AgentMessage, AgentRole, ContentBlock};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;
/// Ceiling of one chat file; a longer chat has to start over.
pub const MAX_AGENT_SESSION_BYTES: usize = 16 * 1024 * 1024;
/// Chats kept per workspace; saving beyond it removes the oldest.
pub const MAX_AGENT_SESSIONS: usize = 200;

/// A saved agent chat: its transcript, as the model saw it.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSessionRecord {
    pub id: String,
    pub title: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub provider_id: String,
    pub model: String,
    pub messages: Vec<AgentMessage>,
    /// Summary that replaces `messages[..summarized_until]` in requests (spec 0135).
    pub summary: Option<String>,
    pub summarized_until: usize,
    /// When each message was written, aligned with `messages`; `0` (or a
    /// missing entry, in chats saved before) means unknown.
    pub message_times_ms: Vec<u64>,
    /// Tokens of each finished turn, shown after the messages it covers (ADR 0066).
    pub turn_tokens: Vec<AgentTurnTokens>,
    /// Every token the chat used, also of turns later replaced (retry or edit).
    pub total_tokens: AgentTokenTotals,
}

/// Tokens a provider used, input and output apart.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTokenTotals {
    pub input: u64,
    pub output: u64,
}

impl AgentTokenTotals {
    pub fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0
    }

    pub fn add(&mut self, other: AgentTokenTotals) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
    }
}

/// The tokens of one turn, which ended with `messages[..after_message]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnTokens {
    pub after_message: usize,
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    version: u32,
    id: String,
    title: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    provider_id: String,
    model: String,
    messages: Vec<PersistedMessage>,
    /// Additive: chats saved before compaction existed have neither field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(default)]
    summarized_until: usize,
    /// Additive, like the summary: older chats have no times.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    message_times_ms: Vec<u64>,
    /// Additive too: chats saved before token usage was kept show none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    turn_tokens: Vec<AgentTurnTokens>,
    #[serde(default, skip_serializing_if = "AgentTokenTotals::is_empty")]
    total_tokens: AgentTokenTotals,
}

/// Only the header, to list chats without keeping their messages.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedHeader {
    version: u32,
    id: String,
    title: String,
    updated_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMessage {
    role: PersistedRole,
    content: Vec<PersistedBlock>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PersistedRole {
    User,
    Assistant,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum PersistedBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

/// Agent chats of each workspace, under app data (`agent-sessions/`), so a
/// synced workspace folder never carries them. Files are local to this
/// machine and named by chat id inside a folder per workspace path.
pub struct AgentSessionStore {
    root: PathBuf,
}

impl AgentSessionStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn load(
        &self,
        workspace: &str,
        id: &str,
    ) -> Result<Option<AgentSessionRecord>, StorageError> {
        let path = self.session_path(workspace, id)?;
        let raw = match fs::read(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(StorageError::Read(error.to_string())),
        };
        let file: PersistedSession = serde_json::from_slice(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        Ok(Some(AgentSessionRecord {
            id: file.id,
            title: file.title,
            created_at_ms: file.created_at_ms,
            updated_at_ms: file.updated_at_ms,
            provider_id: file.provider_id,
            model: file.model,
            summarized_until: file.summarized_until.min(file.messages.len()),
            message_times_ms: file.message_times_ms,
            turn_tokens: file.turn_tokens,
            total_tokens: file.total_tokens,
            messages: file.messages.into_iter().map(message_from).collect(),
            summary: file.summary,
        }))
    }

    pub fn save(&self, workspace: &str, session: &AgentSessionRecord) -> Result<(), StorageError> {
        let path = self.session_path(workspace, &session.id)?;
        let file = PersistedSession {
            version: CURRENT_VERSION,
            id: session.id.clone(),
            title: session.title.clone(),
            created_at_ms: session.created_at_ms,
            updated_at_ms: session.updated_at_ms,
            provider_id: session.provider_id.clone(),
            model: session.model.clone(),
            messages: session.messages.iter().map(message_to).collect(),
            summary: session.summary.clone(),
            summarized_until: session.summarized_until,
            message_times_ms: session.message_times_ms.clone(),
            turn_tokens: session.turn_tokens.clone(),
            total_tokens: session.total_tokens,
        };
        let json =
            serde_json::to_vec(&file).map_err(|error| StorageError::Write(error.to_string()))?;
        if json.len() > MAX_AGENT_SESSION_BYTES {
            return Err(StorageError::Write(format!(
                "the chat exceeds {} MB; start a new one",
                MAX_AGENT_SESSION_BYTES / (1024 * 1024)
            )));
        }
        write_atomically(&path, &json)
    }

    /// Most recent first. Unreadable files are skipped, not fatal.
    pub fn list(&self, workspace: &str) -> Result<Vec<AgentSessionSummary>, StorageError> {
        let dir = self.workspace_dir(workspace);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(StorageError::Read(error.to_string())),
        };
        let mut sessions: Vec<AgentSessionSummary> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| {
                let raw = fs::read(entry.path()).ok()?;
                let header: PersistedHeader = serde_json::from_slice(&raw).ok()?;
                (header.version == CURRENT_VERSION).then_some(AgentSessionSummary {
                    id: header.id,
                    title: header.title,
                    updated_at_ms: header.updated_at_ms,
                })
            })
            .collect();
        sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at_ms));
        Ok(sessions)
    }

    /// Deleting a chat that does not exist is not an error.
    pub fn delete(&self, workspace: &str, id: &str) -> Result<(), StorageError> {
        match fs::remove_file(self.session_path(workspace, id)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StorageError::Write(error.to_string())),
        }
    }

    /// Removes the oldest chats past `MAX_AGENT_SESSIONS`. Meant for when a
    /// chat is created, not on every save: it reads every chat header.
    pub fn prune(&self, workspace: &str) -> Result<(), StorageError> {
        let sessions = self.list(workspace)?;
        for stale in sessions.iter().skip(MAX_AGENT_SESSIONS) {
            self.delete(workspace, &stale.id)?;
        }
        Ok(())
    }

    fn workspace_dir(&self, workspace: &str) -> PathBuf {
        let digest = ring::digest::digest(&ring::digest::SHA256, workspace.as_bytes());
        let name: String = digest.as_ref()[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        self.root.join(name)
    }

    fn session_path(&self, workspace: &str, id: &str) -> Result<PathBuf, StorageError> {
        if !is_valid_session_id(id) {
            return Err(StorageError::NotFound(format!("chat '{id}'")));
        }
        Ok(self.workspace_dir(workspace).join(format!("{id}.json")))
    }
}

/// Ids are generated by the app; anything else (a path) is refused.
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
    }
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, bytes).map_err(|error| StorageError::Write(error.to_string()))?;
    fs::rename(&tmp_path, path).map_err(|error| StorageError::Write(error.to_string()))
}

fn message_to(message: &AgentMessage) -> PersistedMessage {
    PersistedMessage {
        role: match message.role {
            AgentRole::User => PersistedRole::User,
            AgentRole::Assistant => PersistedRole::Assistant,
        },
        content: message
            .content
            .iter()
            .map(|block| match block {
                ContentBlock::Text { text } => PersistedBlock::Text { text: text.clone() },
                ContentBlock::ToolUse { id, name, input } => PersistedBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                },
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => PersistedBlock::ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    content: content.clone(),
                    is_error: *is_error,
                },
            })
            .collect(),
    }
}

fn message_from(message: PersistedMessage) -> AgentMessage {
    AgentMessage {
        role: match message.role {
            PersistedRole::User => AgentRole::User,
            PersistedRole::Assistant => AgentRole::Assistant,
        },
        content: message
            .content
            .into_iter()
            .map(|block| match block {
                PersistedBlock::Text { text } => ContentBlock::Text { text },
                PersistedBlock::ToolUse { id, name, input } => {
                    ContentBlock::ToolUse { id, name, input }
                }
                PersistedBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                },
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_store() -> (AgentSessionStore, PathBuf) {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "alcy-agent-sessions-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        (AgentSessionStore::new(root.clone()), root)
    }

    fn session(id: &str, updated_at_ms: u64) -> AgentSessionRecord {
        AgentSessionRecord {
            id: id.into(),
            title: format!("chat {id}"),
            created_at_ms: 1,
            updated_at_ms,
            provider_id: "claude".into(),
            model: "m".into(),
            messages: vec![
                AgentMessage::user_text("hi"),
                AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![ContentBlock::ToolUse {
                        id: "t".into(),
                        name: "get_request".into(),
                        input: json!({ "tabId": "a" }),
                    }],
                },
                AgentMessage {
                    role: AgentRole::User,
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: "t".into(),
                        content: "{}".into(),
                        is_error: false,
                    }],
                },
            ],
            summary: None,
            summarized_until: 0,
            message_times_ms: vec![10, 11, 12],
            turn_tokens: vec![AgentTurnTokens {
                after_message: 3,
                input: 120,
                output: 30,
            }],
            total_tokens: AgentTokenTotals {
                input: 150,
                output: 40,
            },
        }
    }

    #[test]
    fn roundtrips_lists_and_deletes_per_workspace() {
        let (store, root) = temp_store();
        store.save("/w1", &session("a", 10)).unwrap();
        store.save("/w1", &session("b", 20)).unwrap();
        store.save("/w2", &session("c", 30)).unwrap();

        assert_eq!(store.load("/w1", "a").unwrap(), Some(session("a", 10)));
        let ids: Vec<String> = store
            .list("/w1")
            .unwrap()
            .into_iter()
            .map(|summary| summary.id)
            .collect();
        assert_eq!(ids, vec!["b", "a"]);

        store.delete("/w1", "a").unwrap();
        store.delete("/w1", "a").unwrap();
        assert_eq!(store.load("/w1", "a").unwrap(), None);
        assert_eq!(store.list("/w2").unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keeps_the_summary_and_reads_chats_saved_without_it() {
        let (store, root) = temp_store();
        let mut summarized = session("s", 1);
        summarized.summary = Some("earlier part".into());
        summarized.summarized_until = 2;
        store.save("/w", &summarized).unwrap();
        assert_eq!(store.load("/w", "s").unwrap(), Some(summarized));

        let old = r#"{"version":1,"id":"o","title":"t","createdAtMs":1,"updatedAtMs":1,"providerId":"claude","model":"m","messages":[]}"#;
        let path = store.session_path("/w", "o").unwrap();
        fs::write(path, old).unwrap();
        let loaded = store.load("/w", "o").unwrap().unwrap();
        assert_eq!((loaded.summary, loaded.summarized_until), (None, 0));
        assert!(loaded.turn_tokens.is_empty());
        assert!(loaded.total_tokens.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ids_that_could_escape_the_folder_are_refused() {
        let (store, _) = temp_store();
        assert!(store.load("/w", "../secret").is_err());
        assert!(store.save("/w", &session("a/b", 1)).is_err());
    }

    #[test]
    fn keeps_only_the_most_recent_sessions() {
        let (store, root) = temp_store();
        for index in 0..(MAX_AGENT_SESSIONS as u64 + 2) {
            store
                .save("/w", &session(&format!("s{index}"), index))
                .unwrap();
        }
        store.prune("/w").unwrap();
        let sessions = store.list("/w").unwrap();
        assert_eq!(sessions.len(), MAX_AGENT_SESSIONS);
        assert!(sessions.iter().all(|summary| summary.id != "s0"));
        let _ = fs::remove_dir_all(root);
    }
}
