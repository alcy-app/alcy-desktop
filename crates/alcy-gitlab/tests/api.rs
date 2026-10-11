use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use alcy_app::{
    CommitAction, CredentialError, CredentialStore, RemoteError, RemoteFileMeta, RemoteRepository,
};
use alcy_domain::GitlabAccount;
use alcy_gitlab::{GitlabClient, TokenSet, credential_key, save_tokens};
use wiremock::matchers::{body_string_contains, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, String>>, AtomicUsize);

impl CredentialStore for MemoryCredentials {
    fn load(&self, key: &str) -> Result<Option<String>, CredentialError> {
        self.1.fetch_add(1, Ordering::Relaxed);
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn save(&self, key: &str, secret: &str) -> Result<(), CredentialError> {
        self.0.lock().unwrap().insert(key.into(), secret.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), CredentialError> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

struct Fixture {
    server: MockServer,
    account: GitlabAccount,
    credentials: MemoryCredentials,
    client: GitlabClient,
}

async fn fixture(tokens: Option<TokenSet>) -> Fixture {
    let server = MockServer::start().await;
    let account = GitlabAccount::new("u@host", &server.uri(), "cid", "u", "U").unwrap();
    let credentials = MemoryCredentials::default();
    if let Some(tokens) = tokens {
        save_tokens(&credentials, &account.id, &tokens).unwrap();
    }
    Fixture {
        server,
        account,
        credentials,
        client: GitlabClient::new(),
    }
}

fn valid_tokens(access: &str) -> TokenSet {
    TokenSet {
        access_token: access.into(),
        refresh_token: Some("refresh-1".into()),
        expires_at: None,
    }
}

fn stored_tokens(fixture: &Fixture) -> TokenSet {
    let raw = fixture
        .credentials
        .load(&credential_key(&fixture.account.id))
        .unwrap()
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[tokio::test]
async fn without_tokens_the_session_is_unauthorized() {
    let fixture = fixture(None).await;
    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);

    assert_eq!(session.current_user().await, Err(RemoteError::Unauthorized));
}

#[tokio::test]
async fn a_401_renews_the_tokens_once_and_retries() {
    let fixture = fixture(Some(valid_tokens("old"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .and(header("authorization", "Bearer old"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&fixture.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .and(header("authorization", "Bearer new"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"username": "u", "name": "Usuária"})),
        )
        .mount(&fixture.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .and(body_string_contains("refresh_token=refresh-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "new", "refresh_token": "refresh-2", "expires_in": 7200
        })))
        .expect(1)
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let user = session.current_user().await.unwrap();

    assert_eq!(user.name, "Usuária");
    let stored = stored_tokens(&fixture);
    assert_eq!(stored.access_token, "new");
    assert_eq!(stored.refresh_token.as_deref(), Some("refresh-2"));
}

#[tokio::test]
async fn expired_tokens_are_renewed_before_the_request() {
    let mut tokens = valid_tokens("stale");
    tokens.expires_at = Some(1);
    let fixture = fixture(Some(tokens)).await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh", "refresh_token": "refresh-2", "expires_in": 7200
        })))
        .mount(&fixture.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .and(header("authorization", "Bearer fresh"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"username": "u", "name": "U"})),
        )
        .expect(1)
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);

    assert!(session.current_user().await.is_ok());
}

#[tokio::test]
async fn a_rejected_refresh_means_the_session_expired() {
    let fixture = fixture(Some(valid_tokens("old"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&fixture.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(
            ResponseTemplate::new(400).set_body_json(serde_json::json!({"error": "invalid_grant"})),
        )
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);

    assert_eq!(session.current_user().await, Err(RemoteError::Unauthorized));
}

#[tokio::test]
async fn lists_projects_with_search_and_pagination() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects"))
        .and(query_param("membership", "true"))
        .and(query_param("min_access_level", "30"))
        .and(query_param("search", "alcy"))
        .and(query_param("page", "2"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-next-page", "3")
                .set_body_json(serde_json::json!([
                    {"id": 7, "path_with_namespace": "eq/alcy", "default_branch": "main"},
                    {"id": 8, "path_with_namespace": "eq/vazio", "default_branch": null}
                ])),
        )
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let page = session.list_projects(" alcy ", 2).await.unwrap();

    assert_eq!(page.next_page, Some(3));
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].path_with_namespace, "eq/alcy");
    assert_eq!(page.items[1].default_branch, None);
}

#[tokio::test]
async fn lists_branches_and_marks_the_default() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/repository/branches"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            {"name": "main", "default": true, "can_push": true},
            {"name": "dev", "default": false, "can_push": false}
        ])))
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let page = session.list_branches(7, "", 1).await.unwrap();

    assert_eq!(page.next_page, None);
    assert!(page.items[0].is_default && page.items[0].can_push);
    assert!(!page.items[1].is_default && !page.items[1].can_push);
}

#[tokio::test]
async fn reads_current_branch_permission() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/repository/branches/feature%2Fx"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "feature/x", "default": false, "can_push": true
        })))
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let branch = session.branch(7, "feature/x").await.unwrap();

    assert_eq!(branch.name, "feature/x");
    assert!(branch.can_push);
}

#[tokio::test]
async fn parallel_repository_requests_load_credentials_once_per_session() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    Mock::given(method("HEAD"))
        .and(query_param("ref", "main"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-gitlab-content-sha256", "abc123")
                .insert_header("x-gitlab-last-commit-id", "c1"),
        )
        .expect(2)
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let repository = session.repository(7, "main");

    let (first, second) = tokio::join!(
        repository.file_meta("a.json"),
        repository.file_meta("b.json")
    );

    assert!(first.is_ok() && second.is_ok());
    assert_eq!(fixture.credentials.1.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn reads_file_metadata_and_content_and_handles_absence() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    // `/` do caminho vira `%2F`; nomes simples ficam como estão.
    Mock::given(method("HEAD"))
        .and(path(
            "/api/v4/projects/7/repository/files/pasta%2Falcy-flows.json",
        ))
        .and(query_param("ref", "main"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-gitlab-content-sha256", "ABC123")
                .insert_header("x-gitlab-last-commit-id", "c9"),
        )
        .mount(&fixture.server)
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/api/v4/projects/7/repository/files/pasta%2Falcy-flows.json/raw",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"[1]".to_vec()))
        .mount(&fixture.server)
        .await;
    // Qualquer outro arquivo não existe (404 padrão do wiremock).

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let repository = session.repository(7, "main");

    assert_eq!(
        repository.file_meta("pasta/alcy-flows.json").await,
        Ok(RemoteFileMeta {
            sha256: Some("abc123".into()),
            last_commit_id: Some("c9".into())
        })
    );
    assert_eq!(
        repository.read_file("pasta/alcy-flows.json").await,
        Ok(Some(b"[1]".to_vec()))
    );
    assert_eq!(
        repository.file_meta("ausente.json").await,
        Ok(RemoteFileMeta::default())
    );
    assert_eq!(repository.read_file("ausente.json").await, Ok(None));
}

#[tokio::test]
async fn commits_all_actions_atomically_with_base64_content() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    Mock::given(method("POST"))
        .and(path("/api/v4/projects/7/repository/commits"))
        .and(body_string_contains("\"branch\":\"main\""))
        .and(body_string_contains("\"action\":\"create\""))
        .and(body_string_contains("\"content\":\"e30=\""))
        .and(body_string_contains("\"action\":\"update\""))
        .and(body_string_contains("\"last_commit_id\":\"c1\""))
        .and(body_string_contains("\"action\":\"delete\""))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({"id": "abc"})))
        .expect(1)
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let id = session
        .repository(7, "main")
        .commit(
            "Atualiza",
            &[
                CommitAction::Create {
                    path: "a.json".into(),
                    content: b"{}".to_vec(),
                },
                CommitAction::Update {
                    path: "b.json".into(),
                    content: b"[]".to_vec(),
                    last_commit_id: Some("c1".into()),
                },
                CommitAction::Delete {
                    path: "c.json".into(),
                    last_commit_id: Some("c2".into()),
                },
            ],
        )
        .await
        .unwrap();

    assert_eq!(id, "abc");
}

#[tokio::test]
async fn maps_stale_file_errors_to_conflict_and_others_to_rejected() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    Mock::given(method("POST"))
        .and(path("/api/v4/projects/7/repository/commits"))
        .and(body_string_contains("velho.json"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "message": "You are attempting to update a file that has changed since you started editing it."
        })))
        .mount(&fixture.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v4/projects/7/repository/commits"))
        .and(body_string_contains("protegido.json"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "message": "You are not allowed to push into this branch"
        })))
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let repository = session.repository(7, "main");
    let update = |name: &str| CommitAction::Update {
        path: name.into(),
        content: b"x".to_vec(),
        last_commit_id: Some("c1".into()),
    };

    assert_eq!(
        repository.commit("m", &[update("velho.json")]).await,
        Err(RemoteError::Conflict)
    );
    assert!(matches!(
        repository.commit("m", &[update("protegido.json")]).await,
        Err(RemoteError::Rejected(message)) if message.contains("not allowed")
    ));
}

#[tokio::test]
async fn refuses_oversized_commits_without_calling_the_server() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);

    let result = session
        .repository(7, "main")
        .commit(
            "grande",
            &[CommitAction::Create {
                path: "a.json".into(),
                content: vec![0; 20 * 1024 * 1024 + 1],
            }],
        )
        .await;

    assert_eq!(result, Err(RemoteError::TooLarge));
}

#[tokio::test]
async fn permission_and_missing_project_errors_are_structured() {
    let fixture = fixture(Some(valid_tokens("tok"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/9/repository/branches"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(serde_json::json!({"message": "404 Project Not Found"})),
        )
        .mount(&fixture.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/10/repository/branches"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(serde_json::json!({"message": "403 Forbidden"})),
        )
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);

    assert!(matches!(
        session.list_branches(9, "", 1).await,
        Err(RemoteError::NotFound(message)) if message.contains("Not Found")
    ));
    assert!(matches!(
        session.list_branches(10, "", 1).await,
        Err(RemoteError::Rejected(message)) if message.starts_with("sem permissão")
    ));
}

#[tokio::test]
async fn finds_a_project_by_its_encoded_path() {
    let fixture = fixture(Some(valid_tokens("t"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/grupo%2Fsub%2Falcy"))
        .and(header("authorization", "Bearer t"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": 42,
            "name": "Alcy",
            "path_with_namespace": "grupo/sub/alcy",
            "web_url": "https://gitlab.corp/grupo/sub/alcy"
        })))
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);
    let project = session.project_by_path("grupo/sub/alcy").await.unwrap();

    assert_eq!(project.id, 42);
    assert_eq!(project.name, "Alcy");
    assert_eq!(
        session.project_by_path("grupo/outro").await,
        Err(RemoteError::NotFound("HTTP 404 Not Found".into()))
    );
}

#[tokio::test]
async fn latest_release_skips_upcoming_releases_and_reads_links() {
    let fixture = fixture(Some(valid_tokens("t"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/42/releases"))
        .and(query_param("order_by", "released_at"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            {
                "tag_name": "v0.3.0", "name": "Futura", "description": null,
                "released_at": "2099-01-01T00:00:00Z", "upcoming_release": true,
                "assets": { "links": [] }
            },
            {
                "tag_name": "v0.2.0", "name": "Alcy 0.2.0", "description": "- Novidades",
                "released_at": "2026-09-01T12:00:00Z", "upcoming_release": false,
                "_links": { "self": "https://gitlab.corp/grupo/alcy/-/releases/v0.2.0" },
                "assets": { "links": [
                    { "name": "latest.json", "url": "https://gitlab.corp/l",
                      "direct_asset_url": "https://gitlab.corp/d/latest.json" }
                ] }
            }
        ])))
        .mount(&fixture.server)
        .await;

    let release = fixture
        .client
        .session(&fixture.account, &fixture.credentials)
        .latest_release(42)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(release.tag_name, "v0.2.0");
    assert_eq!(release.description.as_deref(), Some("- Novidades"));
    assert_eq!(
        release.web_url.as_deref(),
        Some("https://gitlab.corp/grupo/alcy/-/releases/v0.2.0")
    );
    assert_eq!(release.manifest_url(), Some("https://gitlab.corp/l"));
}

#[tokio::test]
async fn a_project_without_releases_has_no_latest_release() {
    let fixture = fixture(Some(valid_tokens("t"))).await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/42/releases"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&fixture.server)
        .await;

    let latest = fixture
        .client
        .session(&fixture.account, &fixture.credentials)
        .latest_release(42)
        .await;

    assert_eq!(latest, Ok(None));
}

#[tokio::test]
async fn access_token_renews_an_expiring_token() {
    let mut tokens = valid_tokens("stale");
    tokens.expires_at = Some(1);
    let fixture = fixture(Some(tokens)).await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh", "refresh_token": "refresh-2", "expires_in": 7200
        })))
        .expect(1)
        .mount(&fixture.server)
        .await;

    let session = fixture
        .client
        .session(&fixture.account, &fixture.credentials);

    assert_eq!(session.access_token().await, Ok("fresh".to_string()));
    assert_eq!(stored_tokens(&fixture).access_token, "fresh");
}
