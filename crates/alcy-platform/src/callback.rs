use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

/// Porta do retorno do login. O GitLab exige que a redirect URI seja idêntica
/// à cadastrada no aplicativo OAuth: `http://127.0.0.1:53682/callback`.
pub const CALLBACK_PORT: u16 = 53682;

const CALLBACK_PATH: &str = "/callback";
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CallbackError {
    #[error("a porta de retorno {port} está ocupada; libere-a e tente de novo")]
    PortBusy { port: u16 },
    #[error("falha ao abrir o receptor de retorno: {0}")]
    Bind(String),
    #[error("o acesso foi negado: {0}")]
    Denied(String),
    #[error("o retorno não corresponde ao login iniciado")]
    StateMismatch,
    #[error("o retorno não trouxe o código de autorização")]
    MissingCode,
    #[error("o tempo para concluir o login expirou")]
    Timeout,
}

/// Receptor do retorno do login OAuth. Só escuta em `127.0.0.1` e encerra
/// (ao ser consumido ou descartado) depois do primeiro retorno válido, do
/// timeout ou do cancelamento do chamador.
pub struct CallbackServer {
    listener: TcpListener,
    port: u16,
}

impl CallbackServer {
    /// Escuta em `CALLBACK_PORT`.
    pub async fn bind() -> Result<Self, CallbackError> {
        Self::bind_in(&[CALLBACK_PORT]).await
    }

    /// Como `bind`, com uma lista de portas explícita, tentadas em ordem
    /// (`0` = qualquer porta livre).
    pub async fn bind_in(ports: &[u16]) -> Result<Self, CallbackError> {
        let mut last_error = None;
        let mut last_port = 0;
        for &port in ports {
            last_port = port;
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => {
                    let port = listener
                        .local_addr()
                        .map_err(|error| CallbackError::Bind(error.to_string()))?
                        .port();
                    return Ok(Self { listener, port });
                }
                Err(error) => last_error = Some(error),
            }
        }

        match last_error {
            Some(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                Err(CallbackError::PortBusy { port: last_port })
            }
            Some(error) => Err(CallbackError::Bind(error.to_string())),
            None => Err(CallbackError::Bind("nenhuma porta informada".into())),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// Aguarda o retorno do navegador e devolve o código de autorização.
    pub async fn wait_for_code(
        self,
        expected_state: &str,
        timeout: Duration,
    ) -> Result<String, CallbackError> {
        tokio::time::timeout(timeout, self.accept_callback(expected_state))
            .await
            .map_err(|_| CallbackError::Timeout)?
    }

    async fn accept_callback(&self, expected_state: &str) -> Result<String, CallbackError> {
        loop {
            let Ok((mut stream, _)) = self.listener.accept().await else {
                continue;
            };
            let Some(target) = read_request_target(&mut stream).await else {
                continue;
            };
            let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
                respond(&mut stream, 400, "Requisição inválida.").await;
                continue;
            };
            // Ignora o que não é o retorno (ex.: ícone da aba).
            if url.path() != CALLBACK_PATH {
                respond(&mut stream, 404, "Não encontrado.").await;
                continue;
            }

            let outcome = evaluate(&url, expected_state);
            let (status, message) = match &outcome {
                Ok(_) => (200, "Login concluído. Você já pode fechar esta janela."),
                Err(CallbackError::Denied(_)) => (400, "O acesso foi negado. Volte ao Alcy."),
                Err(_) => (400, "Não foi possível concluir o login. Volte ao Alcy."),
            };
            respond(&mut stream, status, message).await;
            return outcome;
        }
    }
}

fn evaluate(url: &Url, expected_state: &str) -> Result<String, CallbackError> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut description = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => description = Some(value.into_owned()),
            _ => {}
        }
    }

    if state.as_deref() != Some(expected_state) {
        return Err(CallbackError::StateMismatch);
    }
    if let Some(error) = error {
        return Err(CallbackError::Denied(description.unwrap_or(error)));
    }
    code.filter(|code| !code.is_empty())
        .ok_or(CallbackError::MissingCode)
}

/// Lê a linha de requisição e devolve o alvo (`/callback?...`).
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let read = async {
        let mut buffer = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        while buffer.len() < MAX_REQUEST_BYTES && !buffer.windows(2).any(|pair| pair == b"\r\n") {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
        Some(buffer)
    };
    let buffer = tokio::time::timeout(REQUEST_READ_TIMEOUT, read)
        .await
        .ok()??;

    let text = String::from_utf8_lossy(&buffer);
    let line = text.lines().next()?;
    let mut parts = line.split_whitespace();
    (parts.next()? == "GET").then_some(())?;
    parts.next().map(str::to_string)
}

async fn respond(stream: &mut TcpStream, status: u16, message: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Alcy</title></head>\
         <body style=\"font-family:sans-serif;text-align:center;margin-top:20vh\">\
         <h2>Alcy</h2><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

    async fn browser_get(uri: &str, target: &str) -> String {
        let port: u16 = uri
            .rsplit(':')
            .next()
            .and_then(|rest| rest.split('/').next())
            .and_then(|port| port.parse().ok())
            .expect("porta na redirect uri");
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    async fn run(target: &'static str) -> (Result<String, CallbackError>, String) {
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let uri = server.redirect_uri();
        let waiting = tokio::spawn(async move { server.wait_for_code("abc", TIMEOUT).await });
        let response = browser_get(&uri, target).await;
        (waiting.await.unwrap(), response)
    }

    #[tokio::test]
    async fn returns_the_code_when_the_state_matches() {
        let (result, response) = run("/callback?code=xyz%20123&state=abc").await;
        assert_eq!(result, Ok("xyz 123".to_string()));
        assert!(response.starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn rejects_a_mismatched_state() {
        let (result, response) = run("/callback?code=xyz&state=outro").await;
        assert_eq!(result, Err(CallbackError::StateMismatch));
        assert!(response.starts_with("HTTP/1.1 400"));
    }

    #[tokio::test]
    async fn reports_a_denied_authorization() {
        let (result, _) =
            run("/callback?error=access_denied&error_description=Negado&state=abc").await;
        assert_eq!(result, Err(CallbackError::Denied("Negado".into())));
    }

    #[tokio::test]
    async fn requires_a_code() {
        let (result, _) = run("/callback?state=abc").await;
        assert_eq!(result, Err(CallbackError::MissingCode));
    }

    #[tokio::test]
    async fn ignores_unrelated_requests_before_the_callback() {
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let uri = server.redirect_uri();
        let waiting = tokio::spawn(async move { server.wait_for_code("abc", TIMEOUT).await });

        let favicon = browser_get(&uri, "/favicon.ico").await;
        assert!(favicon.starts_with("HTTP/1.1 404"));
        browser_get(&uri, "/callback?code=ok&state=abc").await;

        assert_eq!(waiting.await.unwrap(), Ok("ok".to_string()));
    }

    #[tokio::test]
    async fn times_out_when_nothing_arrives() {
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let result = server.wait_for_code("abc", Duration::from_millis(50)).await;
        assert_eq!(result, Err(CallbackError::Timeout));
    }

    #[tokio::test]
    async fn dropping_the_wait_releases_the_port() {
        let server = CallbackServer::bind_in(&[0]).await.unwrap();
        let port = server.port();
        let waiting = tokio::spawn(async move { server.wait_for_code("abc", TIMEOUT).await });
        waiting.abort();
        let _ = waiting.await;

        assert!(CallbackServer::bind_in(&[port]).await.is_ok());
    }

    #[tokio::test]
    async fn tries_the_next_port_and_reports_the_busy_one() {
        let first = CallbackServer::bind_in(&[0]).await.unwrap();
        let busy = first.port();

        let second = CallbackServer::bind_in(&[busy, 0]).await.unwrap();
        assert_ne!(second.redirect_uri(), first.redirect_uri());

        let all_busy = CallbackServer::bind_in(&[busy]).await;
        assert!(matches!(
            all_busy,
            Err(CallbackError::PortBusy { port }) if port == busy
        ));
    }
}
