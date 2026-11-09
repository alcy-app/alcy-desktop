use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, MutexGuard};

use alcy_app::FlowCancellation;
use tokio::sync::watch;

/// Execution-scoped broadcast cancellation using watch::Sender<bool>, reaching all active nodes. Unlike oneshot, multiple receivers observe it. Cancellation and removal are idempotent.
#[derive(Default)]
pub struct FlowExecutionRegistry {
    pub human: super::flow_human_input::HumanFormRegistry,
    senders: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl FlowExecutionRegistry {
    pub fn is_running(&self, flow_execution_id: &str) -> bool {
        self.lock_senders().contains_key(flow_execution_id)
    }
    pub fn has_active(&self) -> bool {
        !self.lock_senders().is_empty()
    }
    pub fn register(&self, flow_execution_id: String, sender: watch::Sender<bool>) {
        self.lock_senders().insert(flow_execution_id, sender);
    }

    pub fn remove(&self, flow_execution_id: &str) {
        self.human.cancel_execution(flow_execution_id);
        self.lock_senders().remove(flow_execution_id);
    }

    /// Idempotent for unknown or removed IDs. Retain the sender until cleanup finishes so repeated cancellation is harmless.
    pub fn cancel(&self, flow_execution_id: &str) {
        if let Some(sender) = self.lock_senders().get(flow_execution_id) {
            let _ = sender.send(true);
        }
        self.human.cancel_execution(flow_execution_id);
    }

    fn lock_senders(&self) -> MutexGuard<'_, HashMap<String, watch::Sender<bool>>> {
        self.senders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn is_registered(&self, flow_execution_id: &str) -> bool {
        self.lock_senders().contains_key(flow_execution_id)
    }
}

/// Native FlowCancellation adapter around watch::Receiver<bool>; the application depends only on the port (spec 0043).
pub(crate) struct WatchCancellation(pub(crate) watch::Receiver<bool>);

impl FlowCancellation for WatchCancellation {
    fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    fn cancelled(&self) -> impl Future<Output = ()> + Send {
        let mut receiver = self.0.clone();
        async move {
            loop {
                if *receiver.borrow() {
                    return;
                }
                if receiver.changed().await.is_err() {
                    // Normal completion drops the sender without cancelling; remain pending so this future cannot win the execution race.
                    std::future::pending::<()>().await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_sets_the_watched_value_to_true() {
        let registry = FlowExecutionRegistry::default();
        let (sender, receiver) = watch::channel(false);
        registry.register("flow-exec-1".to_string(), sender);

        registry.cancel("flow-exec-1");

        assert!(*receiver.borrow());
        assert!(registry.is_registered("flow-exec-1"));
    }

    #[test]
    fn cancel_is_a_no_op_for_an_unknown_flow_execution_id() {
        let registry = FlowExecutionRegistry::default();

        registry.cancel("does-not-exist");
    }

    #[test]
    fn remove_drops_the_entry() {
        let registry = FlowExecutionRegistry::default();
        let (sender, _receiver) = watch::channel(false);
        registry.register("flow-exec-1".to_string(), sender);

        registry.remove("flow-exec-1");

        assert!(!registry.is_registered("flow-exec-1"));
    }

    #[tokio::test]
    async fn watch_cancellation_resolves_once_cancelled() {
        let (sender, receiver) = watch::channel(false);
        let cancellation = WatchCancellation(receiver);
        assert!(!cancellation.is_cancelled());

        sender.send(true).unwrap();

        cancellation.cancelled().await;
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn watch_cancellation_never_resolves_when_the_sender_is_dropped_without_cancelling() {
        let (sender, receiver) = watch::channel(false);
        let cancellation = WatchCancellation(receiver);
        drop(sender);

        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            cancellation.cancelled(),
        )
        .await;

        assert!(
            outcome.is_err(),
            "cancelled() não deveria resolver quando o run terminou sem cancelar"
        );
    }
}
