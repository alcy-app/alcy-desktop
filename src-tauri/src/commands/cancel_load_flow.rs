use serde::Deserialize;

use crate::commands::execute_load_flow::load_registry_id;
use crate::commands::flow_execution_registry::FlowExecutionRegistry;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelLoadFlowInput {
    pub load_run_id: String,
}

/// Cancela idempotentemente um flow de carga em execução. O namespace próprio
/// impede que um ID coincidente alcance um flow normal.
#[tauri::command]
pub fn cancel_load_flow(
    input: CancelLoadFlowInput,
    flow_registry: tauri::State<'_, FlowExecutionRegistry>,
) {
    flow_registry.cancel(&load_registry_id(&input.load_run_id));
}

#[cfg(test)]
mod tests {
    use tokio::sync::watch;

    use super::*;

    #[test]
    fn cancels_only_the_load_run_namespace() {
        let registry = FlowExecutionRegistry::default();
        let (sender, receiver) = watch::channel(false);
        registry.register(load_registry_id("run-1"), sender);
        registry.cancel(&load_registry_id("run-1"));

        assert!(*receiver.borrow());
    }
}
