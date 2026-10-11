//! Execução dos mock servers locais (ADR 0052): listeners em loopback, log
//! de chamadas e — para os blocos de mock dos flows (spec 0121, ADR 0056) —
//! captura das chamadas recebidas, contagem por rota e respostas forçadas.
//! Tudo em memória: encerrar o aplicativo descarta.

mod flow_control;
mod http;

use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use alcy_app::CapturedRequest;
use alcy_domain::MockServer;
use serde::Serialize;
use tokio::sync::Notify;

pub(crate) use flow_control::FlowMockControl;
pub(crate) use http::method_to;

use http::{HttpResponse, Selection};

const MAX_CALL_LOGS: usize = 1_000;
/// Limites da captura para flows: as chamadas mais antigas saem primeiro
/// quando um dos dois estoura.
const MAX_CAPTURES: usize = 500;
const MAX_CAPTURED_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockCallLogDto {
    pub id: u64,
    pub method: String,
    pub path: String,
    pub route_id: Option<String>,
    pub route_name: Option<String>,
    pub response_name: Option<String>,
    pub status: u16,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StartError {
    #[error("não foi possível usar a porta {port}: {message}")]
    PortUnavailable { port: u16, message: String },
    #[error("{0}")]
    Io(String),
}

#[derive(Default)]
struct Captures {
    next_seq: u64,
    requests: VecDeque<CapturedRequest>,
    bytes: usize,
    route_counts: HashMap<String, u64>,
}

/// Estado de um servidor ligado, compartilhado entre o listener (threads
/// std) e quem controla ou espera chamadas (tasks tokio).
struct ServerShared {
    config: RwLock<MockServer>,
    stopped: AtomicBool,
    logs: Mutex<Vec<MockCallLogDto>>,
    captures: Mutex<Captures>,
    /// `route_id -> response_id` forçados por flows.
    overrides: Mutex<HashMap<String, String>>,
    /// Acorda quem espera chamadas a cada captura e quando o servidor para.
    /// `notify_waiters` funciona fora do runtime tokio.
    notify: Notify,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ServerShared {
    fn config(&self) -> MockServer {
        self.config
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Grava a chamada com o próximo `seq` — atribuído sob o mesmo lock da
    /// fila, para a fila ficar sempre em ordem de `seq`.
    fn capture(&self, mut request: CapturedRequest) {
        let mut captures = lock(&self.captures);
        captures.next_seq += 1;
        request.seq = captures.next_seq;
        *captures
            .route_counts
            .entry(request.route_id.clone())
            .or_default() += 1;
        captures.bytes += request.body.len();
        captures.requests.push_back(request);
        while captures.requests.len() > MAX_CAPTURES || captures.bytes > MAX_CAPTURED_BYTES {
            let Some(oldest) = captures.requests.pop_front() else {
                break;
            };
            captures.bytes -= oldest.body.len();
        }
        drop(captures);
        self.notify.notify_waiters();
    }

    fn find_capture(&self, route_id: &str, after_seq: u64) -> Option<CapturedRequest> {
        lock(&self.captures)
            .requests
            .iter()
            .find(|request| request.route_id == route_id && request.seq > after_seq)
            .cloned()
    }
}

struct RunningMockServer {
    shared: Arc<ServerShared>,
}

/// Servidores ligados, indexados pelo id do mock salvo ou pela chave do mock
/// avulso de um run de flow (`flow:<execução>:<node>`).
#[derive(Default)]
pub struct MockServerRuntime {
    servers: Mutex<HashMap<String, RunningMockServer>>,
    next_log_id: Arc<AtomicU64>,
}

/// Fotografia de um servidor ligado, tirada quando um flow o liga ou
/// reaproveita.
pub(crate) struct RunningSnapshot {
    pub config: MockServer,
    pub last_seq: u64,
    pub route_counts: HashMap<String, u64>,
}

impl MockServerRuntime {
    fn shared(&self, server_id: &str) -> Option<Arc<ServerShared>> {
        lock(&self.servers)
            .get(server_id)
            .map(|server| Arc::clone(&server.shared))
    }

    pub fn running_ids(&self) -> Vec<String> {
        lock(&self.servers).keys().cloned().collect()
    }

    pub fn running_port(&self, server_id: &str) -> Option<u16> {
        self.shared(server_id).map(|shared| shared.config().port)
    }

    /// Liga o servidor; se já está ligado, só troca a configuração.
    pub fn start(&self, config: MockServer) -> Result<(), StartError> {
        let mut servers = lock(&self.servers);
        if let Some(server) = servers.get(&config.id) {
            *server
                .shared
                .config
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = config;
            return Ok(());
        }
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, config.port))
            .map_err(|error| StartError::PortUnavailable {
                port: config.port,
                message: error.to_string(),
            })?;
        listener
            .set_nonblocking(true)
            .map_err(|error| StartError::Io(error.to_string()))?;
        let id = config.id.clone();
        let shared = Arc::new(ServerShared {
            config: RwLock::new(config),
            stopped: AtomicBool::new(false),
            logs: Mutex::new(Vec::new()),
            captures: Mutex::new(Captures::default()),
            overrides: Mutex::new(HashMap::new()),
            notify: Notify::new(),
        });
        let serving = Arc::clone(&shared);
        let next_log_id = Arc::clone(&self.next_log_id);
        thread::spawn(move || serve(listener, serving, next_log_id));
        servers.insert(id, RunningMockServer { shared });
        Ok(())
    }

    pub fn update(&self, config: &MockServer) {
        if let Some(shared) = self.shared(&config.id) {
            *shared
                .config
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = config.clone();
        }
    }

    pub fn stop(&self, server_id: &str) {
        if let Some(server) = lock(&self.servers).remove(server_id) {
            server.shared.stopped.store(true, Ordering::Relaxed);
            server.shared.notify.notify_waiters();
        }
    }

    pub fn logs(&self, server_id: &str, offset: usize, limit: usize) -> Vec<MockCallLogDto> {
        self.shared(server_id)
            .map(|shared| {
                lock(&shared.logs)
                    .iter()
                    .rev()
                    .skip(offset)
                    .take(limit.min(100))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn clear_logs(&self, server_id: &str) {
        if let Some(shared) = self.shared(server_id) {
            lock(&shared.logs).clear();
        }
    }

    pub(crate) fn snapshot(&self, server_id: &str) -> Option<RunningSnapshot> {
        let shared = self.shared(server_id)?;
        let captures = lock(&shared.captures);
        Some(RunningSnapshot {
            config: shared.config(),
            last_seq: captures.next_seq,
            route_counts: captures.route_counts.clone(),
        })
    }

    pub(crate) fn call_count(&self, server_id: &str, route_id: &str) -> Option<u64> {
        let shared = self.shared(server_id)?;
        let count = lock(&shared.captures)
            .route_counts
            .get(route_id)
            .copied()
            .unwrap_or(0);
        Some(count)
    }

    /// `None` desfaz a resposta forçada da rota. `false` se o servidor não
    /// está ligado.
    pub(crate) fn set_override(
        &self,
        server_id: &str,
        route_id: &str,
        response_id: Option<&str>,
    ) -> bool {
        let Some(shared) = self.shared(server_id) else {
            return false;
        };
        let mut overrides = lock(&shared.overrides);
        match response_id {
            Some(response_id) => {
                overrides.insert(route_id.to_string(), response_id.to_string());
            }
            None => {
                overrides.remove(route_id);
            }
        }
        true
    }

    pub(crate) fn clear_overrides(&self, server_id: &str) {
        if let Some(shared) = self.shared(server_id) {
            lock(&shared.overrides).clear();
        }
    }

    /// Próxima chamada de `route_id` com `seq > after_seq`; `None` quando o
    /// servidor não está (ou deixa de estar) ligado.
    pub(crate) async fn wait_request(
        &self,
        server_id: &str,
        route_id: &str,
        after_seq: u64,
    ) -> Option<CapturedRequest> {
        let shared = self.shared(server_id)?;
        loop {
            // Registrado antes de olhar a fila: uma captura entre a
            // verificação e o `await` ainda acorda esta espera.
            let notified = shared.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if shared.stopped.load(Ordering::Relaxed) {
                return None;
            }
            if let Some(request) = shared.find_capture(route_id, after_seq) {
                return Some(request);
            }
            notified.await;
        }
    }
}

fn serve(listener: TcpListener, shared: Arc<ServerShared>, next_log_id: Arc<AtomicU64>) {
    while !shared.stopped.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let shared = Arc::clone(&shared);
                let next_log_id = Arc::clone(&next_log_id);
                thread::spawn(move || handle_connection(stream, &shared, &next_log_id));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
}

fn handle_connection(mut stream: TcpStream, shared: &ServerShared, next_log_id: &AtomicU64) {
    let started = Instant::now();
    let Some(request) = http::read_request(&mut stream) else {
        return;
    };
    let config = shared.config();
    let selection = match request.as_ref() {
        Some(request) if config.cors_enabled && request.method == "OPTIONS" => {
            Selection::unmatched(204, HttpResponse::empty())
        }
        Some(request) => {
            let overrides = lock(&shared.overrides).clone();
            http::select_response(&config, &overrides, request)
        }
        None => Selection::unmatched(400, HttpResponse::text("requisição HTTP inválida")),
    };
    // Capturada antes da resposta sair: quem recebe a resposta e em seguida
    // pergunta ao flow já encontra a chamada registrada.
    if let (Some(request), Some(route_id)) = (request.as_ref(), selection.route_id.as_ref()) {
        shared.capture(CapturedRequest {
            seq: 0,
            route_id: route_id.clone(),
            method: request.method.clone(),
            path: request.path.clone(),
            query: request.query.clone(),
            headers: request.headers.clone(),
            path_params: selection.path_params.clone(),
            body: String::from_utf8_lossy(&request.body).into_owned(),
        });
    }
    if selection.response.delay_ms > 0 {
        thread::sleep(Duration::from_millis(selection.response.delay_ms));
    }
    let _ = http::write_response(
        &mut stream,
        selection.status,
        &selection.response,
        config.cors_enabled,
    );
    let log = MockCallLogDto {
        id: next_log_id.fetch_add(1, Ordering::Relaxed),
        method: request
            .as_ref()
            .map(|request| request.method.clone())
            .unwrap_or_else(|| "?".into()),
        path: request
            .as_ref()
            .map(|request| request.path.clone())
            .unwrap_or_default(),
        route_id: selection.route_id,
        route_name: selection.route_name,
        response_name: selection.response_name,
        status: selection.status,
        duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    };
    let mut calls = lock(&shared.logs);
    calls.push(log);
    if calls.len() > MAX_CALL_LOGS {
        calls.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use alcy_domain::{HttpMethod, MockResponse, MockRoute};

    use super::*;

    pub(super) fn free_port() -> u16 {
        let probe = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        probe.local_addr().unwrap().port()
    }

    pub(super) fn health_server(id: &str, port: u16) -> MockServer {
        let response = |id: &str, status: u16, body: &str| MockResponse {
            id: id.to_string(),
            name: id.to_string(),
            enabled: true,
            status,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: body.to_string(),
            delay_ms: 0,
            condition: None,
        };
        MockServer {
            id: id.to_string(),
            name: "Server".to_string(),
            port,
            cors_enabled: true,
            routes: vec![MockRoute {
                id: "route".to_string(),
                name: "Health".to_string(),
                enabled: true,
                method: HttpMethod::Post,
                path: "/health/:id".to_string(),
                default_response: response("ok", 200, "{\"ok\":true}"),
                alternatives: vec![response("down", 503, "{\"ok\":false}")],
            }],
        }
    }

    pub(super) fn call(port: u16, body: &str) -> String {
        let mut stream = TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).unwrap();
        write!(
            stream,
            "POST /health/7?verbose=1 HTTP/1.1\r\nHost: localhost\r\nX-Trace: abc\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).unwrap();
        output
    }

    #[test]
    fn serves_a_saved_route_over_loopback() {
        let port = free_port();
        let runtime = MockServerRuntime::default();
        runtime.start(health_server("server", port)).unwrap();
        let output = call(port, "");
        runtime.stop("server");
        assert!(output.starts_with("HTTP/1.1 200 OK"));
        assert!(output.ends_with("{\"ok\":true}"));
    }

    #[test]
    fn captures_calls_counts_them_by_route_and_applies_forced_responses() {
        let port = free_port();
        let runtime = MockServerRuntime::default();
        runtime.start(health_server("server", port)).unwrap();

        assert!(call(port, "{\"n\":1}").starts_with("HTTP/1.1 200 OK"));
        assert!(runtime.set_override("server", "route", Some("down")));
        assert!(call(port, "{\"n\":2}").starts_with("HTTP/1.1 503"));
        runtime.clear_overrides("server");
        assert!(call(port, "").starts_with("HTTP/1.1 200 OK"));

        assert_eq!(runtime.call_count("server", "route"), Some(3));
        let shared = runtime.shared("server").unwrap();
        let first = shared.find_capture("route", 0).unwrap();
        assert_eq!(first.seq, 1);
        assert_eq!(first.body, "{\"n\":1}");
        assert_eq!(first.path, "/health/7");
        assert_eq!(first.path_params, vec![("id".to_string(), "7".to_string())]);
        assert_eq!(first.query, vec![("verbose".to_string(), "1".to_string())]);
        assert!(
            first
                .headers
                .contains(&("x-trace".to_string(), "abc".to_string()))
        );
        assert_eq!(shared.find_capture("route", 1).unwrap().body, "{\"n\":2}");
        let logs = runtime.logs("server", 0, 10);
        assert_eq!(logs[0].route_id.as_deref(), Some("route"));
        assert_eq!(logs[0].path, "/health/7");
        runtime.stop("server");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_waiter_wakes_up_on_the_next_call_and_ends_when_the_server_stops() {
        let port = free_port();
        let runtime = Arc::new(MockServerRuntime::default());
        runtime.start(health_server("server", port)).unwrap();

        let waiting = Arc::clone(&runtime);
        let waiter = tokio::spawn(async move { waiting.wait_request("server", "route", 0).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        tokio::task::spawn_blocking(move || call(port, "{\"n\":1}"))
            .await
            .unwrap();
        let received = waiter.await.unwrap().unwrap();
        assert_eq!(received.body, "{\"n\":1}");

        let waiting = Arc::clone(&runtime);
        let waiter = tokio::spawn(async move { waiting.wait_request("server", "route", 1).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        runtime.stop("server");
        assert_eq!(waiter.await.unwrap(), None);
    }
}
