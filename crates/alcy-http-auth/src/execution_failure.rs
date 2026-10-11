//! Traduz falhas do `reqwest` e da autenticação para o `ExecutionError` do
//! domínio. Compartilhado por `alcy-rest` e `alcy-graphql`, que enviam pelo
//! mesmo cliente e precisam reconhecer as mesmas causas.

use std::error::Error as StdError;
use std::io;

use alcy_domain::{ExecutionError, NetworkCause, NetworkFailure};

use crate::AuthHttpError;

pub fn map_reqwest_error(error: reqwest::Error) -> ExecutionError {
    if error.is_timeout() {
        return ExecutionError::Timeout;
    }
    ExecutionError::Network(NetworkFailure {
        cause: network_cause(&error),
        detail: describe_reqwest_error(&error),
    })
}

pub fn map_auth_error(error: AuthHttpError) -> ExecutionError {
    // O detalhe técnico fica em inglês, como as mensagens do `reqwest`: é o
    // que o histórico guarda e o que aparece quando a causa não é exibida.
    let (cause, detail) = match error {
        AuthHttpError::Transport(error) => return map_reqwest_error(error),
        AuthHttpError::TokenStatus(status) => (
            NetworkCause::OAuth2TokenStatus(status.as_u16()),
            format!("OAuth2 token endpoint responded with status {status}"),
        ),
        AuthHttpError::TokenResponse(detail) => (
            NetworkCause::OAuth2TokenResponseInvalid,
            format!("invalid OAuth2 token response: {detail}"),
        ),
        AuthHttpError::DigestBodyNotReplayable => (
            NetworkCause::DigestBodyNotReplayable,
            "request body cannot be replayed for digest authentication".to_string(),
        ),
        AuthHttpError::DigestChallengeMissing => (
            NetworkCause::DigestChallengeMissing,
            "401 response without a WWW-Authenticate header".to_string(),
        ),
        AuthHttpError::DigestChallengeInvalid(detail) => (
            NetworkCause::DigestChallengeInvalid,
            format!("invalid digest challenge: {detail}"),
        ),
    };
    ExecutionError::Network(NetworkFailure {
        cause: Some(cause),
        detail,
    })
}

/// `reqwest::Error::to_string()` sozinho costuma ser pouco informativo
/// (ex.: "builder error" para uma URL inválida, sem dizer por quê). A causa
/// real geralmente está na cadeia de `source()`.
fn describe_reqwest_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = StdError::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

fn network_cause(error: &reqwest::Error) -> Option<NetworkCause> {
    if error.is_builder() {
        // Erros de builder também cobrem header inválido; só a URL traz
        // `url()` (esquema não suportado) ou um `url::ParseError` na cadeia.
        let url_error =
            error.url().is_some() || sources(error).any(|cause| cause.is::<url::ParseError>());
        return url_error.then_some(NetworkCause::InvalidUrl);
    }
    if error.is_redirect() {
        return Some(NetworkCause::TooManyRedirects);
    }
    if !error.is_connect() {
        return None;
    }
    let refused = sources(error).any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|io_error| io_error.kind() == io::ErrorKind::ConnectionRefused)
    });
    if refused {
        return Some(NetworkCause::ConnectionRefused);
    }
    // O conector do hyper e o rustls não expõem tipos públicos para estas
    // falhas; as mensagens deles são o único sinal estável disponível.
    let messages: Vec<String> = sources(error)
        .map(|cause| cause.to_string().to_ascii_lowercase())
        .collect();
    if messages.iter().any(|message| message.contains("dns error")) {
        return Some(NetworkCause::HostNotFound);
    }
    if messages
        .iter()
        .any(|message| message.contains("certificate") || message.contains("tls"))
    {
        return Some(NetworkCause::Tls);
    }
    Some(NetworkCause::ConnectionFailed)
}

fn sources<'a>(error: &'a reqwest::Error) -> impl Iterator<Item = &'a (dyn StdError + 'static)> {
    std::iter::successors(
        StdError::source(error),
        |cause: &&'a (dyn StdError + 'static)| (*cause).source(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::{Client, StatusCode};

    fn cause_of(error: ExecutionError) -> Option<NetworkCause> {
        match error {
            ExecutionError::Network(failure) => failure.cause,
            other => panic!("esperava falha de rede, obteve {other:?}"),
        }
    }

    #[tokio::test]
    async fn recognizes_an_invalid_url() {
        let error = Client::new().get("not a url").send().await.unwrap_err();
        assert_eq!(
            cause_of(map_reqwest_error(error)),
            Some(NetworkCause::InvalidUrl)
        );
    }

    #[tokio::test]
    async fn recognizes_an_unsupported_scheme_as_an_invalid_url() {
        let error = Client::new()
            .get("ftp://example.com/file")
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            cause_of(map_reqwest_error(error)),
            Some(NetworkCause::InvalidUrl)
        );
    }

    #[tokio::test]
    async fn recognizes_a_refused_connection() {
        // Reserva uma porta livre e a fecha: nada escuta nela.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            cause_of(map_reqwest_error(error)),
            Some(NetworkCause::ConnectionRefused)
        );
    }

    #[test]
    fn auth_failures_keep_their_cause_and_an_english_detail() {
        let error = map_auth_error(AuthHttpError::TokenStatus(StatusCode::UNAUTHORIZED));
        match error {
            ExecutionError::Network(failure) => {
                assert_eq!(failure.cause, Some(NetworkCause::OAuth2TokenStatus(401)));
                assert!(failure.detail.contains("401"), "{}", failure.detail);
            }
            other => panic!("esperava falha de rede, obteve {other:?}"),
        }
        assert_eq!(
            cause_of(map_auth_error(AuthHttpError::DigestChallengeMissing)),
            Some(NetworkCause::DigestChallengeMissing)
        );
    }
}
