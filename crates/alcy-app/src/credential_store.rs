use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CredentialError {
    /// Não há armazenamento seguro no sistema (ex.: Linux sem Secret Service).
    #[error("o chaveiro do sistema não está disponível: {0}")]
    Unavailable(String),
    #[error("falha ao acessar o chaveiro do sistema: {0}")]
    Failed(String),
}

/// Porta para guardar segredos (ex.: tokens) fora dos arquivos do app.
///
/// Implementada sobre o chaveiro do sistema operacional. A porta não faz
/// fallback para arquivo: se o chaveiro não existe, o erro sobe a quem chamou
/// (credenciais levam o erro até o usuário; a chave local de
/// `alcy-storage::LocalSecrets` usa um arquivo reserva, ver ADR 0030).
pub trait CredentialStore: Send + Sync {
    fn load(&self, key: &str) -> Result<Option<String>, CredentialError>;
    fn save(&self, key: &str, secret: &str) -> Result<(), CredentialError>;
    /// Remover uma chave que não existe não é erro.
    fn delete(&self, key: &str) -> Result<(), CredentialError>;
}
