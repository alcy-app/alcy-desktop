use std::path::Path;

use alcy_app::RequestExecutor;
use alcy_domain::{ExecutionError, ProtocolId, Request, Response};
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_rest::ReqwestRestExecutor;

/// Composition-root dispatch for mixed protocols. Application use cases depend on RequestExecutor; concrete GraphQL/REST/gRPC adapters stay here.
pub(crate) struct ProtocolDispatchingExecutor<'a> {
    pub(crate) app: Option<&'a tauri::AppHandle>,
    pub(crate) graphql: &'a ReqwestGraphqlExecutor,
    pub(crate) rest: &'a ReqwestRestExecutor,
    /// Resolve workspace-relative body file paths against this root (ADR 0024).
    pub(crate) workspace_root: &'a Path,
}

impl RequestExecutor for ProtocolDispatchingExecutor<'_> {
    async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
        match request.document.protocol {
            ProtocolId::Rest => {
                let mut request = request.clone();
                request.body_payload = request
                    .body_payload
                    .with_files_resolved_against(self.workspace_root);
                self.rest.execute(&request).await
            }
            ProtocolId::GraphQl => self.graphql.execute(request).await,
            ProtocolId::Grpc => {
                super::grpc::execute_saved_request(request, self.workspace_root, self.app).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Authentication, Endpoint, RequestDocument};

    #[tokio::test]
    async fn a_grpc_request_uses_its_own_transport() {
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let dispatcher = ProtocolDispatchingExecutor {
            app: None,
            graphql: &graphql,
            rest: &rest,
            workspace_root: Path::new("."),
        };
        let request = Request::new(
            // An unreachable gRPC endpoint must produce a transport error,
            // rather than the previous unsupported-protocol refusal.
            Endpoint::new("http://127.0.0.1:9").unwrap(),
            RequestDocument::new(ProtocolId::Grpc, "{}"),
            "",
            vec![],
            Authentication::None,
        );

        let error = dispatcher.execute(&request).await.unwrap_err();

        assert!(matches!(error, ExecutionError::Network(_)));
    }
}
