//! Agent chat (ADR 0064): provider settings, API keys in the keyring, chat
//! turns streamed over a channel and the bridge that runs tools in the UI.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use alcy_agent::AgentHttpClient;
use alcy_app::{
    AgentCompactionOutcome, AgentConversation, AgentLanguage, AgentRole, AgentToolHost,
    AgentTurnRequest, AgentTurnSink, ChatModelError, ContentBlock, ContextReference,
    CredentialStore, DEFAULT_MAX_OUTPUT_TOKENS, MAX_CONTEXT_REFERENCES, ToolCall, ToolClass,
    ToolOutcome, TurnStop, agent_system_prompt, agent_tool_catalog, compact_agent_conversation,
    compose_user_message, generate_session_title, last_user_text_index, remove_last_user_text,
    run_agent_turn,
};
use alcy_domain::{
    AgentProvider, AgentProviderKind, AgentSettings, AgentSettingsError, agent_credential_key,
};
use alcy_platform::KeyringCredentialStore;
use alcy_storage::{
    AgentSessionRecord, AgentSessionStore, AgentSettingsStore, AgentTokenTotals, AgentTurnTokens,
    StorageError, is_valid_session_id,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;
use tokio::sync::{oneshot, watch};

use super::flow_execution_registry::WatchCancellation;

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_TOOL_RESULT_IPC_BYTES: usize = 256 * 1024;
const MAX_TITLE_CHARS: usize = 60;
/// Items of a chat sent to the UI when it is reopened.
const MAX_VIEW_ITEMS: usize = 400;
const MAX_VIEW_TEXT_BYTES: usize = 64 * 1024;

/// Where the agent keeps its files (app data).
pub struct AgentPaths {
    pub settings: PathBuf,
    pub sessions: PathBuf,
}

impl AgentPaths {
    fn settings_store(&self) -> AgentSettingsStore {
        AgentSettingsStore::new(self.settings.clone())
    }

    fn session_store(&self) -> AgentSessionStore {
        AgentSessionStore::new(self.sessions.clone())
    }
}

/// Turns in progress: their cancellation, the tool calls waiting for the UI
/// and the chats busy with a turn.
#[derive(Default)]
pub struct AgentRuns {
    pub(crate) document_transcripts: Mutex<HashMap<String, (String, Vec<alcy_app::AgentMessage>)>>,
    cancellations: Mutex<HashMap<String, watch::Sender<bool>>>,
    pending_tools: Mutex<HashMap<String, oneshot::Sender<ToolOutcome>>>,
    busy_sessions: Mutex<HashSet<String>>,
    sequence: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl AgentRuns {
    fn next_id(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }
}

/// Removes the run's registrations however the turn ends.
struct RunGuard<'a> {
    runs: &'a AgentRuns,
    run_id: String,
    session_id: String,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        lock(&self.runs.cancellations).remove(&self.run_id);
        lock(&self.runs.busy_sessions).remove(&self.session_id);
        lock(&self.runs.document_transcripts).remove(&self.session_id);
        let prefix = format!("{}:", self.run_id);
        lock(&self.runs.pending_tools).retain(|wait_id, _| !wait_id.starts_with(&prefix));
    }
}

/// Reserve before loading so maintenance and turns never save stale snapshots.
fn register_run(
    runs: &AgentRuns,
    run_id: String,
    session_id: String,
) -> Result<(RunGuard<'_>, WatchCancellation), AgentCommandError> {
    let mut cancellations = lock(&runs.cancellations);
    let mut busy = lock(&runs.busy_sessions);
    if cancellations.contains_key(&run_id) || !busy.insert(session_id.clone()) {
        return Err(AgentCommandError::Busy);
    }
    let (sender, receiver) = watch::channel(false);
    cancellations.insert(run_id.clone(), sender);
    Ok((
        RunGuard {
            runs,
            run_id,
            session_id,
        },
        WatchCancellation(receiver),
    ))
}

// ---------------------------------------------------------------- DTOs

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentProviderKindDto {
    Anthropic,
    OpenaiCompatible,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderDto {
    pub id: String,
    pub kind: AgentProviderKindDto,
    pub label: String,
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsDto {
    pub providers: Vec<AgentProviderDto>,
    pub active_provider_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInput {
    pub id: String,
    pub kind: AgentProviderKindDto,
    pub label: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentSettingsInput {
    pub providers: Vec<AgentProviderInput>,
    pub active_provider_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentApiKeyInput {
    pub provider_id: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderIdInput {
    pub provider_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelDto {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub enum AgentLanguageDto {
    #[serde(rename = "pt-BR")]
    PortugueseBrazil,
    #[serde(rename = "en")]
    English,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextInput {
    pub kind: String,
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentTurnInput {
    pub run_id: String,
    pub root_path: String,
    pub session_id: Option<String>,
    pub provider_id: String,
    /// Empty uses the provider's default model.
    #[serde(default)]
    pub model: String,
    pub text: String,
    #[serde(default)]
    pub context: Vec<AgentContextInput>,
    pub language: AgentLanguageDto,
    /// The text replaces the user's last message and what came after it
    /// (retry of a failed turn, or an edit of the last message).
    #[serde(default)]
    pub replace_last_turn: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTokenTotalsDto {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolClassDto {
    Read,
    Edit,
    SideEffect,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TurnStopDto {
    EndTurn,
    MaxTokens,
    RoundLimit,
    Cancelled,
    Other,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEventDto {
    SessionStarted {
        session_id: String,
        title: String,
    },
    TextDelta {
        text: String,
    },
    ToolCallRequested {
        wait_id: String,
        call_id: String,
        name: String,
        input: Value,
        class: ToolClassDto,
    },
    ToolCallFinished {
        call_id: String,
        is_error: bool,
    },
    /// The oldest part of the chat was summarized to fit the model's context.
    ContextCompacted,
    /// The model named a new chat from its first message.
    TitleChanged {
        title: String,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnResultDto {
    pub session_id: String,
    pub stop_reason: TurnStopDto,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAgentTurnInput {
    pub run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactAgentSessionInput {
    pub run_id: String,
    pub root_path: String,
    pub session_id: String,
    pub provider_id: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompactionResultDto {
    pub compacted: bool,
    pub cancelled: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAgentToolResultInput {
    pub wait_id: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInput {
    pub root_path: String,
    pub session_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummaryDto {
    pub id: String,
    pub title: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentViewItemDto {
    User {
        text: String,
        /// When the message was sent; absent in chats saved before times existed.
        #[serde(skip_serializing_if = "Option::is_none")]
        at_ms: Option<u64>,
    },
    Assistant {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        at_ms: Option<u64>,
    },
    Tool {
        call_id: String,
        name: String,
        input: Value,
        is_error: bool,
    },
    /// The tokens of the turn that ended just before.
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionViewDto {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub items: Vec<AgentViewItemDto>,
    /// Older items left out of `items`.
    pub omitted_items: usize,
    /// Every token the chat used, also of replaced turns.
    pub total_tokens: AgentTokenTotalsDto,
}

/// Never carries API keys or message contents.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentCommandError {
    Invalid { message: String },
    Storage { message: String },
    Credentials { message: String },
    UnknownProvider,
    MissingApiKey,
    MissingModel,
    Busy,
    NotFound,
    Unauthorized,
    RateLimited,
    Network { message: String },
    Provider { status: u16, message: String },
    InvalidResponse { message: String },
}

impl From<StorageError> for AgentCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

impl From<AgentSettingsError> for AgentCommandError {
    fn from(error: AgentSettingsError) -> Self {
        Self::Invalid {
            message: error.to_string(),
        }
    }
}

impl From<ChatModelError> for AgentCommandError {
    fn from(error: ChatModelError) -> Self {
        match error {
            ChatModelError::Unauthorized => Self::Unauthorized,
            ChatModelError::RateLimited => Self::RateLimited,
            ChatModelError::Network(message) => Self::Network { message },
            ChatModelError::Provider { status, message } => Self::Provider { status, message },
            ChatModelError::InvalidResponse(message) => Self::InvalidResponse { message },
        }
    }
}

fn credentials_error(error: alcy_app::CredentialError) -> AgentCommandError {
    AgentCommandError::Credentials {
        message: error.to_string(),
    }
}

async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, AgentCommandError> + Send + 'static,
) -> Result<T, AgentCommandError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AgentCommandError::Storage {
            message: error.to_string(),
        })?
}

// ---------------------------------------------------------------- settings

fn kind_dto(kind: AgentProviderKind) -> AgentProviderKindDto {
    match kind {
        AgentProviderKind::Anthropic => AgentProviderKindDto::Anthropic,
        AgentProviderKind::OpenAiCompatible => AgentProviderKindDto::OpenaiCompatible,
    }
}

fn settings_dto(settings: AgentSettings, credentials: &dyn CredentialStore) -> AgentSettingsDto {
    AgentSettingsDto {
        providers: settings
            .providers
            .into_iter()
            .map(|provider| AgentProviderDto {
                // A keyring that cannot be read reads as "no key"; storing
                // one reports the real error.
                has_api_key: matches!(
                    credentials.load(&agent_credential_key(&provider.id)),
                    Ok(Some(_))
                ),
                kind: kind_dto(provider.kind),
                id: provider.id,
                label: provider.label,
                base_url: provider.base_url,
                model: provider.model,
            })
            .collect(),
        active_provider_id: settings.active_provider_id,
    }
}

#[tauri::command]
pub async fn get_agent_settings(
    paths: State<'_, AgentPaths>,
    credentials: State<'_, KeyringCredentialStore>,
) -> Result<AgentSettingsDto, AgentCommandError> {
    let store = paths.settings_store();
    let result = async {
        let settings = run_blocking(move || Ok(store.load()?)).await?;
        let (settings, changed) = without_unused_legacy_defaults(settings, &*credentials);
        if changed {
            let store = paths.settings_store();
            let saved = settings.clone();
            run_blocking(move || Ok(store.save(&saved)?)).await?;
        }
        Ok(settings_dto(settings, &*credentials))
    }
    .await;
    crate::logging::logged("alcy::agent", "load agent settings", result)
}

/// Providers earlier builds created by default, as they came: id, base URL
/// and model. Providers are now only added by the user, from presets.
const LEGACY_DEFAULTS: [(&str, &str, &str); 3] = [
    ("claude", "https://api.anthropic.com", "claude-sonnet-5-5"),
    (
        "opencode",
        "https://opencode.ai/inference/openai/v1",
        "claude-sonnet-5-5",
    ),
    ("custom", "http://localhost:11434/v1", ""),
];

/// Drops the old default providers that were never set up: still as they
/// came, without a key and not in use. One the user configured stays as a
/// regular provider. Returns whether anything was removed.
fn without_unused_legacy_defaults(
    mut settings: AgentSettings,
    credentials: &dyn CredentialStore,
) -> (AgentSettings, bool) {
    let before = settings.providers.len();
    let active = settings.active_provider_id.clone();
    settings.providers.retain(|provider| {
        let untouched = LEGACY_DEFAULTS.iter().any(|(id, base_url, model)| {
            provider.id == *id && provider.base_url == *base_url && provider.model == *model
        });
        let unused = untouched
            && active.as_deref() != Some(provider.id.as_str())
            && matches!(
                credentials.load(&agent_credential_key(&provider.id)),
                Ok(None)
            );
        !unused
    });
    let changed = settings.providers.len() != before;
    (settings, changed)
}

#[tauri::command]
pub async fn save_agent_settings(
    input: SaveAgentSettingsInput,
    paths: State<'_, AgentPaths>,
    credentials: State<'_, KeyringCredentialStore>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<AgentSettingsDto, AgentCommandError> {
    let store = paths.settings_store();
    let result = async {
        let settings = AgentSettings {
            providers: input
                .providers
                .into_iter()
                .map(|provider| AgentProvider {
                    id: provider.id,
                    kind: match provider.kind {
                        AgentProviderKindDto::Anthropic => AgentProviderKind::Anthropic,
                        AgentProviderKindDto::OpenaiCompatible => {
                            AgentProviderKind::OpenAiCompatible
                        }
                    },
                    label: provider.label,
                    base_url: provider.base_url,
                    model: provider.model,
                })
                .collect(),
            active_provider_id: input.active_provider_id,
        }
        .validated()?;
        let saved = settings.clone();
        run_blocking(move || Ok(store.save(&saved)?)).await?;
        Ok(settings_dto(settings, &*credentials))
    }
    .await;
    crate::commands::usage_events::record_setting(&usage, "agent", None, &result);
    crate::logging::logged("alcy::agent", "save agent settings", result)
}

#[tauri::command]
pub async fn set_agent_api_key(
    input: SetAgentApiKeyInput,
    credentials: State<'_, KeyringCredentialStore>,
) -> Result<(), AgentCommandError> {
    let result = (|| {
        let key = input.api_key.trim();
        if key.is_empty() {
            return Err(AgentCommandError::MissingApiKey);
        }
        credentials
            .save(&agent_credential_key(&input.provider_id), key)
            .map_err(credentials_error)
    })();
    crate::logging::logged("alcy::agent", "store agent API key", result)
}

#[tauri::command]
pub async fn clear_agent_api_key(
    input: AgentProviderIdInput,
    credentials: State<'_, KeyringCredentialStore>,
) -> Result<(), AgentCommandError> {
    let result = credentials
        .delete(&agent_credential_key(&input.provider_id))
        .map_err(credentials_error);
    crate::logging::logged("alcy::agent", "remove agent API key", result)
}

/// The provider and its stored key.
async fn provider_and_key(
    paths: &AgentPaths,
    credentials: &dyn CredentialStore,
    provider_id: &str,
) -> Result<(AgentProvider, Option<String>), AgentCommandError> {
    let store = paths.settings_store();
    let settings = run_blocking(move || Ok(store.load()?)).await?;
    let provider = settings
        .provider(provider_id)
        .cloned()
        .ok_or(AgentCommandError::UnknownProvider)?;
    let key = credentials
        .load(&agent_credential_key(provider_id))
        .map_err(credentials_error)?;
    if key.is_none() && provider.kind == AgentProviderKind::Anthropic {
        return Err(AgentCommandError::MissingApiKey);
    }
    Ok((provider, key))
}

/// Also serves as the connection test of the settings screen.
#[tauri::command]
pub async fn list_agent_models(
    input: AgentProviderIdInput,
    paths: State<'_, AgentPaths>,
    credentials: State<'_, KeyringCredentialStore>,
    http: State<'_, AgentHttpClient>,
) -> Result<Vec<AgentModelDto>, AgentCommandError> {
    let result = async {
        let (provider, key) = provider_and_key(&paths, &*credentials, &input.provider_id).await?;
        let models = http.chat(&provider, key.as_deref())?.list_models().await?;
        Ok(models
            .into_iter()
            .map(|model| AgentModelDto {
                id: model.id,
                label: model.label,
            })
            .collect())
    }
    .await;
    crate::logging::logged("alcy::agent", "list agent models", result)
}

// ---------------------------------------------------------------- turns

struct ChannelSink<'a> {
    channel: &'a Channel<AgentEventDto>,
}

impl AgentTurnSink for ChannelSink<'_> {
    fn text_delta(&self, text: &str) {
        let _ = self
            .channel
            .send(AgentEventDto::TextDelta { text: text.into() });
    }

    fn tool_finished(&self, call_id: &str, is_error: bool) {
        let _ = self.channel.send(AgentEventDto::ToolCallFinished {
            call_id: call_id.into(),
            is_error,
        });
    }

    fn context_compacted(&self) {
        let _ = self.channel.send(AgentEventDto::ContextCompacted);
    }
}

/// Runs tools in the UI: sends the call over the turn's channel and waits for
/// `submit_agent_tool_result`. Approval and masking happen on that side, so
/// they hold for whichever agent calls the bridge (ADR 0064).
struct UiToolBridge<'a> {
    session_id: &'a str,
    root_path: &'a str,
    channel: &'a Channel<AgentEventDto>,
    runs: &'a AgentRuns,
    run_id: &'a str,
}

struct PendingToolGuard<'a> {
    runs: &'a AgentRuns,
    wait_id: String,
}

impl Drop for PendingToolGuard<'_> {
    fn drop(&mut self) {
        lock(&self.runs.pending_tools).remove(&self.wait_id);
    }
}

impl AgentToolHost for UiToolBridge<'_> {
    fn publish_transcript(&self, messages: &[alcy_app::AgentMessage]) {
        lock(&self.runs.document_transcripts).insert(
            self.session_id.into(),
            (self.root_path.into(), messages.to_vec()),
        );
    }
    fn call(&self, call: &ToolCall<'_>) -> impl Future<Output = ToolOutcome> + Send {
        let wait_id = format!("{}:{}", self.run_id, self.runs.next_id());
        let (sender, receiver) = oneshot::channel();
        lock(&self.runs.pending_tools).insert(wait_id.clone(), sender);
        let sent = self.channel.send(AgentEventDto::ToolCallRequested {
            wait_id: wait_id.clone(),
            call_id: call.id.into(),
            name: call.name.into(),
            input: call.input.clone(),
            class: match call.class {
                ToolClass::Read => ToolClassDto::Read,
                ToolClass::Edit => ToolClassDto::Edit,
                ToolClass::SideEffect => ToolClassDto::SideEffect,
            },
        });
        let guard = PendingToolGuard {
            runs: self.runs,
            wait_id,
        };
        async move {
            let _guard = guard;
            if sent.is_err() {
                return ToolOutcome::error("The app window is not available.");
            }
            receiver
                .await
                .unwrap_or_else(|_| ToolOutcome::error("The app did not answer the tool call."))
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let mut title: String = line.trim().chars().take(MAX_TITLE_CHARS).collect();
    if line.trim().chars().count() > MAX_TITLE_CHARS {
        title.push('…');
    }
    title
}

/// Estimated context window of the provider (spec 0135). Local servers
/// usually run small models, so they get a much smaller budget.
fn context_budget_tokens(provider: &AgentProvider) -> usize {
    let host = provider
        .base_url
        .split_once("://")
        .map_or(provider.base_url.as_str(), |(_, rest)| rest)
        .split(['/', '?'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let local =
        host.starts_with("localhost") || host.starts_with("127.") || host.starts_with("[::1]");
    match (provider.kind, local) {
        (_, true) => 24_000,
        (AgentProviderKind::Anthropic, false) => 150_000,
        (AgentProviderKind::OpenAiCompatible, false) => 100_000,
    }
}

/// Times of the messages a turn added. The user's text lands in a new message,
/// or in the last one when it joined an interrupted turn's tool results; the
/// replies get the time the turn ended. Earlier messages without a time get 0.
/// Drops the user's last message and what came after it, before the turn is
/// sent again. A full manual summary is invalidated before editing its last
/// turn; an automatic summary covering only older turns stays immutable.
fn replace_last_turn(session: &mut AgentSessionRecord) -> Result<(), AgentCommandError> {
    match last_user_text_index(&session.messages) {
        None => Err(AgentCommandError::Invalid {
            message: "there is no message to replace".into(),
        }),
        Some(index)
            if index < session.summarized_until
                && session.summarized_until < session.messages.len() =>
        {
            Err(AgentCommandError::Invalid {
                message: "that message is part of the summarized history".into(),
            })
        }
        Some(_) => {
            if session.summarized_until == session.messages.len() {
                session.summary = None;
                session.summarized_until = 0;
            }
            remove_last_user_text(&mut session.messages);
            let len = session.messages.len();
            session.message_times_ms.truncate(len);
            // The replaced turn's cost leaves the view; the chat total keeps it.
            session.turn_tokens.retain(|turn| turn.after_message <= len);
            Ok(())
        }
    }
}

fn record_message_times(
    times: &mut Vec<u64>,
    previous_len: usize,
    len: usize,
    sent_at_ms: u64,
    finished_at_ms: u64,
) {
    times.resize(previous_len, 0);
    if len == previous_len {
        // The text joined the previous user message.
        if let Some(last) = times.last_mut() {
            *last = sent_at_ms;
        }
        return;
    }
    times.push(sent_at_ms);
    times.resize(len, finished_at_ms);
}

fn turn_stop_dto(stop: TurnStop) -> TurnStopDto {
    match stop {
        TurnStop::EndTurn => TurnStopDto::EndTurn,
        TurnStop::MaxTokens => TurnStopDto::MaxTokens,
        TurnStop::RoundLimit => TurnStopDto::RoundLimit,
        TurnStop::Cancelled => TurnStopDto::Cancelled,
        TurnStop::Other => TurnStopDto::Other,
    }
}

#[tauri::command]
pub async fn start_agent_turn(
    input: StartAgentTurnInput,
    on_event: Channel<AgentEventDto>,
    paths: State<'_, AgentPaths>,
    runs: State<'_, AgentRuns>,
    credentials: State<'_, KeyringCredentialStore>,
    http: State<'_, AgentHttpClient>,
    usage: State<'_, alcy_app::UsageHub>,
) -> Result<AgentTurnResultDto, AgentCommandError> {
    let result = run_turn(
        input,
        &on_event,
        &paths,
        &runs,
        &*credentials,
        &http,
        &usage,
    )
    .await;
    crate::logging::logged("alcy::agent", "agent turn", result)
}

async fn run_turn(
    input: StartAgentTurnInput,
    channel: &Channel<AgentEventDto>,
    paths: &AgentPaths,
    runs: &AgentRuns,
    credentials: &dyn CredentialStore,
    http: &AgentHttpClient,
    usage: &alcy_app::UsageHub,
) -> Result<AgentTurnResultDto, AgentCommandError> {
    let text = input.text.trim().to_string();
    if text.is_empty() {
        return Err(AgentCommandError::Invalid {
            message: "the message is empty".into(),
        });
    }
    if text.len() > MAX_MESSAGE_BYTES {
        return Err(AgentCommandError::Invalid {
            message: "the message is too long".into(),
        });
    }
    let (provider, key) = provider_and_key(paths, credentials, &input.provider_id).await?;
    let model = match input.model.trim() {
        "" => provider.model.clone(),
        model => model.to_string(),
    };
    if model.is_empty() {
        return Err(AgentCommandError::MissingModel);
    }
    let chat = http.chat(&provider, key.as_deref())?;
    // The provider kind only; never the model, the address or the message.
    let provider_kind = match provider.kind {
        alcy_domain::AgentProviderKind::Anthropic => "anthropic",
        alcy_domain::AgentProviderKind::OpenAiCompatible => "openAiCompatible",
    };
    if let Some(provider_kind) = alcy_app::UsageIdentifier::new(provider_kind) {
        usage.record(alcy_app::UsageEvent::AgentMessageSent { provider_kind });
    }

    let target_session_id = input
        .session_id
        .clone()
        .unwrap_or_else(|| format!("{:x}-{:x}", now_ms(), runs.next_id()));
    let (_guard, cancellation) =
        register_run(runs, input.run_id.clone(), target_session_id.clone())?;
    let root_path = input.root_path.clone();
    let sessions = paths.session_store();
    let mut session = match input.session_id.clone() {
        Some(id) => {
            let root = root_path.clone();
            run_blocking(move || sessions.load(&root, &id).map_err(Into::into))
                .await?
                .ok_or(AgentCommandError::NotFound)?
        }
        None => {
            let now = now_ms();
            AgentSessionRecord {
                id: target_session_id,
                title: title_from(&text),
                created_at_ms: now,
                updated_at_ms: now,
                provider_id: provider.id.clone(),
                model: model.clone(),
                messages: Vec::new(),
                summary: None,
                summarized_until: 0,
                message_times_ms: Vec::new(),
                turn_tokens: Vec::new(),
                total_tokens: AgentTokenTotals::default(),
            }
        }
    };
    let is_new = input.session_id.is_none();
    if input.replace_last_turn {
        replace_last_turn(&mut session)?;
    }

    let context: Vec<ContextReference> = input
        .context
        .into_iter()
        .take(MAX_CONTEXT_REFERENCES)
        .map(|reference| ContextReference {
            kind: reference.kind,
            id: reference.id,
            label: reference.label,
            summary: reference.summary,
        })
        .collect();
    let mut conversation = AgentConversation {
        messages: std::mem::take(&mut session.messages),
        summary: session.summary.take(),
        summarized_until: session.summarized_until,
    };
    let sent_at_ms = now_ms();
    let previous_len = conversation.messages.len();
    conversation.push_user_text(compose_user_message(&text, &context));
    let _ = channel.send(AgentEventDto::SessionStarted {
        session_id: session.id.clone(),
        title: session.title.clone(),
    });

    let language = match input.language {
        AgentLanguageDto::PortugueseBrazil => AgentLanguage::PortugueseBrazil,
        AgentLanguageDto::English => AgentLanguage::English,
    };
    let system_prompt = agent_system_prompt(language);
    let tools = agent_tool_catalog();
    // A new chat gets a title from the model, alongside the reply so the turn
    // does not wait for it; until then (or if it fails) the first line stays.
    let title = async {
        if !is_new {
            return None;
        }
        match generate_session_title(&chat, &model, &text, language).await {
            Ok((title, usage)) => {
                if let Some(title) = &title {
                    let _ = channel.send(AgentEventDto::TitleChanged {
                        title: title.clone(),
                    });
                }
                Some((title, usage))
            }
            Err(error) => {
                log::warn!(target: "alcy::agent", "session title failed ({error})");
                None
            }
        }
    };
    let tool_host = UiToolBridge {
        session_id: &session.id,
        root_path: &root_path,
        channel,
        runs,
        run_id: &input.run_id,
    };
    let sink = ChannelSink { channel };
    let turn = run_agent_turn(
        &chat,
        &tool_host,
        &sink,
        &cancellation,
        &mut conversation,
        AgentTurnRequest {
            model: &model,
            system_prompt: &system_prompt,
            tools: &tools,
            max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            context_budget_tokens: context_budget_tokens(&provider),
        },
    );
    let (outcome, title) = tokio::join!(turn, title);
    let mut title_usage = alcy_app::TokenUsage::default();
    if let Some((title, usage)) = title {
        title_usage = usage;
        if let Some(title) = title {
            session.title = title;
        }
    }
    session.messages = conversation.messages;
    session.summary = conversation.summary;
    session.summarized_until = conversation.summarized_until;
    record_message_times(
        &mut session.message_times_ms,
        previous_len,
        session.messages.len(),
        sent_at_ms,
        now_ms(),
    );

    // The title call is counted with the turn that asked for it.
    let turn_tokens = outcome.as_ref().ok().map(|outcome| AgentTokenTotals {
        input: outcome.usage.input_tokens + title_usage.input_tokens,
        output: outcome.usage.output_tokens + title_usage.output_tokens,
    });
    if let Some(tokens) = turn_tokens.filter(|tokens| !tokens.is_empty()) {
        session.turn_tokens.push(AgentTurnTokens {
            after_message: session.messages.len(),
            input: tokens.input,
            output: tokens.output,
        });
        session.total_tokens.add(tokens);
    }

    // The chat is saved even when the turn failed: what happened before the
    // failure (and the user's message) stays in the history.
    session.updated_at_ms = now_ms();
    session.provider_id = provider.id.clone();
    session.model = model;
    let session_id = session.id.clone();
    let store = paths.session_store();
    run_blocking(move || {
        store.save(&root_path, &session)?;
        if is_new {
            store.prune(&root_path)?;
        }
        Ok(())
    })
    .await?;

    let outcome = outcome?;
    let tokens = turn_tokens.unwrap_or_default();
    Ok(AgentTurnResultDto {
        session_id,
        stop_reason: turn_stop_dto(outcome.stop),
        input_tokens: tokens.input,
        output_tokens: tokens.output,
    })
}

/// Idempotent: an unknown or finished run is ignored.
#[tauri::command]
pub async fn compact_agent_session(
    input: CompactAgentSessionInput,
    paths: State<'_, AgentPaths>,
    runs: State<'_, AgentRuns>,
    credentials: State<'_, KeyringCredentialStore>,
    http: State<'_, AgentHttpClient>,
) -> Result<AgentCompactionResultDto, AgentCommandError> {
    let result = compact_session(input, &paths, &runs, &*credentials, &http).await;
    crate::logging::logged("alcy::agent", "compact agent chat", result)
}

async fn compact_session(
    input: CompactAgentSessionInput,
    paths: &AgentPaths,
    runs: &AgentRuns,
    credentials: &dyn CredentialStore,
    http: &AgentHttpClient,
) -> Result<AgentCompactionResultDto, AgentCommandError> {
    if !is_valid_session_id(&input.session_id) {
        return Err(AgentCommandError::NotFound);
    }
    let (_guard, cancellation) = register_run(runs, input.run_id, input.session_id.clone())?;
    let store = paths.session_store();
    let root = input.root_path.clone();
    let id = input.session_id;
    let mut session = run_blocking(move || store.load(&root, &id).map_err(Into::into))
        .await?
        .ok_or(AgentCommandError::NotFound)?;
    let (provider, key) = provider_and_key(paths, credentials, &input.provider_id).await?;
    let model = if input.model.trim().is_empty() {
        provider.model.clone()
    } else {
        input.model.trim().to_string()
    };
    if model.is_empty() {
        return Err(AgentCommandError::MissingModel);
    }
    let chat = http.chat(&provider, key.as_deref())?;
    let mut conversation = AgentConversation {
        messages: std::mem::take(&mut session.messages),
        summary: session.summary.take(),
        summarized_until: session.summarized_until,
    };
    let outcome =
        compact_agent_conversation(&chat, &cancellation, &mut conversation, &model).await?;
    let mut result = AgentCompactionResultDto {
        compacted: false,
        cancelled: false,
        input_tokens: 0,
        output_tokens: 0,
    };
    match outcome {
        AgentCompactionOutcome::Cancelled => result.cancelled = true,
        AgentCompactionOutcome::Unchanged => {}
        AgentCompactionOutcome::Compacted(usage) => {
            session.messages = conversation.messages;
            session.summary = conversation.summary;
            session.summarized_until = conversation.summarized_until;
            let tokens = AgentTokenTotals {
                input: usage.input_tokens,
                output: usage.output_tokens,
            };
            session.total_tokens.add(tokens);
            if !tokens.is_empty() {
                session.turn_tokens.push(AgentTurnTokens {
                    after_message: session.messages.len(),
                    input: tokens.input,
                    output: tokens.output,
                });
            }
            session.updated_at_ms = now_ms();
            let store = paths.session_store();
            run_blocking(move || {
                store.save(&input.root_path, &session)?;
                Ok(())
            })
            .await?;
            result.compacted = true;
            result.input_tokens = tokens.input;
            result.output_tokens = tokens.output;
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn cancel_agent_turn(input: CancelAgentTurnInput, runs: State<'_, AgentRuns>) {
    if let Some(sender) = lock(&runs.cancellations).get(&input.run_id) {
        let _ = sender.send(true);
    }
}

#[tauri::command]
pub fn submit_agent_tool_result(
    input: SubmitAgentToolResultInput,
    runs: State<'_, AgentRuns>,
) -> Result<(), AgentCommandError> {
    let sender = lock(&runs.pending_tools)
        .remove(&input.wait_id)
        .ok_or(AgentCommandError::NotFound)?;
    let mut content = input.content;
    if content.len() > MAX_TOOL_RESULT_IPC_BYTES {
        let mut end = MAX_TOOL_RESULT_IPC_BYTES;
        while !content.is_char_boundary(end) {
            end -= 1;
        }
        content.truncate(end);
    }
    let _ = sender.send(ToolOutcome {
        content,
        is_error: input.is_error,
    });
    Ok(())
}

// ---------------------------------------------------------------- history

#[tauri::command]
pub async fn list_agent_sessions(
    input: AgentSessionsInput,
    paths: State<'_, AgentPaths>,
) -> Result<Vec<AgentSessionSummaryDto>, AgentCommandError> {
    let store = paths.session_store();
    let result = run_blocking(move || {
        Ok(store
            .list(&input.root_path)?
            .into_iter()
            .map(|summary| AgentSessionSummaryDto {
                id: summary.id,
                title: summary.title,
                updated_at_ms: summary.updated_at_ms,
            })
            .collect())
    })
    .await;
    crate::logging::logged("alcy::agent", "list agent chats", result)
}

#[tauri::command]
pub async fn load_agent_session(
    input: AgentSessionInput,
    paths: State<'_, AgentPaths>,
) -> Result<AgentSessionViewDto, AgentCommandError> {
    let store = paths.session_store();
    let result = run_blocking(move || {
        if !is_valid_session_id(&input.session_id) {
            return Err(AgentCommandError::NotFound);
        }
        let session = store
            .load(&input.root_path, &input.session_id)?
            .ok_or(AgentCommandError::NotFound)?;
        Ok(session_view(session))
    })
    .await;
    crate::logging::logged("alcy::agent", "open agent chat", result)
}

#[tauri::command]
pub async fn delete_agent_session(
    input: AgentSessionInput,
    paths: State<'_, AgentPaths>,
    runs: State<'_, AgentRuns>,
) -> Result<(), AgentCommandError> {
    if lock(&runs.busy_sessions).contains(&input.session_id) {
        return Err(AgentCommandError::Busy);
    }
    let store = paths.session_store();
    let result = run_blocking(move || Ok(store.delete(&input.root_path, &input.session_id)?)).await;
    crate::logging::logged("alcy::agent", "delete agent chat", result)
}

/// What the user sees of a chat: their messages without the attached
/// context, the assistant's text and one item per tool call.
fn session_view(session: AgentSessionRecord) -> AgentSessionViewDto {
    let failed: HashSet<&str> = session
        .messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                is_error: true,
                ..
            } => Some(tool_use_id.as_str()),
            _ => None,
        })
        .collect();
    let mut items = Vec::new();
    let time_of = |index: usize| {
        session
            .message_times_ms
            .get(index)
            .copied()
            .filter(|time| *time > 0)
    };
    for (index, message) in session.messages.iter().enumerate() {
        for block in &message.content {
            match (message.role, block) {
                (AgentRole::User, ContentBlock::Text { text }) => {
                    let visible = text
                        .split("\n\n<attached_context>")
                        .next()
                        .unwrap_or_default();
                    items.push(AgentViewItemDto::User {
                        text: capped(visible),
                        at_ms: time_of(index),
                    });
                }
                (AgentRole::Assistant, ContentBlock::Text { text }) => {
                    items.push(AgentViewItemDto::Assistant {
                        text: capped(text),
                        at_ms: time_of(index),
                    });
                }
                (_, ContentBlock::ToolUse { id, name, input }) => {
                    items.push(AgentViewItemDto::Tool {
                        call_id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                        is_error: failed.contains(id.as_str()),
                    });
                }
                _ => {}
            }
        }
        for turn in session
            .turn_tokens
            .iter()
            .filter(|turn| turn.after_message == index + 1)
        {
            items.push(AgentViewItemDto::Usage {
                input_tokens: turn.input,
                output_tokens: turn.output,
            });
        }
    }
    let omitted_items = items.len().saturating_sub(MAX_VIEW_ITEMS);
    let items = items.split_off(omitted_items);
    AgentSessionViewDto {
        id: session.id,
        title: session.title,
        provider_id: session.provider_id,
        model: session.model,
        items,
        omitted_items,
        total_tokens: AgentTokenTotalsDto {
            input: session.total_tokens.input,
            output: session.total_tokens.output,
        },
    }
}

fn capped(text: &str) -> String {
    if text.len() <= MAX_VIEW_TEXT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_VIEW_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_app::AgentMessage;
    use serde_json::json;

    #[test]
    fn turns_and_compaction_share_an_exclusive_session_reservation() {
        let runs = AgentRuns::default();
        let (guard, _) = register_run(&runs, "turn".into(), "session".into()).unwrap();
        assert!(matches!(
            register_run(&runs, "compact".into(), "session".into()),
            Err(AgentCommandError::Busy)
        ));
        assert!(matches!(
            register_run(&runs, "turn".into(), "other-session".into()),
            Err(AgentCommandError::Busy)
        ));
        assert!(!lock(&runs.busy_sessions).contains("other-session"));
        drop(guard);
        assert!(lock(&runs.busy_sessions).is_empty());
        assert!(lock(&runs.cancellations).is_empty());
        assert!(register_run(&runs, "compact".into(), "session".into()).is_ok());
    }

    struct NoKeys;

    impl CredentialStore for NoKeys {
        fn load(&self, _: &str) -> Result<Option<String>, alcy_app::CredentialError> {
            Ok(None)
        }
        fn save(&self, _: &str, _: &str) -> Result<(), alcy_app::CredentialError> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), alcy_app::CredentialError> {
            Ok(())
        }
    }

    fn legacy(id: &str, base_url: &str, model: &str) -> AgentProvider {
        AgentProvider {
            id: id.into(),
            kind: AgentProviderKind::OpenAiCompatible,
            label: id.into(),
            base_url: base_url.into(),
            model: model.into(),
        }
    }

    /// The defaults of earlier builds, as they were saved.
    fn legacy_settings() -> AgentSettings {
        AgentSettings {
            providers: LEGACY_DEFAULTS
                .iter()
                .map(|(id, base_url, model)| legacy(id, base_url, model))
                .collect(),
            active_provider_id: None,
        }
    }

    struct KeyFor(&'static str);

    impl CredentialStore for KeyFor {
        fn load(&self, key: &str) -> Result<Option<String>, alcy_app::CredentialError> {
            Ok((key == agent_credential_key(self.0)).then(|| "secret".into()))
        }
        fn save(&self, _: &str, _: &str) -> Result<(), alcy_app::CredentialError> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), alcy_app::CredentialError> {
            Ok(())
        }
    }

    #[test]
    fn untouched_old_defaults_go_away_and_configured_ones_stay() {
        let (cleaned, changed) = without_unused_legacy_defaults(legacy_settings(), &NoKeys);
        assert!(changed);
        assert!(cleaned.providers.is_empty());

        // A key, a changed model or being in use keeps the provider.
        let (kept, _) = without_unused_legacy_defaults(legacy_settings(), &KeyFor("claude"));
        assert_eq!(kept.providers.len(), 1);
        assert_eq!(kept.providers[0].id, "claude");

        let mut edited = legacy_settings();
        edited.providers[2].model = "qwen3".into();
        let (kept, _) = without_unused_legacy_defaults(edited, &NoKeys);
        assert_eq!(kept.providers.len(), 1);
        assert_eq!(kept.providers[0].id, "custom");

        let mut active = legacy_settings();
        active.active_provider_id = Some("opencode".into());
        let (kept, _) = without_unused_legacy_defaults(active, &NoKeys);
        assert_eq!(kept.providers.len(), 1);
        assert_eq!(kept.providers[0].id, "opencode");

        // Providers added from presets are never touched.
        let added = AgentSettings {
            providers: vec![legacy("openrouter", "https://openrouter.ai/api/v1", "")],
            active_provider_id: None,
        };
        assert!(!without_unused_legacy_defaults(added, &NoKeys).1);
    }

    #[test]
    fn a_turn_records_the_send_and_reply_times() {
        let mut times = vec![1, 2];
        record_message_times(&mut times, 2, 5, 100, 200);
        assert_eq!(times, vec![1, 2, 100, 200, 200]);

        // A chat saved before times existed: earlier messages are unknown.
        let mut old = Vec::new();
        record_message_times(&mut old, 3, 5, 100, 200);
        assert_eq!(old, vec![0, 0, 0, 100, 200]);

        // A turn that failed before any reply only adds the user's message.
        let mut unanswered = vec![1, 2, 3];
        record_message_times(&mut unanswered, 3, 4, 100, 200);
        assert_eq!(unanswered, vec![1, 2, 3, 100]);

        // The text joined the last (tool results) message.
        let mut joined = vec![1, 2, 3];
        record_message_times(&mut joined, 3, 3, 100, 200);
        assert_eq!(joined, vec![1, 2, 100]);
    }

    #[test]
    fn replacing_the_last_turn_drops_it_and_its_times() {
        let reply = alcy_app::AgentMessage {
            role: AgentRole::Assistant,
            content: vec![ContentBlock::Text { text: "two".into() }],
        };
        let mut session = AgentSessionRecord {
            id: "s".into(),
            title: "t".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
            provider_id: "p".into(),
            model: "m".into(),
            messages: vec![
                alcy_app::AgentMessage::user_text("first"),
                reply.clone(),
                alcy_app::AgentMessage::user_text("second"),
                reply,
            ],
            summary: None,
            summarized_until: 0,
            message_times_ms: vec![1, 2, 3, 4],
            turn_tokens: vec![
                AgentTurnTokens {
                    after_message: 2,
                    input: 10,
                    output: 1,
                },
                AgentTurnTokens {
                    after_message: 4,
                    input: 20,
                    output: 2,
                },
            ],
            total_tokens: AgentTokenTotals {
                input: 30,
                output: 3,
            },
        };
        replace_last_turn(&mut session).unwrap();
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.message_times_ms, vec![1, 2]);
        // The replaced turn's cost leaves the view, not the chat total.
        assert_eq!(session.turn_tokens.len(), 1);
        assert_eq!(session.total_tokens.input, 30);

        // The summarized part of a long chat cannot be replaced.
        session.summarized_until = 1;
        assert!(matches!(
            replace_last_turn(&mut session),
            Err(AgentCommandError::Invalid { .. })
        ));
        // Editing after manual compaction invalidates the summary containing
        // the replaced message, so stale facts never reach the next request.
        session.summary = Some("summary including the first question".into());
        session.summarized_until = session.messages.len();
        replace_last_turn(&mut session).unwrap();
        assert!(session.messages.is_empty());
        assert_eq!(session.summary, None);
        assert_eq!(session.summarized_until, 0);
        assert_eq!(session.total_tokens.input, 30);
        session.messages.clear();
        session.summarized_until = 0;
        assert!(matches!(
            replace_last_turn(&mut session),
            Err(AgentCommandError::Invalid { .. })
        ));
    }

    #[test]
    fn local_servers_get_a_smaller_context_budget() {
        let provider = |kind, base_url: &str| AgentProvider {
            id: "p".into(),
            kind,
            label: "P".into(),
            base_url: base_url.into(),
            model: "m".into(),
        };
        assert_eq!(
            context_budget_tokens(&provider(
                AgentProviderKind::Anthropic,
                "https://api.anthropic.com"
            )),
            150_000
        );
        assert_eq!(
            context_budget_tokens(&provider(
                AgentProviderKind::OpenAiCompatible,
                "https://opencode.ai/inference/openai/v1"
            )),
            100_000
        );
        assert_eq!(
            context_budget_tokens(&provider(
                AgentProviderKind::OpenAiCompatible,
                "http://localhost:11434/v1"
            )),
            24_000
        );
        assert_eq!(
            context_budget_tokens(&provider(
                AgentProviderKind::OpenAiCompatible,
                "http://127.0.0.1:1234/v1"
            )),
            24_000
        );
    }

    #[test]
    fn titles_use_the_first_line_and_are_shortened() {
        assert_eq!(title_from("\n  Create a GET  \nmore"), "Create a GET");
        let long = "a".repeat(80);
        assert_eq!(title_from(&long).chars().count(), MAX_TITLE_CHARS + 1);
    }

    #[test]
    fn the_view_hides_context_and_marks_failed_tools() {
        let view = session_view(AgentSessionRecord {
            id: "s".into(),
            title: "t".into(),
            created_at_ms: 0,
            updated_at_ms: 0,
            provider_id: "claude".into(),
            model: "m".into(),
            summary: None,
            summarized_until: 0,
            message_times_ms: vec![1000, 2000, 0],
            turn_tokens: vec![AgentTurnTokens {
                after_message: 3,
                input: 900,
                output: 40,
            }],
            total_tokens: AgentTokenTotals {
                input: 900,
                output: 40,
            },
            messages: vec![
                AgentMessage::user_text(
                    "explain\n\n<attached_context>\n- secret\n</attached_context>",
                ),
                AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![
                        ContentBlock::Text {
                            text: "sending".into(),
                        },
                        ContentBlock::ToolUse {
                            id: "t1".into(),
                            name: "send_request".into(),
                            input: json!({}),
                        },
                    ],
                },
                AgentMessage {
                    role: AgentRole::User,
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: "t1".into(),
                        content: "declined".into(),
                        is_error: true,
                    }],
                },
            ],
        });
        assert_eq!(
            view.items,
            vec![
                AgentViewItemDto::User {
                    text: "explain".into(),
                    at_ms: Some(1000),
                },
                AgentViewItemDto::Assistant {
                    text: "sending".into(),
                    at_ms: Some(2000),
                },
                AgentViewItemDto::Tool {
                    call_id: "t1".into(),
                    name: "send_request".into(),
                    input: json!({}),
                    is_error: true,
                },
                // The turn's tokens come after the messages it covers.
                AgentViewItemDto::Usage {
                    input_tokens: 900,
                    output_tokens: 40,
                },
            ]
        );
        assert_eq!(view.omitted_items, 0);
        assert_eq!(
            view.total_tokens,
            AgentTokenTotalsDto {
                input: 900,
                output: 40
            }
        );
    }

    #[test]
    fn errors_serialize_with_a_kind_and_no_secrets() {
        let value = serde_json::to_value(AgentCommandError::from(ChatModelError::Provider {
            status: 400,
            message: "bad model".into(),
        }))
        .unwrap();
        assert_eq!(
            value,
            json!({ "kind": "provider", "status": 400, "message": "bad model" })
        );
    }
}
