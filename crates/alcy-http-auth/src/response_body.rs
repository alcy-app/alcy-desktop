//! Leitura do corpo de resposta com limite de tamanho. Compartilhada por
//! `alcy-rest` e `alcy-graphql`, que leem a resposta do mesmo jeito.
//!
//! Sem limite, um download de centenas de MB fica inteiro em memória (e é
//! copiado mais vezes adiante: histórico, cache, scripts). Com limite, o
//! download é interrompido assim que se sabe que vai passar dele: pelo
//! `Content-Length` declarado, antes de ler qualquer byte, ou pelo total já
//! lido. Não existe resposta parcial: o que chegou é descartado e a chamada
//! falha com `ExecutionError::ResponseTooLarge`.

use std::sync::atomic::{AtomicUsize, Ordering};

use alcy_domain::{ExecutionError, Request, ResponseSizeLimit};

use crate::map_reqwest_error;

/// Capacidade inicial máxima do buffer, mesmo quando o servidor declara um
/// `Content-Length` maior: um valor declarado não é garantia de que os
/// bytes vão chegar.
const MAX_INITIAL_CAPACITY: usize = 8 * 1024 * 1024;

/// Limite configurado de um executor, alterável em tempo de execução (aba
/// "Geral" das configurações). `0` representa "sem limite".
pub struct ConfiguredResponseLimit(AtomicUsize);

impl ConfiguredResponseLimit {
    pub fn new(limit: ResponseSizeLimit) -> Self {
        Self(AtomicUsize::new(Self::encode(limit)))
    }

    pub fn set(&self, limit: ResponseSizeLimit) {
        self.0.store(Self::encode(limit), Ordering::Relaxed);
    }

    /// Limite que vale para `request`: nenhum quando o envio pediu para
    /// ignorar o limite (`Request::unlimited_response_size`).
    pub fn for_request(&self, request: &Request) -> Option<usize> {
        if request.unlimited_response_size {
            return None;
        }
        match self.0.load(Ordering::Relaxed) {
            0 => None,
            bytes => Some(bytes),
        }
    }

    fn encode(limit: ResponseSizeLimit) -> usize {
        limit.bytes().unwrap_or(0)
    }
}

impl Default for ConfiguredResponseLimit {
    fn default() -> Self {
        Self::new(ResponseSizeLimit::default())
    }
}

/// Lê o corpo inteiro de `response`, respeitando `limit` (em bytes).
pub async fn read_response_body(
    mut response: reqwest::Response,
    limit: Option<usize>,
) -> Result<Vec<u8>, ExecutionError> {
    let declared = response.content_length();
    if let (Some(limit), Some(declared)) = (limit, declared)
        && declared > limit as u64
    {
        return Err(too_large(limit, declared));
    }

    let initial_capacity = declared
        .and_then(|declared| usize::try_from(declared).ok())
        .unwrap_or(0)
        .min(MAX_INITIAL_CAPACITY);
    let mut body = Vec::with_capacity(initial_capacity);
    while let Some(chunk) = response.chunk().await.map_err(map_reqwest_error)? {
        let received = body.len() + chunk.len();
        if let Some(limit) = limit
            && received > limit
        {
            return Err(too_large(limit, received as u64));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Converte o corpo em texto sem copiar quando ele já é UTF-8 válido (o caso
/// comum); só um corpo inválido passa pela conversão com perda.
pub fn body_text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

fn too_large(limit: usize, received: u64) -> ExecutionError {
    ExecutionError::ResponseTooLarge {
        limit_bytes: limit as u64,
        received_bytes: received,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Authentication, Endpoint, ProtocolId, RequestDocument};
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn response_with_body(body: Vec<u8>) -> reqwest::Response {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;
        reqwest::get(server.uri()).await.unwrap()
    }

    fn request() -> Request {
        Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            Vec::new(),
            Authentication::None,
        )
    }

    #[tokio::test]
    async fn reads_a_body_within_the_limit() {
        let response = response_with_body(b"hello".to_vec()).await;

        let body = read_response_body(response, Some(5)).await.unwrap();

        assert_eq!(body, b"hello");
    }

    #[tokio::test]
    async fn reads_any_size_without_a_limit() {
        let response = response_with_body(vec![b'x'; 64 * 1024]).await;

        let body = read_response_body(response, None).await.unwrap();

        assert_eq!(body.len(), 64 * 1024);
    }

    #[tokio::test]
    async fn fails_early_when_the_declared_length_exceeds_the_limit() {
        let response = response_with_body(vec![b'x'; 1000]).await;

        let error = read_response_body(response, Some(10)).await.unwrap_err();

        assert_eq!(
            error,
            ExecutionError::ResponseTooLarge {
                limit_bytes: 10,
                received_bytes: 1000,
            }
        );
    }

    /// Servidor mínimo que responde em `Transfer-Encoding: chunked`, sem
    /// `Content-Length`: o limite só pode ser detectado pelo total lido.
    async fn chunked_response(chunks: usize, chunk_size: usize) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await;
            let payload = vec![b'x'; chunk_size];
            for _ in 0..chunks {
                let header = format!("{chunk_size:x}\r\n");
                if socket.write_all(header.as_bytes()).await.is_err()
                    || socket.write_all(&payload).await.is_err()
                    || socket.write_all(b"\r\n").await.is_err()
                {
                    return;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        reqwest::get(format!("http://{address}")).await.unwrap()
    }

    #[tokio::test]
    async fn stops_reading_once_a_chunked_body_exceeds_the_limit() {
        let response = chunked_response(64, 1024).await;
        assert_eq!(response.content_length(), None);

        let error = read_response_body(response, Some(4096)).await.unwrap_err();

        let ExecutionError::ResponseTooLarge {
            limit_bytes,
            received_bytes,
        } = error
        else {
            panic!("esperava ResponseTooLarge, veio {error:?}");
        };
        assert_eq!(limit_bytes, 4096);
        assert!(received_bytes > 4096 && received_bytes < 64 * 1024);
    }

    #[tokio::test]
    async fn reads_a_chunked_body_within_the_limit() {
        let response = chunked_response(4, 1024).await;

        let body = read_response_body(response, Some(4096)).await.unwrap();

        assert_eq!(body.len(), 4096);
    }

    #[test]
    fn body_text_keeps_valid_utf8_and_replaces_invalid_bytes() {
        assert_eq!(body_text("ação".as_bytes().to_vec()), "ação");
        assert_eq!(body_text(vec![b'a', 0xff, b'b']), "a\u{fffd}b");
    }

    #[test]
    fn the_configured_limit_applies_unless_the_request_opts_out() {
        let limit = ConfiguredResponseLimit::new(ResponseSizeLimit::Megabytes(1));
        assert_eq!(limit.for_request(&request()), Some(1024 * 1024));
        assert_eq!(
            limit.for_request(&request().with_unlimited_response_size(true)),
            None
        );

        limit.set(ResponseSizeLimit::Disabled);
        assert_eq!(limit.for_request(&request()), None);
    }
}
