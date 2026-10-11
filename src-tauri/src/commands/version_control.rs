use std::path::PathBuf;

use alcy_app::{
    ChangeSelection, ConflictSide, DiffLineKind, FileDiff, ItemChangeKind, ItemResolution,
    RemoteRepository, Resolution, ResolutionPreviewInput, StructuredFileChanges, WorkspaceFiles,
    file_diff, local_file_status, preview_conflict_resolution as run_resolution_preview,
    preview_pull as run_preview_pull, pull_changes as run_pull, push_selected_changes,
    resolve_conflict as run_resolve, structured_file_changes_from_content, version_status,
};
use alcy_domain::{FileState, WorkspaceLink};
use alcy_gitlab::GitlabClient;
use alcy_platform::KeyringCredentialStore;
use alcy_storage::{
    DiskWorkspaceFiles, GitlabAccountsStore, LocalSecrets, SecuritySettingsStore,
    SyncedWorkspaceFiles, WorkspaceLinkStore,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::execution_registry::ExecutionRegistry;
use super::gitlab::{GitlabCommandError, cancellable, find_account};
use super::remote_content_cache::{
    CachedRemoteRepository, VersionControlCaches, structured_cache_key,
};
use super::workspace_operation_coordinator::WorkspaceOperationCoordinator;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileStateDto {
    Clean,
    LocalAdded,
    LocalModified,
    LocalDeleted,
    RemoteChanged,
    Conflict,
}

impl From<FileState> for FileStateDto {
    fn from(state: FileState) -> Self {
        match state {
            FileState::Clean => Self::Clean,
            FileState::LocalAdded => Self::LocalAdded,
            FileState::LocalModified => Self::LocalModified,
            FileState::LocalDeleted => Self::LocalDeleted,
            FileState::RemoteChanged => Self::RemoteChanged,
            FileState::Conflict => Self::Conflict,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLinkDto {
    pub account_id: String,
    pub project_id: u64,
    pub project_path: String,
    pub branch: String,
    pub directory: String,
    pub include_environments: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatusDto {
    pub name: String,
    pub state: FileStateDto,
    pub local_revision: Option<String>,
    pub remote_revision: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionStatusDto {
    pub link: WorkspaceLinkDto,
    pub files: Vec<FileStatusDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushResultDto {
    pub commit_id: String,
    pub pushed: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullResultDto {
    pub updated: Vec<String>,
    pub conflicts: Vec<String>,
    pub skipped: Vec<String>,
}

/// O que uma atualização traria, para revisão antes de aplicar.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullPreviewDto {
    pub incoming: Vec<String>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResultDto {
    /// O arquivo local foi reescrito ou removido (a interface recarrega).
    pub local_file_changed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKindDto {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLineDto {
    pub kind: DiffLineKindDto,
    pub text: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkDto {
    pub remote_start: u32,
    pub local_start: u32,
    pub lines: Vec<DiffLineDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffDto {
    pub name: String,
    pub remote_exists: bool,
    pub local_exists: bool,
    pub hunks: Vec<DiffHunkDto>,
    pub too_large: bool,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldChangeDto {
    pub name: String,
    pub remote: Option<String>,
    pub local: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedItemDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub item_kind: String,
    pub change_kind: String,
    pub fields: Vec<FieldChangeDto>,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredFileChangesDto {
    pub name: String,
    pub local_revision: Option<String>,
    pub remote_revision: Option<String>,
    pub supports_partial: bool,
    pub total_items: usize,
    pub next_offset: Option<usize>,
    pub items: Vec<ChangedItemDto>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionPreviewFieldDto {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionPreviewDto {
    pub item_id: String,
    pub label: String,
    pub item_kind: String,
    pub exists: bool,
    pub fields: Vec<ResolutionPreviewFieldDto>,
}

fn structured_changes_dto(
    changes: &StructuredFileChanges,
    offset: usize,
    limit: usize,
) -> StructuredFileChangesDto {
    let total_items = changes.items.len();
    let end = offset.saturating_add(limit).min(total_items);
    let items = if offset < total_items {
        &changes.items[offset..end]
    } else {
        &[]
    };
    StructuredFileChangesDto {
        name: changes.name.clone(),
        local_revision: changes.local_revision.clone(),
        remote_revision: changes.remote_revision.clone(),
        supports_partial: changes.supports_partial,
        total_items,
        next_offset: (end < total_items).then_some(end),
        items: items
            .iter()
            .map(|item| ChangedItemDto {
                id: item.id.clone(),
                parent_id: item.parent_id.clone(),
                label: item.label.clone(),
                item_kind: item.item_kind.clone(),
                change_kind: match item.change_kind {
                    ItemChangeKind::Added => "added",
                    ItemChangeKind::Modified => "modified",
                    ItemChangeKind::Deleted => "deleted",
                }
                .to_string(),
                fields: item
                    .fields
                    .iter()
                    .map(|field| FieldChangeDto {
                        name: field.name.clone(),
                        remote: field.remote.clone(),
                        local: field.local.clone(),
                    })
                    .collect(),
                dependencies: item.dependencies.clone(),
            })
            .collect(),
    }
}

fn link_dto(link: &WorkspaceLink) -> WorkspaceLinkDto {
    WorkspaceLinkDto {
        account_id: link.account_id.clone(),
        project_id: link.project_id,
        project_path: link.project_path.clone(),
        branch: link.branch.clone(),
        directory: link.directory.clone(),
        include_environments: link.include_environments,
    }
}

fn status_dto(link: &WorkspaceLink, files: Vec<alcy_app::FileStatus>) -> VersionStatusDto {
    VersionStatusDto {
        link: link_dto(link),
        files: files
            .into_iter()
            .map(|file| FileStatusDto {
                name: file.name,
                state: file.state.into(),
                local_revision: file.local_revision,
                remote_revision: file.remote_revision,
            })
            .collect(),
    }
}

fn diff_dto(diff: FileDiff) -> FileDiffDto {
    FileDiffDto {
        name: diff.name,
        remote_exists: diff.remote_exists,
        local_exists: diff.local_exists,
        hunks: diff
            .hunks
            .into_iter()
            .map(|hunk| DiffHunkDto {
                remote_start: hunk.remote_start,
                local_start: hunk.local_start,
                lines: hunk
                    .lines
                    .into_iter()
                    .map(|line| DiffLineDto {
                        kind: match line.kind {
                            DiffLineKind::Context => DiffLineKindDto::Context,
                            DiffLineKind::Added => DiffLineKindDto::Added,
                            DiffLineKind::Removed => DiffLineKindDto::Removed,
                        },
                        text: line.text,
                    })
                    .collect(),
            })
            .collect(),
        too_large: diff.too_large,
        binary: diff.binary,
        truncated: diff.truncated,
    }
}

/// Arquivos do workspace como o controle de versão os enxerga: o de
/// ambientes na visão portátil, sem valores sensíveis, a menos que o usuário
/// tenha desligado essa proteção nas configurações de segurança (ver
/// `SyncedWorkspaceFiles`). A preferência é lida a cada operação — é um
/// arquivo pequeno — para valer logo depois de alterada.
pub struct VersionControlFiles {
    secrets: LocalSecrets,
    settings: SecuritySettingsStore,
}

impl VersionControlFiles {
    pub fn new(secrets: LocalSecrets, settings: SecuritySettingsStore) -> Self {
        Self { secrets, settings }
    }

    fn open(
        &self,
        root: PathBuf,
    ) -> Result<SyncedWorkspaceFiles<DiskWorkspaceFiles>, GitlabCommandError> {
        let settings = self.settings.load()?;
        Ok(SyncedWorkspaceFiles::new(
            DiskWorkspaceFiles::new(root),
            self.secrets.clone(),
            settings.sync_sensitive_values,
        ))
    }
}

fn load_link(store: &WorkspaceLinkStore) -> Result<WorkspaceLink, GitlabCommandError> {
    store.load()?.ok_or(GitlabCommandError::NotLinked)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInput {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationInput {
    pub root_path: String,
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkWorkspaceInput {
    pub root_path: String,
    pub operation_id: String,
    pub account_id: String,
    pub project_id: u64,
    pub project_path: String,
    pub branch: String,
    #[serde(default)]
    pub directory: String,
    #[serde(default)]
    pub include_environments: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffInput {
    pub root_path: String,
    pub operation_id: String,
    pub file_name: String,
    #[serde(default)]
    pub expected_local_revision: Option<String>,
    #[serde(default)]
    pub expected_remote_revision: Option<String>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAndPushInput {
    pub root_path: String,
    pub operation_id: String,
    pub message: String,
    pub selections: Vec<ChangeSelectionInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSelectionInput {
    pub name: String,
    pub whole_file: bool,
    #[serde(default)]
    pub item_ids: Vec<String>,
    pub expected_local_revision: Option<String>,
    pub expected_remote_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSideDto {
    Local,
    Remote,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemResolutionDto {
    pub item_id: String,
    pub side: ConflictSideDto,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolutionDto {
    KeepLocal,
    KeepRemote,
    // `rename_all` no enum só afeta o nome das variantes; os campos desta
    // variante em struct precisam da própria anotação para virar camelCase.
    #[serde(rename_all = "camelCase")]
    PerItem {
        items: Vec<ItemResolutionDto>,
        expected_local_revision: Option<String>,
        expected_remote_revision: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictInput {
    pub root_path: String,
    pub operation_id: String,
    pub file_name: String,
    pub resolution: ResolutionDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConflictResolutionInput {
    pub root_path: String,
    pub operation_id: String,
    pub file_name: String,
    pub items: Vec<ItemResolutionDto>,
    pub expected_local_revision: Option<String>,
    pub expected_remote_revision: Option<String>,
    pub item_id: String,
}

#[tauri::command]
pub async fn get_workspace_link(
    input: RootInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
) -> Result<Option<WorkspaceLinkDto>, GitlabCommandError> {
    let result: Result<Option<WorkspaceLinkDto>, GitlabCommandError> = async {
        let root = PathBuf::from(input.root_path);
        let _workspace_guard = coordinator.read(&root).await;
        tauri::async_runtime::spawn_blocking(move || {
            let store = WorkspaceLinkStore::new(root);
            Ok(store.load()?.as_ref().map(link_dto))
        })
        .await
        .map_err(|error| GitlabCommandError::Files {
            message: error.to_string(),
        })?
    }
    .await;
    crate::logging::logged("alcy::vc", "ler vínculo do workspace", result)
}

#[tauri::command]
pub async fn unlink_workspace(
    input: RootInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    caches: State<'_, VersionControlCaches>,
) -> Result<(), GitlabCommandError> {
    let result: Result<(), GitlabCommandError> = async {
        let root = PathBuf::from(input.root_path);
        let _workspace_guard = coordinator.write(&root).await;
        WorkspaceLinkStore::new(root).remove()?;
        caches.clear().await;
        Ok(())
    }
    .await;
    crate::logging::logged("alcy::vc", "desvincular workspace", result)
}

/// Estado dos arquivos rastreados só a partir do disco (hash local × base
/// salva, sem chamar o GitLab) — usado para refletir uma edição local em
/// "Alterações" na hora, sem esperar (nem gerar) uma consulta ao remoto. A
/// checagem periódica/manual (`get_version_status`) continua sendo a única
/// fonte de `remoteChanged`/`conflict`.
#[tauri::command]
pub async fn get_local_version_status(
    input: RootInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
) -> Result<Vec<FileStatusDto>, GitlabCommandError> {
    let result: Result<Vec<FileStatusDto>, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let _workspace_guard = coordinator.read(&root).await;
        let files = files_view.open(root.clone())?;
        let statuses = tauri::async_runtime::spawn_blocking(move || {
            let link = load_link(&WorkspaceLinkStore::new(root))?;
            local_file_status(&files, &link).map_err(GitlabCommandError::from)
        })
        .await
        .map_err(|error| GitlabCommandError::Files {
            message: error.to_string(),
        })??;
        Ok(statuses
            .into_iter()
            .map(|file| FileStatusDto {
                name: file.name,
                state: file.state.into(),
                local_revision: file.local_revision,
                remote_revision: file.remote_revision,
            })
            .collect())
    }
    .await;
    crate::logging::logged("alcy::vc", "verificar status local", result)
}

/// Vincula o workspace a um projeto e uma branch e já calcula o estado
/// inicial (arquivos idênticos nos dois lados entram como sincronizados).
#[tauri::command]
pub async fn link_workspace(
    input: LinkWorkspaceInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<VersionStatusDto, GitlabCommandError> {
    let result: Result<VersionStatusDto, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let _workspace_guard = coordinator.write(&root).await;
        let account = find_account(&accounts, &input.account_id)?;
        let link = WorkspaceLink::new(
            input.account_id,
            input.project_id,
            input.project_path,
            input.branch,
            &input.directory,
            input.include_environments,
        )?;

        let session = client.session(&account, &*credentials);
        let files = files_view.open(root.clone())?;
        let status = cancellable(&registry, &input.operation_id, async {
            let branch = session.branch(link.project_id, &link.branch).await?;
            if !branch.can_push {
                return Err(GitlabCommandError::BranchNotWritable);
            }
            let remote = session.repository(link.project_id, &link.branch);
            version_status(&files, &remote, &link)
                .await
                .map_err(GitlabCommandError::from)
        })
        .await?;

        WorkspaceLinkStore::new(root).save(&status.link)?;
        Ok(status_dto(&status.link, status.files))
    }
    .await;
    crate::logging::logged("alcy::vc", "vincular workspace", result)
}

#[tauri::command]
pub async fn get_version_status(
    input: OperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<VersionStatusDto, GitlabCommandError> {
    let result: Result<VersionStatusDto, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let link = {
            let _workspace_guard = coordinator.read(&root).await;
            load_link(&WorkspaceLinkStore::new(root.clone()))?
        };
        let account = find_account(&accounts, &link.account_id)?;

        let session = client.session(&account, &*credentials);
        let remote = session.repository(link.project_id, &link.branch);
        let files = files_view.open(root.clone())?;
        let status = cancellable(&registry, &input.operation_id, async {
            version_status(&files, &remote, &link)
                .await
                .map_err(GitlabCommandError::from)
        })
        .await?;

        // A rede não mantém o lock exclusivo: o status local continua imediato.
        // Antes de publicar ou curar a base, confirme que nenhuma operação de
        // escrita trocou o vínculo/snapshot enquanto a consulta estava em voo.
        let _workspace_guard = coordinator.write(&root).await;
        if load_link(&WorkspaceLinkStore::new(root.clone()))? != link {
            return Err(GitlabCommandError::Cancelled);
        }
        if status.healed {
            WorkspaceLinkStore::new(root).save(&status.link)?;
        }
        Ok(status_dto(&status.link, status.files))
    }
    .await;
    crate::logging::logged("alcy::vc", "verificar status remoto", result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_file_diff(
    input: FileDiffInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    caches: State<'_, VersionControlCaches>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<FileDiffDto, GitlabCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _workspace_guard = coordinator.read(&root).await;
    let link = load_link(&WorkspaceLinkStore::new(root.clone()))?;
    let account = find_account(&accounts, &link.account_id)?;

    let session = client.session(&account, &*credentials);
    let target_path = link.remote_path(&input.file_name);
    let remote = CachedRemoteRepository::new(
        session.repository(link.project_id, &link.branch),
        &caches.remote,
        target_path,
        input.expected_remote_revision.clone(),
    );
    let files = files_view.open(root)?;
    let diff = cancellable(&registry, &input.operation_id, async {
        file_diff(&files, &remote, &link, &input.file_name)
            .await
            .map_err(GitlabCommandError::from)
    })
    .await?;
    Ok(diff_dto(diff))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_structured_file_changes(
    input: FileDiffInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    caches: State<'_, VersionControlCaches>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<StructuredFileChangesDto, GitlabCommandError> {
    let root = PathBuf::from(&input.root_path);
    let _workspace_guard = coordinator.read(&root).await;
    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(200).clamp(1, 200);
    if let Some(key) = structured_cache_key(
        &root,
        &input.file_name,
        input.expected_local_revision.as_deref(),
        input.expected_remote_revision.as_deref(),
    ) {
        if let Some(changes) = caches.structured.get(&key).await {
            return Ok(structured_changes_dto(&changes, offset, limit));
        }
    }

    let link = load_link(&WorkspaceLinkStore::new(root.clone()))?;
    let account = find_account(&accounts, &link.account_id)?;
    let session = client.session(&account, &*credentials);
    let target_path = link.remote_path(&input.file_name);
    let remote_path = target_path.clone();
    let remote = CachedRemoteRepository::new(
        session.repository(link.project_id, &link.branch),
        &caches.remote,
        target_path,
        input.expected_remote_revision.clone(),
    );
    let local_root = root.clone();
    let local_name = input.file_name.clone();
    let local_files = files_view.open(local_root)?;
    let local_task = tauri::async_runtime::spawn_blocking(move || {
        local_files
            .read(&local_name)
            .map_err(|message| GitlabCommandError::Files { message })
    });
    let parse_name = input.file_name.clone();
    let changes = cancellable(&registry, &input.operation_id, async {
        let remote_bytes = remote.read_file(&remote_path).await?;
        let local = local_task
            .await
            .map_err(|error| GitlabCommandError::Files {
                message: error.to_string(),
            })??;
        tauri::async_runtime::spawn_blocking(move || {
            structured_file_changes_from_content(&parse_name, local, remote_bytes)
                .map_err(GitlabCommandError::from)
        })
        .await
        .map_err(|error| GitlabCommandError::Files {
            message: error.to_string(),
        })?
    })
    .await?;
    let changes = std::sync::Arc::new(changes);
    if let Some(key) = structured_cache_key(
        &root,
        &input.file_name,
        changes.local_revision.as_deref(),
        changes.remote_revision.as_deref(),
    ) {
        caches
            .structured
            .insert(key, std::sync::Arc::clone(&changes))
            .await;
    }
    Ok(structured_changes_dto(&changes, offset, limit))
}

#[tauri::command]
pub async fn commit_and_push(
    input: CommitAndPushInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<PushResultDto, GitlabCommandError> {
    let result: Result<PushResultDto, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let _workspace_guard = coordinator.write(&root).await;
        let link_store = WorkspaceLinkStore::new(root.clone());
        let link = load_link(&link_store)?;
        let account = find_account(&accounts, &link.account_id)?;

        let session = client.session(&account, &*credentials);
        let remote = session.repository(link.project_id, &link.branch);
        let files = files_view.open(root)?;
        let outcome = cancellable(&registry, &input.operation_id, async {
            let selections: Vec<_> = input
                .selections
                .into_iter()
                .map(|selection| ChangeSelection {
                    name: selection.name,
                    whole_file: selection.whole_file,
                    item_ids: selection.item_ids,
                    expected_local_revision: selection.expected_local_revision,
                    expected_remote_revision: selection.expected_remote_revision,
                })
                .collect();
            push_selected_changes(&files, &remote, &link, &input.message, &selections)
                .await
                .map_err(GitlabCommandError::from)
        })
        .await?;

        link_store.save(&outcome.link)?;
        Ok(PushResultDto {
            commit_id: outcome.commit_id,
            pushed: outcome.pushed,
        })
    }
    .await;
    crate::logging::logged("alcy::vc", "commit e push", result)
}

/// O que `pull_changes` aplicaria, sem escrever nada em disco — usado para
/// revisar antes de aplicar (o frontend busca o diff de cada arquivo
/// incoming com `get_file_diff`/`get_structured_file_changes`).
#[tauri::command]
pub async fn preview_pull_changes(
    input: OperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<PullPreviewDto, GitlabCommandError> {
    let result: Result<PullPreviewDto, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let _workspace_guard = coordinator.write(&root).await;
        let link_store = WorkspaceLinkStore::new(root.clone());
        let link = load_link(&link_store)?;
        let account = find_account(&accounts, &link.account_id)?;

        let session = client.session(&account, &*credentials);
        let remote = session.repository(link.project_id, &link.branch);
        let files = files_view.open(root)?;
        let preview = cancellable(&registry, &input.operation_id, async {
            run_preview_pull(&files, &remote, &link)
                .await
                .map_err(GitlabCommandError::from)
        })
        .await?;

        if preview.healed {
            link_store.save(&preview.link)?;
        }
        Ok(PullPreviewDto {
            incoming: preview.incoming,
            conflicts: preview.conflicts,
        })
    }
    .await;
    crate::logging::logged("alcy::vc", "pré-visualizar pull", result)
}

#[tauri::command]
pub async fn pull_changes(
    input: OperationInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<PullResultDto, GitlabCommandError> {
    let result: Result<PullResultDto, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let _workspace_guard = coordinator.write(&root).await;
        let link_store = WorkspaceLinkStore::new(root.clone());
        let link = load_link(&link_store)?;
        let account = find_account(&accounts, &link.account_id)?;

        let session = client.session(&account, &*credentials);
        let remote = session.repository(link.project_id, &link.branch);
        let files = files_view.open(root)?;
        let outcome = cancellable(&registry, &input.operation_id, async {
            run_pull(&files, &remote, &link)
                .await
                .map_err(GitlabCommandError::from)
        })
        .await?;

        link_store.save(&outcome.link)?;
        Ok(PullResultDto {
            updated: outcome.updated,
            conflicts: outcome.conflicts,
            skipped: outcome.skipped,
        })
    }
    .await;
    crate::logging::logged("alcy::vc", "pull", result)
}

#[tauri::command]
pub async fn preview_conflict_resolution(
    input: PreviewConflictResolutionInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<ResolutionPreviewDto, GitlabCommandError> {
    let result: Result<ResolutionPreviewDto, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let _workspace_guard = coordinator.read(&root).await;
        let link = load_link(&WorkspaceLinkStore::new(root.clone()))?;
        let account = find_account(&accounts, &link.account_id)?;
        let items: Vec<_> = input
            .items
            .into_iter()
            .map(|item| ItemResolution {
                item_id: item.item_id,
                side: match item.side {
                    ConflictSideDto::Local => ConflictSide::Local,
                    ConflictSideDto::Remote => ConflictSide::Remote,
                },
            })
            .collect();
        let session = client.session(&account, &*credentials);
        let remote = session.repository(link.project_id, &link.branch);
        let files = files_view.open(root)?;
        let preview = cancellable(&registry, &input.operation_id, async {
            run_resolution_preview(
                &files,
                &remote,
                &link,
                ResolutionPreviewInput {
                    name: input.file_name,
                    items,
                    expected_local_revision: input.expected_local_revision,
                    expected_remote_revision: input.expected_remote_revision,
                    item_id: input.item_id,
                },
            )
            .await
            .map_err(GitlabCommandError::from)
        })
        .await?;
        Ok(ResolutionPreviewDto {
            item_id: preview.item_id,
            label: preview.label,
            item_kind: preview.item_kind,
            exists: preview.exists,
            fields: preview
                .fields
                .into_iter()
                .map(|field| ResolutionPreviewFieldDto {
                    name: field.name,
                    value: field.value,
                })
                .collect(),
        })
    }
    .await;
    crate::logging::logged("alcy::vc", "pré-visualizar resolução de conflito", result)
}

#[tauri::command]
pub async fn resolve_conflict(
    input: ResolveConflictInput,
    coordinator: State<'_, WorkspaceOperationCoordinator>,
    files_view: State<'_, VersionControlFiles>,
    registry: State<'_, ExecutionRegistry>,
    client: State<'_, GitlabClient>,
    credentials: State<'_, KeyringCredentialStore>,
    accounts: State<'_, GitlabAccountsStore>,
) -> Result<ResolveResultDto, GitlabCommandError> {
    let result: Result<ResolveResultDto, GitlabCommandError> = async {
        let root = PathBuf::from(&input.root_path);
        let _workspace_guard = coordinator.write(&root).await;
        let link_store = WorkspaceLinkStore::new(root.clone());
        let link = load_link(&link_store)?;
        let account = find_account(&accounts, &link.account_id)?;
        let resolution = match input.resolution {
            ResolutionDto::KeepLocal => Resolution::KeepLocal,
            ResolutionDto::KeepRemote => Resolution::KeepRemote,
            ResolutionDto::PerItem {
                items,
                expected_local_revision,
                expected_remote_revision,
            } => Resolution::PerItem {
                items: items
                    .into_iter()
                    .map(|item| ItemResolution {
                        item_id: item.item_id,
                        side: match item.side {
                            ConflictSideDto::Local => ConflictSide::Local,
                            ConflictSideDto::Remote => ConflictSide::Remote,
                        },
                    })
                    .collect(),
                expected_local_revision,
                expected_remote_revision,
            },
        };

        let session = client.session(&account, &*credentials);
        let remote = session.repository(link.project_id, &link.branch);
        let files = files_view.open(root)?;
        let (updated_link, local_file_changed) =
            cancellable(&registry, &input.operation_id, async {
                run_resolve(&files, &remote, &link, &input.file_name, resolution)
                    .await
                    .map_err(GitlabCommandError::from)
            })
            .await?;

        link_store.save(&updated_link)?;
        Ok(ResolveResultDto { local_file_changed })
    }
    .await;
    crate::logging::logged("alcy::vc", "resolver conflito", result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_camel_case_with_state_names() {
        let link = WorkspaceLink::new("u@h", 7, "eq/proj", "main", "", false).unwrap();
        let dto = status_dto(
            &link,
            vec![alcy_app::FileStatus {
                name: "alcy-flows.json".into(),
                state: FileState::LocalModified,
                local_revision: Some("local".into()),
                remote_revision: Some("remote".into()),
            }],
        );

        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            serde_json::json!({
                "link": {
                    "accountId": "u@h", "projectId": 7, "projectPath": "eq/proj",
                    "branch": "main", "directory": "", "includeEnvironments": false
                },
                "files": [{
                    "name": "alcy-flows.json",
                    "state": "localModified",
                    "localRevision": "local",
                    "remoteRevision": "remote"
                }]
            })
        );
    }

    #[test]
    fn diff_serializes_line_kinds() {
        let diff = FileDiff {
            name: "a.json".into(),
            remote_exists: true,
            local_exists: true,
            hunks: vec![alcy_app::DiffHunk {
                remote_start: 1,
                local_start: 1,
                lines: vec![alcy_app::DiffLine {
                    kind: DiffLineKind::Removed,
                    text: "x".into(),
                }],
            }],
            too_large: false,
            binary: false,
            truncated: false,
        };

        let value = serde_json::to_value(diff_dto(diff)).unwrap();
        assert_eq!(value["hunks"][0]["lines"][0]["kind"], "removed");
        assert_eq!(value["hunks"][0]["remoteStart"], 1);
    }

    #[test]
    fn unlinked_workspaces_report_not_linked() {
        let root = std::env::temp_dir().join("alcy-vc-command-test-unlinked");
        let store = WorkspaceLinkStore::new(root);
        assert_eq!(load_link(&store), Err(GitlabCommandError::NotLinked));
    }

    #[test]
    fn pull_preview_serializes_camel_case() {
        let dto = PullPreviewDto {
            incoming: vec!["alcy-collections.json".into()],
            conflicts: vec!["alcy-flows.json".into()],
        };
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            serde_json::json!({
                "incoming": ["alcy-collections.json"],
                "conflicts": ["alcy-flows.json"]
            })
        );
    }

    #[test]
    fn resolution_dto_round_trips_all_variants() {
        assert_eq!(
            serde_json::from_value::<ResolutionDto>(serde_json::json!({"kind": "keepLocal"}))
                .unwrap(),
            ResolutionDto::KeepLocal
        );
        assert_eq!(
            serde_json::from_value::<ResolutionDto>(serde_json::json!({"kind": "keepRemote"}))
                .unwrap(),
            ResolutionDto::KeepRemote
        );
        assert_eq!(
            serde_json::from_value::<ResolutionDto>(serde_json::json!({
                "kind": "perItem",
                "items": [{"itemId": "request:r1", "side": "local"}],
                "expectedLocalRevision": "abc",
                "expectedRemoteRevision": null
            }))
            .unwrap(),
            ResolutionDto::PerItem {
                items: vec![ItemResolutionDto {
                    item_id: "request:r1".into(),
                    side: ConflictSideDto::Local
                }],
                expected_local_revision: Some("abc".into()),
                expected_remote_revision: None,
            }
        );
    }
}
