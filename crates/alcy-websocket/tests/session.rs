//! `alcy-websocket` against an in-process server: handshake through a real
//! reqwest client, message exchange, closes and the collect mode.

// The server handshake callback returns tungstenite's own (large) error
// response type; its size is not ours to change.
#![allow(clippy::result_large_err)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use alcy_domain::{Authentication, ExecutionError, HeaderEntry, NetworkCause, WebSocketClosedBy};
use alcy_websocket::{
    ConnectError, ConnectInput, Direction, MessageFormat, Outgoing, SessionAction, SessionEvent,
    SessionMode, connect, run,
};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

type Server = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// Starts a server that accepts one connection, records the handshake
/// headers and hands the socket to `behaviour`.
async fn serve<F, Fut>(behaviour: F) -> (String, Arc<Mutex<Vec<(String, String)>>>)
where
    F: FnOnce(Server) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let callback = move |request: &Request, mut response: Response| {
            let mut headers = recorded.lock().unwrap();
            for (name, value) in request.headers() {
                headers.push((
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                ));
            }
            let offered = request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
                .map(|value| value.trim().to_string());
            if let Some(chosen) = offered {
                response.headers_mut().insert(
                    "sec-websocket-protocol",
                    HeaderValue::from_str(&chosen).unwrap(),
                );
            }
            Ok(response)
        };
        let server = tokio_tungstenite::accept_hdr_async(socket, callback)
            .await
            .unwrap();
        behaviour(server).await;
    });
    (format!("ws://{address}/socket"), seen)
}

async fn echo(mut server: Server) {
    while let Some(Ok(message)) = server.next().await {
        match message {
            Message::Text(_) | Message::Binary(_) => server.send(message).await.unwrap(),
            Message::Close(_) => break,
            _ => {}
        }
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().build().unwrap()
}

async fn open(
    client: &reqwest::Client,
    url: &str,
    headers: &[HeaderEntry],
    authentication: &Authentication,
    subprotocols: &[String],
) -> Result<alcy_websocket::Connection, ConnectError> {
    connect(ConnectInput {
        client,
        url,
        headers,
        authentication,
        subprotocols,
        accepts_invalid_certificates: false,
    })
    .await
}

#[tokio::test]
async fn exchanges_text_and_binary_messages_then_closes_normally() {
    let (url, _) = serve(echo).await;
    let client = client();
    let connection = open(&client, &url, &[], &Authentication::None, &[])
        .await
        .unwrap();
    assert_eq!(connection.handshake.status, 101);

    let (actions, receiver) = mpsc::channel(8);
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let session = tokio::spawn(async move {
        run(
            connection,
            SessionMode::Interactive(receiver),
            move |event| {
                seen.lock().unwrap().push(event.clone());
            },
        )
        .await
    });

    for message in [
        Outgoing::Text(r#"{"op":"ping"}"#.to_string()),
        Outgoing::Binary(vec![0, 1, 2, 255]),
    ] {
        let (reply, sent) = oneshot::channel();
        actions
            .send(SessionAction::Send(message, reply))
            .await
            .unwrap();
        sent.await.unwrap().unwrap();
    }
    // Wait for both echoes before closing.
    for _ in 0..50 {
        if events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                matches!(event, SessionEvent::Message(message) if message.direction == Direction::Received)
            })
            .count()
            == 2
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    actions
        .send(SessionAction::Close {
            code: 1000,
            reason: "done".to_string(),
        })
        .await
        .unwrap();

    let transcript = session.await.unwrap();
    assert_eq!((transcript.sent, transcript.received), (2, 2));
    assert_eq!(transcript.close.closed_by, WebSocketClosedBy::Client);
    assert_eq!(transcript.close.code, Some(1000));
    let received: Vec<_> = transcript.received().collect();
    assert_eq!(received[0].data, r#"{"op":"ping"}"#);
    assert_eq!(received[1].format, MessageFormat::Binary);
    assert_eq!(received[1].data, "AAEC/w==");
    assert_eq!(received[1].size_bytes, 4);
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(SessionEvent::Closed(_))
    ));
}

#[tokio::test]
async fn negotiates_a_subprotocol_and_sends_headers_and_authentication() {
    let (url, seen) = serve(echo).await;
    let client = client();
    let headers = vec![HeaderEntry::new("X-Tenant", "acme", true).unwrap()];
    let connection = open(
        &client,
        &url,
        &headers,
        &Authentication::Bearer {
            token: "secret".to_string(),
        },
        &["chat.v2".to_string(), "chat".to_string()],
    )
    .await
    .unwrap();

    assert_eq!(connection.handshake.subprotocol.as_deref(), Some("chat.v2"));
    let seen = seen.lock().unwrap().clone();
    let header = |name: &str| {
        seen.iter()
            .find(|(seen_name, _)| seen_name == name)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(header("x-tenant").as_deref(), Some("acme"));
    assert_eq!(header("authorization").as_deref(), Some("Bearer secret"));
    assert_eq!(
        header("sec-websocket-protocol").as_deref(),
        Some("chat.v2, chat")
    );
    assert!(
        connection
            .handshake
            .metadata
            .request_headers
            .iter()
            .any(|header| header.name == "authorization")
    );
}

#[tokio::test]
async fn reports_a_server_close_with_its_code_and_reason() {
    let (url, _) = serve(|mut server| async move {
        server.send(Message::text("hello")).await.unwrap();
        server
            .close(Some(CloseFrame {
                code: CloseCode::from(4001),
                reason: "bye".into(),
            }))
            .await
            .unwrap();
        while server.next().await.is_some() {}
    })
    .await;
    let client = client();
    let connection = open(&client, &url, &[], &Authentication::None, &[])
        .await
        .unwrap();

    let transcript = run(
        connection,
        SessionMode::Collect {
            message: None,
            expected_messages: 0,
            wait: Duration::from_secs(5),
        },
        |_| {},
    )
    .await;

    assert_eq!(transcript.received, 1);
    assert_eq!(transcript.close.closed_by, WebSocketClosedBy::Server);
    assert_eq!(transcript.close.code, Some(4001));
    assert_eq!(transcript.close.reason, "bye");
}

#[tokio::test]
async fn collect_mode_sends_the_message_and_stops_after_the_expected_replies() {
    let (url, _) = serve(|mut server| async move {
        if let Some(Ok(Message::Text(text))) = server.next().await {
            for index in 0..5 {
                let reply = format!("{}#{index}", text.as_str());
                if server.send(Message::text(reply)).await.is_err() {
                    return;
                }
            }
        }
        while server.next().await.is_some() {}
    })
    .await;
    let client = client();
    let connection = open(&client, &url, &[], &Authentication::None, &[])
        .await
        .unwrap();

    let transcript = run(
        connection,
        SessionMode::Collect {
            message: Some(Outgoing::Text("hi".to_string())),
            expected_messages: 2,
            wait: Duration::from_secs(5),
        },
        |_| {},
    )
    .await;

    assert_eq!(transcript.sent, 1);
    assert!(transcript.received >= 2, "{transcript:?}");
    assert_eq!(transcript.received().next().unwrap().data, "hi#0");
    assert_eq!(transcript.close.closed_by, WebSocketClosedBy::Client);
    assert_eq!(transcript.close.code, Some(1000));
}

#[tokio::test]
async fn collect_mode_closes_when_the_wait_elapses() {
    let (url, _) = serve(echo).await;
    let client = client();
    let connection = open(&client, &url, &[], &Authentication::None, &[])
        .await
        .unwrap();

    let transcript = run(
        connection,
        SessionMode::Collect {
            message: None,
            expected_messages: 1,
            wait: Duration::from_millis(150),
        },
        |_| {},
    )
    .await;

    assert_eq!(transcript.received, 0);
    assert_eq!(transcript.close.closed_by, WebSocketClosedBy::Client);
    assert_eq!(transcript.close.code, Some(1000));
}

#[tokio::test]
async fn the_client_timeout_does_not_end_an_open_connection() {
    let (url, _) = serve(|mut server| async move {
        tokio::time::sleep(Duration::from_millis(700)).await;
        let _ = server.send(Message::text("late")).await;
        while server.next().await.is_some() {}
    })
    .await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(300))
        .build()
        .unwrap();
    let connection = open(&client, &url, &[], &Authentication::None, &[])
        .await
        .unwrap();

    let transcript = run(
        connection,
        SessionMode::Collect {
            message: None,
            expected_messages: 1,
            wait: Duration::from_secs(5),
        },
        |_| {},
    )
    .await;

    assert_eq!(transcript.received, 1, "{transcript:?}");
    assert_eq!(transcript.received().next().unwrap().data, "late");
}

#[tokio::test]
async fn a_refused_upgrade_returns_the_http_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 4096];
        let _ = socket.read(&mut buffer).await;
        let _ = socket
            .write_all(
                b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope",
            )
            .await;
    });
    let client = client();

    let error = open(
        &client,
        &format!("ws://{address}"),
        &[],
        &Authentication::None,
        &[],
    )
    .await
    .err()
    .unwrap();

    let ConnectError::Rejected(response) = error else {
        panic!("expected a rejected handshake, got {error:?}");
    };
    assert_eq!(response.status_code, 403);
    assert_eq!(response.body, "nope");
    assert_eq!(
        response.protocol_failure().as_deref(),
        Some("WebSocket handshake rejected with HTTP 403")
    );
}

#[tokio::test]
async fn a_closed_port_is_a_connection_refused_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let client = client();

    let error = open(
        &client,
        &format!("ws://{address}"),
        &[],
        &Authentication::None,
        &[],
    )
    .await
    .err()
    .unwrap();

    assert!(
        matches!(
            &error,
            ConnectError::Execution(ExecutionError::Network(failure))
                if failure.cause == Some(NetworkCause::ConnectionRefused)
        ),
        "{error:?}"
    );
}
