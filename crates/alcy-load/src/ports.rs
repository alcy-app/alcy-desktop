//! Portas fornecidas pelo consumidor, sem dependência da aplicação desktop.

use std::future::Future;
use std::time::Duration;

use alcy_domain::{ExecutionError, Request, Response};

/// Tempos de uma troca HTTP. Uma fase ausente não foi medida pelo transporte;
/// o runner não a infere nem a substitui por zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LoadRequestTimings {
    pub dns: Option<Duration>,
    pub connecting: Option<Duration>,
    pub tls_handshaking: Option<Duration>,
    pub sending: Option<Duration>,
    pub waiting: Option<Duration>,
    pub receiving: Option<Duration>,
    /// Medido pelo runner ao redor de toda a chamada de transporte.
    pub total: Duration,
}

impl LoadRequestTimings {
    /// A resposta genérica não prova que uma fase foi medida. Transportes
    /// concretos preenchem os campos que observam; o runner sempre substitui
    /// `total` pela duração real da chamada.
    pub fn from_response(_response: &Response) -> Self {
        Self::default()
    }

    pub(crate) fn with_total(mut self, total: Duration) -> Self {
        self.total = total;
        self
    }
}

/// Resultado do transporte com a resposta e as fases que ele conseguiu
/// observar. Corpos continuam internos ao transporte e não entram no IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadTransportResponse {
    pub response: Response,
    pub timings: LoadRequestTimings,
}

impl LoadTransportResponse {
    pub fn from_response(response: Response) -> Self {
        let timings = LoadRequestTimings::from_response(&response);
        Self { response, timings }
    }

    pub fn new(response: Response, timings: LoadRequestTimings) -> Self {
        Self { response, timings }
    }
}

/// Transporte HTTP injetado. O runner aplica sessão, concorrência e métricas;
/// o consumidor escolhe cliente, proxy e política de resposta. Descartar a
/// future deve cancelar o trabalho em curso, sem tarefas órfãs.
pub trait LoadTransport: Sync {
    fn execute(
        &self,
        request: &Request,
    ) -> impl Future<Output = Result<Response, ExecutionError>> + Send;

    /// Variante que preserva timings fornecidos por um transporte concreto.
    /// A implementação padrão mantém compatibilidade com adaptadores que só
    /// expõem `Response`; nesse caso somente a duração total é observada.
    fn execute_instrumented(
        &self,
        request: &Request,
    ) -> impl Future<Output = Result<LoadTransportResponse, ExecutionError>> + Send {
        async move {
            self.execute(request)
                .await
                .map(LoadTransportResponse::from_response)
        }
    }
}

/// Sinal de execução independente de flows. A future precisa poder ser
/// criada para cada cenário e observar também cancelamentos anteriores.
pub trait LoadCancellation: Sync {
    fn is_cancelled(&self) -> bool;
    fn cancelled(&self) -> impl Future<Output = ()> + Send;
}
