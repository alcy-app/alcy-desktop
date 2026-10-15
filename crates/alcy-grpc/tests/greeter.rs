//! Calls against an in-process server built from the same `.proto` files and
//! the crate's own dynamic codec, so no code generation is needed.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use alcy_grpc::{
    ConnectionSettings, DynamicCodec, GrpcError, GrpcEvent, GrpcTarget, MetadataEntry, MethodKind,
    compile_proto_files, connect, describe, find_method, reflect, start_call,
};
use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_stream::wrappers::TcpListenerStream;
use tokio_stream::{Stream, StreamExt};
use tonic::server::NamedService;
use tonic::{Request, Response, Status, Streaming};
use url::Url;

type BoxStream = Pin<Box<dyn Stream<Item = Result<DynamicMessage, Status>> + Send>>;

fn protos() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protos")
}

fn pool() -> DescriptorPool {
    compile_proto_files(&[protos().join("greeter.proto")], &[]).unwrap()
}

#[derive(Clone)]
struct Greeter {
    pool: DescriptorPool,
}

impl NamedService for Greeter {
    const NAME: &'static str = "test.Greeter";
}

fn name_of(request: &DynamicMessage) -> String {
    match request.get_field_by_name("person").as_deref() {
        Some(Value::Message(person)) => match person.get_field_by_name("name").as_deref() {
            Some(Value::String(name)) => name.clone(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

fn times_of(request: &DynamicMessage) -> i32 {
    match request.get_field_by_name("times").as_deref() {
        Some(Value::I32(times)) => *times,
        _ => 0,
    }
}

fn reply(descriptor: &MessageDescriptor, text: String) -> DynamicMessage {
    let mut message = DynamicMessage::new(descriptor.clone());
    message.set_field_by_name("message", Value::String(text));
    message
}

impl tower::Service<http::Request<tonic::body::Body>> for Greeter {
    type Response = http::Response<tonic::body::Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<tonic::body::Body>) -> Self::Future {
        let pool = self.pool.clone();
        Box::pin(async move {
            let input = pool.get_message_by_name("test.HelloRequest").unwrap();
            let output = pool.get_message_by_name("test.HelloReply").unwrap();
            let mut grpc = tonic::server::Grpc::new(DynamicCodec::new(input));
            let method = request
                .uri()
                .path()
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string();
            let response = match method.as_str() {
                "SayHello" => {
                    grpc.unary(
                        tower::service_fn(move |request: Request<DynamicMessage>| {
                            let output = output.clone();
                            async move {
                                let name = name_of(request.get_ref());
                                match name.as_str() {
                                    "fail" => {
                                        let mut trailers = tonic::metadata::MetadataMap::new();
                                        trailers.insert("x-reason", "bad-name".parse().unwrap());
                                        return Err(Status::with_metadata(
                                            tonic::Code::InvalidArgument,
                                            "name not allowed",
                                            trailers,
                                        ));
                                    }
                                    "slow" => tokio::time::sleep(Duration::from_secs(5)).await,
                                    _ => {}
                                }
                                let mut response =
                                    Response::new(reply(&output, format!("hello {name}")));
                                if let Some(echo) = request.metadata().get("x-echo") {
                                    response.metadata_mut().insert("x-echo", echo.clone());
                                }
                                Ok(response)
                            }
                        }),
                        request,
                    )
                    .await
                }
                "LotsOfReplies" => {
                    grpc.server_streaming(
                        tower::service_fn(move |request: Request<DynamicMessage>| {
                            let output = output.clone();
                            async move {
                                let name = name_of(request.get_ref());
                                let replies: Vec<Result<DynamicMessage, Status>> =
                                    (0..times_of(request.get_ref()))
                                        .map(|index| {
                                            Ok(reply(&output, format!("hello {name} #{index}")))
                                        })
                                        .collect();
                                Ok(Response::new(
                                    Box::pin(tokio_stream::iter(replies)) as BoxStream
                                ))
                            }
                        }),
                        request,
                    )
                    .await
                }
                "LotsOfGreetings" => {
                    grpc.client_streaming(
                        tower::service_fn(move |request: Request<Streaming<DynamicMessage>>| {
                            let output = output.clone();
                            async move {
                                let mut stream = request.into_inner();
                                let mut names = Vec::new();
                                while let Some(message) = stream.message().await? {
                                    names.push(name_of(&message));
                                }
                                Ok(Response::new(reply(
                                    &output,
                                    format!("hello {}", names.join(", ")),
                                )))
                            }
                        }),
                        request,
                    )
                    .await
                }
                "BidiHello" => {
                    grpc.streaming(
                        tower::service_fn(move |request: Request<Streaming<DynamicMessage>>| {
                            let output = output.clone();
                            async move {
                                let replies = request.into_inner().map(move |message| {
                                    message.map(|message| {
                                        reply(&output, format!("hi {}", name_of(&message)))
                                    })
                                });
                                Ok(Response::new(Box::pin(replies) as BoxStream))
                            }
                        }),
                        request,
                    )
                    .await
                }
                _ => Status::unimplemented(method).into_http(),
            };
            Ok(response)
        })
    }
}

/// Starts the server; `with_reflection` also serves reflection v1.
async fn serve(with_reflection: bool) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let greeter = Greeter { pool: pool() };
    let descriptor_set: &'static [u8] = Box::leak(
        protox::compile([protos().join("greeter.proto")], [protos()])
            .unwrap()
            .encode_to_vec()
            .into_boxed_slice(),
    );
    tokio::spawn(async move {
        let mut router = tonic::transport::Server::builder().add_service(greeter);
        if with_reflection {
            let reflection = tonic_reflection::server::Builder::configure()
                .register_encoded_file_descriptor_set(descriptor_set)
                .build_v1()
                .unwrap();
            router = router.add_service(reflection);
        }
        router
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await
            .unwrap();
    });
    address
}

async fn channel(address: SocketAddr, settings: &ConnectionSettings) -> tonic::transport::Channel {
    let target = GrpcTarget::parse(&format!("grpc://{address}")).unwrap();
    connect(&target, settings).await.unwrap()
}

fn request_json(name: &str, times: i32) -> String {
    format!(r#"{{"person": {{"name": "{name}"}}, "times": {times}}}"#)
}

fn received(events: &[GrpcEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            GrpcEvent::Received { json, .. } => {
                let value: serde_json::Value = serde_json::from_str(json).unwrap();
                Some(value["message"].as_str().unwrap().to_string())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn describes_services_compiled_from_proto_files_with_imports() {
    let summary = describe(&pool());
    assert_eq!(summary.services.len(), 1);
    let service = &summary.services[0];
    assert_eq!(service.name, "test.Greeter");
    let kinds: Vec<(&str, MethodKind)> = service
        .methods
        .iter()
        .map(|method| (method.name.as_str(), method.kind))
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("SayHello", MethodKind::Unary),
            ("LotsOfReplies", MethodKind::ServerStreaming),
            ("LotsOfGreetings", MethodKind::ClientStreaming),
            ("BidiHello", MethodKind::BidiStreaming),
        ]
    );
    let say_hello = &service.methods[0];
    assert_eq!(say_hello.input_type, "test.HelloRequest");
    let template: serde_json::Value = serde_json::from_str(&say_hello.input_template).unwrap();
    assert_eq!(
        template,
        serde_json::json!({
            "person": { "name": "", "mood": "MOOD_UNSPECIFIED", "tags": [""], "scores": {} },
            "times": 0,
            "sentAt": "1970-01-01T00:00:00Z",
            "email": "",
        })
    );
    let schema = &say_hello.input_schema;
    assert_eq!(
        schema["properties"]["person"]["properties"]["mood"]["enum"],
        serde_json::json!(["MOOD_UNSPECIFIED", "HAPPY"])
    );
    assert_eq!(
        schema["properties"]["person"]["properties"]["scores"]["additionalProperties"]["type"],
        serde_json::json!(["integer", "string"])
    );
    assert_eq!(schema["properties"]["sentAt"]["type"], "string");
    // The template is a valid request.
    let method = find_method(&pool(), "test.Greeter", "SayHello").unwrap();
    alcy_grpc::message_from_json(&method.input(), &say_hello.input_template).unwrap();
}

#[test]
fn reports_proto_compilation_errors() {
    let missing = compile_proto_files(&[protos().join("missing.proto")], &[]).unwrap_err();
    assert!(matches!(missing, GrpcError::ProtoFiles(_)), "{missing:?}");
    // Without the folder that holds `common/`, the import cannot resolve.
    let unresolved = compile_proto_files(
        &[protos().join("greeter.proto")],
        &[protos().join("common")],
    );
    assert!(
        unresolved.is_ok(),
        "the file's own folder is always searched"
    );
}

#[tokio::test]
async fn reflection_describes_the_server_and_fails_clearly_without_it() {
    let with = serve(true).await;
    let reflected = reflect(channel(with, &ConnectionSettings::default()).await, &[])
        .await
        .unwrap();
    assert_eq!(describe(&reflected), describe(&pool()));

    let without = serve(false).await;
    let error = reflect(channel(without, &ConnectionSettings::default()).await, &[])
        .await
        .unwrap_err();
    assert!(
        matches!(&error, GrpcError::Reflection(message) if message.contains(".proto")),
        "{error:?}"
    );
}

#[tokio::test]
async fn unary_call_carries_metadata_and_returns_the_reply() {
    let address = serve(false).await;
    let method = find_method(&pool(), "test.Greeter", "SayHello").unwrap();
    let metadata = [MetadataEntry {
        name: "x-echo".to_string(),
        value: "ping".to_string(),
    }];
    let mut call = start_call(
        channel(address, &ConnectionSettings::default()).await,
        &method,
        &metadata,
        None,
    )
    .unwrap();
    call.send_json(&request_json("ana", 0)).await.unwrap();
    let outcome = call.collect().await;

    assert_eq!(received(&outcome.events), vec!["hello ana"]);
    assert!(outcome.status().unwrap().is_ok());
    let headers = outcome.events.iter().find_map(|event| match event {
        GrpcEvent::Headers { metadata, .. } => Some(metadata.clone()),
        _ => None,
    });
    assert!(
        headers
            .unwrap()
            .iter()
            .any(|entry| entry.name == "x-echo" && entry.value == "ping")
    );
    assert!(matches!(
        outcome.events.first(),
        Some(GrpcEvent::Sent { index: 0, .. })
    ));
    assert!(matches!(
        outcome.events.last(),
        Some(GrpcEvent::Finished { .. })
    ));
}

#[tokio::test]
async fn an_error_status_keeps_its_code_message_and_trailers() {
    let address = serve(false).await;
    let method = find_method(&pool(), "test.Greeter", "SayHello").unwrap();
    let mut call = start_call(
        channel(address, &ConnectionSettings::default()).await,
        &method,
        &[],
        None,
    )
    .unwrap();
    call.send_json(&request_json("fail", 0)).await.unwrap();
    let outcome = call.collect().await;

    let Some(GrpcEvent::Finished {
        status, trailers, ..
    }) = outcome.events.last()
    else {
        panic!("no finished event: {:?}", outcome.events);
    };
    assert_eq!(
        (
            status.code,
            status.code_name.as_str(),
            status.message.as_str()
        ),
        (3, "INVALID_ARGUMENT", "name not allowed")
    );
    assert!(
        trailers
            .iter()
            .any(|entry| entry.name == "x-reason" && entry.value == "bad-name")
    );
    assert!(received(&outcome.events).is_empty());
}

#[tokio::test]
async fn server_streaming_receives_every_message() {
    let address = serve(false).await;
    let method = find_method(&pool(), "test.Greeter", "LotsOfReplies").unwrap();
    let mut call = start_call(
        channel(address, &ConnectionSettings::default()).await,
        &method,
        &[],
        None,
    )
    .unwrap();
    call.send_json(&request_json("bia", 3)).await.unwrap();
    let outcome = call.collect().await;

    assert_eq!(
        received(&outcome.events),
        vec!["hello bia #0", "hello bia #1", "hello bia #2"]
    );
    assert!(outcome.status().unwrap().is_ok());
}

#[tokio::test]
async fn client_streaming_sends_every_message_before_the_reply() {
    let address = serve(false).await;
    let method = find_method(&pool(), "test.Greeter", "LotsOfGreetings").unwrap();
    let mut call = start_call(
        channel(address, &ConnectionSettings::default()).await,
        &method,
        &[],
        None,
    )
    .unwrap();
    for name in ["ana", "bia", "caio"] {
        call.send_json(&request_json(name, 0)).await.unwrap();
    }
    let outcome = call.collect().await;

    assert_eq!(received(&outcome.events), vec!["hello ana, bia, caio"]);
    let sent = outcome
        .events
        .iter()
        .filter(|event| matches!(event, GrpcEvent::Sent { .. }))
        .count();
    assert_eq!(sent, 3);
}

#[tokio::test]
async fn bidirectional_streaming_replies_while_the_client_keeps_sending() {
    let address = serve(false).await;
    let method = find_method(&pool(), "test.Greeter", "BidiHello").unwrap();
    let mut call = start_call(
        channel(address, &ConnectionSettings::default()).await,
        &method,
        &[],
        None,
    )
    .unwrap();

    call.send_json(&request_json("ana", 0)).await.unwrap();
    let mut first_reply = None;
    while first_reply.is_none() {
        match call.next_event().await.unwrap() {
            GrpcEvent::Received { json, .. } => first_reply = Some(json),
            GrpcEvent::Finished { status, .. } => panic!("finished early: {status:?}"),
            _ => {}
        }
    }
    assert!(first_reply.unwrap().contains("hi ana"));

    call.send_json(&request_json("bia", 0)).await.unwrap();
    let outcome = call.collect().await;
    assert_eq!(received(&outcome.events), vec!["hi bia"]);
    assert!(outcome.status().unwrap().is_ok());
}

#[tokio::test]
async fn a_deadline_ends_a_slow_call() {
    let address = serve(false).await;
    let method = find_method(&pool(), "test.Greeter", "SayHello").unwrap();
    let deadline = Some(Duration::from_millis(200));
    let mut call = start_call(
        channel(address, &ConnectionSettings::default()).await,
        &method,
        &[],
        deadline,
    )
    .unwrap();
    call.send_json(&request_json("slow", 0)).await.unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(3), call.collect())
        .await
        .unwrap();

    assert_eq!(
        outcome.status().unwrap().code_name,
        "DEADLINE_EXCEEDED",
        "{:?}",
        outcome.events
    );
}

#[tokio::test]
async fn rejects_messages_that_do_not_match_the_input_type() {
    let address = serve(false).await;
    let method = find_method(&pool(), "test.Greeter", "SayHello").unwrap();
    let mut call = start_call(
        channel(address, &ConnectionSettings::default()).await,
        &method,
        &[],
        None,
    )
    .unwrap();

    let unknown = call.send_json(r#"{"persn": {}}"#).await.unwrap_err();
    assert!(
        matches!(&unknown, GrpcError::InvalidMessage { message_type, detail } if message_type == "test.HelloRequest" && detail.contains("persn")),
        "{unknown:?}"
    );
    let wrong_type = call.send_json(r#"{"times": "many"}"#).await.unwrap_err();
    assert!(matches!(wrong_type, GrpcError::InvalidMessage { .. }));
    assert!(find_method(&pool(), "test.Greeter", "Nope").is_err());
}

#[tokio::test]
async fn an_unreachable_server_finishes_as_unavailable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let target = GrpcTarget::parse(&format!("grpc://{address}")).unwrap();

    let error = connect(&target, &ConnectionSettings::default())
        .await
        .unwrap_err();

    assert!(
        matches!(&error, GrpcError::Connection(message) if !message.is_empty()),
        "{error:?}"
    );
}

/// A minimal HTTP proxy that accepts `CONNECT` and records the targets.
async fn connect_proxy() -> (Url, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else {
                return;
            };
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let target = head
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                recorded
                    .lock()
                    .unwrap()
                    .push(head.lines().take(3).collect::<Vec<_>>().join("|"));
                let mut upstream = TcpStream::connect(&target).await.unwrap();
                client
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .await
                    .unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    (
        Url::parse(&format!("http://user:p%40ss@{address}")).unwrap(),
        seen,
    )
}

#[tokio::test]
async fn calls_through_an_http_proxy_tunnel() {
    let address = serve(false).await;
    let (proxy, seen) = connect_proxy().await;
    let settings = ConnectionSettings {
        proxy: Some(proxy),
        ..ConnectionSettings::default()
    };
    let method = find_method(&pool(), "test.Greeter", "SayHello").unwrap();
    let mut call = start_call(channel(address, &settings).await, &method, &[], None).unwrap();
    call.send_json(&request_json("via proxy", 0)).await.unwrap();
    let outcome = call.collect().await;

    assert_eq!(received(&outcome.events), vec!["hello via proxy"]);
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].starts_with(&format!("CONNECT {address} HTTP/1.1")),
        "{requests:?}"
    );
    // `user:p@ss`
    assert!(
        requests[0].contains("Proxy-Authorization: Basic dXNlcjpwQHNz"),
        "{requests:?}"
    );
}
