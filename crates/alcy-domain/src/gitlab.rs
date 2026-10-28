use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GitlabAccountError {
    #[error("a URL da instância não pode ser vazia")]
    EmptyInstanceUrl,
    #[error("a URL da instância é inválida")]
    InvalidInstanceUrl,
    #[error("o client_id não pode ser vazio")]
    EmptyClientId,
}

/// Normaliza a URL base de uma instância (sem barra final, sem caminho de
/// consulta). Aceita http ou https — instâncias internas costumam usar HTTP
/// por trás de um túnel ou de uma rede já confiável; a escolha é do usuário.
pub fn normalize_instance_url(input: &str) -> Result<String, GitlabAccountError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(GitlabAccountError::EmptyInstanceUrl);
    }

    let lower = trimmed.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or(GitlabAccountError::InvalidInstanceUrl)?;

    let authority = rest.split('/').next().unwrap_or_default();
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default();
    if host.is_empty() || trimmed.contains(['?', '#', ' ']) {
        return Err(GitlabAccountError::InvalidInstanceUrl);
    }

    Ok(trimmed.trim_end_matches('/').to_string())
}

/// Conta conectada. Nunca carrega tokens: eles ficam no chaveiro do sistema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitlabAccount {
    pub id: String,
    pub base_url: String,
    pub client_id: String,
    pub username: String,
    pub name: String,
}

impl GitlabAccount {
    pub fn new(
        id: impl Into<String>,
        base_url: &str,
        client_id: &str,
        username: impl Into<String>,
        name: impl Into<String>,
    ) -> Result<Self, GitlabAccountError> {
        let client_id = client_id.trim();
        if client_id.is_empty() {
            return Err(GitlabAccountError::EmptyClientId);
        }
        Ok(Self {
            id: id.into(),
            base_url: normalize_instance_url(base_url)?,
            client_id: client_id.to_string(),
            username: username.into(),
            name: name.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_instance_urls() {
        assert_eq!(
            normalize_instance_url(" https://gitlab.com/ ").unwrap(),
            "https://gitlab.com"
        );
        assert_eq!(
            normalize_instance_url("https://git.corp.local:8443/gitlab/").unwrap(),
            "https://git.corp.local:8443/gitlab"
        );
        assert_eq!(
            normalize_instance_url("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(
            normalize_instance_url("http://git.interno.local/gitlab/").unwrap(),
            "http://git.interno.local/gitlab"
        );
        assert_eq!(
            normalize_instance_url(""),
            Err(GitlabAccountError::EmptyInstanceUrl)
        );
        assert_eq!(
            normalize_instance_url("gitlab.com"),
            Err(GitlabAccountError::InvalidInstanceUrl)
        );
        assert_eq!(
            normalize_instance_url("https://"),
            Err(GitlabAccountError::InvalidInstanceUrl)
        );
        assert_eq!(
            normalize_instance_url("https://gitlab.com?x=1"),
            Err(GitlabAccountError::InvalidInstanceUrl)
        );
    }

    #[test]
    fn account_requires_a_client_id() {
        assert_eq!(
            GitlabAccount::new("a", "https://gitlab.com", "  ", "u", "U"),
            Err(GitlabAccountError::EmptyClientId)
        );
    }
}
