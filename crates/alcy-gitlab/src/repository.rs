use alcy_app::{CommitAction, RemoteError, RemoteFileMeta, RemoteRepository};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::StatusCode;
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::json;

use crate::client::{GitlabSession, check, error_message, network_error};

/// Limite do que um único commit pode carregar.
const MAX_COMMIT_BYTES: usize = 20 * 1024 * 1024;

/// Caminho de arquivo como um único segmento de URL (`/` vira `%2F`).
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// Mensagens do GitLab que indicam que o arquivo mudou desde a última leitura.
const CONFLICT_HINTS: [&str; 4] = [
    "changed since",
    "already exists",
    "doesn't exist",
    "does not exist",
];

/// Repositório de um projeto e uma branch do GitLab (API v4).
pub struct GitlabRepository<'a> {
    session: GitlabSession<'a>,
    project_id: u64,
    branch: String,
}

#[derive(Deserialize)]
struct CommitResponse {
    id: String,
}

impl<'a> GitlabRepository<'a> {
    pub(crate) fn new(session: GitlabSession<'a>, project_id: u64, branch: &str) -> Self {
        Self {
            session,
            project_id,
            branch: branch.to_string(),
        }
    }

    fn file_url(&self, path: &str) -> String {
        self.session.api_url(&format!(
            "/projects/{}/repository/files/{}",
            self.project_id,
            utf8_percent_encode(path, PATH_SEGMENT)
        ))
    }
}

impl RemoteRepository for GitlabRepository<'_> {
    async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
        let url = self.file_url(path);
        let response = self
            .session
            .send(|client, token| {
                client
                    .head(&url)
                    .bearer_auth(token)
                    .query(&[("ref", self.branch.as_str())])
            })
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(RemoteFileMeta::default());
        }
        let response = check(response).await?;

        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        let sha256 = header("x-gitlab-content-sha256").ok_or_else(|| {
            RemoteError::Rejected("o GitLab não informou o hash do arquivo".into())
        })?;
        Ok(RemoteFileMeta {
            sha256: Some(sha256.to_ascii_lowercase()),
            last_commit_id: header("x-gitlab-last-commit-id"),
        })
    }

    async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        let url = format!("{}/raw", self.file_url(path));
        let response = self
            .session
            .send(|client, token| {
                client
                    .get(&url)
                    .bearer_auth(token)
                    .query(&[("ref", self.branch.as_str())])
            })
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let bytes = check(response)
            .await?
            .bytes()
            .await
            .map_err(network_error)?;
        Ok(Some(bytes.to_vec()))
    }

    async fn commit(&self, message: &str, actions: &[CommitAction]) -> Result<String, RemoteError> {
        let total: usize = actions
            .iter()
            .map(|action| match action {
                CommitAction::Create { content, .. } | CommitAction::Update { content, .. } => {
                    content.len()
                }
                CommitAction::Delete { .. } => 0,
            })
            .sum();
        if total > MAX_COMMIT_BYTES {
            return Err(RemoteError::TooLarge);
        }

        let actions: Vec<serde_json::Value> = actions.iter().map(action_to_json).collect();
        let body = serde_json::to_vec(&json!({
            "branch": self.branch,
            "commit_message": message,
            "actions": actions,
        }))
        .map_err(|error| RemoteError::Rejected(error.to_string()))?;

        let url = self
            .session
            .api_url(&format!("/projects/{}/repository/commits", self.project_id));
        let response = self
            .session
            .send(|client, token| {
                client
                    .post(&url)
                    .bearer_auth(token)
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.clone())
            })
            .await?;

        if response.status() == StatusCode::BAD_REQUEST {
            let message = error_message(response).await;
            let lower = message.to_lowercase();
            return Err(if CONFLICT_HINTS.iter().any(|hint| lower.contains(hint)) {
                RemoteError::Conflict
            } else {
                RemoteError::Rejected(message)
            });
        }

        let bytes = check(response)
            .await?
            .bytes()
            .await
            .map_err(network_error)?;
        let commit: CommitResponse = serde_json::from_slice(&bytes)
            .map_err(|error| RemoteError::Rejected(format!("resposta inesperada: {error}")))?;
        Ok(commit.id)
    }
}

fn action_to_json(action: &CommitAction) -> serde_json::Value {
    match action {
        CommitAction::Create { path, content } => json!({
            "action": "create",
            "file_path": path,
            "content": BASE64.encode(content),
            "encoding": "base64",
        }),
        CommitAction::Update {
            path,
            content,
            last_commit_id,
        } => {
            let mut value = json!({
                "action": "update",
                "file_path": path,
                "content": BASE64.encode(content),
                "encoding": "base64",
            });
            if let Some(id) = last_commit_id {
                value["last_commit_id"] = json!(id);
            }
            value
        }
        CommitAction::Delete {
            path,
            last_commit_id,
        } => {
            let mut value = json!({ "action": "delete", "file_path": path });
            if let Some(id) = last_commit_id {
                value["last_commit_id"] = json!(id);
            }
            value
        }
    }
}
