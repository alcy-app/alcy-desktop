//! Git in the workspace through the provider-neutral sync use cases, on real
//! repositories in temporary folders.

use std::path::{Path, PathBuf};

use alcy_app::{
    Resolution, VersionControlError, VersionStatus, WorkspaceFiles, push_changes, resolve_conflict,
    version_status,
};
use alcy_domain::{FileState, GitIdentity, WorkspaceLink};
use alcy_git::{
    BlobHashCache, GitError, Integration, PeerState, WorkspaceRemote, abort_merge, checkout,
    create_branch, delete_branch, file_versions, finish_merge, git_state, history, init_bare,
    init_workspace, merge_branch, peer_statuses, restore_file, sync,
};
use serde_json::{Value, json};

const MANIFEST: &str = "alcy-workspace.json";
const COLLECTIONS: &str = "alcy-collections.json";

/// The workspace folder on disk, as the sync use cases see it.
struct DiskFiles(PathBuf);

impl WorkspaceFiles for DiskFiles {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(self.0.join(name)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    fn write(&self, name: &str, content: &[u8]) -> Result<(), String> {
        std::fs::write(self.0.join(name), content).map_err(|error| error.to_string())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        std::fs::remove_file(self.0.join(name)).map_err(|error| error.to_string())
    }
}

struct Workspace {
    _dir: tempfile::TempDir,
    root: PathBuf,
    files: DiskFiles,
    link: WorkspaceLink,
    identity: GitIdentity,
    peer: String,
}

impl Workspace {
    fn new(name: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let link = WorkspaceLink::git(None, false).unwrap();
        init_workspace(&root, "main", &link.tracked_files()).unwrap();
        std::fs::write(root.join("alcy-history.json"), "[]").unwrap();
        Self {
            _dir: dir,
            files: DiskFiles(root.clone()),
            root,
            link,
            identity: GitIdentity::new(name, &format!("{}@example.com", name.to_lowercase()))
                .unwrap(),
            peer: name.to_lowercase(),
        }
    }

    fn remote(&self) -> WorkspaceRemote {
        WorkspaceRemote::new(
            &self.root,
            Some(self.identity.clone()),
            BlobHashCache::default(),
        )
    }

    fn write(&self, name: &str, value: &Value) {
        self.files
            .write(name, &serde_json::to_vec_pretty(value).unwrap())
            .unwrap();
    }

    fn json(&self, name: &str) -> Value {
        serde_json::from_slice(&self.files.read(name).unwrap().unwrap()).unwrap()
    }

    async fn status(&mut self) -> VersionStatus {
        let status = version_status(&self.files, &self.remote(), &self.link)
            .await
            .unwrap();
        self.link = status.link.clone();
        status
    }

    async fn commit(&mut self, message: &str) {
        let status = self.status().await;
        let outcome = push_changes(&self.files, &self.remote(), &status.link, message)
            .await
            .unwrap();
        self.link = outcome.link;
    }

    fn sync(&mut self, shared: &Path) -> alcy_git::SyncOutcome {
        let outcome = sync(
            &self.root,
            &self.files,
            &self.link,
            Some(&self.identity),
            shared,
            &self.peer,
        )
        .unwrap();
        self.link = outcome.link.clone();
        outcome
    }
}

fn state(status: &VersionStatus, name: &str) -> FileState {
    status
        .files
        .iter()
        .find(|file| file.name == name)
        .map(|file| file.state)
        .unwrap()
}

fn collections(requests: Value) -> Value {
    json!({ "collections": [{ "id": "c", "name": "API", "requests": requests }] })
}

fn request_url(workspace: &Workspace, id: &str) -> Option<String> {
    workspace.json(COLLECTIONS)["collections"][0]["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|request| request["id"] == id)
        .map(|request| request["url"].as_str().unwrap().to_string())
}

fn seeded(name: &str) -> Workspace {
    let workspace = Workspace::new(name);
    workspace.write(MANIFEST, &json!({ "name": "W" }));
    workspace.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/login" },
            { "id": "r2", "name": "Users", "url": "/users" }
        ])),
    );
    workspace
}

fn index_paths(root: &Path) -> Vec<String> {
    let repo = gix::open(root).unwrap();
    let index = repo.open_index().unwrap();
    index
        .entries()
        .iter()
        .map(|entry| entry.path(&index).to_string())
        .collect()
}

#[tokio::test]
async fn commits_through_the_sync_use_cases_and_keeps_the_index() {
    let mut ana = seeded("Ana");
    assert_eq!(
        state(&ana.status().await, COLLECTIONS),
        FileState::LocalAdded
    );
    ana.commit("Initial workspace").await;
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);
    assert_eq!(index_paths(&ana.root), [COLLECTIONS, MANIFEST]);

    let log = history(&ana.root, 0, 10).unwrap();
    assert_eq!(log.commits.len(), 1);
    assert_eq!(log.commits[0].author_name, "Ana");
    assert_eq!(log.commits[0].files, [COLLECTIONS, MANIFEST]);
    assert!(git_state(&ana.root).unwrap().has_commits);
}

#[tokio::test]
async fn branches_switch_files_and_protect_uncommitted_work() {
    let mut ana = seeded("Ana");
    ana.commit("Initial").await;
    create_branch(&ana.root, "feature").unwrap();
    let applied = checkout(&ana.root, &ana.files, &ana.link, "feature").unwrap();
    ana.link = applied.link;
    assert!(applied.files.is_empty());
    assert_eq!(git_state(&ana.root).unwrap().branch, "feature");

    ana.write(
        COLLECTIONS,
        &collections(json!([{ "id": "r1", "name": "Login", "url": "/feature" }])),
    );
    ana.commit("Feature").await;

    let applied = checkout(&ana.root, &ana.files, &ana.link, "main").unwrap();
    ana.link = applied.link;
    assert_eq!(applied.files, [COLLECTIONS]);
    assert_eq!(request_url(&ana, "r1").as_deref(), Some("/login"));
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);

    ana.write(COLLECTIONS, &collections(json!([])));
    assert_eq!(
        checkout(&ana.root, &ana.files, &ana.link, "feature"),
        Err(GitError::UncommittedChanges(vec![COLLECTIONS.to_string()]))
    );
    assert!(delete_branch(&ana.root, "main").is_err(), "current branch");
    delete_branch(&ana.root, "feature").unwrap();
    assert_eq!(git_state(&ana.root).unwrap().branches, ["main"]);
}

#[tokio::test]
async fn merging_combines_items_and_pauses_on_conflicts() {
    let mut ana = seeded("Ana");
    ana.commit("Initial").await;
    create_branch(&ana.root, "feature").unwrap();
    ana.link = checkout(&ana.root, &ana.files, &ana.link, "feature")
        .unwrap()
        .link;
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/v2/login" },
            { "id": "r2", "name": "Users", "url": "/users" }
        ])),
    );
    ana.commit("Feature login").await;
    ana.link = checkout(&ana.root, &ana.files, &ana.link, "main")
        .unwrap()
        .link;
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/login" },
            { "id": "r2", "name": "Users", "url": "/v2/users" }
        ])),
    );
    ana.commit("Main users").await;

    let (integration, applied) = merge_branch(
        &ana.root,
        &ana.files,
        &ana.link,
        Some(&ana.identity),
        "feature",
    )
    .unwrap();
    ana.link = applied.link;
    assert_eq!(integration, Integration::Merged);
    assert_eq!(request_url(&ana, "r1").as_deref(), Some("/v2/login"));
    assert_eq!(request_url(&ana, "r2").as_deref(), Some("/v2/users"));
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);
    assert!(history(&ana.root, 0, 1).unwrap().commits[0].merge);

    // Same request on both branches: a pending merge.
    ana.link = checkout(&ana.root, &ana.files, &ana.link, "feature")
        .unwrap()
        .link;
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/feature" },
            { "id": "r2", "name": "Users", "url": "/users" }
        ])),
    );
    ana.commit("Feature again").await;
    ana.link = checkout(&ana.root, &ana.files, &ana.link, "main")
        .unwrap()
        .link;
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/main" },
            { "id": "r2", "name": "Users", "url": "/v2/users" }
        ])),
    );
    ana.commit("Main again").await;

    let (integration, applied) = merge_branch(
        &ana.root,
        &ana.files,
        &ana.link,
        Some(&ana.identity),
        "feature",
    )
    .unwrap();
    ana.link = applied.link;
    assert_eq!(
        integration,
        Integration::Conflicts(vec![COLLECTIONS.to_string()])
    );
    let merge = git_state(&ana.root).unwrap().merge.unwrap();
    assert_eq!(merge.label, "feature");
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Conflict);
    assert!(matches!(
        push_changes(&ana.files, &ana.remote(), &ana.link, "x").await,
        Err(VersionControlError::Conflicts(_))
    ));
    assert_eq!(
        finish_merge(&ana.root, &ana.files, &ana.link, Some(&ana.identity), ""),
        Err(GitError::Conflicts(vec![COLLECTIONS.to_string()]))
    );

    // Cancel restores our side; merging again and keeping ours finishes.
    ana.link = abort_merge(&ana.root, &ana.files, &ana.link).unwrap().link;
    assert_eq!(request_url(&ana, "r1").as_deref(), Some("/main"));
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);

    ana.link = merge_branch(
        &ana.root,
        &ana.files,
        &ana.link,
        Some(&ana.identity),
        "feature",
    )
    .unwrap()
    .1
    .link;
    let status = ana.status().await;
    let (link, _) = resolve_conflict(
        &ana.files,
        &ana.remote(),
        &status.link,
        COLLECTIONS,
        Resolution::KeepLocal,
    )
    .await
    .unwrap();
    ana.link = link;
    let (_, applied) =
        finish_merge(&ana.root, &ana.files, &ana.link, Some(&ana.identity), "").unwrap();
    ana.link = applied.link;
    assert_eq!(git_state(&ana.root).unwrap().merge, None);
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);
    let last = &history(&ana.root, 0, 1).unwrap().commits[0];
    assert!(last.merge);
    assert_eq!(last.summary, "Merge changes from feature");
    assert_eq!(request_url(&ana, "r1").as_deref(), Some("/main"));
}

#[tokio::test]
async fn history_pages_and_restores_a_file_version() {
    let mut ana = seeded("Ana");
    ana.commit("c0").await;
    for index in 1..4 {
        ana.write(
            COLLECTIONS,
            &collections(json!([{ "id": "r1", "name": "Login", "url": format!("/v{index}") }])),
        );
        ana.commit(&format!("c{index}")).await;
    }
    let first = history(&ana.root, 0, 3).unwrap();
    let summaries: Vec<_> = first
        .commits
        .iter()
        .map(|commit| commit.summary.as_str())
        .collect();
    assert_eq!(summaries, ["c3", "c2", "c1"]);
    let rest = history(&ana.root, first.next_offset.unwrap(), 3).unwrap();
    assert_eq!(rest.commits.len(), 1);
    assert_eq!(rest.next_offset, None);

    let c1 = &first.commits[2].id;
    let versions = file_versions(&ana.root, c1, COLLECTIONS).unwrap();
    assert!(
        String::from_utf8(versions.at_commit.unwrap())
            .unwrap()
            .contains("/v1")
    );
    assert!(versions.before.is_some());

    restore_file(&ana.root, &ana.files, c1, COLLECTIONS).unwrap();
    assert_eq!(request_url(&ana, "r1").as_deref(), Some("/v1"));
    assert_eq!(
        state(&ana.status().await, COLLECTIONS),
        FileState::LocalModified
    );
}

#[tokio::test]
async fn people_sharing_a_folder_never_lose_concurrent_commits() {
    let shared = tempfile::tempdir().unwrap();
    init_bare(shared.path(), "main").unwrap();
    let shared = shared.path();

    let mut ana = seeded("Ana");
    ana.commit("Initial").await;
    assert!(ana.sync(shared).published);

    // Bia starts from an empty workspace and receives everything.
    let mut bia = Workspace::new("Bia");
    assert_eq!(
        peer_statuses(&bia.root, shared, &bia.peer).unwrap()[0].state,
        PeerState::Incoming
    );
    let outcome = bia.sync(shared);
    assert_eq!(outcome.integrated, ["Ana"]);
    assert_eq!(outcome.files, [COLLECTIONS, MANIFEST]);
    assert_eq!(request_url(&bia, "r1").as_deref(), Some("/login"));
    assert_eq!(
        peer_statuses(&bia.root, shared, &bia.peer).unwrap()[0].state,
        PeerState::UpToDate
    );

    // Both commit different requests before syncing.
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/ana" },
            { "id": "r2", "name": "Users", "url": "/users" }
        ])),
    );
    ana.commit("Ana's change").await;
    bia.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/login" },
            { "id": "r2", "name": "Users", "url": "/bia" }
        ])),
    );
    bia.commit("Bia's change").await;
    ana.sync(shared);
    let outcome = bia.sync(shared);
    assert_eq!(outcome.integrated, ["Ana"]);
    assert_eq!(request_url(&bia, "r1").as_deref(), Some("/ana"));
    assert_eq!(request_url(&bia, "r2").as_deref(), Some("/bia"));

    let outcome = ana.sync(shared);
    assert_eq!(outcome.integrated, ["Bia"]);
    assert_eq!(request_url(&ana, "r2").as_deref(), Some("/bia"));
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);
    let authors: Vec<_> = history(&ana.root, 0, 10)
        .unwrap()
        .commits
        .into_iter()
        .map(|commit| commit.summary)
        .collect();
    assert!(authors.contains(&"Ana's change".to_string()));
    assert!(authors.contains(&"Bia's change".to_string()));

    // The same request on both sides waits for a decision.
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/ana2" },
            { "id": "r2", "name": "Users", "url": "/bia" }
        ])),
    );
    ana.commit("Ana edits r1").await;
    bia.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/bia2" },
            { "id": "r2", "name": "Users", "url": "/bia" }
        ])),
    );
    bia.commit("Bia edits r1").await;
    ana.sync(shared);
    let outcome = bia.sync(shared);
    assert_eq!(
        outcome.merging,
        Some(("Ana".to_string(), vec![COLLECTIONS.to_string()]))
    );
    assert_eq!(state(&bia.status().await, COLLECTIONS), FileState::Conflict);
    assert_eq!(
        sync(
            &bia.root,
            &bia.files,
            &bia.link,
            Some(&bia.identity),
            shared,
            &bia.peer
        ),
        Err(GitError::MergeInProgress)
    );
}

#[tokio::test]
async fn a_peer_whose_objects_have_not_arrived_is_left_alone() {
    let shared_dir = tempfile::tempdir().unwrap();
    init_bare(shared_dir.path(), "main").unwrap();
    let shared = shared_dir.path();
    let mut ana = seeded("Ana");
    ana.commit("Initial").await;
    ana.sync(shared);

    // Simulate a sync client that delivered the ref before the commit object.
    let head = history(&ana.root, 0, 1).unwrap().commits[0].id.clone();
    let object = shared.join("objects").join(&head[..2]).join(&head[2..]);
    let saved = std::fs::read(&object).unwrap();
    std::fs::remove_file(&object).unwrap();

    let mut bia = Workspace::new("Bia");
    assert_eq!(
        peer_statuses(&bia.root, shared, &bia.peer).unwrap()[0].state,
        PeerState::Syncing
    );
    let outcome = bia.sync(shared);
    // Without the commit there is no author yet: the peer id stands in.
    assert_eq!(outcome.syncing, ["ana"]);
    assert!(outcome.integrated.is_empty());
    assert!(bia.files.read(COLLECTIONS).unwrap().is_none());

    std::fs::write(&object, saved).unwrap();
    assert_eq!(bia.sync(shared).integrated, ["Ana"]);
}

#[tokio::test]
async fn joining_replaces_a_fresh_workspace_but_protects_one_with_content() {
    let shared_dir = tempfile::tempdir().unwrap();
    init_bare(shared_dir.path(), "main").unwrap();
    let shared = shared_dir.path();
    let mut ana = seeded("Ana");
    ana.commit("Initial").await;
    ana.sync(shared);

    // Just created: its own manifest and an empty collections file.
    let mut bia = Workspace::new("Bia");
    bia.write(MANIFEST, &json!({ "name": "Bia's new workspace" }));
    bia.write(COLLECTIONS, &json!({ "collections": [] }));
    let outcome = bia.sync(shared);
    assert_eq!(outcome.integrated, ["Ana"]);
    assert_eq!(bia.json(MANIFEST)["name"], "W");
    assert_eq!(request_url(&bia, "r1").as_deref(), Some("/login"));
    assert_eq!(state(&bia.status().await, MANIFEST), FileState::Clean);

    // Work of its own is never overwritten.
    let carlos = Workspace::new("Carlos");
    carlos.write(
        COLLECTIONS,
        &collections(json!([{ "id": "c1", "name": "Mine", "url": "/mine" }])),
    );
    assert_eq!(
        sync(
            &carlos.root,
            &carlos.files,
            &carlos.link,
            Some(&carlos.identity),
            shared,
            &carlos.peer
        ),
        Err(GitError::UncommittedChanges(vec![COLLECTIONS.to_string()]))
    );
    assert_eq!(request_url(&carlos, "c1").as_deref(), Some("/mine"));
}
