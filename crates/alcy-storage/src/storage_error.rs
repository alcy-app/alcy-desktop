use thiserror::Error;

/// Erro genérico de leitura/escrita de um arquivo local versionado —
/// compartilhado por todos os stores deste crate (não é específico de
/// ambientes ou schema).
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("falha ao ler arquivo: {0}")]
    Read(String),
    #[error("não encontrado: {0}")]
    NotFound(String),
    #[error("falha ao escrever arquivo: {0}")]
    Write(String),
    #[error("arquivo corrompido: {0}")]
    Corrupted(String),
    #[error("versão de arquivo não suportada: {0}")]
    UnsupportedVersion(u32),
    /// A request uses a protocol this build does not know (saved by a newer
    /// one). Loading fails as a whole, so the file is never saved back without
    /// the requests it could not read (ADR 0062).
    #[error("o arquivo usa o protocolo '{0}', que esta versão do Alcy não suporta; atualize o app")]
    UnsupportedProtocol(String),
    #[error("falha ao acessar a chave de criptografia local: {0}")]
    Secrets(String),
}
