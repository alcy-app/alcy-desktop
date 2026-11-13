//! Git in the workspace through the provider-neutral sync use cases, on real
//! repositories in temporary folders.

use std::path::{Path, PathBuf};

use alcy_app::{
    CredentialError, CredentialStore, Resolution, VersionControlError, VersionStatus,
    WorkspaceFiles, push_changes, resolve_conflict, version_status,
};
use alcy_domain::{EnvironmentVariable, FileState, GitIdentity, WorkspaceLink};
use alcy_git::{
    BlobHashCache, FileDeletion, GitError, Integration, RepositoryOwner, Tracking, WorkspaceRemote,
    abort_merge, can_clone_as_remote, checkout, clone, clone_folder, create_branch, delete_branch,
    fetch, file_deletion, file_versions, finish_merge, git_state, history, init_workspace,
    merge_branch, merge_upstream, push, restore_file, set_remote, versions_environments,
};
use alcy_storage::{
    DiskWorkspaceFiles, EnvironmentStore, EnvironmentsSnapshot, LocalSecrets, SyncedWorkspaceFiles,
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
        DiskWorkspaceFiles::new(self.0.clone()).write(name, content)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        DiskWorkspaceFiles::new(self.0.clone()).delete(name)
    }
    fn list(&self, folder: &str) -> Result<Vec<String>, String> {
        DiskWorkspaceFiles::new(self.0.clone()).list(folder)
    }
}

struct Workspace {
    _dir: tempfile::TempDir,
    root: PathBuf,
    files: DiskFiles,
    link: WorkspaceLink,
    identity: GitIdentity,
}

impl Workspace {
    fn new(name: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let link = WorkspaceLink::new(false);
        init_workspace(&root, "main", &link.tracked_files()).unwrap();
        std::fs::write(root.join("alcy-history.json"), "[]").unwrap();
        Self {
            _dir: dir,
            files: DiskFiles(root.clone()),
            root,
            link,
            identity: GitIdentity::new(name, &format!("{}@example.com", name.to_lowercase()))
                .unwrap(),
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

    /// Fetches and merges `origin/<branch>`.
    async fn pull(&mut self) -> Result<(Integration, Vec<String>), GitError> {
        fetch(&self.root).await?;
        let (integration, applied) =
            merge_upstream(&self.root, &self.files, &self.link, Some(&self.identity))?;
        self.link = applied.link;
        Ok((integration, applied.files))
    }

    /// A workspace cloned from `url`, linked as the app does it.
    async fn cloned(name: &str, url: &Path) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("clone");
        clone(&url.to_string_lossy(), &root).await.unwrap();
        Self::linked(name, dir, root).await
    }

    /// A copy of the workspace folder `source`, which becomes its `origin`.
    async fn cloned_from_folder(name: &str, source: &Path) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("clone");
        clone_folder(source, &root).await.unwrap();
        Self::linked(name, dir, root).await
    }

    async fn linked(name: &str, dir: tempfile::TempDir, root: PathBuf) -> Self {
        let link = WorkspaceLink::new(versions_environments(&root).unwrap());
        init_workspace(&root, "main", &link.tracked_files()).unwrap();
        let mut workspace = Self {
            _dir: dir,
            files: DiskFiles(root.clone()),
            root,
            link,
            identity: GitIdentity::new(name, &format!("{}@example.com", name.to_lowercase()))
                .unwrap(),
        };
        workspace.status().await;
        workspace
    }
}

/// A bare repository standing in for a server or a shared folder.
fn origin(default_branch: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    gix::init_bare(dir.path()).unwrap();
    std::fs::write(
        dir.path().join("HEAD"),
        format!("ref: refs/heads/{default_branch}\n"),
    )
    .unwrap();
    dir
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
    assert_eq!(
        history(&ana.root, 0, 1).unwrap().commits[0].parents.len(),
        2
    );

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
    assert_eq!(last.parents.len(), 2);
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
async fn pushes_clones_and_pulls_through_origin() {
    let origin = origin("main");
    let url = origin.path().to_string_lossy().to_string();

    let mut ana = seeded("Ana");
    assert_eq!(push(&ana.root).await, Err(GitError::NoRemote));
    assert_eq!(
        set_remote(&ana.root, Some(" ext::sh -c touch ")).await,
        Err(GitError::InvalidRemote("ext::sh -c touch".to_string()))
    );
    assert_eq!(
        set_remote(&ana.root, Some(&url)).await.unwrap(),
        Some(url.clone())
    );
    ana.commit("Initial").await;
    let first = git_state(&ana.root).unwrap();
    assert_eq!(first.remote.as_deref(), Some(url.as_str()));
    assert_eq!(first.tracking, None);
    push(&ana.root).await.unwrap();
    assert_eq!(
        git_state(&ana.root).unwrap().tracking,
        Some(Tracking {
            ahead: 0,
            behind: 0
        })
    );

    let mut bia = Workspace::cloned("Bia", origin.path()).await;
    assert_eq!(request_url(&bia, "r1").as_deref(), Some("/login"));
    assert_eq!(state(&bia.status().await, COLLECTIONS), FileState::Clean);
    assert_eq!(
        git_state(&bia.root).unwrap().remote.as_deref(),
        Some(url.as_str())
    );

    // Both change different requests; the second push is rejected until a
    // pull merges the two.
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/ana" },
            { "id": "r2", "name": "Users", "url": "/users" }
        ])),
    );
    ana.commit("Ana's change").await;
    assert_eq!(
        git_state(&ana.root).unwrap().tracking,
        Some(Tracking {
            ahead: 1,
            behind: 0
        })
    );
    push(&ana.root).await.unwrap();
    bia.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/login" },
            { "id": "r2", "name": "Users", "url": "/bia" }
        ])),
    );
    bia.commit("Bia's change").await;
    assert_eq!(push(&bia.root).await, Err(GitError::PushRejected));
    // What the fetch brought shows in the graph before it is pulled.
    fetch(&bia.root).await.unwrap();
    let graph = history(&bia.root, 0, 10).unwrap().commits;
    let top = |summary: &str| {
        graph
            .iter()
            .find(|commit| commit.summary == summary)
            .unwrap()
    };
    assert_eq!(top("Ana's change").refs, ["origin/main"]);
    assert_eq!(top("Bia's change").refs, ["main"]);
    assert_eq!(top("Initial").parents.len(), 0);
    assert_eq!(top("Ana's change").parents, [top("Initial").id.clone()]);
    let (integration, files) = bia.pull().await.unwrap();
    assert_eq!(integration, Integration::Merged);
    assert_eq!(files, [COLLECTIONS]);
    assert_eq!(
        history(&bia.root, 0, 1).unwrap().commits[0].parents.len(),
        2
    );
    assert_eq!(request_url(&bia, "r1").as_deref(), Some("/ana"));
    assert_eq!(request_url(&bia, "r2").as_deref(), Some("/bia"));
    assert_eq!(
        git_state(&bia.root).unwrap().tracking,
        Some(Tracking {
            ahead: 2,
            behind: 0
        })
    );
    push(&bia.root).await.unwrap();

    assert_eq!(ana.pull().await.unwrap().0, Integration::FastForward);
    assert_eq!(request_url(&ana, "r2").as_deref(), Some("/bia"));
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);
    assert_eq!(ana.pull().await.unwrap().0, Integration::UpToDate);

    // The same request on both sides waits for a decision.
    ana.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/ana2" },
            { "id": "r2", "name": "Users", "url": "/bia" }
        ])),
    );
    ana.commit("Ana edits r1").await;
    push(&ana.root).await.unwrap();
    bia.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/bia2" },
            { "id": "r2", "name": "Users", "url": "/bia" }
        ])),
    );
    bia.commit("Bia edits r1").await;
    assert_eq!(
        bia.pull().await.unwrap().0,
        Integration::Conflicts(vec![COLLECTIONS.to_string()])
    );
    assert_eq!(state(&bia.status().await, COLLECTIONS), FileState::Conflict);
    assert_eq!(
        git_state(&bia.root).unwrap().merge.unwrap().label,
        "origin/main"
    );
    assert_eq!(bia.pull().await, Err(GitError::MergeInProgress));

    assert_eq!(set_remote(&ana.root, None).await.unwrap(), None);
    assert_eq!(git_state(&ana.root).unwrap().remote, None);
}

#[tokio::test]
async fn a_first_pull_fills_a_fresh_workspace_but_protects_one_with_content() {
    let origin = origin("trunk");
    let url = origin.path().to_string_lossy().to_string();
    let mut ana = seeded("Ana");
    set_remote(&ana.root, Some(&url)).await.unwrap();
    ana.commit("Initial").await;
    // Ana works on "main"; the remote's default branch is "trunk".
    create_branch(&ana.root, "trunk").unwrap();
    checkout(&ana.root, &ana.files, &ana.link, "trunk").unwrap();
    push(&ana.root).await.unwrap();

    // Just created: its own manifest and an empty collections file.
    let mut bia = Workspace::new("Bia");
    bia.write(MANIFEST, &json!({ "name": "Bia's new workspace" }));
    bia.write(COLLECTIONS, &json!({ "collections": [] }));
    set_remote(&bia.root, Some(&url)).await.unwrap();
    let (integration, _) = bia.pull().await.unwrap();
    assert_eq!(integration, Integration::FastForward);
    assert_eq!(git_state(&bia.root).unwrap().branch, "trunk");
    assert_eq!(bia.json(MANIFEST)["name"], "W");
    assert_eq!(request_url(&bia, "r1").as_deref(), Some("/login"));
    assert_eq!(state(&bia.status().await, MANIFEST), FileState::Clean);

    // Work of its own is never overwritten.
    let mut carlos = Workspace::new("Carlos");
    carlos.write(
        COLLECTIONS,
        &collections(json!([{ "id": "c1", "name": "Mine", "url": "/mine" }])),
    );
    set_remote(&carlos.root, Some(&url)).await.unwrap();
    assert!(matches!(
        carlos.pull().await,
        Err(GitError::UncommittedChanges(files)) if files.contains(&COLLECTIONS.to_string())
    ));
    assert_eq!(request_url(&carlos, "c1").as_deref(), Some("/mine"));
}

#[tokio::test]
async fn clone_needs_a_new_folder_and_an_alcy_workspace() {
    let origin = origin("main");
    let url = origin.path().to_string_lossy().to_string();

    let busy = tempfile::tempdir().unwrap();
    std::fs::write(busy.path().join("notes.txt"), "x").unwrap();
    assert_eq!(
        clone(&url, busy.path()).await,
        Err(GitError::DestinationExists)
    );
    assert!(busy.path().join("notes.txt").is_file());

    // An empty repository holds no workspace: the clone is removed.
    let parent = tempfile::tempdir().unwrap();
    let destination = parent.path().join("w");
    assert_eq!(
        clone(&url, &destination).await,
        Err(GitError::NotAWorkspace)
    );
    assert!(!destination.exists());

    let missing = parent.path().join("missing.git");
    assert!(matches!(
        clone(&missing.to_string_lossy(), &parent.path().join("x")).await,
        Err(GitError::Command(_))
    ));
}

fn owner_only_ana() -> FileDeletion {
    FileDeletion::OwnerOnly(RepositoryOwner {
        name: "Ana".to_string(),
        email: "ana@example.com".to_string(),
    })
}

#[tokio::test]
async fn only_the_first_author_may_delete_a_folder_everyone_shares() {
    let mut workspace = seeded("Ana");
    let ana = workspace.identity.clone();
    let bia = GitIdentity::new("Bia", "bia@example.com").unwrap();

    // Without commits there is no owner yet.
    assert_eq!(
        file_deletion(&workspace.root, Some(&bia)).unwrap(),
        FileDeletion::Allowed
    );

    workspace.commit("Initial").await;
    assert_eq!(
        file_deletion(&workspace.root, Some(&ana)).unwrap(),
        FileDeletion::Allowed
    );
    assert_eq!(
        file_deletion(&workspace.root, Some(&bia)).unwrap(),
        owner_only_ana()
    );
    assert_eq!(
        file_deletion(&workspace.root, None).unwrap(),
        owner_only_ana()
    );

    // Committing later does not make someone else the owner.
    workspace.identity = bia.clone();
    workspace.write(
        COLLECTIONS,
        &collections(json!([{ "id": "r1", "name": "Login", "url": "/v2/login" }])),
    );
    workspace.commit("Bia's change").await;
    assert_eq!(
        file_deletion(&workspace.root, Some(&bia)).unwrap(),
        owner_only_ana()
    );
}

#[tokio::test]
async fn a_cloned_copy_can_be_deleted_by_whoever_made_it() {
    let origin = origin("main");
    let url = origin.path().to_string_lossy().to_string();
    let mut ana = seeded("Ana");
    ana.commit("Initial").await;
    set_remote(&ana.root, Some(&url)).await.unwrap();
    push(&ana.root).await.unwrap();

    let bia = Workspace::cloned("Bia", origin.path()).await;

    assert_eq!(
        file_deletion(&bia.root, Some(&bia.identity)).unwrap(),
        FileDeletion::Allowed
    );
}

#[test]
fn a_folder_without_a_repository_has_no_owner_and_a_broken_one_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        file_deletion(dir.path(), None).unwrap(),
        FileDeletion::Allowed
    );

    std::fs::create_dir(dir.path().join(".git")).unwrap();
    assert!(file_deletion(dir.path(), None).is_err());
}

fn folder_config(root: &Path, key: &str) -> Option<String> {
    gix::open_opts(root, gix::open::Options::isolated())
        .unwrap()
        .config_snapshot()
        .string(key)
        .map(|value| value.to_string())
}

#[tokio::test]
async fn only_a_folder_holding_a_committed_workspace_without_a_remote_can_be_cloned() {
    let plain = tempfile::tempdir().unwrap();
    assert!(!can_clone_as_remote(plain.path()));

    let mut folder = seeded("Ana");
    assert!(!can_clone_as_remote(&folder.root), "no commits yet");
    folder.commit("Initial").await;
    assert!(can_clone_as_remote(&folder.root));

    set_remote(&folder.root, Some("https://example.com/team/api.git"))
        .await
        .unwrap();
    assert!(!can_clone_as_remote(&folder.root), "it has its own origin");

    let mut no_manifest = Workspace::new("Ana");
    no_manifest.write(COLLECTIONS, &collections(json!([])));
    no_manifest.commit("No manifest").await;
    assert!(!can_clone_as_remote(&no_manifest.root));
}

#[tokio::test]
async fn a_shared_folder_works_as_the_remote_of_its_copies() {
    let mut folder = seeded("Ana");
    folder.commit("Initial").await;
    let url = folder.root.to_string_lossy().to_string();

    let mut bia = Workspace::cloned_from_folder("Bia", &folder.root).await;
    assert_eq!(
        git_state(&bia.root).unwrap().remote.as_deref(),
        Some(url.as_str())
    );
    assert_eq!(
        file_deletion(&bia.root, Some(&bia.identity)).unwrap(),
        FileDeletion::Allowed,
        "a copy is the business of whoever made it"
    );
    assert_eq!(
        folder_config(&folder.root, "receive.denyCurrentBranch").as_deref(),
        Some("updateInstead")
    );
    assert!(
        !can_clone_as_remote(&bia.root),
        "a copy already has its origin"
    );

    // A push reaches the folder's own files.
    bia.write(
        COLLECTIONS,
        &collections(json!([{ "id": "r9", "name": "Bia", "url": "/b" }])),
    );
    bia.commit("From Bia").await;
    push(&bia.root).await.unwrap();
    assert_eq!(folder.json(COLLECTIONS), bia.json(COLLECTIONS));
    assert_eq!(state(&folder.status().await, COLLECTIONS), FileState::Clean);

    // A commit made in the folder comes back with a pull.
    folder.write(
        COLLECTIONS,
        &collections(json!([{ "id": "r10", "name": "Ana", "url": "/a" }])),
    );
    folder.commit("From Ana").await;
    assert_eq!(bia.pull().await.unwrap().0, Integration::FastForward);
    assert_eq!(bia.json(COLLECTIONS), folder.json(COLLECTIONS));
}

#[tokio::test]
async fn copies_and_pushed_folders_keep_the_committed_line_endings() {
    let mut folder = seeded("Ana");
    folder.commit("Initial").await;
    // Git for Windows' default, here in the folder's own configuration.
    let config = folder.root.join(".git").join("config");
    let mut content = std::fs::read_to_string(&config).unwrap();
    content.push_str("[core]\n\tautocrlf = true\n");
    std::fs::write(&config, content).unwrap();

    let mut bia = Workspace::cloned_from_folder("Bia", &folder.root).await;
    assert_eq!(state(&bia.status().await, COLLECTIONS), FileState::Clean);
    for root in [&folder.root, &bia.root] {
        assert_eq!(
            folder_config(root, "core.autocrlf").as_deref(),
            Some("false")
        );
        assert_eq!(folder_config(root, "core.eol").as_deref(), Some("lf"));
    }

    bia.write(
        COLLECTIONS,
        &collections(json!([{ "id": "r9", "name": "Bia", "url": "/b" }])),
    );
    bia.commit("From Bia").await;
    push(&bia.root).await.unwrap();
    assert_eq!(
        folder.files.read(COLLECTIONS).unwrap(),
        bia.files.read(COLLECTIONS).unwrap()
    );
    assert_eq!(state(&folder.status().await, COLLECTIONS), FileState::Clean);
}

#[tokio::test]
async fn a_folder_with_uncommitted_changes_refuses_the_push_and_keeps_them() {
    let mut folder = seeded("Ana");
    folder.commit("Initial").await;
    let mut bia = Workspace::cloned_from_folder("Bia", &folder.root).await;

    let unsaved = collections(json!([{ "id": "r3", "name": "Unsaved", "url": "/u" }]));
    folder.write(COLLECTIONS, &unsaved);
    bia.write(
        COLLECTIONS,
        &collections(json!([{ "id": "r9", "name": "Bia", "url": "/b" }])),
    );
    bia.commit("From Bia").await;

    assert_eq!(push(&bia.root).await, Err(GitError::RemoteFolderBusy));
    assert_eq!(folder.json(COLLECTIONS), unsaved);
}

#[tokio::test]
async fn a_folder_that_keeps_refusing_pushes_is_reported_as_such() {
    let mut folder = seeded("Ana");
    folder.commit("Initial").await;
    let config = folder.root.join(".git").join("config");
    let mut content = std::fs::read_to_string(&config).unwrap();
    content.push_str("[receive]\n\tdenyCurrentBranch = refuse\n");
    std::fs::write(&config, content).unwrap();

    let mut bia = Workspace::cloned_from_folder("Bia", &folder.root).await;
    assert_eq!(
        folder_config(&folder.root, "receive.denyCurrentBranch").as_deref(),
        Some("refuse"),
        "an existing setting stays"
    );

    bia.write(
        COLLECTIONS,
        &collections(json!([{ "id": "r9", "name": "Bia", "url": "/b" }])),
    );
    bia.commit("From Bia").await;
    assert_eq!(push(&bia.root).await, Err(GitError::RemoteFolderBusy));
}

/// Sealing keys of one person: no keyring, a key file of their own.
fn personal_secrets(dir: &Path) -> LocalSecrets {
    struct NoKeyring;

    impl CredentialStore for NoKeyring {
        fn load(&self, _key: &str) -> Result<Option<String>, CredentialError> {
            Err(CredentialError::Unavailable("no keyring".into()))
        }
        fn save(&self, _key: &str, _secret: &str) -> Result<(), CredentialError> {
            Err(CredentialError::Unavailable("no keyring".into()))
        }
        fn delete(&self, _key: &str) -> Result<(), CredentialError> {
            Ok(())
        }
    }

    LocalSecrets::new(Box::new(NoKeyring), dir.join("test-key"))
}

fn environments(base_url: &str, token: &str) -> EnvironmentsSnapshot {
    let variables = vec![
        EnvironmentVariable::new("baseUrl", base_url, false).unwrap(),
        EnvironmentVariable::new("token", token, true).unwrap(),
    ];
    EnvironmentsSnapshot {
        environments: vec![alcy_domain::Environment::new("env-1", "Dev", variables).unwrap()],
        active_environment_id: Some("env-1".to_string()),
    }
}

fn variable_value(root: &Path, secrets: &LocalSecrets, name: &str) -> String {
    let loaded = EnvironmentStore::new(root.to_path_buf(), secrets.clone())
        .load()
        .unwrap();
    loaded.snapshot.environments[0]
        .variables()
        .iter()
        .find(|variable| variable.name() == name)
        .map(|variable| variable.value().to_string())
        .unwrap()
}

#[tokio::test]
async fn a_folder_with_versioned_environments_takes_pushes_and_keeps_its_secrets() {
    let keys = tempfile::tempdir().unwrap();
    let ana_secrets = personal_secrets(&keys.path().join("ana"));
    let bia_secrets = personal_secrets(&keys.path().join("bia"));
    std::fs::create_dir_all(keys.path().join("ana")).unwrap();
    std::fs::create_dir_all(keys.path().join("bia")).unwrap();

    let mut folder = seeded("Ana");
    folder.link = WorkspaceLink::new(true);
    init_workspace(&folder.root, "main", &folder.link.tracked_files()).unwrap();
    EnvironmentStore::new(folder.root.clone(), ana_secrets.clone())
        .save(&environments("https://a", "ana-secret"))
        .unwrap();
    let synced = SyncedWorkspaceFiles::new(
        DiskWorkspaceFiles::new(folder.root.clone()),
        ana_secrets.clone(),
        false,
    );
    let status = version_status(&synced, &folder.remote(), &folder.link)
        .await
        .unwrap();
    let outcome = push_changes(&synced, &folder.remote(), &status.link, "Initial")
        .await
        .unwrap();
    folder.link = outcome.link;

    let mut bia = Workspace::cloned_from_folder("Bia", &folder.root).await;
    assert!(bia.link.tracked_files().contains(&"alcy-environments.json"));
    EnvironmentStore::new(bia.root.clone(), bia_secrets.clone())
        .save(&environments("https://b", "bia-secret"))
        .unwrap();
    bia.commit("From Bia").await;
    push(&bia.root).await.unwrap();

    assert_eq!(
        variable_value(&folder.root, &ana_secrets, "baseUrl"),
        "https://b"
    );
    assert_eq!(
        variable_value(&folder.root, &ana_secrets, "token"),
        "ana-secret"
    );
    assert_eq!(
        variable_value(&bia.root, &bia_secrets, "token"),
        "bia-secret"
    );
}

const ENVIRONMENTS: &str = "alcy-environments.json";

/// Three environments sharing a name, as "New environment" leaves them.
fn three_environments() -> EnvironmentsSnapshot {
    let environments = (1..=3)
        .map(|index| {
            let variables = vec![
                EnvironmentVariable::new("baseUrl", format!("https://{index}"), false).unwrap(),
            ];
            alcy_domain::Environment::new(format!("env-{index}"), "New environment", variables)
                .unwrap()
        })
        .collect();
    EnvironmentsSnapshot {
        environments,
        active_environment_id: Some("env-1".to_string()),
    }
}

fn environment_ids(root: &Path, secrets: &LocalSecrets) -> Vec<String> {
    EnvironmentStore::new(root.to_path_buf(), secrets.clone())
        .load()
        .unwrap()
        .snapshot
        .environments
        .into_iter()
        .map(|environment| environment.id)
        .collect()
}

/// What turning environment versioning on does to a linked workspace.
async fn version_environments_of(workspace: &mut Workspace) {
    workspace.link.include_environments = true;
    init_workspace(&workspace.root, "main", &workspace.link.tracked_files()).unwrap();
    workspace.status().await;
}

#[tokio::test]
async fn every_environment_reaches_a_clone_once_they_are_versioned() {
    let keys = tempfile::tempdir().unwrap();
    let secrets = personal_secrets(keys.path());
    let origin = origin("main");
    let mut ana = seeded("Ana");
    set_remote(&ana.root, Some(&origin.path().to_string_lossy()))
        .await
        .unwrap();
    EnvironmentStore::new(ana.root.clone(), secrets.clone())
        .save(&three_environments())
        .unwrap();
    ana.commit("Initial").await;
    push(&ana.root).await.unwrap();
    // Unversioned, a clone only gets the default environment.
    let before = Workspace::cloned("Bia", origin.path()).await;
    assert!(!before.root.join(ENVIRONMENTS).exists());

    version_environments_of(&mut ana).await;
    let gitignore = std::fs::read_to_string(ana.root.join(".gitignore")).unwrap();
    assert!(gitignore.contains("!/alcy-environments.json"));
    assert_eq!(
        state(&ana.status().await, ENVIRONMENTS),
        FileState::LocalAdded
    );
    assert_eq!(state(&ana.status().await, COLLECTIONS), FileState::Clean);
    ana.commit("Environments").await;
    push(&ana.root).await.unwrap();

    let bia = Workspace::cloned("Bia", origin.path()).await;
    assert!(bia.link.tracked_files().contains(&ENVIRONMENTS));
    assert_eq!(
        environment_ids(&bia.root, &secrets),
        ["env-1", "env-2", "env-3"]
    );
}

#[tokio::test]
async fn a_merge_by_someone_who_does_not_version_environments_keeps_them() {
    let keys = tempfile::tempdir().unwrap();
    let secrets = personal_secrets(keys.path());
    let origin = origin("main");
    let mut ana = seeded("Ana");
    set_remote(&ana.root, Some(&origin.path().to_string_lossy()))
        .await
        .unwrap();
    ana.commit("Initial").await;
    push(&ana.root).await.unwrap();
    // Bia joined before Ana started versioning the environments.
    let mut bia = Workspace::cloned("Bia", origin.path()).await;
    assert!(!bia.link.include_environments);

    EnvironmentStore::new(ana.root.clone(), secrets.clone())
        .save(&three_environments())
        .unwrap();
    version_environments_of(&mut ana).await;
    ana.commit("Environments").await;
    push(&ana.root).await.unwrap();

    bia.write(
        COLLECTIONS,
        &collections(json!([
            { "id": "r1", "name": "Login", "url": "/bia" },
            { "id": "r2", "name": "Users", "url": "/users" }
        ])),
    );
    bia.commit("Bia's change").await;
    assert_eq!(bia.pull().await.unwrap().0, Integration::Merged);
    assert!(versions_environments(&bia.root).unwrap());
    assert!(!bia.root.join(ENVIRONMENTS).exists());
    push(&bia.root).await.unwrap();

    assert_eq!(ana.pull().await.unwrap().0, Integration::FastForward);
    assert_eq!(request_url(&ana, "r1").as_deref(), Some("/bia"));
    assert_eq!(
        environment_ids(&ana.root, &secrets),
        ["env-1", "env-2", "env-3"]
    );
}

const DOCUMENT: &str = "alcy-documents/doc-1/document.json";
const DATASET: &str = "alcy-flow-assets/flow-1/users.csv";
const MOCKS: &str = "alcy-mock-servers.json";

fn text(workspace: &Workspace, name: &str) -> Option<String> {
    workspace
        .files
        .read(name)
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
}

#[tokio::test]
async fn documents_datasets_and_mock_servers_travel_with_the_workspace() {
    let origin = origin("main");
    let mut ana = seeded("Ana");
    set_remote(&ana.root, Some(&origin.path().to_string_lossy()))
        .await
        .unwrap();
    ana.files.write(DOCUMENT, br#"{"title":"Guide"}"#).unwrap();
    ana.files.write(DATASET, b"id\n1\n").unwrap();
    ana.write(MOCKS, &json!({ "version": 1, "servers": [] }));
    std::fs::write(ana.root.join("alcy-documents/doc-1/.draft"), "local").unwrap();
    let gitignore = std::fs::read_to_string(ana.root.join(".gitignore")).unwrap();
    assert!(gitignore.contains("!/alcy-documents/"));
    assert!(gitignore.contains("!/alcy-flow-assets/"));
    assert!(gitignore.contains("!/alcy-mock-servers.json"));

    let status = ana.status().await;
    for name in [DOCUMENT, DATASET, MOCKS] {
        assert_eq!(state(&status, name), FileState::LocalAdded, "{name}");
    }
    assert!(!status.files.iter().any(|file| file.name.contains(".draft")));
    ana.commit("Initial").await;
    push(&ana.root).await.unwrap();
    assert!(index_paths(&ana.root).contains(&DATASET.to_string()));
    assert!(
        history(&ana.root, 0, 1).unwrap().commits[0]
            .files
            .contains(&DOCUMENT.to_string())
    );

    let mut bia = Workspace::cloned("Bia", origin.path()).await;
    assert_eq!(
        text(&bia, DOCUMENT).as_deref(),
        Some(r#"{"title":"Guide"}"#)
    );
    assert_eq!(text(&bia, DATASET).as_deref(), Some("id\n1\n"));
    assert!(bia.root.join(MOCKS).is_file());
    assert!(!bia.root.join("alcy-documents/doc-1/.draft").exists());
    assert_eq!(state(&bia.status().await, DATASET), FileState::Clean);

    // Each side changes a different folder file; the pull merges both, and a
    // file deleted on one side goes away on the other.
    let second = "alcy-documents/doc-2/document.json";
    ana.files.write(second, b"{}").unwrap();
    ana.files.delete(DATASET).unwrap();
    ana.commit("Ana's document").await;
    push(&ana.root).await.unwrap();
    bia.files.write(DOCUMENT, br#"{"title":"Bia"}"#).unwrap();
    bia.commit("Bia's edit").await;
    let (integration, files) = bia.pull().await.unwrap();
    assert_eq!(integration, Integration::Merged);
    assert!(files.contains(&second.to_string()) && files.contains(&DATASET.to_string()));
    assert_eq!(text(&bia, second).as_deref(), Some("{}"));
    assert_eq!(text(&bia, DOCUMENT).as_deref(), Some(r#"{"title":"Bia"}"#));
    assert!(!bia.root.join("alcy-flow-assets/flow-1").exists());
    push(&bia.root).await.unwrap();
    assert_eq!(ana.pull().await.unwrap().0, Integration::FastForward);
    assert_eq!(text(&ana, DOCUMENT).as_deref(), Some(r#"{"title":"Bia"}"#));

    // Switching branches swaps the folder files too.
    create_branch(&bia.root, "draft").unwrap();
    let applied = checkout(&bia.root, &bia.files, &bia.link, "draft").unwrap();
    bia.link = applied.link;
    bia.files.write(DATASET, b"id\n2\n").unwrap();
    bia.commit("Dataset on draft").await;
    let applied = checkout(&bia.root, &bia.files, &bia.link, "main").unwrap();
    bia.link = applied.link;
    assert!(text(&bia, DATASET).is_none());
    let applied = checkout(&bia.root, &bia.files, &bia.link, "draft").unwrap();
    bia.link = applied.link;
    assert_eq!(text(&bia, DATASET).as_deref(), Some("id\n2\n"));
}

const LEGACY_SECRET: &str = "s3cr3t-Vh7Qk";

/// One request per authentication variant, each with `secret` in its secret
/// field when it has one.
fn collections_with_every_authentication(secret: &str) -> Vec<alcy_domain::Collection> {
    use alcy_domain::{
        Authentication, Collection, Endpoint, ProtocolId, Request, RequestDocument, SavedRequest,
    };
    let authentications = [
        Authentication::None,
        Authentication::Inherit,
        Authentication::CustomHeader {
            name: "X-Api-Key".to_string(),
            value: secret.to_string(),
        },
        Authentication::Bearer {
            token: secret.to_string(),
        },
        Authentication::Basic {
            username: "ana".to_string(),
            password: secret.to_string(),
        },
        Authentication::Digest {
            username: "ana".to_string(),
            password: secret.to_string(),
        },
        Authentication::OAuth2ClientCredentials {
            client_id: "client-1".to_string(),
            client_secret: secret.to_string(),
            token_url: "https://auth.example.com/token".to_string(),
            scope: "read".to_string(),
        },
    ];
    let requests = authentications
        .into_iter()
        .enumerate()
        .map(|(index, authentication)| {
            let request = Request::new(
                Endpoint::new("https://api.example.com").unwrap(),
                RequestDocument::new(ProtocolId::Rest, ""),
                "",
                vec![],
                authentication,
            );
            SavedRequest::new(format!("r{index}"), format!("Request {index}"), request).unwrap()
        })
        .collect();
    vec![Collection::new("c", "API", vec![], requests).unwrap()]
}

/// Every file of the workspace folder outside `.git` that contains `text`.
fn workspace_files_containing(root: &Path, text: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name != ".git") {
                    folders.push(path);
                }
            } else if std::fs::read(&path)
                .unwrap()
                .windows(text.len())
                .any(|window| window == text.as_bytes())
            {
                found.push(path);
            }
        }
    }
    found
}

#[tokio::test]
async fn a_legacy_workspace_with_committed_secrets_stops_committing_them() {
    let keys = tempfile::tempdir().unwrap();
    let secrets = personal_secrets(keys.path());
    let legacy = collections_with_every_authentication(LEGACY_SECRET);
    // An older Alcy wrote and committed the secrets in plain text.
    let mut ana = seeded("Ana");
    alcy_storage::export_collections(&ana.root.join(COLLECTIONS), &legacy).unwrap();
    ana.commit("Legacy").await;
    let legacy_commit = history(&ana.root, 0, 1).unwrap().commits[0].id.clone();
    let committed = file_versions(&ana.root, &legacy_commit, COLLECTIONS).unwrap();
    assert!(
        String::from_utf8(committed.at_commit.unwrap())
            .unwrap()
            .contains(LEGACY_SECRET)
    );

    // This version lists the collections and commits through the app's view.
    let store = alcy_storage::CollectionsStore::new(ana.root.clone(), secrets.clone());
    assert_eq!(store.load_and_seal().unwrap(), legacy);
    assert!(workspace_files_containing(&ana.root, LEGACY_SECRET).is_empty());
    let synced = SyncedWorkspaceFiles::new(
        DiskWorkspaceFiles::new(ana.root.clone()),
        secrets.clone(),
        false,
    );
    let status = version_status(&synced, &ana.remote(), &ana.link)
        .await
        .unwrap();
    assert_eq!(state(&status, COLLECTIONS), FileState::LocalModified);
    let outcome = push_changes(&synced, &ana.remote(), &status.link, "Seal secrets")
        .await
        .unwrap();
    ana.link = outcome.link;

    let head = history(&ana.root, 0, 1).unwrap().commits[0].id.clone();
    let committed = file_versions(&ana.root, &head, COLLECTIONS).unwrap();
    assert!(
        !String::from_utf8(committed.at_commit.unwrap())
            .unwrap()
            .contains(LEGACY_SECRET)
    );
    assert_eq!(index_paths(&ana.root), [COLLECTIONS, MANIFEST]);
    assert_eq!(store.load().unwrap(), legacy);
    // A clone gets the references and the other fields, not the secrets.
    let bia = Workspace::cloned_from_folder("Bia", &ana.root).await;
    assert!(workspace_files_containing(&bia.root, LEGACY_SECRET).is_empty());
}
