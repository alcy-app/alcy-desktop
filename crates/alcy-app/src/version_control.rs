//! Controle de versão do workspace contra um repositório remoto.
//!
//! Não há repositório local: o estado de cada arquivo vem da comparação de
//! três conteúdos (base da última sincronização, local e remoto), por hash
//! SHA-256. Os casos de uso dependem só das portas `RemoteRepository` e
//! `WorkspaceFiles`.

use std::collections::{BTreeMap, HashSet};
use std::future::Future;

use alcy_domain::{FileState, MANIFEST_FILE, WorkspaceLink, classify};
use futures_util::future::try_join_all;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use thiserror::Error;

/// Cada lado do diff textual acima disso não é comparado.
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// Limite separado para o diff semântico. A estrutura por item continua útil
/// em workspaces grandes mesmo quando o diff textual integral seria caro.
pub const MAX_STRUCTURED_DIFF_BYTES: usize = 32 * 1024 * 1024;
/// Linhas devolvidas no diff (contexto incluído) antes de truncar.
pub const MAX_DIFF_LINES: usize = 4000;
const DIFF_CONTEXT_LINES: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RemoteError {
    #[error("sessão expirada ou sem permissão")]
    Unauthorized,
    #[error("não encontrado no repositório: {0}")]
    NotFound(String),
    /// O arquivo mudou no remoto depois da última sincronização.
    #[error("o repositório foi alterado por outra pessoa")]
    Conflict,
    #[error("falha de rede: {0}")]
    Network(String),
    #[error("recusado pelo repositório: {0}")]
    Rejected(String),
    #[error("arquivo grande demais para o repositório")]
    TooLarge,
    /// O chaveiro do sistema falhou ao entregar ou guardar o token.
    #[error("{0}")]
    Credentials(String),
}

/// Situação de um arquivo no remoto (`sha256: None` = não existe).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoteFileMeta {
    pub sha256: Option<String>,
    pub last_commit_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitAction {
    Create {
        path: String,
        content: Vec<u8>,
    },
    Update {
        path: String,
        content: Vec<u8>,
        last_commit_id: Option<String>,
    },
    Delete {
        path: String,
        last_commit_id: Option<String>,
    },
}

/// Repositório remoto já apontado para um projeto e uma branch.
pub trait RemoteRepository {
    fn file_meta(
        &self,
        path: &str,
    ) -> impl Future<Output = Result<RemoteFileMeta, RemoteError>> + Send;

    /// `None` quando o arquivo não existe.
    fn read_file(
        &self,
        path: &str,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, RemoteError>> + Send;

    /// Grava todas as ações num único commit e devolve o id dele.
    fn commit(
        &self,
        message: &str,
        actions: &[CommitAction],
    ) -> impl Future<Output = Result<String, RemoteError>> + Send;
}

/// Arquivos do workspace na máquina local (nomes relativos à raiz).
pub trait WorkspaceFiles {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, name: &str, content: &[u8]) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum VersionControlError {
    #[error(transparent)]
    Remote(#[from] RemoteError),
    #[error("falha ao acessar arquivos do workspace: {0}")]
    Files(String),
    #[error("há arquivos em conflito: {0:?}")]
    Conflicts(Vec<String>),
    #[error("não há alterações para enviar")]
    NothingToCommit,
    #[error("a mensagem de commit não pode ser vazia")]
    EmptyMessage,
    #[error("arquivo fora do controle de versão: {0}")]
    NotTracked(String),
    #[error("o arquivo não está em conflito: {0}")]
    NotInConflict(String),
    #[error("o manifesto do workspace não pode ser removido")]
    ManifestRemoval,
    #[error("a seleção de alterações está desatualizada")]
    StaleSelection,
    #[error("não foi possível interpretar {0} para uma seleção parcial")]
    InvalidStructuredFile(String),
    #[error("a resolução do conflito em {0} não cobre todos os itens alterados")]
    IncompleteResolution(String),
    #[error("{0} não permite resolução de conflito por item")]
    PartialResolutionUnsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStatus {
    pub name: String,
    pub state: FileState,
    /// Hash do conteúdo local usado para calcular este estado. Também serve
    /// como revisão barata para invalidar detalhes no frontend.
    pub local_revision: Option<String>,
    /// Hash remoto conhecido nesta consulta. No status exclusivamente local,
    /// contém a base sincronizada (a última revisão remota conhecida).
    pub remote_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionStatus {
    pub files: Vec<FileStatus>,
    /// Vínculo com a base atualizada para arquivos que já convergiram; o
    /// chamador o persiste quando `healed` é verdadeiro.
    pub link: WorkspaceLink,
    pub healed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushOutcome {
    pub commit_id: String,
    pub pushed: Vec<String>,
    pub link: WorkspaceLink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullOutcome {
    /// Arquivos locais reescritos ou removidos.
    pub updated: Vec<String>,
    pub conflicts: Vec<String>,
    /// Alterações remotas não aplicadas (ex.: remoção do manifesto).
    pub skipped: Vec<String>,
    pub link: WorkspaceLink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictSide {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemResolution {
    pub item_id: String,
    pub side: ConflictSide,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    KeepLocal,
    KeepRemote,
    /// Resolução item a item: para cada entidade alterada, qual lado
    /// prevalece. Só vale para arquivos com `supports_partial_format`; todo
    /// item alterado precisa de uma decisão explícita, sem valor padrão.
    PerItem {
        items: Vec<ItemResolution>,
        expected_local_revision: Option<String>,
        expected_remote_revision: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

/// Trecho alterado; `Removed` é o que só existe no remoto e `Added` o que só
/// existe no local.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    pub remote_start: u32,
    pub local_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
    pub name: String,
    pub remote_exists: bool,
    pub local_exists: bool,
    pub hunks: Vec<DiffHunk>,
    pub too_large: bool,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldChange {
    pub name: String,
    pub remote: Option<String>,
    pub local: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedItem {
    pub id: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub item_kind: String,
    pub change_kind: ItemChangeKind,
    pub fields: Vec<FieldChange>,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredFileChanges {
    pub name: String,
    pub local_revision: Option<String>,
    pub remote_revision: Option<String>,
    pub supports_partial: bool,
    pub items: Vec<ChangedItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeSelection {
    pub name: String,
    pub whole_file: bool,
    pub item_ids: Vec<String>,
    pub expected_local_revision: Option<String>,
    pub expected_remote_revision: Option<String>,
}

pub fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Entry {
    name: &'static str,
    local: Option<Vec<u8>>,
    local_hash: Option<String>,
    remote: RemoteFileMeta,
}

impl Entry {
    fn state(&self, link: &WorkspaceLink) -> FileState {
        classify(
            link.base.get(self.name).map(String::as_str),
            self.local_hash.as_deref(),
            self.remote.sha256.as_deref(),
        )
    }
}

async fn snapshot<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
) -> Result<Vec<Entry>, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    let names = link.tracked_files();
    let metas = try_join_all(names.iter().map(|name| {
        let path = name.to_string();
        async move { remote.file_meta(&path).await }
    }))
    .await?;

    names
        .into_iter()
        .zip(metas)
        .map(|(name, remote)| {
            let local = files.read(name).map_err(VersionControlError::Files)?;
            let local_hash = local.as_deref().map(content_hash);
            Ok(Entry {
                name,
                local,
                local_hash,
                remote,
            })
        })
        .collect()
}

/// Atualiza a base dos arquivos que já convergem (mesmo conteúdo dos dois
/// lados), evitando conflitos falsos numa edição futura.
fn heal(link: &WorkspaceLink, entries: &[Entry]) -> (WorkspaceLink, bool) {
    let mut healed = link.clone();
    for entry in entries {
        if entry.state(link) != FileState::Clean {
            continue;
        }
        match &entry.local_hash {
            Some(hash) => {
                healed.base.insert(entry.name.to_string(), hash.clone());
            }
            None => {
                healed.base.remove(entry.name);
            }
        }
    }
    let changed = healed != *link;
    (healed, changed)
}

pub async fn version_status<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
) -> Result<VersionStatus, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    let entries = snapshot(files, remote, link).await?;
    let (link, healed) = heal(link, &entries);
    let files = entries
        .iter()
        .map(|entry| FileStatus {
            name: entry.name.to_string(),
            state: entry.state(&link),
            local_revision: entry.local_hash.clone(),
            remote_revision: entry.remote.sha256.clone(),
        })
        .collect();
    Ok(VersionStatus {
        files,
        link,
        healed,
    })
}

/// Situação de cada arquivo rastreado comparando só o hash local com a
/// `base` salva — sem tocar o remoto. Mais rápida e sem custo de rede, mas
/// otimista: assume que o remoto não mudou, então nunca produz
/// `RemoteChanged`/`Conflict` (isso continua exigindo `version_status`).
/// Serve para refletir uma edição local na hora (ex.: logo após um
/// autosave), sem gerar uma chamada à API a cada alteração; o chamador
/// mescla o resultado com o último estado conhecido em vez de substituí-lo
/// por inteiro, para não perder um `RemoteChanged`/`Conflict` já detectado.
pub fn local_file_status<F>(
    files: &F,
    link: &WorkspaceLink,
) -> Result<Vec<FileStatus>, VersionControlError>
where
    F: WorkspaceFiles,
{
    link.tracked_files()
        .into_iter()
        .map(|name| {
            let local = files.read(name).map_err(VersionControlError::Files)?;
            let local_hash = local.as_deref().map(content_hash);
            let base = link.base.get(name).map(String::as_str);
            Ok(FileStatus {
                name: name.to_string(),
                state: classify(base, local_hash.as_deref(), base),
                local_revision: local_hash,
                remote_revision: base.map(str::to_string),
            })
        })
        .collect()
}

fn entity_kind(array_name: &str) -> Option<&'static str> {
    match array_name {
        "collections" => Some("collection"),
        "folders" => Some("folder"),
        "requests" => Some("request"),
        "flows" => Some("flow"),
        "environments" => Some("environment"),
        "monitors" => Some("monitor"),
        _ => None,
    }
}

fn display_value(value: Option<&Value>) -> Option<String> {
    value.map(|value| match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    })
}

fn shallow_fields(value: &Value) -> BTreeMap<String, &Value> {
    value
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter(|(name, _)| entity_kind(name).is_none() && name.as_str() != "id")
        .map(|(name, value)| (name.clone(), value))
        .collect()
}

fn field_changes(remote: Option<&Value>, local: Option<&Value>) -> Vec<FieldChange> {
    let remote_fields = remote.map(shallow_fields).unwrap_or_default();
    let local_fields = local.map(shallow_fields).unwrap_or_default();
    let names: std::collections::BTreeSet<_> = remote_fields
        .keys()
        .chain(local_fields.keys())
        .cloned()
        .collect();
    names
        .into_iter()
        .filter_map(|name| {
            let remote = remote_fields.get(&name).copied();
            let local = local_fields.get(&name).copied();
            (remote != local).then(|| FieldChange {
                name,
                remote: display_value(remote),
                local: display_value(local),
            })
        })
        .collect()
}

#[derive(Clone)]
struct FlatItem {
    id: String,
    parent_id: Option<String>,
    label: String,
    kind: String,
    value: Value,
}

fn collect_items(value: &Value) -> BTreeMap<String, FlatItem> {
    fn visit(value: &Value, parent: Option<&str>, result: &mut BTreeMap<String, FlatItem>) {
        let Some(object) = value.as_object() else {
            return;
        };
        for (array_name, children) in object {
            let Some(kind) = entity_kind(array_name) else {
                continue;
            };
            let Some(children) = children.as_array() else {
                continue;
            };
            for child in children {
                let Some(child_object) = child.as_object() else {
                    continue;
                };
                let Some(id) = child_object.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let key = format!("{kind}:{id}");
                let label = child_object
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string();
                result.insert(
                    key.clone(),
                    FlatItem {
                        id: key.clone(),
                        parent_id: parent.map(str::to_string),
                        label,
                        kind: kind.to_string(),
                        value: child.clone(),
                    },
                );
                visit(child, Some(&key), result);
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(value, None, &mut result);
    result
}

fn request_dependencies(value: &Value) -> Vec<String> {
    fn visit(value: &Value, result: &mut std::collections::BTreeSet<String>) {
        match value {
            Value::Object(object) => {
                if let Some(id) = object.get("requestId").and_then(Value::as_str) {
                    result.insert(format!("request:{id}"));
                }
                object.values().for_each(|value| visit(value, result));
            }
            Value::Array(values) => values.iter().for_each(|value| visit(value, result)),
            _ => {}
        }
    }
    let mut result = std::collections::BTreeSet::new();
    visit(value, &mut result);
    result.into_iter().collect()
}

fn parse_json(bytes: Option<&[u8]>, name: &str) -> Result<Option<Value>, VersionControlError> {
    bytes
        .map(|bytes| {
            serde_json::from_slice(bytes)
                .map_err(|_| VersionControlError::InvalidStructuredFile(name.to_string()))
        })
        .transpose()
}

/// Arquivos cuja estrutura JSON é reconhecida (entidades com `id`), e que
/// portanto aceitam seleção/resolução por item em vez de só por inteiro.
fn supports_partial_format(name: &str) -> bool {
    matches!(
        name,
        "alcy-collections.json"
            | "alcy-flows.json"
            | "alcy-environments.json"
            | "alcy-value-monitors.json"
    )
}

/// Ids das entidades que diferem entre remoto e local (adicionadas,
/// removidas ou com campos alterados) — usado tanto para reportar as
/// alterações estruturadas quanto para exigir cobertura completa numa
/// resolução de conflito por item.
fn changed_item_ids(
    remote_items: &BTreeMap<String, FlatItem>,
    local_items: &BTreeMap<String, FlatItem>,
) -> std::collections::BTreeSet<String> {
    let ids: std::collections::BTreeSet<_> = local_items
        .keys()
        .chain(remote_items.keys())
        .cloned()
        .collect();
    ids.into_iter()
        .filter(|id| {
            let local_item = local_items.get(id);
            let remote_item = remote_items.get(id);
            match (remote_item, local_item) {
                (Some(remote), Some(local)) => {
                    remote.parent_id != local.parent_id
                        || shallow_fields(&remote.value) != shallow_fields(&local.value)
                }
                _ => true,
            }
        })
        .collect()
}

/// Retorna as entidades alteradas de um arquivo conhecido. O conteúdo fica no
/// backend; apenas campos efetivamente diferentes atravessam o IPC.
pub async fn structured_file_changes<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
    name: &str,
) -> Result<StructuredFileChanges, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    if !link.tracked_files().contains(&name) {
        return Err(VersionControlError::NotTracked(name.to_string()));
    }
    let local = files.read(name).map_err(VersionControlError::Files)?;
    let remote_bytes = remote.read_file(name).await?;
    structured_file_changes_from_content(name, local, remote_bytes)
}

/// Calcula o diff semântico a partir de buffers já carregados. Commands podem
/// executar esta etapa em spawn_blocking, mantendo parsing e indexação de
/// workspaces grandes fora dos workers assíncronos usados pela rede.
pub fn structured_file_changes_from_content(
    name: &str,
    local: Option<Vec<u8>>,
    remote_bytes: Option<Vec<u8>>,
) -> Result<StructuredFileChanges, VersionControlError> {
    let supports_partial = supports_partial_format(name)
        && local
            .as_ref()
            .is_none_or(|bytes| bytes.len() <= MAX_STRUCTURED_DIFF_BYTES)
        && remote_bytes
            .as_ref()
            .is_none_or(|bytes| bytes.len() <= MAX_STRUCTURED_DIFF_BYTES);
    let mut items = Vec::new();
    if supports_partial {
        let local_json = parse_json(local.as_deref(), name)?.unwrap_or(Value::Object(Map::new()));
        let remote_json =
            parse_json(remote_bytes.as_deref(), name)?.unwrap_or(Value::Object(Map::new()));
        let local_items = collect_items(&local_json);
        let remote_items = collect_items(&remote_json);
        for id in changed_item_ids(&remote_items, &local_items) {
            let local_item = local_items.get(&id);
            let remote_item = remote_items.get(&id);
            let Some(source) = local_item.or(remote_item) else {
                continue;
            };
            items.push(ChangedItem {
                id: source.id.clone(),
                parent_id: source.parent_id.clone(),
                label: source.label.clone(),
                item_kind: source.kind.clone(),
                change_kind: match (remote_item, local_item) {
                    (None, Some(_)) => ItemChangeKind::Added,
                    (Some(_), None) => ItemChangeKind::Deleted,
                    _ => ItemChangeKind::Modified,
                },
                fields: field_changes(
                    remote_item.map(|item| &item.value),
                    local_item.map(|item| &item.value),
                ),
                dependencies: if source.kind == "flow" {
                    request_dependencies(&source.value)
                } else {
                    Vec::new()
                },
            });
        }
    }
    Ok(StructuredFileChanges {
        name: name.to_string(),
        local_revision: local.as_deref().map(content_hash),
        remote_revision: remote_bytes.as_deref().map(content_hash),
        supports_partial,
        items,
    })
}

fn contains_selected(value: &Value, selected: &HashSet<String>) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().any(|(array_name, children)| {
        let Some(kind) = entity_kind(array_name) else {
            return false;
        };
        children.as_array().is_some_and(|children| {
            children.iter().any(|child| {
                let own = child
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| selected.contains(&format!("{kind}:{id}")));
                own || contains_selected(child, selected)
            })
        })
    })
}

fn overlay_local_fields(remote: &Value, local: &Value) -> Value {
    let (Some(remote_object), Some(local_object)) = (remote.as_object(), local.as_object()) else {
        return local.clone();
    };
    let mut result = remote_object.clone();
    for (name, value) in local_object {
        result.insert(name.clone(), value.clone());
    }
    Value::Object(result)
}

fn merge_partial_value(
    remote: Option<&Value>,
    local: Option<&Value>,
    selected: &HashSet<String>,
) -> Option<Value> {
    match (remote, local) {
        (None, None) => None,
        (Some(remote), None) => Some(remote.clone()),
        (None, Some(local)) if !contains_selected(local, selected) => None,
        (remote, Some(local)) => {
            let mut result = remote.cloned().unwrap_or_else(|| local.clone());
            let (Some(result_object), Some(local_object)) =
                (result.as_object_mut(), local.as_object())
            else {
                return remote.cloned().or_else(|| Some(local.clone()));
            };
            for (array_name, local_children_value) in local_object {
                let Some(kind) = entity_kind(array_name) else {
                    continue;
                };
                let Some(local_children) = local_children_value.as_array() else {
                    continue;
                };
                let remote_children = remote
                    .and_then(|value| value.get(array_name))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let local_by_id: BTreeMap<_, _> = local_children
                    .iter()
                    .filter_map(|child| {
                        child
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| (id, child))
                    })
                    .collect();
                let mut merged = Vec::new();
                for remote_child in &remote_children {
                    let Some(id) = remote_child.get("id").and_then(Value::as_str) else {
                        merged.push(remote_child.clone());
                        continue;
                    };
                    let key = format!("{kind}:{id}");
                    let local_child = local_by_id.get(id).copied();
                    if selected.contains(&key) {
                        if let Some(local_child) = local_child {
                            if matches!(kind, "collection" | "folder") {
                                let mut container = merge_partial_value(
                                    Some(remote_child),
                                    Some(local_child),
                                    selected,
                                )
                                .unwrap_or_else(|| local_child.clone());
                                if let (Some(result), Some(local_object)) =
                                    (container.as_object_mut(), local_child.as_object())
                                {
                                    for (name, value) in local_object {
                                        if entity_kind(name).is_none() {
                                            result.insert(name.clone(), value.clone());
                                        }
                                    }
                                }
                                merged.push(container);
                            } else {
                                merged.push(overlay_local_fields(remote_child, local_child));
                            }
                        }
                    } else if let Some(value) =
                        merge_partial_value(Some(remote_child), local_child, selected)
                    {
                        merged.push(value);
                    }
                }
                let remote_ids: HashSet<_> = remote_children
                    .iter()
                    .filter_map(|child| child.get("id").and_then(Value::as_str))
                    .collect();
                for local_child in local_children {
                    let Some(id) = local_child.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    if remote_ids.contains(id) {
                        continue;
                    }
                    let key = format!("{kind}:{id}");
                    if selected.contains(&key) {
                        merged.push(local_child.clone());
                    } else if let Some(value) =
                        merge_partial_value(None, Some(local_child), selected)
                    {
                        merged.push(value);
                    }
                }
                result_object.insert(array_name.clone(), Value::Array(merged));
            }
            Some(result)
        }
    }
}

fn compose_selection(
    name: &str,
    remote: Option<&[u8]>,
    local: Option<&[u8]>,
    selection: &ChangeSelection,
) -> Result<Option<Vec<u8>>, VersionControlError> {
    if selection.whole_file {
        return Ok(local.map(ToOwned::to_owned));
    }
    let remote_json = parse_json(remote, name)?.unwrap_or(Value::Object(Map::new()));
    let local_json = parse_json(local, name)?.unwrap_or(Value::Object(Map::new()));
    let selected: HashSet<_> = selection.item_ids.iter().cloned().collect();
    let merged = merge_partial_value(Some(&remote_json), Some(&local_json), &selected)
        .ok_or_else(|| VersionControlError::InvalidStructuredFile(name.to_string()))?;
    serde_json::to_vec_pretty(&merged)
        .map(Some)
        .map_err(|_| VersionControlError::InvalidStructuredFile(name.to_string()))
}

/// Result of merging one file from a common base (ADR 0074).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileMerge {
    /// Merged content; `None` means the file ends up deleted.
    Merged(Option<Vec<u8>>),
    /// Both sides changed the same thing differently.
    Conflict,
}

fn same_item(a: Option<&FlatItem>, b: Option<&FlatItem>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.parent_id == b.parent_id && shallow_fields(&a.value) == shallow_fields(&b.value)
        }
        _ => false,
    }
}

/// Three-way merge of one versioned file. A side that left the file as in
/// `base` takes the other side. When both changed a structured file, entities
/// and top-level fields changed on one side only are combined; the same
/// entity changed differently on both sides, or any other file changed on
/// both sides, is a conflict.
pub fn merge_file(
    name: &str,
    base: Option<&[u8]>,
    ours: Option<&[u8]>,
    theirs: Option<&[u8]>,
) -> FileMerge {
    if ours == theirs || theirs == base {
        return FileMerge::Merged(ours.map(ToOwned::to_owned));
    }
    if ours == base {
        return FileMerge::Merged(theirs.map(ToOwned::to_owned));
    }
    let (Some(ours), Some(theirs)) = (ours, theirs) else {
        return FileMerge::Conflict;
    };
    let too_large = |bytes: &[u8]| bytes.len() > MAX_STRUCTURED_DIFF_BYTES;
    if !supports_partial_format(name)
        || too_large(ours)
        || too_large(theirs)
        || base.is_some_and(too_large)
    {
        return FileMerge::Conflict;
    }
    let parse = |bytes: Option<&[u8]>| parse_json(bytes, name).ok().map(Option::unwrap_or_default);
    let (Some(base_json), Some(ours_json), Some(theirs_json)) =
        (parse(base), parse(Some(ours)), parse(Some(theirs)))
    else {
        return FileMerge::Conflict;
    };
    let empty = Value::Object(Map::new());
    let base_json = if base_json.is_null() {
        empty
    } else {
        base_json
    };

    let base_items = collect_items(&base_json);
    let ours_items = collect_items(&ours_json);
    let theirs_items = collect_items(&theirs_json);
    let ours_changed = changed_item_ids(&base_items, &ours_items);
    let theirs_changed = changed_item_ids(&base_items, &theirs_items);
    let clash = ours_changed
        .intersection(&theirs_changed)
        .any(|id| !same_item(ours_items.get(id), theirs_items.get(id)));
    if clash {
        return FileMerge::Conflict;
    }

    // Top-level fields outside the entity arrays (e.g. a format version).
    let base_fields = shallow_fields(&base_json);
    let ours_fields = shallow_fields(&ours_json);
    let theirs_fields = shallow_fields(&theirs_json);
    let mut ours_only = Vec::new();
    let field_names: std::collections::BTreeSet<_> = base_fields
        .keys()
        .chain(ours_fields.keys())
        .chain(theirs_fields.keys())
        .cloned()
        .collect();
    for field in field_names {
        let (b, o, t) = (
            base_fields.get(&field),
            ours_fields.get(&field),
            theirs_fields.get(&field),
        );
        if o == t || o == b {
            continue;
        }
        if t != b {
            return FileMerge::Conflict;
        }
        ours_only.push((field, o.map(|value| (*value).clone())));
    }

    let selected: HashSet<String> = ours_changed.into_iter().collect();
    let Some(mut merged) = merge_partial_value(Some(&theirs_json), Some(&ours_json), &selected)
    else {
        return FileMerge::Conflict;
    };
    if let Some(object) = merged.as_object_mut() {
        for (field, value) in ours_only {
            match value {
                Some(value) => {
                    object.insert(field, value);
                }
                None => {
                    object.remove(&field);
                }
            }
        }
    }
    match serde_json::to_vec_pretty(&merged) {
        Ok(bytes) => FileMerge::Merged(Some(bytes)),
        Err(_) => FileMerge::Conflict,
    }
}

pub async fn push_selected_changes<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
    message: &str,
    selections: &[ChangeSelection],
) -> Result<PushOutcome, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    let message = message.trim();
    if message.is_empty() {
        return Err(VersionControlError::EmptyMessage);
    }

    let entries = snapshot(files, remote, link).await?;
    let (link, _) = heal(link, &entries);

    if selections.is_empty() {
        return Err(VersionControlError::NothingToCommit);
    }
    let selected_names: HashSet<_> = selections
        .iter()
        .map(|selection| selection.name.as_str())
        .collect();
    let conflicts: Vec<String> = entries
        .iter()
        .filter(|entry| {
            selected_names.contains(entry.name) && entry.state(&link) == FileState::Conflict
        })
        .map(|entry| entry.name.to_string())
        .collect();
    if !conflicts.is_empty() {
        return Err(VersionControlError::Conflicts(conflicts));
    }

    let mut actions = Vec::new();
    let mut pushed = Vec::new();
    let mut pushed_contents: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    for selection in selections {
        let entry = entries
            .iter()
            .find(|entry| entry.name == selection.name)
            .ok_or_else(|| VersionControlError::NotTracked(selection.name.clone()))?;
        if selection.expected_local_revision != entry.local_hash
            || selection.expected_remote_revision != entry.remote.sha256
        {
            return Err(VersionControlError::StaleSelection);
        }
        let remote_content = remote.read_file(entry.name).await?;
        if remote_content.as_deref().map(content_hash) != entry.remote.sha256 {
            return Err(VersionControlError::StaleSelection);
        }
        let content = compose_selection(
            entry.name,
            remote_content.as_deref(),
            entry.local.as_deref(),
            selection,
        )?;
        let path = entry.name.to_string();
        let last_commit_id = entry.remote.last_commit_id.clone();
        let action = match (&entry.remote.sha256, &content) {
            (None, Some(content)) => CommitAction::Create {
                path,
                content: content.clone(),
            },
            (Some(_), Some(content)) => CommitAction::Update {
                path,
                content: content.clone(),
                last_commit_id,
            },
            (Some(_), None) => CommitAction::Delete {
                path,
                last_commit_id,
            },
            (None, None) => continue,
        };
        actions.push(action);
        pushed.push(entry.name.to_string());
        pushed_contents.insert(entry.name.to_string(), content);
    }
    if actions.is_empty() {
        return Err(VersionControlError::NothingToCommit);
    }

    let commit_id = remote.commit(message, &actions).await?;

    let mut updated = link;
    for (name, content) in pushed_contents {
        match content {
            Some(bytes) => {
                updated.base.insert(name, content_hash(&bytes));
            }
            None => {
                updated.base.remove(&name);
            }
        }
    }

    Ok(PushOutcome {
        commit_id,
        pushed,
        link: updated,
    })
}

/// Compatibilidade para os consumidores que enviam todas as alterações
/// locais. A interface do desktop usa `push_selected_changes`.
pub async fn push_changes<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
    message: &str,
) -> Result<PushOutcome, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    let entries = snapshot(files, remote, link).await?;
    let selections: Vec<_> = entries
        .iter()
        .filter(|entry| {
            let state = entry.state(link);
            state.is_local_change() || state == FileState::Conflict
        })
        .map(|entry| ChangeSelection {
            name: entry.name.to_string(),
            whole_file: true,
            item_ids: Vec::new(),
            expected_local_revision: entry.local_hash.clone(),
            expected_remote_revision: entry.remote.sha256.clone(),
        })
        .collect();
    push_selected_changes(files, remote, link, message, &selections).await
}

/// O que uma atualização traria do remoto, sem gravar nada em disco. Serve
/// para revisar antes de aplicar (`pull_changes`); os nomes retornados são
/// consultados por `structured_file_changes`/`file_diff` para mostrar o
/// diff de cada arquivo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullPreview {
    /// Arquivos alterados só no remoto; uma atualização os aplicaria.
    pub incoming: Vec<String>,
    /// Arquivos em conflito; uma atualização não os toca.
    pub conflicts: Vec<String>,
    /// Vínculo com a base atualizada para arquivos que já convergiram; o
    /// chamador o persiste quando `healed` é verdadeiro.
    pub link: WorkspaceLink,
    pub healed: bool,
}

pub async fn preview_pull<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
) -> Result<PullPreview, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    let entries = snapshot(files, remote, link).await?;
    let (link, healed) = heal(link, &entries);

    let mut incoming = Vec::new();
    let mut conflicts = Vec::new();
    for entry in &entries {
        match entry.state(&link) {
            FileState::Conflict => conflicts.push(entry.name.to_string()),
            FileState::RemoteChanged => incoming.push(entry.name.to_string()),
            _ => {}
        }
    }

    Ok(PullPreview {
        incoming,
        conflicts,
        link,
        healed,
    })
}

pub async fn pull_changes<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
) -> Result<PullOutcome, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    let entries = snapshot(files, remote, link).await?;
    let (mut link, _) = heal(link, &entries);

    let mut updated = Vec::new();
    let mut conflicts = Vec::new();
    let mut skipped = Vec::new();

    for entry in &entries {
        match entry.state(&link) {
            FileState::Conflict => conflicts.push(entry.name.to_string()),
            FileState::RemoteChanged => {
                let path = entry.name.to_string();
                match &entry.remote.sha256 {
                    None if entry.name == MANIFEST_FILE => skipped.push(entry.name.to_string()),
                    None => {
                        let current = files.read(entry.name).map_err(VersionControlError::Files)?;
                        let current_hash = current.as_deref().map(content_hash);
                        if current_hash != entry.local_hash {
                            conflicts.push(entry.name.to_string());
                            continue;
                        }
                        files
                            .delete(entry.name)
                            .map_err(VersionControlError::Files)?;
                        link.base.remove(entry.name);
                        updated.push(entry.name.to_string());
                    }
                    Some(expected) => {
                        let content = remote.read_file(&path).await?;
                        // O arquivo pode ter mudado entre a consulta e a leitura;
                        // nesse caso fica para a próxima atualização.
                        match content {
                            Some(bytes) if &content_hash(&bytes) == expected => {
                                let current =
                                    files.read(entry.name).map_err(VersionControlError::Files)?;
                                let current_hash = current.as_deref().map(content_hash);
                                if current_hash != entry.local_hash {
                                    conflicts.push(entry.name.to_string());
                                    continue;
                                }
                                files
                                    .write(entry.name, &bytes)
                                    .map_err(VersionControlError::Files)?;
                                link.base.insert(entry.name.to_string(), expected.clone());
                                updated.push(entry.name.to_string());
                            }
                            _ => skipped.push(entry.name.to_string()),
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(PullOutcome {
        updated,
        conflicts,
        skipped,
        link,
    })
}

/// Calcula a entidade resultante de uma resolução completa sem escrever no
/// workspace. O mesmo compositor é usado por `resolve_conflict`.
pub async fn preview_conflict_resolution<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
    input: ResolutionPreviewInput,
) -> Result<ResolutionPreview, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    let name = input.name.as_str();
    let item_id = input.item_id.as_str();
    let items = input.items.as_slice();
    if !link.tracked_files().contains(&name) {
        return Err(VersionControlError::NotTracked(name.to_string()));
    }
    let entries = snapshot(files, remote, link).await?;
    let (healed_link, _) = heal(link, &entries);
    let entry = entries
        .iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| VersionControlError::NotTracked(name.to_string()))?;
    if entry.state(&healed_link) != FileState::Conflict {
        return Err(VersionControlError::NotInConflict(name.to_string()));
    }
    if !supports_partial_format(name)
        || entry
            .local
            .as_ref()
            .is_some_and(|bytes| bytes.len() > MAX_DIFF_BYTES)
    {
        return Err(VersionControlError::PartialResolutionUnsupported(
            name.to_string(),
        ));
    }
    if entry.local_hash.as_ref() != input.expected_local_revision.as_ref()
        || entry.remote.sha256.as_ref() != input.expected_remote_revision.as_ref()
    {
        return Err(VersionControlError::StaleSelection);
    }
    let remote_bytes = remote.read_file(name).await?;
    if remote_bytes.as_deref().map(content_hash) != entry.remote.sha256 {
        return Err(VersionControlError::StaleSelection);
    }
    if remote_bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_DIFF_BYTES)
    {
        return Err(VersionControlError::PartialResolutionUnsupported(
            name.to_string(),
        ));
    }
    let merged =
        compose_conflict_value(name, entry.local.as_deref(), remote_bytes.as_deref(), items)?;
    let merged_items = collect_items(&merged);
    let local_json = parse_json(entry.local.as_deref(), name)?.unwrap_or(Value::Object(Map::new()));
    let remote_json =
        parse_json(remote_bytes.as_deref(), name)?.unwrap_or(Value::Object(Map::new()));
    let local_items = collect_items(&local_json);
    let remote_items = collect_items(&remote_json);
    let source = local_items
        .get(item_id)
        .or_else(|| remote_items.get(item_id))
        .ok_or_else(|| VersionControlError::InvalidStructuredFile(name.to_string()))?;
    let result = merged_items.get(item_id);
    let fields = result
        .map(|item| {
            shallow_fields(&item.value)
                .into_iter()
                .filter_map(|(name, value)| {
                    display_value(Some(value)).map(|value| PreviewField { name, value })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ResolutionPreview {
        item_id: item_id.to_string(),
        label: source.label.clone(),
        item_kind: source.kind.clone(),
        exists: result.is_some(),
        fields,
    })
}

/// Resolve um conflito. `KeepLocal` aceita a versão remota como base (o
/// arquivo local vira uma alteração a enviar); `KeepRemote` sobrescreve o
/// arquivo local com a versão remota. Devolve o vínculo e se o arquivo local
/// foi reescrito ou removido.
pub async fn resolve_conflict<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
    name: &str,
    resolution: Resolution,
) -> Result<(WorkspaceLink, bool), VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    if !link.tracked_files().contains(&name) {
        return Err(VersionControlError::NotTracked(name.to_string()));
    }

    let entries = snapshot(files, remote, link).await?;
    let (mut link, _) = heal(link, &entries);
    let entry = entries
        .iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| VersionControlError::NotTracked(name.to_string()))?;
    if entry.state(&link) != FileState::Conflict {
        return Err(VersionControlError::NotInConflict(name.to_string()));
    }

    let mut rewrote = false;
    match resolution {
        Resolution::KeepLocal => match &entry.remote.sha256 {
            Some(sha) => {
                link.base.insert(name.to_string(), sha.clone());
            }
            None => {
                link.base.remove(name);
            }
        },
        Resolution::KeepRemote => match &entry.remote.sha256 {
            None => {
                if name == MANIFEST_FILE {
                    return Err(VersionControlError::ManifestRemoval);
                }
                files.delete(name).map_err(VersionControlError::Files)?;
                link.base.remove(name);
                rewrote = true;
            }
            Some(_) => {
                let bytes = remote
                    .read_file(name)
                    .await?
                    .ok_or_else(|| RemoteError::NotFound(name.to_string()))?;
                files
                    .write(name, &bytes)
                    .map_err(VersionControlError::Files)?;
                link.base.insert(name.to_string(), content_hash(&bytes));
                rewrote = true;
            }
        },
        Resolution::PerItem {
            items,
            expected_local_revision,
            expected_remote_revision,
        } => {
            let oversized = entry
                .local
                .as_ref()
                .is_some_and(|bytes| bytes.len() > MAX_DIFF_BYTES);
            if !supports_partial_format(name) || oversized {
                return Err(VersionControlError::PartialResolutionUnsupported(
                    name.to_string(),
                ));
            }
            // Revalida os hashes observados pelo chamador contra o estado atual
            // (mesmo padrão do ADR 0021 para a seleção parcial de push).
            if entry.local_hash != expected_local_revision
                || entry.remote.sha256 != expected_remote_revision
            {
                return Err(VersionControlError::StaleSelection);
            }
            let remote_bytes = remote.read_file(name).await?;
            if remote_bytes.as_deref().map(content_hash) != entry.remote.sha256 {
                return Err(VersionControlError::StaleSelection);
            }
            if remote_bytes
                .as_ref()
                .is_some_and(|bytes| bytes.len() > MAX_DIFF_BYTES)
            {
                return Err(VersionControlError::PartialResolutionUnsupported(
                    name.to_string(),
                ));
            }

            // Reaproveita a composição do push parcial (ADR 0021): remoto
            // como base, com os itens escolhidos como "meu" sobrepostos do
            // local — só que o resultado vai para o arquivo local, não para
            // o remoto.
            let merged = compose_conflict_value(
                name,
                entry.local.as_deref(),
                remote_bytes.as_deref(),
                &items,
            )?;
            let merged_bytes = serde_json::to_vec_pretty(&merged)
                .map_err(|_| VersionControlError::InvalidStructuredFile(name.to_string()))?;

            if entry.local_hash.as_deref() != Some(content_hash(&merged_bytes).as_str()) {
                files
                    .write(name, &merged_bytes)
                    .map_err(VersionControlError::Files)?;
                rewrote = true;
            }
            // Nova base = remoto: o resultado combinado ainda não foi
            // enviado, então segue como alteração local pendente até o push
            // (mesmo critério do KeepLocal).
            match &entry.remote.sha256 {
                Some(sha) => {
                    link.base.insert(name.to_string(), sha.clone());
                }
                None => {
                    link.base.remove(name);
                }
            }
        }
    }

    Ok((link, rewrote))
}

/// Diff entre a versão remota (esquerda) e a local (direita) de um arquivo.
pub async fn file_diff<F, R>(
    files: &F,
    remote: &R,
    link: &WorkspaceLink,
    name: &str,
) -> Result<FileDiff, VersionControlError>
where
    F: WorkspaceFiles + Sync,
    R: RemoteRepository + Sync,
{
    if !link.tracked_files().contains(&name) {
        return Err(VersionControlError::NotTracked(name.to_string()));
    }

    let local = files.read(name).map_err(VersionControlError::Files)?;
    let remote_bytes = remote.read_file(name).await?;

    let mut diff = FileDiff {
        name: name.to_string(),
        remote_exists: remote_bytes.is_some(),
        local_exists: local.is_some(),
        hunks: Vec::new(),
        too_large: false,
        binary: false,
        truncated: false,
    };

    let sides = [local.as_deref(), remote_bytes.as_deref()];
    if sides
        .iter()
        .any(|side| side.is_some_and(|bytes| bytes.len() > MAX_DIFF_BYTES))
    {
        diff.too_large = true;
        return Ok(diff);
    }

    let (Some(local_text), Some(remote_text)) = (
        text_of(local.as_deref(), &mut diff.binary),
        text_of(remote_bytes.as_deref(), &mut diff.binary),
    ) else {
        return Ok(diff);
    };

    let text_diff = TextDiff::from_lines(remote_text, local_text);
    let mut emitted = 0usize;
    'groups: for group in text_diff.grouped_ops(DIFF_CONTEXT_LINES) {
        let (Some(first), Some(_)) = (group.first(), group.last()) else {
            continue;
        };
        let mut hunk = DiffHunk {
            remote_start: to_line_number(first.old_range().start),
            local_start: to_line_number(first.new_range().start),
            lines: Vec::new(),
        };
        for op in &group {
            for change in text_diff.iter_changes(op) {
                if emitted >= MAX_DIFF_LINES {
                    diff.truncated = true;
                    if !hunk.lines.is_empty() {
                        diff.hunks.push(hunk);
                    }
                    break 'groups;
                }
                let kind = match change.tag() {
                    ChangeTag::Equal => DiffLineKind::Context,
                    ChangeTag::Insert => DiffLineKind::Added,
                    ChangeTag::Delete => DiffLineKind::Removed,
                };
                hunk.lines.push(DiffLine {
                    kind,
                    text: change.value().trim_end_matches(['\n', '\r']).to_string(),
                });
                emitted += 1;
            }
        }
        diff.hunks.push(hunk);
    }

    Ok(diff)
}

/// Ausente conta como texto vazio; binário marca `binary` e devolve `None`.
fn text_of<'a>(bytes: Option<&'a [u8]>, binary: &mut bool) -> Option<&'a str> {
    match bytes {
        None => Some(""),
        Some(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => Some(text),
            Err(_) => {
                *binary = true;
                None
            }
        },
    }
}

fn to_line_number(zero_based: usize) -> u32 {
    u32::try_from(zero_based + 1).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeFiles(Mutex<BTreeMap<String, Vec<u8>>>);

    impl FakeFiles {
        fn with(entries: &[(&str, &str)]) -> Self {
            let files = Self::default();
            for (name, content) in entries {
                files.write(name, content.as_bytes()).unwrap();
            }
            files
        }

        fn text(&self, name: &str) -> Option<String> {
            self.read(name)
                .unwrap()
                .map(|bytes| String::from_utf8(bytes).unwrap())
        }
    }

    impl WorkspaceFiles for FakeFiles {
        fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }
        fn write(&self, name: &str, content: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(name.to_string(), content.to_vec());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeRemote {
        // caminho -> (conteúdo, id do último commit)
        files: Mutex<BTreeMap<String, (Vec<u8>, String)>>,
        commits: Mutex<u32>,
    }

    impl FakeRemote {
        fn with(entries: &[(&str, &str)]) -> Self {
            let remote = Self::default();
            for (path, content) in entries {
                remote
                    .files
                    .lock()
                    .unwrap()
                    .insert(path.to_string(), (content.as_bytes().to_vec(), "c0".into()));
            }
            remote
        }

        fn set(&self, path: &str, content: &str) {
            self.files.lock().unwrap().insert(
                path.to_string(),
                (content.as_bytes().to_vec(), "c-other".into()),
            );
        }

        fn text(&self, path: &str) -> Option<String> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .map(|(bytes, _)| String::from_utf8(bytes.clone()).unwrap())
        }
    }

    impl RemoteRepository for FakeRemote {
        async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .get(path)
                .map(|(bytes, commit)| RemoteFileMeta {
                    sha256: Some(content_hash(bytes)),
                    last_commit_id: Some(commit.clone()),
                })
                .unwrap_or_default())
        }

        async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .get(path)
                .map(|(bytes, _)| bytes.clone()))
        }

        async fn commit(
            &self,
            _message: &str,
            actions: &[CommitAction],
        ) -> Result<String, RemoteError> {
            let mut files = self.files.lock().unwrap();
            // Valida tudo antes de aplicar (commit atômico).
            for action in actions {
                match action {
                    CommitAction::Create { path, .. } if files.contains_key(path) => {
                        return Err(RemoteError::Conflict);
                    }
                    CommitAction::Update {
                        path,
                        last_commit_id,
                        ..
                    }
                    | CommitAction::Delete {
                        path,
                        last_commit_id,
                    } => {
                        let current = files.get(path).map(|(_, commit)| commit.clone());
                        if current != *last_commit_id {
                            return Err(RemoteError::Conflict);
                        }
                    }
                    CommitAction::Create { .. } => {}
                }
            }
            let mut commits = self.commits.lock().unwrap();
            *commits += 1;
            let id = format!("commit-{commits}");
            for action in actions {
                match action {
                    CommitAction::Create { path, content }
                    | CommitAction::Update { path, content, .. } => {
                        files.insert(path.clone(), (content.clone(), id.clone()));
                    }
                    CommitAction::Delete { path, .. } => {
                        files.remove(path);
                    }
                }
            }
            Ok(id)
        }
    }

    struct EditingRemote<'a> {
        inner: FakeRemote,
        local: &'a FakeFiles,
        edited: Mutex<bool>,
    }

    impl RemoteRepository for EditingRemote<'_> {
        async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
            self.inner.file_meta(path).await
        }

        async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
            if path == "alcy-collections.json" {
                let mut edited = self.edited.lock().unwrap();
                if !*edited {
                    self.local
                        .write("alcy-collections.json", br#"{"local":"during-pull"}"#)
                        .unwrap();
                    *edited = true;
                }
            }
            self.inner.read_file(path).await
        }

        async fn commit(
            &self,
            _message: &str,
            _actions: &[CommitAction],
        ) -> Result<String, RemoteError> {
            Err(RemoteError::Rejected("não usado no teste".into()))
        }
    }

    /// Remote without multi-file transactions: applies
    /// the first action and then fails, like a connection drop mid-push.
    struct NonAtomicRemote(FakeRemote);

    impl RemoteRepository for NonAtomicRemote {
        async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
            self.0.file_meta(path).await
        }

        async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
            self.0.read_file(path).await
        }

        async fn commit(
            &self,
            message: &str,
            actions: &[CommitAction],
        ) -> Result<String, RemoteError> {
            self.0.commit(message, &actions[..1]).await?;
            Err(RemoteError::Network("connection reset".into()))
        }
    }

    fn link() -> WorkspaceLink {
        WorkspaceLink::new(false)
    }

    fn states(status: &VersionStatus) -> Vec<(String, FileState)> {
        status
            .files
            .iter()
            .map(|file| (file.name.clone(), file.state))
            .collect()
    }

    fn state_of(status: &VersionStatus, name: &str) -> FileState {
        status
            .files
            .iter()
            .find(|file| file.name == name)
            .unwrap()
            .state
    }

    #[tokio::test]
    async fn linking_identical_trees_is_clean_and_heals_the_base() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}")]);
        let remote = FakeRemote::with(&[("alcy-collections.json", "{}")]);

        let status = version_status(&files, &remote, &link()).await.unwrap();

        assert!(status.healed);
        assert!(
            status
                .files
                .iter()
                .all(|file| file.state == FileState::Clean)
        );
        assert_eq!(
            status.link.base.get("alcy-collections.json"),
            Some(&content_hash(b"{}"))
        );
    }

    #[tokio::test]
    async fn push_interrupted_midway_heals_the_files_already_sent() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}")]);
        let remote = NonAtomicRemote(FakeRemote::with(&[("alcy-collections.json", "{}")]));
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;
        files.write("alcy-collections.json", b"{\"a\":1}").unwrap();
        files.write("alcy-flows.json", b"[]").unwrap();

        let pushed = push_changes(&files, &remote, &synced, "msg").await;
        assert!(matches!(
            pushed,
            Err(VersionControlError::Remote(RemoteError::Network(_)))
        ));

        let status = version_status(&files, &remote, &synced).await.unwrap();
        assert!(status.healed);
        assert_eq!(state_of(&status, "alcy-collections.json"), FileState::Clean);
        assert_eq!(state_of(&status, "alcy-flows.json"), FileState::LocalAdded);
    }

    #[tokio::test]
    async fn local_edit_then_push_makes_the_tree_clean() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}")]);
        let remote = FakeRemote::with(&[("alcy-collections.json", "{}")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;

        files.write("alcy-collections.json", b"{\"a\":1}").unwrap();
        files.write("alcy-flows.json", b"[]").unwrap();
        let status = version_status(&files, &remote, &synced).await.unwrap();
        assert_eq!(
            state_of(&status, "alcy-collections.json"),
            FileState::LocalModified
        );
        assert_eq!(state_of(&status, "alcy-flows.json"), FileState::LocalAdded);

        let outcome = push_changes(&files, &remote, &synced, "  Atualiza  ")
            .await
            .unwrap();
        assert_eq!(outcome.pushed.len(), 2);
        assert_eq!(remote.text("alcy-collections.json").unwrap(), "{\"a\":1}");
        assert_eq!(remote.text("alcy-flows.json").unwrap(), "[]");

        let after = version_status(&files, &remote, &outcome.link)
            .await
            .unwrap();
        assert!(
            after
                .files
                .iter()
                .all(|file| file.state == FileState::Clean)
        );
    }

    #[test]
    fn local_file_status_classifies_from_disk_without_touching_the_remote() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}")]);
        let synced_link = WorkspaceLink {
            base: BTreeMap::from([("alcy-collections.json".to_string(), content_hash(b"{}"))]),
            ..link()
        };

        // Sincronizado: nada mudou desde a base.
        let clean = local_file_status(&files, &synced_link).unwrap();
        assert_eq!(
            clean
                .iter()
                .find(|f| f.name == "alcy-collections.json")
                .unwrap()
                .state,
            FileState::Clean
        );
        assert_eq!(
            clean
                .iter()
                .find(|f| f.name == "alcy-flows.json")
                .unwrap()
                .state,
            FileState::Clean
        );

        // Modificado + criado localmente.
        files.write("alcy-collections.json", b"{\"a\":1}").unwrap();
        files.write("alcy-flows.json", b"[]").unwrap();
        let edited = local_file_status(&files, &synced_link).unwrap();
        assert_eq!(
            edited
                .iter()
                .find(|f| f.name == "alcy-collections.json")
                .unwrap()
                .state,
            FileState::LocalModified
        );
        assert_eq!(
            edited
                .iter()
                .find(|f| f.name == "alcy-flows.json")
                .unwrap()
                .state,
            FileState::LocalAdded
        );

        // Apagado localmente.
        files.delete("alcy-collections.json").unwrap();
        let deleted = local_file_status(&files, &synced_link).unwrap();
        assert_eq!(
            deleted
                .iter()
                .find(|f| f.name == "alcy-collections.json")
                .unwrap()
                .state,
            FileState::LocalDeleted
        );

        // Otimista por natureza: nunca alega saber do remoto.
        assert!(
            [clean, edited, deleted]
                .concat()
                .iter()
                .all(|f| f.state != FileState::RemoteChanged && f.state != FileState::Conflict)
        );
    }

    #[tokio::test]
    async fn push_requires_a_message_and_changes() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}")]);
        let remote = FakeRemote::with(&[("alcy-collections.json", "{}")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;

        assert_eq!(
            push_changes(&files, &remote, &synced, "  ").await,
            Err(VersionControlError::EmptyMessage)
        );
        assert_eq!(
            push_changes(&files, &remote, &synced, "msg").await,
            Err(VersionControlError::NothingToCommit)
        );
    }

    #[tokio::test]
    async fn pull_applies_remote_only_changes_and_reports_conflicts() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}"), ("alcy-flows.json", "[]")]);
        let remote =
            FakeRemote::with(&[("alcy-collections.json", "{}"), ("alcy-flows.json", "[]")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;

        remote.set("alcy-collections.json", "{\"remote\":true}");
        remote.set("alcy-flows.json", "[1]");
        files.write("alcy-flows.json", b"[2]").unwrap();

        let outcome = pull_changes(&files, &remote, &synced).await.unwrap();

        assert_eq!(outcome.updated, vec!["alcy-collections.json"]);
        assert_eq!(outcome.conflicts, vec!["alcy-flows.json"]);
        assert_eq!(
            files.text("alcy-collections.json").unwrap(),
            "{\"remote\":true}"
        );
        // O conflito não é sobrescrito.
        assert_eq!(files.text("alcy-flows.json").unwrap(), "[2]");
    }

    #[tokio::test]
    async fn pull_does_not_overwrite_an_edit_made_while_remote_content_loads() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}")]);
        let initial_remote = FakeRemote::with(&[("alcy-collections.json", "{}")]);
        let synced = version_status(&files, &initial_remote, &link())
            .await
            .unwrap()
            .link;
        let remote = EditingRemote {
            inner: FakeRemote::with(&[("alcy-collections.json", r#"{"remote":true}"#)]),
            local: &files,
            edited: Mutex::new(false),
        };

        let outcome = pull_changes(&files, &remote, &synced).await.unwrap();

        assert!(outcome.updated.is_empty());
        assert_eq!(outcome.conflicts, vec!["alcy-collections.json"]);
        assert_eq!(
            files.text("alcy-collections.json").as_deref(),
            Some(r#"{"local":"during-pull"}"#)
        );
    }

    #[tokio::test]
    async fn preview_pull_reports_incoming_and_conflicts_without_writing_anything() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}"), ("alcy-flows.json", "[]")]);
        let remote =
            FakeRemote::with(&[("alcy-collections.json", "{}"), ("alcy-flows.json", "[]")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;

        remote.set("alcy-collections.json", "{\"remote\":true}");
        remote.set("alcy-flows.json", "[1]");
        files.write("alcy-flows.json", b"[2]").unwrap();

        let preview = preview_pull(&files, &remote, &synced).await.unwrap();

        assert_eq!(preview.incoming, vec!["alcy-collections.json"]);
        assert_eq!(preview.conflicts, vec!["alcy-flows.json"]);
        // Nada foi escrito: os arquivos locais continuam exatamente como antes.
        assert_eq!(files.text("alcy-collections.json").unwrap(), "{}");
        assert_eq!(files.text("alcy-flows.json").unwrap(), "[2]");

        // `pull_changes` aplicaria/reportaria exatamente o mesmo conjunto.
        let outcome = pull_changes(&files, &remote, &synced).await.unwrap();
        assert_eq!(outcome.updated, preview.incoming);
        assert_eq!(outcome.conflicts, preview.conflicts);
    }

    #[tokio::test]
    async fn preview_pull_heals_the_base_like_version_status() {
        let files = FakeFiles::with(&[("alcy-collections.json", "{}")]);
        let remote = FakeRemote::with(&[("alcy-collections.json", "{}")]);

        let preview = preview_pull(&files, &remote, &link()).await.unwrap();

        assert!(preview.healed);
        assert_eq!(
            preview.link.base.get("alcy-collections.json"),
            Some(&content_hash(b"{}"))
        );
        assert!(preview.incoming.is_empty() && preview.conflicts.is_empty());
    }

    #[tokio::test]
    async fn pull_never_removes_the_manifest() {
        let files = FakeFiles::with(&[("alcy-workspace.json", "{}")]);
        let remote = FakeRemote::with(&[("alcy-workspace.json", "{}")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;

        remote.files.lock().unwrap().remove("alcy-workspace.json");
        let outcome = pull_changes(&files, &remote, &synced).await.unwrap();

        assert_eq!(outcome.skipped, vec!["alcy-workspace.json"]);
        assert!(files.text("alcy-workspace.json").is_some());
    }

    #[tokio::test]
    async fn push_is_blocked_by_conflicts_and_changes_nothing() {
        let files = FakeFiles::with(&[("alcy-flows.json", "[]")]);
        let remote = FakeRemote::with(&[("alcy-flows.json", "[]")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;

        remote.set("alcy-flows.json", "[1]");
        files.write("alcy-flows.json", b"[2]").unwrap();

        assert_eq!(
            push_changes(&files, &remote, &synced, "msg").await,
            Err(VersionControlError::Conflicts(vec![
                "alcy-flows.json".into()
            ]))
        );
        assert_eq!(remote.text("alcy-flows.json").unwrap(), "[1]");
    }

    #[tokio::test]
    async fn remote_race_during_push_is_a_conflict() {
        let files = FakeFiles::with(&[("alcy-flows.json", "[]")]);
        let remote = FakeRemote::with(&[("alcy-flows.json", "[]")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;
        files.write("alcy-flows.json", b"[2]").unwrap();

        // O commit falha se o arquivo mudou entre a consulta e a gravação.
        struct Racy<'a>(&'a FakeRemote);
        impl RemoteRepository for Racy<'_> {
            async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
                let meta = self.0.file_meta(path).await;
                self.0.set(path, "[9]");
                meta
            }
            async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
                self.0.read_file(path).await
            }
            async fn commit(
                &self,
                message: &str,
                actions: &[CommitAction],
            ) -> Result<String, RemoteError> {
                self.0.commit(message, actions).await
            }
        }

        let result = push_changes(&files, &Racy(&remote), &synced, "msg").await;
        assert_eq!(
            result,
            Err(VersionControlError::Conflicts(vec![
                "alcy-flows.json".into()
            ]))
        );
        assert_eq!(remote.text("alcy-flows.json").unwrap(), "[9]");
    }

    #[tokio::test]
    async fn resolves_conflicts_keeping_either_side() {
        let build = || async {
            let files = FakeFiles::with(&[("alcy-flows.json", "[]")]);
            let remote = FakeRemote::with(&[("alcy-flows.json", "[]")]);
            let synced = version_status(&files, &remote, &link()).await.unwrap().link;
            remote.set("alcy-flows.json", "[1]");
            files.write("alcy-flows.json", b"[2]").unwrap();
            (files, remote, synced)
        };

        let (files, remote, synced) = build().await;
        let (link_local, rewrote) = resolve_conflict(
            &files,
            &remote,
            &synced,
            "alcy-flows.json",
            Resolution::KeepLocal,
        )
        .await
        .unwrap();
        assert!(!rewrote);
        let status = version_status(&files, &remote, &link_local).await.unwrap();
        assert_eq!(
            state_of(&status, "alcy-flows.json"),
            FileState::LocalModified
        );
        push_changes(&files, &remote, &link_local, "msg")
            .await
            .unwrap();
        assert_eq!(remote.text("alcy-flows.json").unwrap(), "[2]");

        let (files, remote, synced) = build().await;
        let (link_remote, rewrote) = resolve_conflict(
            &files,
            &remote,
            &synced,
            "alcy-flows.json",
            Resolution::KeepRemote,
        )
        .await
        .unwrap();
        assert!(rewrote);
        assert_eq!(files.text("alcy-flows.json").unwrap(), "[1]");
        let status = version_status(&files, &remote, &link_remote).await.unwrap();
        assert_eq!(state_of(&status, "alcy-flows.json"), FileState::Clean);
    }

    #[tokio::test]
    async fn resolves_conflicts_per_item_composing_both_sides() {
        let original = r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one"},{"id":"r2","name":"Two","endpoint":"/two"}]}]}"#;
        let files = FakeFiles::with(&[("alcy-collections.json", original)]);
        let remote = FakeRemote::with(&[("alcy-collections.json", original)]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;

        // r1 muda no remoto; r2 muda no local — conflito estruturado.
        remote.set(
            "alcy-collections.json",
            r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one-remote"},{"id":"r2","name":"Two","endpoint":"/two"}]}]}"#,
        );
        files
            .write(
                "alcy-collections.json",
                br#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one"},{"id":"r2","name":"Two","endpoint":"/two-local"}]}]}"#,
            )
            .unwrap();

        let status = version_status(&files, &remote, &synced).await.unwrap();
        assert_eq!(
            state_of(&status, "alcy-collections.json"),
            FileState::Conflict
        );

        let changes = structured_file_changes(&files, &remote, &synced, "alcy-collections.json")
            .await
            .unwrap();
        let item_ids: std::collections::BTreeSet<_> =
            changes.items.iter().map(|item| item.id.clone()).collect();
        assert_eq!(
            item_ids,
            std::collections::BTreeSet::from(["request:r1".to_string(), "request:r2".to_string()])
        );

        let resolutions = vec![
            ItemResolution {
                item_id: "request:r1".into(),
                side: ConflictSide::Remote,
            },
            ItemResolution {
                item_id: "request:r2".into(),
                side: ConflictSide::Local,
            },
        ];
        let preview = preview_conflict_resolution(
            &files,
            &remote,
            &synced,
            ResolutionPreviewInput {
                name: "alcy-collections.json".into(),
                items: resolutions.clone(),
                expected_local_revision: changes.local_revision.clone(),
                expected_remote_revision: changes.remote_revision.clone(),
                item_id: "request:r2".into(),
            },
        )
        .await
        .unwrap();
        assert!(preview.exists);
        assert!(
            preview
                .fields
                .iter()
                .any(|field| field.name == "endpoint" && field.value == "/two-local")
        );

        let (resolved_link, rewrote) = resolve_conflict(
            &files,
            &remote,
            &synced,
            "alcy-collections.json",
            Resolution::PerItem {
                items: resolutions,
                expected_local_revision: changes.local_revision,
                expected_remote_revision: changes.remote_revision,
            },
        )
        .await
        .unwrap();
        assert!(rewrote);

        let merged: Value =
            serde_json::from_str(&files.text("alcy-collections.json").unwrap()).unwrap();
        let requests = merged["collections"][0]["requests"].as_array().unwrap();
        assert_eq!(requests[0]["endpoint"], "/one-remote");
        assert_eq!(requests[1]["endpoint"], "/two-local");

        // A combinação ainda não foi enviada: continua como alteração local pendente.
        let status = version_status(&files, &remote, &resolved_link)
            .await
            .unwrap();
        assert_eq!(
            state_of(&status, "alcy-collections.json"),
            FileState::LocalModified
        );
    }

    #[tokio::test]
    async fn per_item_resolution_rejects_incomplete_coverage() {
        let original = r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one"},{"id":"r2","name":"Two","endpoint":"/two"}]}]}"#;
        let files = FakeFiles::with(&[("alcy-collections.json", original)]);
        let remote = FakeRemote::with(&[("alcy-collections.json", original)]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;
        remote.set(
            "alcy-collections.json",
            r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one-remote"},{"id":"r2","name":"Two","endpoint":"/two"}]}]}"#,
        );
        files
            .write(
                "alcy-collections.json",
                br#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one"},{"id":"r2","name":"Two","endpoint":"/two-local"}]}]}"#,
            )
            .unwrap();
        let changes = structured_file_changes(&files, &remote, &synced, "alcy-collections.json")
            .await
            .unwrap();

        // Só cobre um dos dois itens alterados.
        let result = resolve_conflict(
            &files,
            &remote,
            &synced,
            "alcy-collections.json",
            Resolution::PerItem {
                items: vec![ItemResolution {
                    item_id: "request:r1".into(),
                    side: ConflictSide::Remote,
                }],
                expected_local_revision: changes.local_revision,
                expected_remote_revision: changes.remote_revision,
            },
        )
        .await;
        assert_eq!(
            result,
            Err(VersionControlError::IncompleteResolution(
                "alcy-collections.json".into()
            ))
        );
    }

    #[tokio::test]
    async fn per_item_resolution_rejects_stale_hashes() {
        let original = r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one"},{"id":"r2","name":"Two","endpoint":"/two"}]}]}"#;
        let files = FakeFiles::with(&[("alcy-collections.json", original)]);
        let remote = FakeRemote::with(&[("alcy-collections.json", original)]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;
        remote.set(
            "alcy-collections.json",
            r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one-remote"},{"id":"r2","name":"Two","endpoint":"/two"}]}]}"#,
        );
        files
            .write(
                "alcy-collections.json",
                br#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one"},{"id":"r2","name":"Two","endpoint":"/two-local"}]}]}"#,
            )
            .unwrap();
        let changes = structured_file_changes(&files, &remote, &synced, "alcy-collections.json")
            .await
            .unwrap();

        // O remoto muda de novo entre a revisão e a resolução.
        remote.set("alcy-collections.json", r#"{"version":1,"collections":[]}"#);

        let result = resolve_conflict(
            &files,
            &remote,
            &synced,
            "alcy-collections.json",
            Resolution::PerItem {
                items: vec![
                    ItemResolution {
                        item_id: "request:r1".into(),
                        side: ConflictSide::Remote,
                    },
                    ItemResolution {
                        item_id: "request:r2".into(),
                        side: ConflictSide::Local,
                    },
                ],
                expected_local_revision: changes.local_revision,
                expected_remote_revision: changes.remote_revision,
            },
        )
        .await;
        assert_eq!(result, Err(VersionControlError::StaleSelection));
    }

    #[tokio::test]
    async fn per_item_resolution_rejected_for_the_manifest() {
        let files = FakeFiles::with(&[("alcy-workspace.json", "{}")]);
        let remote = FakeRemote::with(&[("alcy-workspace.json", "{}")]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;
        remote.set("alcy-workspace.json", r#"{"a":1}"#);
        files.write("alcy-workspace.json", br#"{"b":2}"#).unwrap();

        let result = resolve_conflict(
            &files,
            &remote,
            &synced,
            "alcy-workspace.json",
            Resolution::PerItem {
                items: vec![],
                expected_local_revision: None,
                expected_remote_revision: None,
            },
        )
        .await;
        assert_eq!(
            result,
            Err(VersionControlError::PartialResolutionUnsupported(
                "alcy-workspace.json".into()
            ))
        );
    }

    #[tokio::test]
    async fn resolve_rejects_untracked_and_non_conflicting_files() {
        let files = FakeFiles::default();
        let remote = FakeRemote::default();
        let base = link();

        assert_eq!(
            resolve_conflict(&files, &remote, &base, "outro.json", Resolution::KeepLocal).await,
            Err(VersionControlError::NotTracked("outro.json".into()))
        );
        assert_eq!(
            resolve_conflict(
                &files,
                &remote,
                &base,
                "alcy-flows.json",
                Resolution::KeepLocal
            )
            .await,
            Err(VersionControlError::NotInConflict("alcy-flows.json".into()))
        );
    }

    #[test]
    fn semantic_diff_supports_ten_thousand_items_above_text_diff_limit() {
        let requests: Vec<_> = (0..10_000)
            .map(|index| {
                serde_json::json!({
                    "id": format!("request-{index}"),
                    "name": format!("{}-{index}", "x".repeat(220)),
                    "endpoint": "https://example.test"
                })
            })
            .collect();
        let remote = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "collections": [{
                "id": "collection",
                "name": "Large",
                "folders": [],
                "requests": requests
            }]
        }))
        .unwrap();
        let mut local_value: Value = serde_json::from_slice(&remote).unwrap();
        local_value["collections"][0]["requests"][9999]["name"] = Value::String("changed".into());
        let local = serde_json::to_vec(&local_value).unwrap();

        assert!(remote.len() > MAX_DIFF_BYTES);
        let changes = structured_file_changes_from_content(
            "alcy-collections.json",
            Some(local),
            Some(remote),
        )
        .unwrap();

        assert!(changes.supports_partial);
        assert!(
            changes
                .items
                .iter()
                .any(|item| item.id == "request:request-9999")
        );
    }

    #[test]
    fn value_monitors_are_diffed_per_monitor() {
        let remote = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "monitors": [
                { "id": "a", "name": "Nome curto", "enabled": true, "fields": ["nome"], "rules": [] },
                { "id": "b", "name": "E-mail", "enabled": true, "fields": ["email"], "rules": [] }
            ]
        }))
        .unwrap();
        let local = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "monitors": [
                { "id": "a", "name": "Nome curto", "enabled": false, "fields": ["nome"], "rules": [] },
                { "id": "b", "name": "E-mail", "enabled": true, "fields": ["email"], "rules": [] }
            ]
        }))
        .unwrap();

        let changes = structured_file_changes_from_content(
            "alcy-value-monitors.json",
            Some(local),
            Some(remote),
        )
        .unwrap();

        assert!(changes.supports_partial);
        let ids: Vec<&str> = changes.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["monitor:a"]);
        assert_eq!(changes.items[0].label, "Nome curto");
    }

    #[tokio::test]
    async fn diff_shows_remote_on_the_left_and_local_on_the_right() {
        let files = FakeFiles::with(&[("alcy-flows.json", "a\nb\nc\n")]);
        let remote = FakeRemote::with(&[("alcy-flows.json", "a\nx\nc\n")]);

        let diff = file_diff(&files, &remote, &link(), "alcy-flows.json")
            .await
            .unwrap();

        assert!(diff.remote_exists && diff.local_exists);
        assert_eq!(diff.hunks.len(), 1);
        let lines: Vec<(DiffLineKind, &str)> = diff.hunks[0]
            .lines
            .iter()
            .map(|line| (line.kind, line.text.as_str()))
            .collect();
        assert_eq!(
            lines,
            vec![
                (DiffLineKind::Context, "a"),
                (DiffLineKind::Removed, "x"),
                (DiffLineKind::Added, "b"),
                (DiffLineKind::Context, "c"),
            ]
        );
    }

    #[tokio::test]
    async fn diff_handles_added_files_binary_and_large_content() {
        let files = FakeFiles::with(&[("alcy-flows.json", "novo\n")]);
        let remote = FakeRemote::default();
        let added = file_diff(&files, &remote, &link(), "alcy-flows.json")
            .await
            .unwrap();
        assert!(!added.remote_exists && added.local_exists);
        assert_eq!(added.hunks[0].lines[0].kind, DiffLineKind::Added);

        files.write("alcy-flows.json", &[0xff, 0xfe, 0x00]).unwrap();
        let binary = file_diff(&files, &remote, &link(), "alcy-flows.json")
            .await
            .unwrap();
        assert!(binary.binary && binary.hunks.is_empty());

        files
            .write("alcy-flows.json", &vec![b'a'; MAX_DIFF_BYTES + 1])
            .unwrap();
        let large = file_diff(&files, &remote, &link(), "alcy-flows.json")
            .await
            .unwrap();
        assert!(large.too_large && large.hunks.is_empty());

        assert_eq!(
            file_diff(&files, &remote, &link(), "x.json").await,
            Err(VersionControlError::NotTracked("x.json".into()))
        );
    }

    #[tokio::test]
    async fn diff_is_truncated_past_the_line_limit() {
        let many: String = (0..MAX_DIFF_LINES + 10)
            .map(|index| format!("linha {index}\n"))
            .collect();
        let files = FakeFiles::with(&[("alcy-flows.json", many.as_str())]);
        let remote = FakeRemote::default();

        let diff = file_diff(&files, &remote, &link(), "alcy-flows.json")
            .await
            .unwrap();

        assert!(diff.truncated);
        let total: usize = diff.hunks.iter().map(|hunk| hunk.lines.len()).sum();
        assert_eq!(total, MAX_DIFF_LINES);
    }

    #[tokio::test]
    async fn status_lists_environments_only_when_opted_in() {
        let files = FakeFiles::default();
        let remote = FakeRemote::default();

        let without = version_status(&files, &remote, &link()).await.unwrap();
        // Workspace, coleções, flows, documentação importada e monitores de valores.
        assert_eq!(states(&without).len(), 5);

        let mut with_env = link();
        with_env.include_environments = true;
        let with = version_status(&files, &remote, &with_env).await.unwrap();
        assert_eq!(states(&with).len(), 6);
    }

    #[tokio::test]
    async fn selective_push_keeps_unselected_requests_pending() {
        let original = r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one"},{"id":"r2","name":"Two","endpoint":"/two"}]}]}"#;
        let edited = r#"{"version":1,"collections":[{"id":"c1","name":"API","folders":[],"requests":[{"id":"r1","name":"One","endpoint":"/one-new"},{"id":"r2","name":"Two","endpoint":"/two-new"}]}]}"#;
        let files = FakeFiles::with(&[("alcy-collections.json", original)]);
        let remote = FakeRemote::with(&[("alcy-collections.json", original)]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;
        files
            .write("alcy-collections.json", edited.as_bytes())
            .unwrap();
        let changes = structured_file_changes(&files, &remote, &synced, "alcy-collections.json")
            .await
            .unwrap();
        assert_eq!(changes.items.len(), 2);

        let outcome = push_selected_changes(
            &files,
            &remote,
            &synced,
            "Update one request",
            &[ChangeSelection {
                name: "alcy-collections.json".into(),
                whole_file: false,
                item_ids: vec!["request:r1".into()],
                expected_local_revision: changes.local_revision,
                expected_remote_revision: changes.remote_revision,
            }],
        )
        .await
        .unwrap();

        let remote_json: Value =
            serde_json::from_str(&remote.text("alcy-collections.json").unwrap()).unwrap();
        let requests = remote_json["collections"][0]["requests"]
            .as_array()
            .unwrap();
        assert_eq!(requests[0]["endpoint"], "/one-new");
        assert_eq!(requests[1]["endpoint"], "/two");
        let status = version_status(&files, &remote, &outcome.link)
            .await
            .unwrap();
        assert_eq!(
            states(&status)
                .into_iter()
                .find(|(name, _)| name == "alcy-collections.json")
                .unwrap()
                .1,
            FileState::LocalModified
        );
    }

    #[tokio::test]
    async fn selective_push_rejects_a_stale_local_revision() {
        let original = r#"{"version":1,"flows":[{"id":"f1","name":"Before"}]}"#;
        let files = FakeFiles::with(&[("alcy-flows.json", original)]);
        let remote = FakeRemote::with(&[("alcy-flows.json", original)]);
        let synced = version_status(&files, &remote, &link()).await.unwrap().link;
        files
            .write(
                "alcy-flows.json",
                br#"{"version":1,"flows":[{"id":"f1","name":"After"}]}"#,
            )
            .unwrap();
        let changes = structured_file_changes(&files, &remote, &synced, "alcy-flows.json")
            .await
            .unwrap();
        files
            .write(
                "alcy-flows.json",
                br#"{"version":1,"flows":[{"id":"f1","name":"Newer"}]}"#,
            )
            .unwrap();

        let result = push_selected_changes(
            &files,
            &remote,
            &synced,
            "msg",
            &[ChangeSelection {
                name: "alcy-flows.json".into(),
                whole_file: false,
                item_ids: vec!["flow:f1".into()],
                expected_local_revision: changes.local_revision,
                expected_remote_revision: changes.remote_revision,
            }],
        )
        .await;

        assert_eq!(result, Err(VersionControlError::StaleSelection));
    }
}

/// Resultado materializado de uma única entidade depois de aplicar, em
/// memória, todas as escolhas de uma resolução de conflito.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolutionPreview {
    pub item_id: String,
    pub label: String,
    pub item_kind: String,
    pub exists: bool,
    pub fields: Vec<PreviewField>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolutionPreviewInput {
    pub name: String,
    pub items: Vec<ItemResolution>,
    pub expected_local_revision: Option<String>,
    pub expected_remote_revision: Option<String>,
    pub item_id: String,
}

fn compose_conflict_value(
    name: &str,
    local: Option<&[u8]>,
    remote: Option<&[u8]>,
    items: &[ItemResolution],
) -> Result<Value, VersionControlError> {
    let remote_json = parse_json(remote, name)?.unwrap_or(Value::Object(Map::new()));
    let local_json = parse_json(local, name)?.unwrap_or(Value::Object(Map::new()));
    let remote_items = collect_items(&remote_json);
    let local_items = collect_items(&local_json);
    let changed: HashSet<String> = changed_item_ids(&remote_items, &local_items)
        .into_iter()
        .collect();
    let provided: HashSet<String> = items.iter().map(|item| item.item_id.clone()).collect();
    if provided != changed {
        return Err(VersionControlError::IncompleteResolution(name.to_string()));
    }
    let selected_local: HashSet<String> = items
        .iter()
        .filter(|item| item.side == ConflictSide::Local)
        .map(|item| item.item_id.clone())
        .collect();
    merge_partial_value(Some(&remote_json), Some(&local_json), &selected_local)
        .ok_or_else(|| VersionControlError::InvalidStructuredFile(name.to_string()))
}

#[cfg(test)]
mod merge_tests {
    use super::*;
    use serde_json::json;

    const COLLECTIONS: &str = "alcy-collections.json";

    fn bytes(value: Value) -> Vec<u8> {
        serde_json::to_vec_pretty(&value).unwrap()
    }

    fn merged(result: FileMerge) -> Value {
        match result {
            FileMerge::Merged(Some(bytes)) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("expected a merge, got {other:?}"),
        }
    }

    fn collections(requests: Value) -> Value {
        json!({ "version": 1, "collections": [{ "id": "c", "name": "API", "requests": requests }] })
    }

    #[test]
    fn a_side_that_kept_the_base_takes_the_other_side() {
        let base = b"a".as_slice();
        assert_eq!(
            merge_file("x.json", Some(base), Some(b"b"), Some(base)),
            FileMerge::Merged(Some(b"b".to_vec()))
        );
        assert_eq!(
            merge_file("x.json", Some(base), Some(base), None),
            FileMerge::Merged(None)
        );
        assert_eq!(
            merge_file("x.json", None, Some(b"same"), Some(b"same")),
            FileMerge::Merged(Some(b"same".to_vec()))
        );
        // Unstructured file changed on both sides.
        assert_eq!(
            merge_file("alcy-workspace.json", Some(base), Some(b"b"), Some(b"c")),
            FileMerge::Conflict
        );
        // Deleted on one side, changed on the other.
        assert_eq!(
            merge_file(COLLECTIONS, Some(base), None, Some(b"c")),
            FileMerge::Conflict
        );
    }

    #[test]
    fn combines_entities_changed_on_different_sides() {
        let base = collections(json!([
            { "id": "r1", "name": "Login", "url": "/login" },
            { "id": "r2", "name": "Users", "url": "/users" },
            { "id": "r3", "name": "Old", "url": "/old" }
        ]));
        let ours = collections(json!([
            { "id": "r1", "name": "Login", "url": "/v2/login" },
            { "id": "r2", "name": "Users", "url": "/users" },
            { "id": "r4", "name": "Mine", "url": "/mine" }
        ]));
        let theirs = collections(json!([
            { "id": "r1", "name": "Login", "url": "/login" },
            { "id": "r2", "name": "All users", "url": "/users" },
            { "id": "r3", "name": "Old", "url": "/old" },
            { "id": "r5", "name": "Theirs", "url": "/theirs" }
        ]));
        let result = merged(merge_file(
            COLLECTIONS,
            Some(&bytes(base)),
            Some(&bytes(ours)),
            Some(&bytes(theirs)),
        ));
        let requests = result["collections"][0]["requests"].as_array().unwrap();
        let by_id: BTreeMap<_, _> = requests
            .iter()
            .map(|request| (request["id"].as_str().unwrap(), request))
            .collect();
        assert_eq!(by_id["r1"]["url"], "/v2/login");
        assert_eq!(by_id["r2"]["name"], "All users");
        assert!(!by_id.contains_key("r3"), "deleted by ours");
        assert!(by_id.contains_key("r4"));
        assert!(by_id.contains_key("r5"));
        assert_eq!(result["version"], 1);
    }

    #[test]
    fn the_same_entity_changed_on_both_sides_conflicts() {
        let base = collections(json!([{ "id": "r1", "name": "Login", "url": "/login" }]));
        let ours = collections(json!([{ "id": "r1", "name": "Login", "url": "/a" }]));
        let theirs = collections(json!([{ "id": "r1", "name": "Login", "url": "/b" }]));
        assert_eq!(
            merge_file(
                COLLECTIONS,
                Some(&bytes(base.clone())),
                Some(&bytes(ours)),
                Some(&bytes(theirs))
            ),
            FileMerge::Conflict
        );

        // Identical edits on both sides are not a conflict.
        let both = collections(json!([{ "id": "r1", "name": "Login", "url": "/same" }]));
        let result = merged(merge_file(
            COLLECTIONS,
            Some(&bytes(base.clone())),
            Some(&bytes(both.clone())),
            Some(&bytes(collections(json!([
                { "id": "r1", "name": "Login", "url": "/same" },
                { "id": "r2", "name": "New", "url": "/new" }
            ])))),
        ));
        assert_eq!(
            result["collections"][0]["requests"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        // Deleted on one side, edited on the other.
        let deleted = collections(json!([]));
        let edited = collections(json!([{ "id": "r1", "name": "Login", "url": "/c" }]));
        assert_eq!(
            merge_file(
                COLLECTIONS,
                Some(&bytes(base)),
                Some(&bytes(deleted)),
                Some(&bytes(edited))
            ),
            FileMerge::Conflict
        );
    }

    #[test]
    fn top_level_fields_merge_like_entities() {
        let base = json!({ "version": 1, "collections": [] });
        let ours = json!({ "version": 1, "theme": "dark", "collections": [] });
        let theirs = json!({ "version": 1, "collections": [{ "id": "c", "name": "New" }] });
        let result = merged(merge_file(
            COLLECTIONS,
            Some(&bytes(base.clone())),
            Some(&bytes(ours)),
            Some(&bytes(theirs)),
        ));
        assert_eq!(result["theme"], "dark");
        assert_eq!(result["collections"][0]["name"], "New");

        assert_eq!(
            merge_file(
                COLLECTIONS,
                Some(&bytes(base)),
                Some(&bytes(json!({ "version": 2, "collections": [] }))),
                Some(&bytes(json!({ "version": 3, "collections": [] })))
            ),
            FileMerge::Conflict
        );
    }

    #[test]
    fn edits_inside_a_renamed_folder_survive() {
        let base = json!({ "collections": [{ "id": "c", "name": "API", "folders": [
            { "id": "f", "name": "Auth", "requests": [{ "id": "r1", "name": "Login" }] }
        ] }] });
        let ours = json!({ "collections": [{ "id": "c", "name": "API", "folders": [
            { "id": "f", "name": "Authentication", "requests": [{ "id": "r1", "name": "Login" }] }
        ] }] });
        let theirs = json!({ "collections": [{ "id": "c", "name": "API", "folders": [
            { "id": "f", "name": "Auth", "requests": [
                { "id": "r1", "name": "Login" }, { "id": "r2", "name": "Logout" }
            ] }
        ] }] });
        let result = merged(merge_file(
            COLLECTIONS,
            Some(&bytes(base)),
            Some(&bytes(ours)),
            Some(&bytes(theirs)),
        ));
        let folder = &result["collections"][0]["folders"][0];
        assert_eq!(folder["name"], "Authentication");
        assert_eq!(folder["requests"].as_array().unwrap().len(), 2);
    }
}
