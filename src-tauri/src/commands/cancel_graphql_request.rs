use serde::Deserialize;

use crate::commands::execution_registry::ExecutionRegistry;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelGraphqlRequestInput {
    pub execution_id: String,
}

/// Cancela uma execução em andamento.
///
/// Idempotente: não faz nada se o `execution_id` não existir ou a execução
/// já tiver terminado.
#[tauri::command]
pub fn cancel_graphql_request(
    input: CancelGraphqlRequestInput,
    registry: tauri::State<'_, ExecutionRegistry>,
) {
    log::info!(target: "alcy::request", "{}: cancelamento pedido", input.execution_id);
    cancel_graphql_request_inner(input, &registry)
}

fn cancel_graphql_request_inner(input: CancelGraphqlRequestInput, registry: &ExecutionRegistry) {
    registry.cancel(&input.execution_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn delegates_to_the_registry_using_the_input_execution_id() {
        let registry = ExecutionRegistry::default();
        let (sender, receiver) = oneshot::channel::<()>();
        registry.register("exec-1".to_string(), sender);

        cancel_graphql_request_inner(
            CancelGraphqlRequestInput {
                execution_id: "exec-1".to_string(),
            },
            &registry,
        );

        assert!(receiver.await.is_ok());
    }
}
