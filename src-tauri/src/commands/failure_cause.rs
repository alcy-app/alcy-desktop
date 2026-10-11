//! Causas reconhecidas das falhas de envio, enviadas ao frontend junto da
//! mensagem técnica para que a interface descreva a falha no idioma do
//! usuário (ADR 0044). Compartilhadas pelos comandos de envio REST e GraphQL.

use alcy_app::TemplateError;
use alcy_domain::{EndpointError, EnvironmentVariableError, HeaderError, NetworkCause};
use serde::Serialize;

/// Por que a requisição não pôde ser montada ou enviada.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InvalidRequestCause {
    EmptyEndpoint,
    EmptyHeaderName,
    InvalidHeaderName { name: String },
    InvalidHeaderValue { name: String },
    MissingVariable { name: String },
    EmptyVariableName,
    InvalidVariableName,
    BodyFileUnreadable { path: String },
}

impl InvalidRequestCause {
    pub(crate) fn header(name: &str, error: &HeaderError) -> Self {
        match error {
            HeaderError::EmptyName => Self::EmptyHeaderName,
            HeaderError::InvalidName => Self::InvalidHeaderName {
                name: name.to_string(),
            },
            HeaderError::InvalidValue => Self::InvalidHeaderValue {
                name: name.to_string(),
            },
        }
    }

    /// `None` para referências a nodes de flow, que só existem fora do envio
    /// avulso.
    pub(crate) fn template(error: &TemplateError) -> Option<Self> {
        match error {
            TemplateError::MissingVariable(name) => {
                Some(Self::MissingVariable { name: name.clone() })
            }
            TemplateError::NodeReference(_) => None,
        }
    }
}

impl From<&EndpointError> for InvalidRequestCause {
    fn from(error: &EndpointError) -> Self {
        match error {
            EndpointError::Empty => Self::EmptyEndpoint,
        }
    }
}

impl From<&EnvironmentVariableError> for InvalidRequestCause {
    fn from(error: &EnvironmentVariableError) -> Self {
        match error {
            EnvironmentVariableError::EmptyName => Self::EmptyVariableName,
            EnvironmentVariableError::InvalidName => Self::InvalidVariableName,
        }
    }
}

/// Espelho serializável de `NetworkCause` (o domínio não depende de serde).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NetworkCauseOutput {
    InvalidUrl,
    HostNotFound,
    ConnectionRefused,
    ConnectionFailed,
    Tls,
    TooManyRedirects,
    #[serde(rename = "oauth2TokenStatus")]
    OAuth2TokenStatus {
        status: u16,
    },
    #[serde(rename = "oauth2TokenResponseInvalid")]
    OAuth2TokenResponseInvalid,
    DigestBodyNotReplayable,
    DigestChallengeMissing,
    DigestChallengeInvalid,
}

impl From<NetworkCause> for NetworkCauseOutput {
    fn from(cause: NetworkCause) -> Self {
        match cause {
            NetworkCause::InvalidUrl => Self::InvalidUrl,
            NetworkCause::HostNotFound => Self::HostNotFound,
            NetworkCause::ConnectionRefused => Self::ConnectionRefused,
            NetworkCause::ConnectionFailed => Self::ConnectionFailed,
            NetworkCause::Tls => Self::Tls,
            NetworkCause::TooManyRedirects => Self::TooManyRedirects,
            NetworkCause::OAuth2TokenStatus(status) => Self::OAuth2TokenStatus { status },
            NetworkCause::OAuth2TokenResponseInvalid => Self::OAuth2TokenResponseInvalid,
            NetworkCause::DigestBodyNotReplayable => Self::DigestBodyNotReplayable,
            NetworkCause::DigestChallengeMissing => Self::DigestChallengeMissing,
            NetworkCause::DigestChallengeInvalid => Self::DigestChallengeInvalid,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_causes_as_tagged_objects() {
        assert_eq!(
            serde_json::to_value(InvalidRequestCause::MissingVariable {
                name: "baseUrl".to_string()
            })
            .unwrap(),
            json!({ "type": "missingVariable", "name": "baseUrl" })
        );
        assert_eq!(
            serde_json::to_value(NetworkCauseOutput::from(NetworkCause::OAuth2TokenStatus(
                401
            )))
            .unwrap(),
            json!({ "type": "oauth2TokenStatus", "status": 401 })
        );
        assert_eq!(
            serde_json::to_value(NetworkCauseOutput::from(NetworkCause::ConnectionRefused))
                .unwrap(),
            json!({ "type": "connectionRefused" })
        );
    }
}
