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
    #[error("falha ao acessar a chave de criptografia local: {0}")]
    Secrets(String),
}
