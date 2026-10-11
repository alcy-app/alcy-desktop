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
        if request.document.protocol == ProtocolId::Rest {
            let mut request = request.clone();
            request.body_payload = request
                .body_payload
                .with_files_resolved_against(self.workspace_root);
            self.rest.execute(&request).await
        } else {
            self.graphql.execute(request).await
        }
    }
}
