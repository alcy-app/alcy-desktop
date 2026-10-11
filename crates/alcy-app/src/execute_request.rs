use std::future::Future;

use alcy_domain::{ExecutionError, Request, Response};

use crate::RequestExecutor;

/// Executa uma requisição através da porta informada, cancelável via
/// `cancellation`.
///
/// Corrida (`select!`) entre a execução e o sinal de cancelamento: quando
/// `cancellation` resolve primeiro, o resultado é
/// `ExecutionError::Cancelled` e a execução em progresso é descartada. Nem
/// `RequestExecutor` nem os adapters concretos precisam saber que
/// cancelamento existe.
pub async fn execute_request<E, C>(
    executor: &E,
    request: &Request,
    cancellation: C,
) -> Result<Response, ExecutionError>
where
    E: RequestExecutor,
    C: Future<Output = ()> + Send,
{
    tokio::select! {
        result = executor.execute(request) => result,
        _ = cancellation => Err(ExecutionError::Cancelled),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Authentication, Endpoint, ProtocolId, RequestDocument, ResponseMetadata};
    use std::future::pending;

    struct FakeExecutor {
        result: Result<Response, ExecutionError>,
    }

    impl RequestExecutor for FakeExecutor {
        async fn execute(&self, _request: &Request) -> Result<Response, ExecutionError> {
            self.result.clone()
        }
    }

    struct PendingExecutor;

    impl RequestExecutor for PendingExecutor {
        async fn execute(&self, _request: &Request) -> Result<Response, ExecutionError> {
            pending().await
        }
    }

    fn sample_request() -> Request {
        Request::new(
            Endpoint::new("https://api.example.com/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        )
    }

    #[tokio::test]
    async fn delegates_to_the_executor_on_success() {
        let response = Response::new(
            200,
            12,
            "{\"data\":{}}",
            vec![],
            ResponseMetadata::default(),
        );
        let executor = FakeExecutor {
            result: Ok(response.clone()),
        };

        let outcome = execute_request(&executor, &sample_request(), pending()).await;

        assert_eq!(outcome, Ok(response));
    }

    #[tokio::test]
    async fn delegates_to_the_executor_on_error() {
        let executor = FakeExecutor {
            result: Err(ExecutionError::Timeout),
        };

        let outcome = execute_request(&executor, &sample_request(), pending()).await;

        assert_eq!(outcome, Err(ExecutionError::Timeout));
    }

    #[tokio::test]
    async fn cancellation_wins_the_race_against_a_never_resolving_executor() {
        let executor = PendingExecutor;

        let outcome = execute_request(&executor, &sample_request(), async {}).await;

        assert_eq!(outcome, Err(ExecutionError::Cancelled));
    }
}
