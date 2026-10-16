//! A minimal HTTP/2 gRPC peer for adapter integration tests. It deliberately
//! avoids generated clients, external processes and additional dependencies.

use alcy_domain::{
    Authentication, Endpoint, GrpcCall, GrpcSchemaSource, ProtocolId, Request, RequestDocument,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn frame(socket: &mut TcpStream, kind: u8, flags: u8, stream: u32, payload: &[u8]) {
    let size = payload.len() as u32;
    let mut bytes = vec![
        (size >> 16) as u8,
        (size >> 8) as u8,
        size as u8,
        kind,
        flags,
    ];
    bytes.extend_from_slice(&stream.to_be_bytes());
    bytes.extend_from_slice(payload);
    socket.write_all(&bytes).await.unwrap();
}

fn literal(name: &str, value: &str, bytes: &mut Vec<u8>) {
    bytes.push(0); // HPACK literal without indexing, new name.
    bytes.push(name.len() as u8);
    bytes.extend_from_slice(name.as_bytes());
    bytes.push(value.len() as u8);
    bytes.extend_from_slice(value.as_bytes());
}

/// Returns the endpoint and the protobuf request bytes observed on the wire.
pub(crate) async fn serve(
    code: u8,
    messages: &[&str],
) -> (String, tokio::sync::oneshot::Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let messages: Vec<String> = messages.iter().map(|message| message.to_string()).collect();
    let (sent, observed) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut preface = [0; 24];
        socket.read_exact(&mut preface).await.unwrap();
        assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
        frame(&mut socket, 4, 0, 0, &[]).await;
        let mut body = Vec::new();
        let stream = loop {
            let mut header = [0; 9];
            socket.read_exact(&mut header).await.unwrap();
            let size = (usize::from(header[0]) << 16)
                | (usize::from(header[1]) << 8)
                | usize::from(header[2]);
            let mut payload = vec![0; size];
            socket.read_exact(&mut payload).await.unwrap();
            let stream = u32::from_be_bytes(header[5..9].try_into().unwrap()) & 0x7fff_ffff;
            if header[3] == 4 && header[4] & 1 == 0 {
                frame(&mut socket, 4, 1, 0, &[]).await;
            }
            if header[3] == 0 && stream != 0 {
                body.extend_from_slice(&payload);
            }
            if stream != 0 && header[4] & 1 != 0 && matches!(header[3], 0 | 1) {
                break stream;
            }
        };
        let _ = sent.send(body);
        let mut headers = vec![0x88]; // Static HPACK entry :status = 200.
        literal("content-type", "application/grpc", &mut headers);
        literal("x-initial", "headers", &mut headers);
        frame(&mut socket, 1, 4, stream, &headers).await;
        for message in messages {
            assert!(message.len() < 128);
            let mut protobuf = vec![0x0a, message.len() as u8];
            protobuf.extend_from_slice(message.as_bytes());
            let mut body = vec![0];
            body.extend_from_slice(&(protobuf.len() as u32).to_be_bytes());
            body.extend_from_slice(&protobuf);
            frame(&mut socket, 0, 0, stream, &body).await;
        }
        let mut trailers = Vec::new();
        literal("grpc-status", &code.to_string(), &mut trailers);
        literal(
            "grpc-message",
            if code == 0 { "" } else { "test failure" },
            &mut trailers,
        );
        literal("x-final", "trailers", &mut trailers);
        frame(&mut socket, 1, 5, stream, &trailers).await;
        // Keep the transport alive until the client consumes its trailers.
        let mut rest = Vec::new();
        let _ = socket.read_to_end(&mut rest).await;
    });
    (endpoint, observed)
}

pub(crate) fn request(endpoint: &str, method: &str) -> Request {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../crates/alcy-grpc/tests/fixtures/protos");
    Request::new(
        Endpoint::new(endpoint).unwrap(),
        RequestDocument::new(ProtocolId::Grpc, r#"{"person":{"name":"ana"}}"#),
        "",
        vec![],
        Authentication::None,
    )
    .with_grpc(GrpcCall {
        service: "test.Greeter".to_string(),
        method: method.to_string(),
        schema_source: GrpcSchemaSource::ProtoFiles {
            files: vec![root.join("greeter.proto").to_string_lossy().to_string()],
            import_paths: vec![],
        },
        deadline_ms: Some(2000),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collection_run_step::CollectionRunStepExecutor;
    use crate::commands::protocol_dispatching_executor::ProtocolDispatchingExecutor;
    use crate::commands::scripting::ScriptingExecutor;
    use alcy_app::{
        CollectionRunPlan, CollectionRunSink, FlowCancellation, FlowNodeOutcome, FlowRunSink,
        IterationData, NoMockServers, RequestExecutor, RunStepReport, execute_flow, run_collection,
    };
    use alcy_domain::{
        Collection, CollectionRunOptions, Flow, FlowEdge, FlowNode, FlowNodeKind, FlowPosition,
        Response, RunStepOutcome, SavedRequest,
    };
    use alcy_graphql::ReqwestGraphqlExecutor;
    use alcy_rest::ReqwestRestExecutor;
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::SystemTime;

    struct NeverCancelled;
    impl FlowCancellation for NeverCancelled {
        fn is_cancelled(&self) -> bool {
            false
        }
        async fn cancelled(&self) {
            std::future::pending().await
        }
    }

    #[derive(Default)]
    struct RunnerSink(Mutex<Vec<RunStepReport>>);
    impl CollectionRunSink for RunnerSink {
        fn run_started(&self, _: u32, _: usize) {}
        fn iteration_started(&self, _: u32) {}
        fn request_started(&self, _: u32, _: usize, _: &str) {}
        fn request_finished(&self, report: &RunStepReport, response: Option<&Response>) {
            assert!(response.is_some());
            self.0.lock().unwrap().push(report.clone());
        }
    }

    #[derive(Default)]
    struct FlowSink {
        events: Mutex<Vec<(String, FlowNodeOutcome)>>,
        outputs: Mutex<Vec<Response>>,
    }
    impl FlowRunSink for FlowSink {
        fn node_started(&self, _: &str) {}
        fn node_finished(&self, id: &str, outcome: FlowNodeOutcome) {
            self.events.lock().unwrap().push((id.to_string(), outcome));
        }
        fn node_output(&self, _: &str, response: &Response) {
            self.outputs.lock().unwrap().push(response.clone());
        }
    }

    #[tokio::test]
    async fn collected_adapter_executes_every_call_kind_and_half_closes_the_request() {
        for (method, messages) in [
            ("SayHello", vec!["one"]),
            ("LotsOfReplies", vec!["one", "two"]),
            ("LotsOfGreetings", vec!["one"]),
            ("BidiHello", vec!["one", "two"]),
        ] {
            let (endpoint, observed) = serve(0, &messages).await;
            let response = crate::commands::grpc::execute_saved_request(
                &request(&endpoint, method),
                Path::new("."),
                None,
            )
            .await
            .unwrap();
            assert_eq!(response.grpc.as_ref().unwrap().code, 0);
            assert!(response.protocol_failure().is_none());
            let trailers = response.grpc.unwrap().trailers;
            assert!(trailers.contains(&alcy_domain::ResponseHeader {
                name: "x-final".to_string(),
                value: "trailers".to_string()
            }));
            assert!(!trailers.iter().any(|entry| entry.name == "x-initial"));
            let json: serde_json::Value = serde_json::from_str(&response.body).unwrap();
            assert_eq!(
                if messages.len() == 1 {
                    1
                } else {
                    json.as_array().unwrap().len()
                },
                messages.len()
            );
            assert!(!observed.await.unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn runner_fails_non_ok_grpc_even_when_http_failures_are_disabled_and_keeps_script_effects()
     {
        let (endpoint, observed) = serve(5, &["reply"]).await;
        let call = request(&endpoint, "SayHello").with_scripts(
            "al.request.grpc.message = { person: { name: 'scripted' } }; al.request.grpc.metadata.set('x-script', 'yes');",
            "al.test('grpc', function () { al.expect(al.response.grpc.code).toBe(5); al.expect(al.response.grpc.messages[0].message).toBe('reply'); al.expect(al.response.grpc.trailers[0].name).toBe('x-final'); }); al.environment.set('result', al.response.grpc.codeName);"
        );
        let collections = vec![
            Collection::new(
                "c",
                "Calls",
                vec![],
                vec![SavedRequest::new("r", "Call", call).unwrap()],
            )
            .unwrap(),
        ];
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let step = CollectionRunStepExecutor {
            inner: ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: Path::new("."),
            },
            cookies: None,
            runtime_variables: Mutex::default(),
        };
        let mut options = CollectionRunOptions::new(1, 0).unwrap();
        options.http_errors_fail = false;
        options.stop_on_error = true;
        let sink = RunnerSink::default();
        let ids = vec!["r".to_string()];
        let summary = run_collection(
            &CollectionRunPlan {
                request_ids: &ids,
                collections: &collections,
                options: &options,
                environment: &[],
                data: &IterationData::default(),
            },
            &step,
            &sink,
            &NeverCancelled,
        )
        .await;
        assert!(summary.stopped_on_error);
        assert!(
            summary
                .environment_changes
                .contains(&("result".to_string(), Some("NOT_FOUND".to_string())))
        );
        let reports = sink.0.lock().unwrap().clone();
        assert_eq!(reports[0].outcome, RunStepOutcome::Failed);
        assert_eq!(reports[0].status_code, Some(200));
        assert!(reports[0].tests[0].passed, "{:?}", reports[0].tests);
        assert!(
            reports[0]
                .error_message
                .as_ref()
                .unwrap()
                .contains("NOT_FOUND")
        );
        assert!(
            observed
                .await
                .unwrap()
                .windows(8)
                .any(|bytes| bytes == b"scripted")
        );
    }

    #[tokio::test]
    async fn flows_take_the_grpc_failure_branch_and_expose_received_messages_to_successors() {
        let (endpoint, _observed) = serve(5, &["reply"]).await;
        let call = request(&endpoint, "SayHello")
            .with_scripts("", "al.environment.set('grpc', al.response.grpc.codeName);");
        let collections = vec![
            Collection::new(
                "c",
                "Calls",
                vec![],
                vec![SavedRequest::new("r", "Call", call).unwrap()],
            )
            .unwrap(),
        ];
        let node = |id: &str, kind| FlowNode {
            id: id.to_string(),
            kind,
            position: FlowPosition { x: 0.0, y: 0.0 },
        };
        let edge = |id: &str, source: &str, target: &str, handle: Option<&str>| FlowEdge {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: handle.map(str::to_string),
        };
        let flow = Flow::new("f", "Calls", vec![node("start", FlowNodeKind::Start), node("req", FlowNodeKind::Request { request_id: "r".to_string() }), node("failure", FlowNodeKind::Display { template: "{{nodes.req.response.grpcStatus.codeName}} {{nodes.req.response.messages.0.message}}".to_string() }), node("success", FlowNodeKind::Display { template: "wrong branch".to_string() })], vec![edge("a", "start", "req", None), edge("b", "req", "failure", Some("failure")), edge("c", "req", "success", Some("success"))], SystemTime::now(), SystemTime::now()).unwrap();
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let executor = ScriptingExecutor::new(
            ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: Path::new("."),
            },
            &collections,
            vec![],
        );
        let sink = FlowSink::default();
        execute_flow(
            &flow,
            &collections,
            &executor,
            &[],
            &sink,
            &NeverCancelled,
            &NoMockServers,
        )
        .await
        .unwrap();
        assert!(sink.events.lock().unwrap().iter().any(|(id, result)| id == "failure" && matches!(result, FlowNodeOutcome::Completed { message: Some(message) } if message == "NOT_FOUND reply")));
        assert_eq!(
            sink.outputs.lock().unwrap()[0].grpc.as_ref().unwrap().code,
            5
        );
        assert_eq!(
            executor.take_effects().environment_changes[0]
                .value
                .as_deref(),
            Some("NOT_FOUND")
        );
    }

    #[tokio::test]
    async fn pre_script_can_change_the_grpc_method_and_post_script_sees_the_stream() {
        let (endpoint, observed) = serve(0, &["one", "two"]).await;
        let graphql = ReqwestGraphqlExecutor::new();
        let rest = ReqwestRestExecutor::new();
        let executor = ScriptingExecutor::new(
            ProtocolDispatchingExecutor {
                app: None,
                graphql: &graphql,
                rest: &rest,
                workspace_root: Path::new("."),
            },
            &[],
            vec![],
        );
        let call = request(&endpoint, "missing").with_scripts(
            "al.request.grpc.method = 'LotsOfReplies'; al.request.grpc.message = {person:{name:'changed'}};",
            "al.test('messages', function () { al.expect(al.response.grpc.messages.length).toBe(2); }); al.environment.set('second', al.response.grpc.messages[1].message);"
        );
        executor.execute(&call).await.unwrap();
        let effects = executor.take_effects();
        assert!(effects.tests[0].passed);
        assert_eq!(effects.environment_changes[0].value.as_deref(), Some("two"));
        assert!(
            observed
                .await
                .unwrap()
                .windows(7)
                .any(|bytes| bytes == b"changed")
        );
    }
}
