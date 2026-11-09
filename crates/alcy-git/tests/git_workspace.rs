//! Git in the workspace through the provider-neutral sync use cases, on real
//! repositories in temporary folders.

use std::path::{Path, PathBuf};

use alcy_app::{
    Resolution, VersionControlError, VersionStatus, WorkspaceFiles, push_changes, resolve_conflict,
    version_status,
};
use alcy_domain::{FileState, GitIdentity, WorkspaceLink};
use alcy_git::{
    BlobHashCache, FileDeletion, GitError, Integration, RepositoryOwner, Tracking, WorkspaceRemote,
    abort_merge, checkout, clone, create_branch, delete_branch, fetch, file_deletion,
    file_versions, finish_merge, git_state, history, init_workspace, merge_branch, merge_upstream,
    push, restore_file, set_remote, versions_environments,
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
