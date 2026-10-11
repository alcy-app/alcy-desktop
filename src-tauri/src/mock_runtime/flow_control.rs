use std::path::PathBuf;

use alcy_app::{
    CapturedRequest, MockControlError, MockRouteSummary, MockRunHandle, MockServerControl,
};
use alcy_domain::{MockServer, MockServerSource};
use alcy_storage::MockServerStore;

use super::{MockServerRuntime, RunningSnapshot, StartError, method_to};

/// Adaptador da porta `MockServerControl` (spec 0121) sobre o runtime dos
/// mock servers, válido para um run de flow: mocks salvos vêm do workspace
/// `root`; mocks avulsos ganham uma chave própria do run, que não colide com
/// nenhum mock salvo nem com outro run.
pub(crate) struct FlowMockControl<'a> {
    runtime: &'a MockServerRuntime,
    root: PathBuf,
    flow_execution_id: String,
}

impl<'a> FlowMockControl<'a> {
    pub(crate) fn new(
        runtime: &'a MockServerRuntime,
        root: PathBuf,
        flow_execution_id: String,
    ) -> Self {
        Self {
            runtime,
            root,
            flow_execution_id,
        }
    }

    fn start_owned(&self, config: MockServer) -> Result<MockRunHandle, MockControlError> {
        let key = config.id.clone();
        self.runtime.start(config).map_err(|error| match error {
            StartError::PortUnavailable { port, .. } => MockControlError::PortInUse(port),
            StartError::Io(message) => MockControlError::Invalid(message),
        })?;
        let snapshot = self
            .runtime
            .snapshot(&key)
            .ok_or(MockControlError::Stopped)?;
        Ok(handle(key, snapshot, true))
    }
}

fn handle(key: String, snapshot: RunningSnapshot, owned: bool) -> MockRunHandle {
    let config = snapshot.config;
    let name = if config.name.trim().is_empty() {
        "Mock".to_string()
    } else {
        config.name.clone()
    };
    MockRunHandle {
        key,
        name,
        port: config.port,
        owned,
        start_seq: snapshot.last_seq,
        baseline_counts: snapshot.route_counts,
        routes: config
            .routes
            .iter()
            .map(|route| MockRouteSummary {
                id: route.id.clone(),
                label: format!("{} {}", method_to(route.method), route.path),
                responses: std::iter::once(&route.default_response)
                    .chain(&route.alternatives)
                    .map(|response| (response.id.clone(), response.name.clone()))
                    .collect(),
            })
            .collect(),
    }
}

impl MockServerControl for FlowMockControl<'_> {
    fn start(
        &self,
        node_id: &str,
        source: &MockServerSource,
    ) -> Result<MockRunHandle, MockControlError> {
        match source {
            MockServerSource::Saved { server_id } => {
                if server_id.trim().is_empty() {
                    return Err(MockControlError::Invalid(
                        "selecione o mock server deste bloco".to_string(),
                    ));
                }
                if let Some(snapshot) = self.runtime.snapshot(server_id) {
                    return Ok(handle(server_id.clone(), snapshot, false));
                }
                let config = MockServerStore::new(self.root.clone())
                    .load()
                    .map_err(|error| {
                        MockControlError::Invalid(format!(
                            "falha ao carregar os mock servers: {error}"
                        ))
                    })?
                    .into_iter()
                    .find(|server| server.id == *server_id)
                    .ok_or_else(|| MockControlError::ServerNotFound(server_id.clone()))?;
                self.start_owned(config)
            }
            MockServerSource::Inline { server } => {
                let mut config = (**server).clone();
                config.id = format!("flow:{}:{node_id}", self.flow_execution_id);
                self.start_owned(config)
            }
        }
    }

    fn stop(&self, key: &str) {
        self.runtime.stop(key);
    }

    async fn wait_request(
        &self,
        key: String,
        route_id: String,
        after_seq: u64,
    ) -> Result<CapturedRequest, MockControlError> {
        self.runtime
            .wait_request(&key, &route_id, after_seq)
            .await
            .ok_or(MockControlError::Stopped)
    }

    fn set_response(
        &self,
        key: &str,
        route_id: &str,
        response_id: Option<&str>,
    ) -> Result<(), MockControlError> {
        if self.runtime.set_override(key, route_id, response_id) {
            Ok(())
        } else {
            Err(MockControlError::Stopped)
        }
    }

    fn call_count(&self, key: &str, route_id: &str) -> Result<u64, MockControlError> {
        self.runtime
            .call_count(key, route_id)
            .ok_or(MockControlError::Stopped)
    }

    fn clear_overrides(&self, key: &str) {
        self.runtime.clear_overrides(key);
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{call, free_port, health_server};
    use super::*;

    #[test]
    fn reuses_a_running_saved_mock_and_isolates_inline_mocks_by_run() {
        let runtime = MockServerRuntime::default();
        let saved_port = free_port();
        runtime.start(health_server("saved", saved_port)).unwrap();
        call(saved_port, "{}");
        let control = FlowMockControl::new(&runtime, PathBuf::from("/nao-usado"), "run-1".into());

        let reused = control
            .start(
                "mock-a",
                &MockServerSource::Saved {
                    server_id: "saved".to_string(),
                },
            )
            .unwrap();
        assert!(!reused.owned);
        assert_eq!(reused.start_seq, 1);
        assert_eq!(reused.baseline_counts.get("route"), Some(&1));
        assert_eq!(reused.routes[0].label, "POST /health/:id");

        let inline_port = free_port();
        let inline = control
            .start(
                "mock-b",
                &MockServerSource::Inline {
                    server: Box::new(health_server("ignored", inline_port)),
                },
            )
            .unwrap();
        assert!(inline.owned);
        assert_eq!(inline.key, "flow:run-1:mock-b");
        assert_eq!(inline.url(), format!("http://127.0.0.1:{inline_port}"));

        let busy = control.start(
            "mock-c",
            &MockServerSource::Inline {
                server: Box::new(health_server("ignored", saved_port)),
            },
        );
        assert_eq!(busy.unwrap_err(), MockControlError::PortInUse(saved_port));

        control.stop(&inline.key);
        runtime.stop("saved");
    }
}
