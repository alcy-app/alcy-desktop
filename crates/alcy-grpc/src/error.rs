use thiserror::Error;

/// Failures before a call reaches the server, or while describing it. A call
/// that reaches the server ends with a [`crate::GrpcStatus`] instead, even
/// when that status is an error.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GrpcError {
    #[error("endereço gRPC inválido: {0}")]
    InvalidTarget(String),
    #[error("falha ao conectar: {0}")]
    Connection(String),
    #[error("certificado inválido: {0}")]
    Certificate(String),
    #[error("falha ao compilar os arquivos .proto: {0}")]
    ProtoFiles(String),
    #[error("falha na reflection do servidor: {0}")]
    Reflection(String),
    #[error("método não encontrado: {0}")]
    MethodNotFound(String),
    #[error("mensagem inválida para {message_type}: {detail}")]
    InvalidMessage {
        message_type: String,
        detail: String,
    },
    #[error("metadata inválida '{name}': {detail}")]
    InvalidMetadata { name: String, detail: String },
}
