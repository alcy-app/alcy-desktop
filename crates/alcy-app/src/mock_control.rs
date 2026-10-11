use std::collections::HashMap;
use std::future::Future;

use alcy_domain::MockServerSource;
use thiserror::Error;

/// Chamada recebida por uma rota de um mock server, entregue a um node
/// `MockWaitRequest` (spec 0120). `seq` cresce a cada chamada recebida pelo
/// servidor e serve de cursor: o motor pede sempre "a próxima depois de".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedRequest {
    pub seq: u64,
    pub route_id: String,
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub path_params: Vec<(String, String)>,
    pub body: String,
}

/// Rota de um mock ligado, com o rótulo usado nas mensagens do run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockRouteSummary {
    pub id: String,
    pub label: String,
    /// `(id, nome)` da resposta padrão e das alternativas.
    pub responses: Vec<(String, String)>,
}

/// Mock ligado (ou reaproveitado) por um node `MockStart`. `owned` é
/// `false` quando o servidor já estava ligado antes — o run não o desliga no
/// fim. `start_seq` e `baseline_counts` marcam o ponto a partir do qual o run
/// conta e espera chamadas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockRunHandle {
    pub key: String,
    pub name: String,
    pub port: u16,
    pub owned: bool,
    pub start_seq: u64,
    pub baseline_counts: HashMap<String, u64>,
    pub routes: Vec<MockRouteSummary>,
}

impl MockRunHandle {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn route(&self, route_id: &str) -> Option<&MockRouteSummary> {
        self.routes.iter().find(|route| route.id == route_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MockControlError {
    #[error("mock servers não estão disponíveis neste run")]
    Unavailable,
    #[error("mock server '{0}' não encontrado")]
    ServerNotFound(String),
    #[error("a porta {0} já está em uso")]
    PortInUse(u16),
    #[error("o mock server foi desligado")]
    Stopped,
    #[error("{0}")]
    Invalid(String),
}

/// Porta pela qual o motor de flows controla mock servers (spec 0120, ADR
/// 0054). A implementação concreta (listeners em loopback) fica em
/// `src-tauri`; `alcy-app` só conhece o contrato.
pub trait MockServerControl: Sync {
    /// Liga o mock do node `node_id`. Um mock salvo que já está ligado é
    /// reaproveitado com `owned: false`.
    fn start(
        &self,
        node_id: &str,
        source: &MockServerSource,
    ) -> Result<MockRunHandle, MockControlError>;
    fn stop(&self, key: &str);
    /// Próxima chamada recebida por `route_id` com `seq > after_seq`,
    /// inclusive uma que já tenha chegado antes desta espera começar.
    fn wait_request(
        &self,
        key: String,
        route_id: String,
        after_seq: u64,
    ) -> impl Future<Output = Result<CapturedRequest, MockControlError>> + Send;
    fn set_response(
        &self,
        key: &str,
        route_id: &str,
        response_id: Option<&str>,
    ) -> Result<(), MockControlError>;
    /// Total de chamadas recebidas pela rota desde que o servidor ligou.
    fn call_count(&self, key: &str, route_id: &str) -> Result<u64, MockControlError>;
    fn clear_overrides(&self, key: &str);
}

/// Sem mock servers — para quem executa flows sem esse recurso (testes,
/// usos fora do desktop). Todo node de mock falha com uma mensagem clara.
pub struct NoMockServers;

impl MockServerControl for NoMockServers {
    fn start(&self, _: &str, _: &MockServerSource) -> Result<MockRunHandle, MockControlError> {
        Err(MockControlError::Unavailable)
    }

    fn stop(&self, _: &str) {}

    async fn wait_request(
        &self,
        _: String,
        _: String,
        _: u64,
    ) -> Result<CapturedRequest, MockControlError> {
        Err(MockControlError::Unavailable)
    }

    fn set_response(&self, _: &str, _: &str, _: Option<&str>) -> Result<(), MockControlError> {
        Err(MockControlError::Unavailable)
    }

    fn call_count(&self, _: &str, _: &str) -> Result<u64, MockControlError> {
        Err(MockControlError::Unavailable)
    }

    fn clear_overrides(&self, _: &str) {}
}
