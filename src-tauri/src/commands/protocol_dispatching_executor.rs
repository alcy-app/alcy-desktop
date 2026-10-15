use std::path::Path;

use alcy_app::RequestExecutor;
use alcy_domain::{ExecutionError, ProtocolId, Request, Response};
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_rest::ReqwestRestExecutor;

/// Composição pura: despacha uma requisição para o executor do protocolo
/// certo. Existe porque `alcy_app::execute_flow` é genérico sobre um único
/// `E: RequestExecutor`, mas um flow pode ter nodes GraphQL e REST
/// misturados — o núcleo (`alcy-app`) não pode conhecer "protocolo" além do
/// identificador opaco já presente em `Request.document.protocol`
/// (invariante 6 de `ARCHITECTURE.md`), então esse despacho vive aqui.
pub(crate) struct ProtocolDispatchingExecutor<'a> {
    pub(crate) graphql: &'a ReqwestGraphqlExecutor,
    pub(crate) rest: &'a ReqwestRestExecutor,
    /// Raiz do workspace: arquivos de corpo salvos com caminho relativo são
    /// resolvidos contra ela antes de enviar (ADR 0024).
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
            // The gRPC executor arrives in a later slice of spec 0129.
            ProtocolId::Grpc => Err(ExecutionError::InvalidRequest(
                "requisições gRPC ainda não podem ser enviadas nesta versão".to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Authentication, Endpoint, RequestDocument};

    #[tokio::test]
    async fn a_grpc_request_is_never_sent_by_an_http_executor() {
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let dispatcher = ProtocolDispatchingExecutor {
            graphql: &graphql,
            rest: &rest,
            workspace_root: Path::new("."),
        };
        let request = Request::new(
            // Unreachable on purpose: an HTTP executor would fail with a
            // network error, not with `InvalidRequest`.
            Endpoint::new("http://127.0.0.1:9").unwrap(),
            RequestDocument::new(ProtocolId::Grpc, "{}"),
            "",
            vec![],
            Authentication::None,
        );

        let error = dispatcher.execute(&request).await.unwrap_err();

        assert!(
            matches!(error, ExecutionError::InvalidRequest(ref message) if message.contains("gRPC"))
        );
    }
}
