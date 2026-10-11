use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex;

use alcy_app::{
    CommitAction, RemoteError, RemoteFileMeta, RemoteRepository, StructuredFileChanges,
    content_hash,
};

// O orçamento total de cache em memória é 64 MiB: metade para conteúdo bruto
// e metade para os índices semânticos derivados desse conteúdo.
pub const REMOTE_CACHE_MEMORY_BYTES: usize = 32 * 1024 * 1024;
pub const REMOTE_CACHE_DISK_BYTES: u64 = 256 * 1024 * 1024;

/// Estado único dos caches do controle de versão. Agrupar os dois mantém um
/// orçamento explícito e evita espalhar estados Tauri pelos commands.
pub struct VersionControlCaches {
    pub remote: RemoteContentCache,
    pub structured: StructuredChangesCache,
}

impl VersionControlCaches {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            remote: RemoteContentCache::new(dir),
            structured: StructuredChangesCache::default(),
        }
    }

    pub async fn clear(&self) {
        self.remote.clear().await;
        self.structured.clear().await;
    }
}

#[derive(Default)]
struct MemoryState {
    entries: HashMap<String, Arc<[u8]>>,
    order: VecDeque<String>,
    bytes: usize,
}

/// Cache descartável e limitado de conteúdo remoto, endereçado pelo SHA-256
/// informado pelo GitLab. O hash é validado em toda leitura de disco, então
/// corrupção do cache vira miss em vez de contaminar um diff ou resolução.
pub struct RemoteContentCache {
    dir: PathBuf,
    memory_limit: usize,
    disk_limit: u64,
    memory: Mutex<MemoryState>,
    disk: Mutex<()>,
}

impl RemoteContentCache {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_limits(dir, REMOTE_CACHE_MEMORY_BYTES, REMOTE_CACHE_DISK_BYTES)
    }

    fn with_limits(dir: PathBuf, memory_limit: usize, disk_limit: u64) -> Self {
        Self {
            dir,
            memory_limit,
            disk_limit,
            memory: Mutex::new(MemoryState::default()),
            disk: Mutex::new(()),
        }
    }

    pub async fn get(&self, revision: &str) -> Option<Vec<u8>> {
        if !valid_revision(revision) {
            return None;
        }
        {
            let mut memory = self.memory.lock().await;
            if let Some(bytes) = memory.entries.get(revision).cloned() {
                touch_memory(&mut memory, revision);
                return Some(bytes.as_ref().to_vec());
            }
        }

        let _disk_guard = self.disk.lock().await;
        let path = self.content_path(revision);
        let bytes = tokio::fs::read(&path).await.ok()?;
        if content_hash(&bytes) != revision {
            let _ = tokio::fs::remove_file(&path).await;
            let _ = tokio::fs::remove_file(self.access_path(revision)).await;
            return None;
        }
        self.touch_disk(revision).await;
        self.insert_memory(revision.to_string(), Arc::from(bytes.clone()))
            .await;
        Some(bytes)
    }

    pub async fn put(&self, revision: &str, bytes: &[u8]) {
        if !valid_revision(revision) || content_hash(bytes) != revision {
            return;
        }
        self.insert_memory(revision.to_string(), Arc::from(bytes))
            .await;

        let _disk_guard = self.disk.lock().await;
        if tokio::fs::create_dir_all(&self.dir).await.is_err() {
            return;
        }
        let path = self.content_path(revision);
        if tokio::fs::metadata(&path).await.is_err() {
            let tmp = self.dir.join(format!("{revision}.tmp"));
            if tokio::fs::write(&tmp, bytes).await.is_err()
                || tokio::fs::rename(&tmp, &path).await.is_err()
            {
                let _ = tokio::fs::remove_file(tmp).await;
                return;
            }
        }
        self.touch_disk(revision).await;
        self.prune_disk().await;
    }

    pub async fn clear(&self) {
        {
            let mut memory = self.memory.lock().await;
            *memory = MemoryState::default();
        }
        let _disk_guard = self.disk.lock().await;
        match tokio::fs::remove_dir_all(&self.dir).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }

    async fn insert_memory(&self, revision: String, bytes: Arc<[u8]>) {
        let mut memory = self.memory.lock().await;
        if let Some(previous) = memory.entries.remove(&revision) {
            memory.bytes = memory.bytes.saturating_sub(previous.len());
            memory.order.retain(|key| key != &revision);
        }
        memory.bytes = memory.bytes.saturating_add(bytes.len());
        memory.entries.insert(revision.clone(), bytes);
        memory.order.push_back(revision);
        while memory.bytes > self.memory_limit {
            let Some(oldest) = memory.order.pop_front() else {
                break;
            };
            if let Some(removed) = memory.entries.remove(&oldest) {
                memory.bytes = memory.bytes.saturating_sub(removed.len());
            }
        }
    }

    async fn touch_disk(&self, revision: &str) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let _ = tokio::fs::write(self.access_path(revision), timestamp.to_string()).await;
    }

    async fn prune_disk(&self) {
        let Ok(mut directory) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        let mut entries = Vec::new();
        let mut total = 0u64;
        while let Ok(Some(entry)) = directory.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("bin") {
                continue;
            }
            let Ok(metadata) = entry.metadata().await else {
                continue;
            };
            let Some(revision) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let accessed = tokio::fs::read_to_string(self.access_path(revision))
                .await
                .ok()
                .and_then(|value| value.parse::<u128>().ok())
                .unwrap_or_default();
            total = total.saturating_add(metadata.len());
            entries.push((accessed, metadata.len(), revision.to_string(), path));
        }
        entries.sort_by_key(|entry| entry.0);
        for (_, size, revision, path) in entries {
            if total <= self.disk_limit {
                break;
            }
            if tokio::fs::remove_file(path).await.is_ok() {
                total = total.saturating_sub(size);
            }
            let _ = tokio::fs::remove_file(self.access_path(&revision)).await;
        }
    }

    fn content_path(&self, revision: &str) -> PathBuf {
        self.dir.join(format!("{revision}.bin"))
    }

    fn access_path(&self, revision: &str) -> PathBuf {
        self.dir.join(format!("{revision}.atime"))
    }
}

fn touch_memory(memory: &mut MemoryState, revision: &str) {
    memory.order.retain(|key| key != revision);
    memory.order.push_back(revision.to_string());
}

fn valid_revision(revision: &str) -> bool {
    revision.len() == 64 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}

const STRUCTURED_CACHE_MEMORY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
struct StructuredState {
    entries: HashMap<String, Arc<StructuredFileChanges>>,
    sizes: HashMap<String, usize>,
    order: VecDeque<String>,
    bytes: usize,
}

/// Índices semânticos já calculados, compartilhados entre páginas e
/// consumidores do mesmo snapshot. O limite impede que workspaces grandes
/// cresçam a memória do processo sem controle.
pub struct StructuredChangesCache {
    limit: usize,
    state: Mutex<StructuredState>,
}

impl Default for StructuredChangesCache {
    fn default() -> Self {
        Self {
            limit: STRUCTURED_CACHE_MEMORY_BYTES,
            state: Mutex::new(StructuredState::default()),
        }
    }
}

impl StructuredChangesCache {
    pub async fn get(&self, key: &str) -> Option<Arc<StructuredFileChanges>> {
        let mut state = self.state.lock().await;
        let entry = state.entries.get(key).cloned()?;
        state.order.retain(|candidate| candidate != key);
        state.order.push_back(key.to_string());
        Some(entry)
    }

    pub async fn insert(&self, key: String, changes: Arc<StructuredFileChanges>) {
        let size = structured_size(&changes);
        let mut state = self.state.lock().await;
        if let Some(previous_size) = state.sizes.remove(&key) {
            state.bytes = state.bytes.saturating_sub(previous_size);
            state.entries.remove(&key);
            state.order.retain(|candidate| candidate != &key);
        }
        state.bytes = state.bytes.saturating_add(size);
        state.sizes.insert(key.clone(), size);
        state.entries.insert(key.clone(), changes);
        state.order.push_back(key);
        while state.bytes > self.limit {
            let Some(oldest) = state.order.pop_front() else {
                break;
            };
            if let Some(size) = state.sizes.remove(&oldest) {
                state.bytes = state.bytes.saturating_sub(size);
            }
            state.entries.remove(&oldest);
        }
    }

    pub async fn clear(&self) {
        *self.state.lock().await = StructuredState::default();
    }
}

pub fn structured_cache_key(
    root: &Path,
    file_name: &str,
    local_revision: Option<&str>,
    remote_revision: Option<&str>,
) -> Option<String> {
    Some(format!(
        "{}\n{}\n{}\n{}",
        root.to_string_lossy(),
        file_name,
        local_revision?,
        remote_revision?
    ))
}

fn structured_size(changes: &StructuredFileChanges) -> usize {
    let mut size = changes.name.len();
    for item in &changes.items {
        size = size
            .saturating_add(item.id.len())
            .saturating_add(item.label.len())
            .saturating_add(item.item_kind.len());
        size = item.fields.iter().fold(size, |total, field| {
            total
                .saturating_add(field.name.len())
                .saturating_add(field.local.as_ref().map_or(0, String::len))
                .saturating_add(field.remote.as_ref().map_or(0, String::len))
        });
        size = item.dependencies.iter().fold(size, |total, dependency| {
            total.saturating_add(dependency.len())
        });
    }
    size
}

/// Decorador de repositório usado por consultas de detalhes. Quando o caller
/// já conhece o hash remoto do status, uma entrada válida evita completamente
/// o GET do arquivo; misses seguem para a rede e aquecem o cache.
pub struct CachedRemoteRepository<'a, R> {
    inner: R,
    cache: &'a RemoteContentCache,
    target_path: String,
    expected_revision: Option<String>,
}

impl<'a, R> CachedRemoteRepository<'a, R> {
    pub fn new(
        inner: R,
        cache: &'a RemoteContentCache,
        target_path: String,
        expected_revision: Option<String>,
    ) -> Self {
        Self {
            inner,
            cache,
            target_path,
            expected_revision,
        }
    }
}

impl<R> RemoteRepository for CachedRemoteRepository<'_, R>
where
    R: RemoteRepository + Sync,
{
    async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
        self.inner.file_meta(path).await
    }

    async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        if path == self.target_path {
            if let Some(revision) = &self.expected_revision {
                if let Some(bytes) = self.cache.get(revision).await {
                    return Ok(Some(bytes));
                }
            }
        }

        let content = self.inner.read_file(path).await?;
        if path == self.target_path {
            if let (Some(revision), Some(bytes)) = (&self.expected_revision, &content) {
                if content_hash(bytes) == *revision {
                    self.cache.put(revision, bytes).await;
                }
            }
        }
        Ok(content)
    }

    async fn commit(&self, message: &str, actions: &[CommitAction]) -> Result<String, RemoteError> {
        self.inner.commit(message, actions).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-remote-cache-{}-{id}", std::process::id()))
    }

    #[tokio::test]
    async fn survives_reopening_and_rejects_corruption() {
        let dir = temp_dir();
        let revision = content_hash(b"remote");
        let cache = RemoteContentCache::with_limits(dir.clone(), 1024, 4096);
        cache.put(&revision, b"remote").await;
        assert_eq!(
            cache.get(&revision).await.as_deref(),
            Some(b"remote".as_slice())
        );

        let reopened = RemoteContentCache::with_limits(dir.clone(), 1024, 4096);
        assert_eq!(
            reopened.get(&revision).await.as_deref(),
            Some(b"remote".as_slice())
        );

        tokio::fs::write(reopened.content_path(&revision), b"corrupt")
            .await
            .unwrap();
        let cold = RemoteContentCache::with_limits(dir.clone(), 1024, 4096);
        assert_eq!(cold.get(&revision).await, None);
        cold.clear().await;
    }

    #[tokio::test]
    async fn evicts_memory_and_disk_to_their_limits() {
        let dir = temp_dir();
        let cache = RemoteContentCache::with_limits(dir.clone(), 4, 5);
        for content in [b"aaa".as_slice(), b"bbb".as_slice()] {
            let revision = content_hash(content);
            cache.put(&revision, content).await;
        }

        assert!(cache.memory.lock().await.bytes <= 4);
        let mut disk_bytes = 0;
        let mut entries = tokio::fs::read_dir(&dir).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            if entry.path().extension().and_then(|value| value.to_str()) == Some("bin") {
                disk_bytes += entry.metadata().await.unwrap().len();
            }
        }
        assert!(disk_bytes <= 5);
        cache.clear().await;
    }

    struct FakeRemote {
        content: Option<Vec<u8>>,
        reads: std::sync::atomic::AtomicUsize,
    }

    impl RemoteRepository for FakeRemote {
        async fn file_meta(&self, _path: &str) -> Result<RemoteFileMeta, RemoteError> {
            Ok(RemoteFileMeta::default())
        }

        async fn read_file(&self, _path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.content
                .clone()
                .map(Some)
                .ok_or_else(|| RemoteError::Network("offline".into()))
        }

        async fn commit(
            &self,
            _message: &str,
            _actions: &[CommitAction],
        ) -> Result<String, RemoteError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn cached_repository_uses_persisted_content_without_network() {
        let dir = temp_dir();
        let revision = content_hash(b"remote");
        let warm_cache = RemoteContentCache::with_limits(dir.clone(), 1024, 4096);
        let online = FakeRemote {
            content: Some(b"remote".to_vec()),
            reads: std::sync::atomic::AtomicUsize::new(0),
        };
        let repository = CachedRemoteRepository::new(
            online,
            &warm_cache,
            "file.json".into(),
            Some(revision.clone()),
        );
        assert_eq!(
            repository.read_file("file.json").await.unwrap().as_deref(),
            Some(b"remote".as_slice())
        );

        let cold_cache = RemoteContentCache::with_limits(dir.clone(), 1024, 4096);
        let offline = FakeRemote {
            content: None,
            reads: std::sync::atomic::AtomicUsize::new(0),
        };
        let repository =
            CachedRemoteRepository::new(offline, &cold_cache, "file.json".into(), Some(revision));
        assert_eq!(
            repository.read_file("file.json").await.unwrap().as_deref(),
            Some(b"remote".as_slice())
        );
        assert_eq!(
            repository
                .inner
                .reads
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        cold_cache.clear().await;
    }

    #[test]
    fn only_accepts_sha256_hex_keys() {
        assert!(valid_revision(&"a".repeat(64)));
        assert!(!valid_revision("../outside"));
        assert!(!valid_revision(&"g".repeat(64)));
    }
}
