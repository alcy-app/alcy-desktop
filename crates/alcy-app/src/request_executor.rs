use std::future::Future;
use std::time::Duration;

use alcy_domain::{EnvironmentVariable, ExecutionError, Request, Response};

/// Transport phases observed by an HTTP executor. An absent phase means the
/// transport does not expose it, rather than a zero duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RequestExecutionTimings {
    pub dns: Option<Duration>,
    pub connecting: Option<Duration>,
    pub tls_handshaking: Option<Duration>,
    pub sending: Option<Duration>,
    pub waiting: Option<Duration>,
    pub receiving: Option<Duration>,
}

/// A response with optional transport telemetry. Consumers without timing
/// requirements can keep calling `execute`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstrumentedResponse {
    pub response: Response,
    pub timings: RequestExecutionTimings,
}

/// Protocol-independent request execution, implemented by infrastructure adapters.
/// Application use cases depend on this port rather than a concrete HTTP client.
/// Futures explicitly require Send because native commands use a multithreaded runtime.
pub trait RequestExecutor {
    /// Current run environment, including script writes and removals. Stateless
    /// executors return None so callers retain their initial environment.
    fn environment_snapshot(&self) -> Option<Vec<EnvironmentVariable>> {
        None
    }

    fn execute(
        &self,
        request: &Request,
    ) -> impl Future<Output = Result<Response, ExecutionError>> + Send;

    /// Optional transport telemetry with a default for uninstrumented adapters.
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

    /// Execute with saved-request identity for collection/folder script scopes (ADR 0031).
    fn execute_saved(
        &self,
        request_id: &str,
        request: &Request,
    ) -> impl Future<Output = Result<Response, ExecutionError>> + Send {
        let _ = request_id;
        self.execute(request)
    }
}
