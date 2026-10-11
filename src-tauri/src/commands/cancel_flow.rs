use serde::Deserialize;

use crate::commands::flow_execution_registry::FlowExecutionRegistry;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelFlowInput {
    pub flow_execution_id: String,
}

/// Cancela um flow em execução.
///
/// Idempotente: não faz nada se `flow_execution_id` não existir ou o run já
/// tiver terminado.
#[tauri::command]
pub fn cancel_flow(input: CancelFlowInput, flow_registry: tauri::State<'_, FlowExecutionRegistry>) {
    log::info!(target: "alcy::flow", "{}: cancelamento pedido", input.flow_execution_id);
    cancel_flow_inner(input, &flow_registry)
}

fn cancel_flow_inner(input: CancelFlowInput, flow_registry: &FlowExecutionRegistry) {
    flow_registry.cancel(&input.flow_execution_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::watch;

    #[test]
    fn delegates_to_the_registry_using_the_input_flow_execution_id() {
        let registry = FlowExecutionRegistry::default();
        let (sender, receiver) = watch::channel(false);
        registry.register("flow-exec-1".to_string(), sender);

        cancel_flow_inner(
            CancelFlowInput {
                flow_execution_id: "flow-exec-1".to_string(),
            },
            &registry,
        );

        assert!(*receiver.borrow());
    }
}
