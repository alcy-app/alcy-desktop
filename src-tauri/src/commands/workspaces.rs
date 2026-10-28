use std::path::PathBuf;
use std::sync::Mutex;

use alcy_domain::Workspace;
use alcy_storage::{
    RecentWorkspaceEntry, RecentWorkspacesStore, StorageError, WorkspaceLinkStore, WorkspaceStore,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

const WORKSPACES_FOLDER_NAME: &str = "Alcy Workspaces";
const DEFAULT_WORKSPACE_NAME: &str = "Workspace";
const MAX_NAME_ATTEMPTS: u32 = 1000;

/// Os commands de workspace leem e regravam a lista de recentes (e, ao
/// criar, escolhem o próximo nome de pasta livre). Rodando em
/// `spawn_blocking`, duas chamadas poderiam se cruzar e uma desfazer a
/// gravação da outra; o lock mantém a ordem que antes vinha de rodarem
/// todos na thread principal.
static WORKSPACE_OPERATIONS: Mutex<()> = Mutex::new(());

/// Roda `work` (disco: manifesto, lista de recentes, remoção de pasta) na
/// thread pool de blocking, fora da thread principal da interface, uma
/// operação de workspace por vez.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, WorkspaceCommandError> + Send + 'static,
) -> Result<T, WorkspaceCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WORKSPACE_OPERATIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        work()
    })
    .await
    .unwrap_or_else(|error| {
        Err(WorkspaceCommandError::Storage {
            message: error.to_string(),
        })
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub root_path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspaceDto {
    pub root_path: String,
    pub name: String,
    /// Se o workspace está vinculado a um repositório remoto (tem
    /// `alcy-git-link.json`) — mostra o símbolo de Git na lista sem exigir
    /// que o workspace esteja aberto. Um arquivo de vínculo corrompido ou
    /// ilegível conta como "não vinculado" em vez de derrubar a listagem
    /// inteira por causa de um único workspace.
    pub linked: bool,
}

fn recent_dto(entry: RecentWorkspaceEntry) -> RecentWorkspaceDto {
    let linked = WorkspaceLinkStore::new(entry.root_path.clone())
        .load()
        .ok()
        .flatten()
        .is_some();

    RecentWorkspaceDto {
        root_path: entry.root_path.to_string_lossy().to_string(),
        name: entry.name,
        linked,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspaceInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorkspaceInput {
    pub root_path: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorkspaceInput {
    pub root_path: String,
    pub delete_files: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceCommandError {
    Invalid { message: String },
    NotAWorkspace { message: String },
    Storage { message: String },
}

fn storage_error(error: StorageError) -> WorkspaceCommandError {
    WorkspaceCommandError::Storage {
        message: error.to_string(),
    }
}

fn workspace_to_dto(workspace: &Workspace, root_path: String) -> WorkspaceDto {
    WorkspaceDto {
        id: workspace.id.clone(),
        name: workspace.name().to_string(),
        root_path,
    }
}

fn record_recent(
    recent_store: &RecentWorkspacesStore,
    root_path: PathBuf,
    name: String,
) -> Result<(), WorkspaceCommandError> {
    recent_store
        .record(RecentWorkspaceEntry { root_path, name })
        .map(|_| ())
        .map_err(storage_error)
}

/// Primeiro nome livre em `workspaces_root`: "Workspace", "Workspace 2",
/// "Workspace 3"... Só verifica se o diretório já existe (nunca
/// sobrescreve algo que já esteja lá), sem exigir que seja um workspace
/// válido.
fn next_available_workspace(
    workspaces_root: &std::path::Path,
) -> Result<(PathBuf, String), WorkspaceCommandError> {
    for attempt in 1..=MAX_NAME_ATTEMPTS {
        let name = if attempt == 1 {
            DEFAULT_WORKSPACE_NAME.to_string()
        } else {
            format!("{DEFAULT_WORKSPACE_NAME} {attempt}")
        };
        let path = workspaces_root.join(&name);
        if !path.exists() {
            return Ok((path, name));
        }
    }

    Err(WorkspaceCommandError::Storage {
        message: format!(
            "não foi possível achar um nome livre em {}",
            workspaces_root.display()
        ),
    })
}

#[tauri::command]
pub async fn create_workspace(
    input: CreateWorkspaceInput,
    app: tauri::AppHandle,
    recent_store: tauri::State<'_, RecentWorkspacesStore>,
) -> Result<WorkspaceDto, WorkspaceCommandError> {
    let recent_store = RecentWorkspacesStore::clone(&recent_store);
    let result = match app.path().document_dir() {
        Ok(documents_dir) => {
            run_blocking(move || create_workspace_inner(input, documents_dir, &recent_store)).await
        }
        Err(error) => Err(WorkspaceCommandError::Storage {
            message: error.to_string(),
        }),
    };
    crate::logging::logged("alcy::workspace", "criar workspace", result)
}

fn create_workspace_inner(
    input: CreateWorkspaceInput,
    documents_dir: PathBuf,
    recent_store: &RecentWorkspacesStore,
) -> Result<WorkspaceDto, WorkspaceCommandError> {
    let workspaces_root = documents_dir.join(WORKSPACES_FOLDER_NAME);
    let (root_path, name) = next_available_workspace(&workspaces_root)?;

    let store = WorkspaceStore::new(root_path.clone());
    let workspace =
        Workspace::new(input.id, name).map_err(|error| WorkspaceCommandError::Invalid {
            message: error.to_string(),
        })?;

    store.save(&workspace).map_err(storage_error)?;
    record_recent(
        recent_store,
        root_path.clone(),
        workspace.name().to_string(),
    )?;

    Ok(workspace_to_dto(
        &workspace,
        root_path.to_string_lossy().to_string(),
    ))
}

#[tauri::command]
pub async fn open_workspace(
    input: OpenWorkspaceInput,
    recent_store: tauri::State<'_, RecentWorkspacesStore>,
) -> Result<WorkspaceDto, WorkspaceCommandError> {
    let recent_store = RecentWorkspacesStore::clone(&recent_store);
    let result = run_blocking(move || open_workspace_inner(input, &recent_store)).await;
    crate::logging::logged("alcy::workspace", "abrir workspace", result)
}

fn open_workspace_inner(
    input: OpenWorkspaceInput,
    recent_store: &RecentWorkspacesStore,
) -> Result<WorkspaceDto, WorkspaceCommandError> {
    let root_path = PathBuf::from(&input.root_path);
    let store = WorkspaceStore::new(root_path.clone());

    let workspace = store.load().map_err(|error| match error {
        StorageError::NotFound(message) => WorkspaceCommandError::NotAWorkspace { message },
        other => storage_error(other),
    })?;

    record_recent(recent_store, root_path, workspace.name().to_string())?;

    Ok(workspace_to_dto(&workspace, input.root_path))
}

#[tauri::command]
pub async fn rename_workspace(
    input: RenameWorkspaceInput,
    recent_store: tauri::State<'_, RecentWorkspacesStore>,
) -> Result<WorkspaceDto, WorkspaceCommandError> {
    let recent_store = RecentWorkspacesStore::clone(&recent_store);
    let result = run_blocking(move || rename_workspace_inner(input, &recent_store)).await;
    crate::logging::logged("alcy::workspace", "renomear workspace", result)
}

/// Troca só o nome gravado no manifesto — a pasta continua onde está, já
/// que a raiz é a identidade do workspace (abas, vínculo Git, recentes).
fn rename_workspace_inner(
    input: RenameWorkspaceInput,
    recent_store: &RecentWorkspacesStore,
) -> Result<WorkspaceDto, WorkspaceCommandError> {
    let root_path = PathBuf::from(&input.root_path);
    let store = WorkspaceStore::new(root_path.clone());

    let mut workspace = store.load().map_err(|error| match error {
        StorageError::NotFound(message) => WorkspaceCommandError::NotAWorkspace { message },
        other => storage_error(other),
    })?;
    workspace
        .rename(&input.name)
        .map_err(|error| WorkspaceCommandError::Invalid {
            message: error.to_string(),
        })?;

    store.save(&workspace).map_err(storage_error)?;
    recent_store
        .rename(&root_path, workspace.name())
        .map_err(storage_error)?;

    Ok(workspace_to_dto(&workspace, input.root_path))
}

/// Apagar a pasta (`remove_dir_all`) pode levar segundos num workspace com
/// muitos arquivos de histórico: roda fora da thread principal.
#[tauri::command]
pub async fn remove_workspace(
    input: RemoveWorkspaceInput,
    recent_store: tauri::State<'_, RecentWorkspacesStore>,
) -> Result<Vec<RecentWorkspaceDto>, WorkspaceCommandError> {
    let recent_store = RecentWorkspacesStore::clone(&recent_store);
    let result = run_blocking(move || remove_workspace_inner(input, &recent_store)).await;
    crate::logging::logged("alcy::workspace", "remover workspace", result)
}

fn remove_workspace_inner(
    input: RemoveWorkspaceInput,
    recent_store: &RecentWorkspacesStore,
) -> Result<Vec<RecentWorkspaceDto>, WorkspaceCommandError> {
    let root_path = PathBuf::from(&input.root_path);

    if input.delete_files {
        // Só apaga a pasta se ela de fato for um workspace Alcy — evita
        // apagar por engano um diretório arbitrário que o front-end
        // tenha nos recentes por engano.
        WorkspaceStore::new(root_path.clone())
            .load()
            .map_err(|error| match error {
                StorageError::NotFound(message) => WorkspaceCommandError::NotAWorkspace { message },
                other => storage_error(other),
            })?;

        std::fs::remove_dir_all(&root_path).map_err(|error| WorkspaceCommandError::Storage {
            message: error.to_string(),
        })?;
    }

    let entries = recent_store.remove(&root_path).map_err(storage_error)?;

    Ok(entries.into_iter().map(recent_dto).collect())
}

#[tauri::command]
pub async fn list_recent_workspaces(
    recent_store: tauri::State<'_, RecentWorkspacesStore>,
) -> Result<Vec<RecentWorkspaceDto>, WorkspaceCommandError> {
    let recent_store = RecentWorkspacesStore::clone(&recent_store);
    let result = run_blocking(move || list_recent_workspaces_inner(&recent_store)).await;
    crate::logging::logged("alcy::workspace", "listar workspaces recentes", result)
}

fn list_recent_workspaces_inner(
    recent_store: &RecentWorkspacesStore,
) -> Result<Vec<RecentWorkspaceDto>, WorkspaceCommandError> {
    recent_store
        .load()
        .map(|entries| entries.into_iter().map(recent_dto).collect())
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-workspaces-cmd-test-{label}-{nanos}-{count}"))
    }

    fn temp_recent_store() -> (RecentWorkspacesStore, PathBuf) {
        let path = temp_dir("recent").join("recent-workspaces.json");
        (RecentWorkspacesStore::new(path.clone()), path)
    }

    #[test]
    fn creates_a_workspace_in_the_default_location_with_the_default_name() {
        let documents_dir = temp_dir("documents");
        let (recent_store, recent_path) = temp_recent_store();

        let dto = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-1".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();

        assert_eq!(dto.id, "workspace-1");
        assert_eq!(dto.name, "Workspace");
        assert_eq!(
            dto.root_path,
            documents_dir
                .join("Alcy Workspaces")
                .join("Workspace")
                .to_string_lossy()
        );

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }

    #[test]
    fn increments_the_name_when_the_default_is_already_taken() {
        let documents_dir = temp_dir("documents-taken");
        let (recent_store, recent_path) = temp_recent_store();
        let input = || CreateWorkspaceInput {
            id: "workspace".to_string(),
        };

        create_workspace_inner(input(), documents_dir.clone(), &recent_store).unwrap();
        let second = create_workspace_inner(input(), documents_dir.clone(), &recent_store).unwrap();

        assert_eq!(second.name, "Workspace 2");

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }

    #[test]
    fn opens_a_workspace_created_before() {
        let documents_dir = temp_dir("open-documents");
        let (recent_store, recent_path) = temp_recent_store();

        let created = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-1".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();

        let dto = open_workspace_inner(
            OpenWorkspaceInput {
                root_path: created.root_path.clone(),
            },
            &recent_store,
        )
        .unwrap();

        assert_eq!(dto.id, "workspace-1");

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }

    #[test]
    fn open_fails_with_not_a_workspace_when_the_folder_has_no_manifest() {
        let root = temp_dir("open-missing");
        let (recent_store, recent_path) = temp_recent_store();

        let error = open_workspace_inner(
            OpenWorkspaceInput {
                root_path: root.to_string_lossy().to_string(),
            },
            &recent_store,
        )
        .unwrap_err();

        assert!(matches!(error, WorkspaceCommandError::NotAWorkspace { .. }));

        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }

    #[test]
    fn create_and_open_record_recent_workspaces() {
        let documents_dir = temp_dir("recent-documents");
        let (recent_store, recent_path) = temp_recent_store();

        let workspace_a = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-a".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();
        create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-b".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();
        open_workspace_inner(
            OpenWorkspaceInput {
                root_path: workspace_a.root_path.clone(),
            },
            &recent_store,
        )
        .unwrap();

        let recents = list_recent_workspaces_inner(&recent_store);

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();

        let recents = recents.unwrap();
        assert_eq!(recents.len(), 2);
        assert_eq!(recents[0].root_path, workspace_a.root_path);
        assert_eq!(recents[1].name, "Workspace 2");
    }

    #[test]
    fn marks_as_linked_only_the_recent_workspaces_that_have_a_git_link() {
        use alcy_domain::WorkspaceLink;

        let documents_dir = temp_dir("recent-linked-documents");
        let (recent_store, recent_path) = temp_recent_store();

        let linked = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-linked".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();
        let unlinked = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-unlinked".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();

        let link = WorkspaceLink::gitlab("acc", 1, "eq/proj", "main", "", false).unwrap();
        WorkspaceLinkStore::new(PathBuf::from(&linked.root_path))
            .save(&link)
            .unwrap();

        let recents = list_recent_workspaces_inner(&recent_store);

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();

        let recents = recents.unwrap();
        let linked_entry = recents
            .iter()
            .find(|entry| entry.root_path == linked.root_path)
            .unwrap();
        let unlinked_entry = recents
            .iter()
            .find(|entry| entry.root_path == unlinked.root_path)
            .unwrap();
        assert!(linked_entry.linked);
        assert!(!unlinked_entry.linked);
    }

    #[test]
    fn rename_updates_the_manifest_and_the_recent_entry_keeping_the_folder() {
        let documents_dir = temp_dir("rename-documents");
        let (recent_store, recent_path) = temp_recent_store();

        let created = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-1".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();

        let renamed = rename_workspace_inner(
            RenameWorkspaceInput {
                root_path: created.root_path.clone(),
                name: "  Payments API ".to_string(),
            },
            &recent_store,
        );
        let reopened = WorkspaceStore::new(PathBuf::from(&created.root_path)).load();
        let recents = list_recent_workspaces_inner(&recent_store);

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();

        let renamed = renamed.unwrap();
        assert_eq!(renamed.id, "workspace-1");
        assert_eq!(renamed.name, "Payments API");
        assert_eq!(renamed.root_path, created.root_path);
        assert_eq!(reopened.unwrap().name(), "Payments API");
        assert_eq!(recents.unwrap()[0].name, "Payments API");
    }

    #[test]
    fn rename_rejects_an_empty_name_without_touching_the_manifest() {
        let documents_dir = temp_dir("rename-empty-documents");
        let (recent_store, recent_path) = temp_recent_store();

        let created = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-1".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();

        let error = rename_workspace_inner(
            RenameWorkspaceInput {
                root_path: created.root_path.clone(),
                name: "   ".to_string(),
            },
            &recent_store,
        );
        let reopened = WorkspaceStore::new(PathBuf::from(&created.root_path)).load();

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();

        assert!(matches!(error, Err(WorkspaceCommandError::Invalid { .. })));
        assert_eq!(reopened.unwrap().name(), "Workspace");
    }

    #[test]
    fn rename_fails_with_not_a_workspace_when_the_folder_has_no_manifest() {
        let root = temp_dir("rename-missing");
        let (recent_store, recent_path) = temp_recent_store();

        let error = rename_workspace_inner(
            RenameWorkspaceInput {
                root_path: root.to_string_lossy().to_string(),
                name: "Other".to_string(),
            },
            &recent_store,
        )
        .unwrap_err();

        assert!(matches!(error, WorkspaceCommandError::NotAWorkspace { .. }));
        assert!(!root.exists());

        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }

    #[test]
    fn remove_without_delete_files_forgets_the_entry_but_keeps_the_folder() {
        let documents_dir = temp_dir("remove-keep-documents");
        let (recent_store, recent_path) = temp_recent_store();

        let created = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-1".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();

        let recents = remove_workspace_inner(
            RemoveWorkspaceInput {
                root_path: created.root_path.clone(),
                delete_files: false,
            },
            &recent_store,
        )
        .unwrap();

        assert!(recents.is_empty());
        assert!(PathBuf::from(&created.root_path).exists());

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }

    #[test]
    fn remove_with_delete_files_forgets_the_entry_and_deletes_the_folder() {
        let documents_dir = temp_dir("remove-delete-documents");
        let (recent_store, recent_path) = temp_recent_store();

        let created = create_workspace_inner(
            CreateWorkspaceInput {
                id: "workspace-1".to_string(),
            },
            documents_dir.clone(),
            &recent_store,
        )
        .unwrap();

        let recents = remove_workspace_inner(
            RemoveWorkspaceInput {
                root_path: created.root_path.clone(),
                delete_files: true,
            },
            &recent_store,
        )
        .unwrap();

        assert!(recents.is_empty());
        assert!(!PathBuf::from(&created.root_path).exists());

        fs::remove_dir_all(&documents_dir).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }

    #[test]
    fn remove_with_delete_files_fails_when_the_folder_is_not_a_workspace() {
        let root = temp_dir("remove-not-a-workspace");
        let (recent_store, recent_path) = temp_recent_store();
        fs::create_dir_all(&root).unwrap();

        let error = remove_workspace_inner(
            RemoveWorkspaceInput {
                root_path: root.to_string_lossy().to_string(),
                delete_files: true,
            },
            &recent_store,
        )
        .unwrap_err();

        assert!(matches!(error, WorkspaceCommandError::NotAWorkspace { .. }));
        assert!(root.exists());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(recent_path.parent().unwrap()).ok();
    }
}
