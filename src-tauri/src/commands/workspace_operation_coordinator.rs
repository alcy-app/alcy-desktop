use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

/// Coordena operações de controle de versão por raiz de workspace.
///
/// Leituras independentes podem coexistir; qualquer operação que atualize
/// arquivos ou a base sincronizada adquire exclusividade. As entradas usam
/// referências fracas para não manter uma raiz na memória depois que todas as
/// operações terminarem.
#[derive(Default)]
pub struct WorkspaceOperationCoordinator {
    locks: Mutex<HashMap<String, Weak<RwLock<()>>>>,
}

impl WorkspaceOperationCoordinator {
    pub async fn read(&self, root: &Path) -> OwnedRwLockReadGuard<()> {
        self.lock_for(root).read_owned().await
    }

    pub async fn write(&self, root: &Path) -> OwnedRwLockWriteGuard<()> {
        self.lock_for(root).write_owned().await
    }

    fn lock_for(&self, root: &Path) -> Arc<RwLock<()>> {
        let key = root.to_string_lossy().into_owned();
        let mut locks = self.lock_locks();
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(RwLock::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    fn lock_locks(&self) -> MutexGuard<'_, HashMap<String, Weak<RwLock<()>>>> {
        self.locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_waits_for_existing_readers() {
        let coordinator = Arc::new(WorkspaceOperationCoordinator::default());
        let root = Path::new("/workspace");
        let reader = coordinator.read(root).await;
        let other = Arc::clone(&coordinator);
        let waiting = tokio::spawn(async move { other.write(Path::new("/workspace")).await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());

        drop(reader);

        assert!(waiting.await.is_ok());
    }

    #[tokio::test]
    async fn different_workspaces_do_not_block_each_other() {
        let coordinator = WorkspaceOperationCoordinator::default();
        let _writer = coordinator.write(Path::new("/workspace-a")).await;

        let reader = coordinator.read(Path::new("/workspace-b")).await;

        drop(reader);
    }
}
