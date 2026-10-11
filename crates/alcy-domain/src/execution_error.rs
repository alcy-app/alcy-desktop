use std::fmt;

use thiserror::Error;

/// Erros que impedem a obtenção de uma `Response`.
///
/// Não inclui status HTTP não-2xx nem erro GraphQL no corpo — ambos chegam
/// como `Response` bem-sucedida do ponto de vista de transporte (ver
/// `Response`).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExecutionError {
    #[error("falha de rede: {0}")]
    Network(NetworkFailure),
    #[error("tempo de execução esgotado")]
    Timeout,
    #[error("variables inválidas: {0}")]
    InvalidVariables(String),
    /// Requisição inválida no momento da execução. Diferente de
    /// `InvalidVariables`, que é especificamente sobre `variables` do
    /// GraphQL.
    #[error("requisição inválida: {0}")]
    InvalidRequest(String),
    /// Arquivo de corpo (form-data/binary) que não pôde ser lido no momento
    /// do envio — ex.: não existe mais no disco. `detail` é a mensagem do
    /// sistema operacional.
    #[error("requisição inválida: não foi possível ler o arquivo \"{path}\": {detail}")]
    BodyFileUnreadable { path: String, detail: String },
    #[error("{0}")]
    Script(String),
    #[error("execução cancelada")]
    Cancelled,
    /// O corpo da resposta passou do limite de tamanho configurado e o
    /// download foi interrompido. Não há resposta parcial: o que já tinha
    /// chegado é descartado. `received_bytes` é o que se sabia do tamanho
    /// ao interromper — o `Content-Length` declarado, quando o servidor o
    /// envia, ou o total lido até ali.
    #[error(
        "a resposta excede o limite de tamanho ({received_bytes} bytes; limite de {limit_bytes} bytes)"
    )]
    ResponseTooLarge {
        limit_bytes: u64,
        received_bytes: u64,
    },
}

impl ExecutionError {
    /// Falha de rede sem causa reconhecida — só a mensagem técnica.
    pub fn network(detail: impl Into<String>) -> Self {
        Self::Network(NetworkFailure {
            cause: None,
            detail: detail.into(),
        })
    }
}

/// Falha de rede: a causa, quando reconhecida, e a mensagem técnica da
/// camada HTTP. A causa existe para a interface descrever a falha no idioma
/// do usuário; `detail` continua disponível para diagnóstico e é o que vai
/// para o histórico.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkFailure {
    pub cause: Option<NetworkCause>,
    pub detail: String,
}

impl fmt::Display for NetworkFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

/// Causas de falha de rede que a interface sabe explicar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkCause {
    /// A URL resolvida não é válida (sem esquema, host ausente etc.).
    InvalidUrl,
    /// O nome do host não pôde ser resolvido (DNS).
    HostNotFound,
    /// O servidor recusou a conexão — geralmente nada escuta na porta.
    ConnectionRefused,
    /// Outra falha ao estabelecer a conexão.
    ConnectionFailed,
    /// Falha no handshake TLS ou certificado não confiável.
    Tls,
    TooManyRedirects,
    /// O servidor de token OAuth2 respondeu com status de erro.
    OAuth2TokenStatus(u16),
    /// A resposta do servidor de token OAuth2 não trouxe um `access_token`.
    OAuth2TokenResponseInvalid,
    /// Autenticação Digest exige reenviar o corpo, e ele não pode ser
    /// reenviado (ex.: streaming).
    DigestBodyNotReplayable,
    /// A resposta 401 não trouxe o cabeçalho `WWW-Authenticate`.
    DigestChallengeMissing,
    /// O desafio Digest do servidor é inválido ou não suportado.
    DigestChallengeInvalid,
}
