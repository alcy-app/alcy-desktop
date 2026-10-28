use std::collections::HashMap;
use std::sync::Mutex;

use alcy_app::{CommitAction, RemoteError, RemoteFileMeta, RemoteRepository, content_hash};
use reqwest::StatusCode;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, IF_MATCH};
use serde::Deserialize;
use serde_json::json;

use crate::client::{GraphItem, OnedriveSession, check, network_error, parse_json, segment};

/// Same ceiling as one GitLab commit.
const MAX_COMMIT_BYTES: usize = 20 * 1024 * 1024;
/// Graph's documented limit for a single-request upload; larger files go
/// through an upload session.
const SIMPLE_UPLOAD_LIMIT: usize = 4 * 1024 * 1024;
/// Upload session chunks must be multiples of 320 KiB.
const UPLOAD_CHUNK: usize = 10 * 320 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    upload_url: String,
}

/// Workspace files inside one OneDrive or SharePoint folder (ADR 0063).
///
/// Graph has no multi-file transaction: `commit` applies the actions in
/// sequence, each guarded by the item's eTag, and the use cases' `heal` step
/// reconciles a push that stops midway.
pub struct OnedriveRepository<'a> {
    session: OnedriveSession<'a>,
    drive_id: String,
    folder_id: String,
    /// Contents downloaded to compute a hash, handed to the next
    /// `read_file` of the same path instead of downloading twice.
    downloaded: Mutex<HashMap<String, Vec<u8>>>,
}

impl<'a> OnedriveRepository<'a> {
    pub(crate) fn new(session: OnedriveSession<'a>, drive_id: &str, folder_id: &str) -> Self {
        Self {
            session,
            drive_id: drive_id.to_string(),
            folder_id: folder_id.to_string(),
            downloaded: Mutex::new(HashMap::new()),
        }
    }

    /// Item addressed by its name relative to the linked folder.
    fn item_url(&self, path: &str) -> String {
        self.session.client.graph_url(&format!(
            "/drives/{}/items/{}:/{}:",
            segment(&self.drive_id),
            segment(&self.folder_id),
            segment(path)
        ))
    }

    fn take_downloaded(&self, path: &str) -> Option<Vec<u8>> {
        self.downloaded
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(path)
    }

    async fn download(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        let url = format!("{}/content", self.item_url(path));
        // Graph answers with a redirect to a pre-authenticated URL; reqwest
        // drops the Authorization header when the redirect changes origin.
        let response = self
            .session
            .send(|client, token| client.get(&url).bearer_auth(token))
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

    /// Creates (`if_match: None`) or replaces the file, failing with
    /// `Conflict` when it changed since it was read.
    async fn upload(
        &self,
        path: &str,
        content: &[u8],
        if_match: Option<&str>,
    ) -> Result<Option<String>, RemoteError> {
        let conflict_behavior = if if_match.is_some() {
            "replace"
        } else {
            "fail"
        };
        if content.len() > SIMPLE_UPLOAD_LIMIT {
            return self
                .upload_in_chunks(path, content, if_match, conflict_behavior)
                .await;
        }

        let url = format!("{}/content", self.item_url(path));
        let response = self
            .session
            .send(|client, token| {
                let mut request = client
                    .put(&url)
                    .query(&[("@microsoft.graph.conflictBehavior", conflict_behavior)])
                    .bearer_auth(token)
                    .header(CONTENT_TYPE, "application/octet-stream")
                    .body(content.to_vec());
                if let Some(etag) = if_match {
                    request = request.header(IF_MATCH, etag);
                }
                request
            })
            .await?;
        let item: GraphItem = parse_json(check(response).await?).await?;
        Ok(item.e_tag)
    }

    async fn upload_in_chunks(
        &self,
        path: &str,
        content: &[u8],
        if_match: Option<&str>,
        conflict_behavior: &str,
    ) -> Result<Option<String>, RemoteError> {
        let url = format!("{}/createUploadSession", self.item_url(path));
        let body = json!({ "item": { "@microsoft.graph.conflictBehavior": conflict_behavior } })
            .to_string();
        let response = self
            .session
            .send(|client, token| {
                let mut request = client
                    .post(&url)
                    .bearer_auth(token)
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.clone());
                if let Some(etag) = if_match {
                    request = request.header(IF_MATCH, etag);
                }
                request
            })
            .await?;
        let upload: UploadSession = parse_json(check(response).await?).await?;

        // The upload URL is pre-authenticated: the access token never goes
        // with the chunks.
        let http = self.session.client.http().await;
        let total = content.len();
        let mut last = None;
        for (index, chunk) in content.chunks(UPLOAD_CHUNK).enumerate() {
            let start = index * UPLOAD_CHUNK;
            let end = start + chunk.len() - 1;
            let response = http
                .put(&upload.upload_url)
                .header(CONTENT_LENGTH, chunk.len())
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
                .body(chunk.to_vec())
                .send()
                .await
                .map_err(network_error)?;
            last = Some(check(response).await?);
        }
        match last {
            Some(response) => {
                let item: GraphItem = parse_json(response).await?;
                Ok(item.e_tag)
            }
            None => Ok(None),
        }
    }

    async fn delete(&self, path: &str, if_match: &str) -> Result<(), RemoteError> {
        let url = self.item_url(path);
        let response = self
            .session
            .send(|client, token| {
                client
                    .delete(&url)
                    .bearer_auth(token)
                    .header(IF_MATCH, if_match)
            })
            .await?;
        // Already gone means someone else changed it since it was read.
        if response.status() == StatusCode::NOT_FOUND {
            return Err(RemoteError::Conflict);
        }
        check(response).await?;
        Ok(())
    }
}

impl RemoteRepository for OnedriveRepository<'_> {
    async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
        let url = self.item_url(path);
        let response = self
            .session
            .send(|client, token| {
                client
                    .get(&url)
                    .query(&[("$select", "id,name,eTag,cTag,file")])
                    .bearer_auth(token)
            })
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(RemoteFileMeta::default());
        }
        let item: GraphItem = parse_json(check(response).await?).await?;
        let Some(file) = item.file else {
            return Err(RemoteError::Rejected(format!(
                "{path} existe na pasta, mas não é um arquivo"
            )));
        };

        let reported = file
            .hashes
            .and_then(|hashes| hashes.sha256_hash)
            .map(|hash| hash.to_ascii_lowercase());
        let cached = item
            .c_tag
            .as_deref()
            .and_then(|c_tag| self.session.client.cached_hash(c_tag));
        let sha256 = match reported.or(cached) {
            Some(sha256) => sha256,
            None => {
                let Some(bytes) = self.download(path).await? else {
                    // Deleted between the two requests.
                    return Ok(RemoteFileMeta::default());
                };
                let sha256 = content_hash(&bytes);
                if let Some(c_tag) = item.c_tag.as_deref() {
                    self.session.client.cache_hash(c_tag, &sha256);
                }
                self.downloaded
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(path.to_string(), bytes);
                sha256
            }
        };
        Ok(RemoteFileMeta {
            sha256: Some(sha256),
            last_commit_id: item.e_tag,
        })
    }

    async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        if let Some(bytes) = self.take_downloaded(path) {
            return Ok(Some(bytes));
        }
        self.download(path).await
    }

    /// The message has nowhere to go in a drive; the returned id is the eTag
    /// of the last file written.
    async fn commit(
        &self,
        _message: &str,
        actions: &[CommitAction],
    ) -> Result<String, RemoteError> {
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

        let mut last_etag = None;
        for action in actions {
            match action {
                CommitAction::Create { path, content } => {
                    last_etag = self.upload(path, content, None).await?.or(last_etag);
                }
                CommitAction::Update {
                    path,
                    content,
                    last_commit_id,
                } => {
                    // Without the eTag read with the status there is nothing
                    // to guard the write with.
                    let etag = last_commit_id.as_deref().ok_or(RemoteError::Conflict)?;
                    last_etag = self.upload(path, content, Some(etag)).await?.or(last_etag);
                }
                CommitAction::Delete {
                    path,
                    last_commit_id,
                } => {
                    let etag = last_commit_id.as_deref().ok_or(RemoteError::Conflict)?;
                    self.delete(path, etag).await?;
                }
            }
        }
        Ok(last_etag.unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::tests::{account, logged_in};
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const ITEM: &str = "/drives/b!d/items/F1:/alcy-collections.json:";

    fn meta(server_item: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(server_item)
    }

    #[tokio::test]
    async fn meta_uses_the_reported_sha256_and_the_etag() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(ITEM))
            .respond_with(meta(serde_json::json!({
                "id": "I", "eTag": "\"{I},3\"", "cTag": "c3",
                "file": { "hashes": { "sha256Hash": "ABC123" } }
            })))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let repository = client
            .session(&account, &credentials)
            .repository("b!d", "F1");

        let meta = repository.file_meta("alcy-collections.json").await.unwrap();
        assert_eq!(meta.sha256.as_deref(), Some("abc123"));
        assert_eq!(meta.last_commit_id.as_deref(), Some("\"{I},3\""));
    }

    #[tokio::test]
    async fn meta_without_sha256_hashes_the_content_once_per_ctag() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(ITEM))
            .respond_with(meta(serde_json::json!({
                "id": "I", "eTag": "e1", "cTag": "c1",
                "file": { "hashes": { "quickXorHash": "x" } }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("{ITEM}/content")))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .expect(1)
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let session = client.session(&account, &credentials);

        let first = session.repository("b!d", "F1");
        let meta = first.file_meta("alcy-collections.json").await.unwrap();
        assert_eq!(meta.sha256, Some(content_hash(b"{}")));
        // The bytes downloaded for the hash serve the following read.
        assert_eq!(
            first.read_file("alcy-collections.json").await.unwrap(),
            Some(b"{}".to_vec())
        );

        // Another operation reuses the hash cached by cTag.
        let second = session.repository("b!d", "F1");
        let again = second.file_meta("alcy-collections.json").await.unwrap();
        assert_eq!(again.sha256, Some(content_hash(b"{}")));
    }

    #[tokio::test]
    async fn missing_files_and_folders_in_place_of_files() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(ITEM))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "itemNotFound", "message": "not found" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/drives/b!d/items/F1:/alcy-flows.json:"))
            .respond_with(meta(serde_json::json!({ "id": "D", "folder": {} })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("{ITEM}/content")))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let repository = client
            .session(&account, &credentials)
            .repository("b!d", "F1");

        assert_eq!(
            repository.file_meta("alcy-collections.json").await.unwrap(),
            RemoteFileMeta::default()
        );
        assert_eq!(
            repository.read_file("alcy-collections.json").await.unwrap(),
            None
        );
        assert!(matches!(
            repository.file_meta("alcy-flows.json").await,
            Err(RemoteError::Rejected(_))
        ));
    }

    #[tokio::test]
    async fn commit_guards_each_write_with_the_etag() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path(format!("{ITEM}/content")))
            .and(header("if-match", "e1"))
            .and(query_param("@microsoft.graph.conflictBehavior", "replace"))
            .respond_with(meta(serde_json::json!({ "id": "I", "eTag": "e2" })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/drives/b!d/items/F1:/alcy-flows.json:/content"))
            .and(query_param("@microsoft.graph.conflictBehavior", "fail"))
            .respond_with(meta(serde_json::json!({ "id": "J", "eTag": "f1" })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/drives/b!d/items/F1:/alcy-api-docs.json:"))
            .and(header("if-match", "g1"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let repository = client
            .session(&account, &credentials)
            .repository("b!d", "F1");

        let id = repository
            .commit(
                "ignored",
                &[
                    CommitAction::Update {
                        path: "alcy-collections.json".into(),
                        content: b"{}".to_vec(),
                        last_commit_id: Some("e1".into()),
                    },
                    CommitAction::Create {
                        path: "alcy-flows.json".into(),
                        content: b"[]".to_vec(),
                    },
                    CommitAction::Delete {
                        path: "alcy-api-docs.json".into(),
                        last_commit_id: Some("g1".into()),
                    },
                ],
            )
            .await
            .unwrap();
        assert_eq!(id, "f1");
    }

    #[tokio::test]
    async fn concurrent_changes_become_conflicts() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path(format!("{ITEM}/content")))
            .respond_with(ResponseTemplate::new(412).set_body_json(serde_json::json!({
                "error": { "code": "preconditionFailed", "message": "eTag mismatch" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/drives/b!d/items/F1:/alcy-flows.json:/content"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": { "code": "nameAlreadyExists", "message": "exists" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let repository = client
            .session(&account, &credentials)
            .repository("b!d", "F1");

        for action in [
            CommitAction::Update {
                path: "alcy-collections.json".into(),
                content: b"{}".to_vec(),
                last_commit_id: Some("old".into()),
            },
            CommitAction::Update {
                path: "alcy-collections.json".into(),
                content: b"{}".to_vec(),
                last_commit_id: None,
            },
            CommitAction::Create {
                path: "alcy-flows.json".into(),
                content: b"[]".to_vec(),
            },
            CommitAction::Delete {
                path: "alcy-api-docs.json".into(),
                last_commit_id: Some("g1".into()),
            },
        ] {
            assert_eq!(
                repository.commit("m", &[action]).await,
                Err(RemoteError::Conflict)
            );
        }
    }

    #[tokio::test]
    async fn large_files_use_an_upload_session_without_the_token() {
        let server = MockServer::start().await;
        let upload_url = format!("{}/upload/session-1", server.uri());
        Mock::given(method("POST"))
            .and(path(format!("{ITEM}/createUploadSession")))
            .and(header("if-match", "e1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "uploadUrl": upload_url })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let size = SIMPLE_UPLOAD_LIMIT + 1;
        let chunks = size.div_ceil(UPLOAD_CHUNK);
        Mock::given(method("PUT"))
            .and(path("/upload/session-1"))
            .respond_with(move |request: &Request| {
                assert!(request.headers.get("authorization").is_none());
                let range = request.headers["content-range"].to_str().unwrap();
                if range.ends_with(&format!("-{}/{size}", size - 1)) {
                    ResponseTemplate::new(201)
                        .set_body_json(serde_json::json!({ "id": "I", "eTag": "big" }))
                } else {
                    ResponseTemplate::new(202)
                        .set_body_json(serde_json::json!({ "nextExpectedRanges": [] }))
                }
            })
            .expect(chunks as u64)
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let repository = client
            .session(&account, &credentials)
            .repository("b!d", "F1");

        let id = repository
            .commit(
                "m",
                &[CommitAction::Update {
                    path: "alcy-collections.json".into(),
                    content: vec![b'x'; size],
                    last_commit_id: Some("e1".into()),
                }],
            )
            .await
            .unwrap();
        assert_eq!(id, "big");
    }

    #[tokio::test]
    async fn rejects_pushes_over_the_limit() {
        let server = MockServer::start().await;
        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let repository = client
            .session(&account, &credentials)
            .repository("b!d", "F1");

        let error = repository
            .commit(
                "m",
                &[CommitAction::Create {
                    path: "alcy-collections.json".into(),
                    content: vec![0; MAX_COMMIT_BYTES + 1],
                }],
            )
            .await
            .unwrap_err();
        assert_eq!(error, RemoteError::TooLarge);
    }
}
