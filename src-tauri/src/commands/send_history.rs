//! Histórico de envios de uma requisição e comparação entre respostas
//! (ADR 0036). O corpo das respostas nunca atravessa o IPC aqui: a lista
//! leva só resumos, e a comparação devolve o diff já calculado e limitado.

use std::path::PathBuf;

use alcy_app::{
    BodyDiff, ComparedOutcome, DiffLineKind, ResponseComparison, ResponseDiffHunk,
    compare_responses,
};
use alcy_domain::HistoryRetention;
use alcy_storage::{HistoryStore, HistorySummary, StorageError};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::execute_graphql_request::DEFAULT_HISTORY_RETENTION;
use crate::commands::execute_rest_request::HttpMethodInput;
use crate::commands::general_settings::HistoryPreferencesState;
use crate::commands::history::{
    HistoryCommandError, HistoryOutcomeSummaryDto, executed_at_ms, failure_kind_to_str,
    outcome_summary_dto, protocol_to_str,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRequestSendsInput {
    pub root_path: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRequestSendsInput {
    pub root_path: String,
    pub base_id: String,
    pub target_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSendBaselineInput {
    pub root_path: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    /// `None` desmarca o baseline atual da requisição.
    pub id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestSendDto {
    pub id: String,
    pub executed_at_ms: u64,
    pub protocol: String,
    /// URL já resolvida, como foi enviada.
    pub endpoint: String,
    /// `"get"`, `"post"`...; `None` em entradas antigas sem o método no índice.
    pub method: Option<String>,
    pub outcome: HistoryOutcomeSummaryDto,
    pub baseline: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ComparedOutcomeDto {
    #[serde(rename_all = "camelCase")]
    Response {
        status_code: u16,
    },
    Failed {
        kind: String,
        message: String,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDiffLineDto {
    /// `"context"`, `"added"` ou `"removed"`.
    pub kind: &'static str,
    pub text: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDiffHunkDto {
    pub base_start: u32,
    pub target_start: u32,
    pub lines: Vec<ResponseDiffLineDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BodyDiffDto {
    pub hunks: Vec<ResponseDiffHunkDto>,
    pub too_large: bool,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseComparisonDto {
    pub identical: bool,
    pub base: ComparedOutcomeDto,
    pub target: ComparedOutcomeDto,
    pub body: BodyDiffDto,
}

/// Envios da requisição (salva, pelo `requestId`) ou da aba (`tabId`), mais
/// recente primeiro.
/// Como `list_history`, poda antes o que passou da retenção configurada.
#[tauri::command]
pub async fn list_request_sends(
    input: ListRequestSendsInput,
    history: State<'_, HistoryPreferencesState>,
) -> Result<Vec<RequestSendDto>, HistoryCommandError> {
    let retention = history.get().retention;
    let result: Result<Vec<RequestSendDto>, HistoryCommandError> =
        async { run_blocking(move || list_request_sends_inner(input, retention)).await }.await;
    crate::logging::logged("alcy::history", "listar envios", result)
}

/// Compara a resposta de dois envios; `baseId` é o lado antigo ("−").
#[tauri::command]
pub async fn compare_request_sends(
    input: CompareRequestSendsInput,
) -> Result<ResponseComparisonDto, HistoryCommandError> {
    let result: Result<ResponseComparisonDto, HistoryCommandError> =
        async { run_blocking(move || compare_request_sends_inner(input)).await }.await;
    crate::logging::logged("alcy::history", "comparar envios", result)
}

/// Marca (ou desmarca, com `id: null`) o baseline dos envios da requisição.
#[tauri::command]
pub async fn set_send_baseline(input: SetSendBaselineInput) -> Result<(), HistoryCommandError> {
    let result: Result<(), HistoryCommandError> =
        async { run_blocking(move || set_send_baseline_inner(input)).await }.await;
    crate::logging::logged("alcy::history", "marcar envio de referência", result)
}

/// Leitura de disco e diff rodam fora da runtime assíncrona.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, HistoryCommandError> + Send + 'static,
) -> Result<T, HistoryCommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            Err(HistoryCommandError::Storage {
                message: error.to_string(),
            })
        })
}

fn store_for(root_path: String) -> HistoryStore {
    HistoryStore::new(PathBuf::from(root_path), DEFAULT_HISTORY_RETENTION)
}

fn list_request_sends_inner(
    input: ListRequestSendsInput,
    retention: HistoryRetention,
) -> Result<Vec<RequestSendDto>, HistoryCommandError> {
    let store = HistoryStore::new(PathBuf::from(input.root_path), retention.duration());
    if let Err(error) = store.prune() {
        log::warn!(target: "alcy::history", "falha ao podar o histórico: {error}");
    }
    let sends = store.load_sends(input.request_id.as_deref(), input.tab_id.as_deref())?;
    Ok(sends.into_iter().map(send_dto).collect())
}

fn compare_request_sends_inner(
    input: CompareRequestSendsInput,
) -> Result<ResponseComparisonDto, HistoryCommandError> {
    let store = store_for(input.root_path);
    let base = store
        .load_entry(&input.base_id)?
        .ok_or(HistoryCommandError::NotFound)?;
    let target = store
        .load_entry(&input.target_id)?
        .ok_or(HistoryCommandError::NotFound)?;
    // Sem a resposta guardada, o diff compararia corpos vazios.
    if base.response_omitted || target.response_omitted {
        return Err(HistoryCommandError::ResponseNotStored);
    }
    Ok(comparison_dto(compare_responses(
        &base.outcome,
        &target.outcome,
    )))
}

fn set_send_baseline_inner(input: SetSendBaselineInput) -> Result<(), HistoryCommandError> {
    store_for(input.root_path)
        .set_baseline(
            input.request_id.as_deref(),
            input.tab_id.as_deref(),
            input.id.as_deref(),
        )
        .map_err(|error| match error {
            StorageError::NotFound(_) => HistoryCommandError::NotFound,
            other => other.into(),
        })
}

fn send_dto(send: HistorySummary) -> RequestSendDto {
    RequestSendDto {
        id: send.id,
        executed_at_ms: executed_at_ms(send.executed_at),
        protocol: protocol_to_str(send.protocol).to_string(),
        endpoint: send.endpoint,
        method: send
            .method
            .map(|method| HttpMethodInput::from(method).as_str().to_string()),
        outcome: outcome_summary_dto(send.outcome),
        baseline: send.baseline,
    }
}

fn comparison_dto(comparison: ResponseComparison) -> ResponseComparisonDto {
    ResponseComparisonDto {
        identical: comparison.identical,
        base: outcome_dto(comparison.base),
        target: outcome_dto(comparison.target),
        body: body_diff_dto(comparison.body),
    }
}

fn outcome_dto(outcome: ComparedOutcome) -> ComparedOutcomeDto {
    match outcome {
        ComparedOutcome::Response { status_code } => ComparedOutcomeDto::Response { status_code },
        ComparedOutcome::Failed { kind, message } => ComparedOutcomeDto::Failed {
            kind: failure_kind_to_str(kind).to_string(),
            message,
        },
    }
}

fn body_diff_dto(diff: BodyDiff) -> BodyDiffDto {
    BodyDiffDto {
        hunks: diff.hunks.into_iter().map(hunk_dto).collect(),
        too_large: diff.too_large,
        binary: diff.binary,
        truncated: diff.truncated,
    }
}

fn hunk_dto(hunk: ResponseDiffHunk) -> ResponseDiffHunkDto {
    ResponseDiffHunkDto {
        base_start: hunk.base_start,
        target_start: hunk.target_start,
        lines: hunk
            .lines
            .into_iter()
            .map(|line| ResponseDiffLineDto {
                kind: match line.kind {
                    DiffLineKind::Context => "context",
                    DiffLineKind::Added => "added",
                    DiffLineKind::Removed => "removed",
                },
                text: line.text,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{
        Authentication, Endpoint, HistoryEntry, HistoryFailureKind, HistoryOutcome, ProtocolId,
        Request, RequestDocument, Response, ResponseMetadata,
    };
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-send-history-test-{nanos}-{count}"))
    }

    fn record(root: &Path, id: &str, request_id: Option<&str>, tab_id: Option<&str>, body: &str) {
        let request = Request::new(
            Endpoint::new("https://api.example.com/items").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            Vec::new(),
            Authentication::None,
        );
        let outcome = HistoryOutcome::Success(Response::new(
            200,
            5,
            body,
            Vec::new(),
            ResponseMetadata::default(),
        ));
        let entry = HistoryEntry::new(id, request, outcome, SystemTime::now())
            .with_source(request_id.map(str::to_string), tab_id.map(str::to_string));
        HistoryStore::new(root.to_path_buf(), Duration::from_secs(3600))
            .record(entry)
            .unwrap();
    }

    fn root_path(root: &Path) -> String {
        root.to_string_lossy().to_string()
    }

    #[test]
    fn lists_only_the_sends_of_the_request_or_tab_in_camel_case() {
        let root = temp_root();
        record(&root, "a", Some("req-1"), None, "{}");
        record(&root, "b", None, Some("tab-1"), "{}");
        record(&root, "c", Some("req-2"), None, "{}");

        let sends = list_request_sends_inner(
            ListRequestSendsInput {
                root_path: root_path(&root),
                request_id: Some("req-1".to_string()),
                tab_id: Some("tab-1".to_string()),
            },
            HistoryRetention::default(),
        )
        .unwrap();

        let ids: Vec<&str> = sends.iter().map(|send| send.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
        let json = serde_json::to_value(&sends[0]).unwrap();
        assert!(json.get("executedAtMs").is_some());
        assert_eq!(json["outcome"]["statusCode"], 200);
        assert_eq!(json["baseline"], false);
        assert_eq!(json["protocol"], "rest");
        assert_eq!(json["endpoint"], "https://api.example.com/items");
        assert_eq!(json["method"], "post");
        assert!(json.get("fingerprint").is_none());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_to_compare_a_send_whose_response_was_not_stored() {
        let root = temp_root();
        record(&root, "old", Some("req-1"), None, r#"{"a":1}"#);
        let request = Request::new(
            Endpoint::new("https://api.example.com/items").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            Vec::new(),
            Authentication::None,
        );
        let outcome = HistoryOutcome::Success(Response::new(
            200,
            5,
            r#"{"a":2}"#,
            Vec::new(),
            ResponseMetadata::default(),
        ));
        let summary_only = HistoryEntry::new("new", request, outcome, SystemTime::now())
            .with_source(Some("req-1".to_string()), None)
            .without_response_details();
        HistoryStore::new(root.clone(), Duration::from_secs(3600))
            .record(summary_only)
            .unwrap();

        let result = compare_request_sends_inner(CompareRequestSendsInput {
            root_path: root_path(&root),
            base_id: "old".to_string(),
            target_id: "new".to_string(),
        });

        assert_eq!(result.unwrap_err(), HistoryCommandError::ResponseNotStored);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn compares_two_sends() {
        let root = temp_root();
        record(&root, "old", Some("req-1"), None, r#"{"a":1,"b":2}"#);
        record(&root, "new", Some("req-1"), None, r#"{"b":2,"a":1}"#);

        let comparison = compare_request_sends_inner(CompareRequestSendsInput {
            root_path: root_path(&root),
            base_id: "old".to_string(),
            target_id: "new".to_string(),
        })
        .unwrap();

        assert!(!comparison.identical);
        assert!(!comparison.body.hunks.is_empty());
        let json = serde_json::to_value(&comparison).unwrap();
        assert_eq!(json["base"]["type"], "response");
        assert_eq!(json["base"]["statusCode"], 200);
        assert!(json["body"]["hunks"][0]["baseStart"].is_number());
        assert!(json["body"]["hunks"][0]["lines"][0]["kind"].is_string());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn comparing_an_unknown_send_fails_with_not_found() {
        let root = temp_root();
        record(&root, "old", Some("req-1"), None, "{}");

        let error = compare_request_sends_inner(CompareRequestSendsInput {
            root_path: root_path(&root),
            base_id: "old".to_string(),
            target_id: "missing".to_string(),
        })
        .unwrap_err();

        assert_eq!(error, HistoryCommandError::NotFound);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sets_and_clears_the_baseline() {
        let root = temp_root();
        record(&root, "a", Some("req-1"), None, "{}");
        record(&root, "b", Some("req-1"), None, "{}");
        let baseline_ids = || -> Vec<String> {
            list_request_sends_inner(
                ListRequestSendsInput {
                    root_path: root_path(&root),
                    request_id: Some("req-1".to_string()),
                    tab_id: None,
                },
                HistoryRetention::default(),
            )
            .unwrap()
            .into_iter()
            .filter(|send| send.baseline)
            .map(|send| send.id)
            .collect()
        };
        let set = |id: Option<&str>| {
            set_send_baseline_inner(SetSendBaselineInput {
                root_path: root_path(&root),
                request_id: Some("req-1".to_string()),
                tab_id: None,
                id: id.map(str::to_string),
            })
        };

        set(Some("a")).unwrap();
        assert_eq!(baseline_ids(), vec!["a"]);
        set(None).unwrap();
        assert!(baseline_ids().is_empty());
        assert_eq!(set(Some("missing")), Err(HistoryCommandError::NotFound));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn compares_failures_by_kind() {
        let outcome = |kind| HistoryOutcome::Failed {
            kind,
            message: "boom".to_string(),
        };
        let dto = comparison_dto(compare_responses(
            &outcome(HistoryFailureKind::Network),
            &outcome(HistoryFailureKind::Timeout),
        ));

        assert!(!dto.identical);
        assert_eq!(
            dto.target,
            ComparedOutcomeDto::Failed {
                kind: "timeout".to_string(),
                message: "boom".to_string(),
            }
        );
    }
}
