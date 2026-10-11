use std::future::Future;
use std::time::Duration;

use alcy_domain::{ExecutionError, Request, Response};

/// Fases que um executor HTTP conseguiu observar. A ausência de uma fase não
/// representa duração zero: só significa que o transporte não a expõe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RequestExecutionTimings {
    pub dns: Option<Duration>,
    pub connecting: Option<Duration>,
    pub tls_handshaking: Option<Duration>,
    pub sending: Option<Duration>,
    pub waiting: Option<Duration>,
    pub receiving: Option<Duration>,
}

/// Resposta opcionalmente instrumentada. Mantém a porta de requests genérica:
/// consumidores sem interesse nas fases continuam chamando `execute`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstrumentedResponse {
    pub response: Response,
    pub timings: RequestExecutionTimings,
}

/// Porta para executar uma requisição contra um servidor, independente do
/// protocolo (`Request.document.protocol` diz qual é).
///
/// Implementada por um adapter de infraestrutura por protocolo (ex.:
/// `alcy-graphql`, `alcy-rest`). O caso de uso depende só desta abstração,
/// não de um cliente HTTP concreto.
///
/// Usa `-> impl Future + Send` em vez de `async fn` porque commands Tauri
/// rodam em um runtime multi-thread; `async fn` em trait não permite
/// declarar esse bound (`Send`) na assinatura.
pub trait RequestExecutor {
    fn execute(
        &self,
        request: &Request,
    ) -> impl Future<Output = Result<Response, ExecutionError>> + Send;

    /// Variante que permite ao adapter HTTP expor telemetria sem obrigar os
    /// demais executores a instrumentar suas respostas. A implementação
    /// padrão preserva a compatibilidade de todos os adaptadores existentes.
    fn execute_instrumented(
        &self,
        request: &Request,
    ) -> impl Future<Output = Result<InstrumentedResponse, ExecutionError>> + Send
    where
        Self: Sync,
    {
        async move {
            self.execute(request)
                .await
                .map(|response| InstrumentedResponse {
                    response,
                    timings: RequestExecutionTimings::default(),
                })
        }
    }

    /// Como `execute`, sabendo de qual requisição salva `request` veio —
    /// para executores que precisam do contexto dela na coleção (ex.:
    /// scripts com `al.collection`/`al.folder`, ADR 0031).
    fn execute_saved(
        &self,
        request_id: &str,
        request: &Request,
    ) -> impl Future<Output = Result<Response, ExecutionError>> + Send {
        let _ = request_id;
        self.execute(request)
    }
}
