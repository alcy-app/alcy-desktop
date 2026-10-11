use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use tokio::sync::oneshot;

/// Rastreia sinais de cancelamento de execuções em andamento, por
/// `execution_id`. `cancel` e `remove` são idempotentes.
#[derive(Default)]
pub struct ExecutionRegistry {
    senders: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl ExecutionRegistry {
    pub fn register(&self, execution_id: String, sender: oneshot::Sender<()>) {
        self.lock_senders().insert(execution_id, sender);
    }

    pub fn remove(&self, execution_id: &str) {
        self.lock_senders().remove(execution_id);
    }

    pub fn cancel(&self, execution_id: &str) {
        if let Some(sender) = self.lock_senders().remove(execution_id) {
            let _ = sender.send(());
        }
    }

    fn lock_senders(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<()>>> {
        self.senders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn is_registered(&self, execution_id: &str) -> bool {
        self.lock_senders().contains_key(execution_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_resolves_the_receiver_and_removes_the_entry() {
        let registry = ExecutionRegistry::default();
        let (sender, receiver) = oneshot::channel::<()>();
        registry.register("exec-1".to_string(), sender);

        registry.cancel("exec-1");

        assert!(receiver.await.is_ok());
        assert!(!registry.is_registered("exec-1"));
    }

    #[test]
    fn cancel_is_a_no_op_for_an_unknown_execution_id() {
        let registry = ExecutionRegistry::default();

        registry.cancel("does-not-exist");
    }

    #[tokio::test]
    async fn remove_drops_the_entry_without_signalling_cancellation() {
        let registry = ExecutionRegistry::default();
        let (sender, receiver) = oneshot::channel::<()>();
        registry.register("exec-1".to_string(), sender);

        registry.remove("exec-1");

        assert!(!registry.is_registered("exec-1"));
        assert!(receiver.await.is_err());
    }
}
