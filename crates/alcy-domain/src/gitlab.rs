use std::collections::BTreeMap;

use thiserror::Error;

/// Arquivos do workspace que entram no controle de versão por padrão.
pub const VERSIONED_FILES: [&str; 5] = [
    "alcy-workspace.json",
    "alcy-collections.json",
    "alcy-flows.json",
    API_DOCS_FILE,
    VALUE_MONITORS_FILE,
];

/// Documentação importada das APIs (ADR 0035) — versionada junto das
/// coleções que a referenciam.
pub const API_DOCS_FILE: &str = "alcy-api-docs.json";

/// Monitores de valores — regras de validação dos campos das respostas,
/// compartilhadas entre as requisições do workspace.
pub const VALUE_MONITORS_FILE: &str = "alcy-value-monitors.json";

/// Arquivo que só é versionado por opt-in (guarda segredos em texto claro).
pub const ENVIRONMENTS_FILE: &str = "alcy-environments.json";

/// Manifesto do workspace: nunca é apagado por uma atualização remota.
pub const MANIFEST_FILE: &str = "alcy-workspace.json";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GitlabAccountError {
    #[error("a URL da instância não pode ser vazia")]
    EmptyInstanceUrl,
    #[error("a URL da instância é inválida")]
    InvalidInstanceUrl,
    #[error("o client_id não pode ser vazio")]
    EmptyClientId,
    #[error("o caminho dentro do repositório é inválido")]
    InvalidDirectory,
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

/// Vínculo de um workspace com um projeto e uma branch do GitLab.
///
/// `base` guarda o SHA-256 de cada arquivo na última sincronização; um
/// arquivo ausente do mapa não existia nesse ponto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceLink {
    pub account_id: String,
    pub project_id: u64,
    pub project_path: String,
    pub branch: String,
    /// Pasta dentro do repositório (vazia = raiz), sem barras nas pontas.
    pub directory: String,
    pub include_environments: bool,
    pub base: BTreeMap<String, String>,
}

impl WorkspaceLink {
    pub fn new(
        account_id: impl Into<String>,
        project_id: u64,
        project_path: impl Into<String>,
        branch: impl Into<String>,
        directory: &str,
        include_environments: bool,
    ) -> Result<Self, GitlabAccountError> {
        Ok(Self {
            account_id: account_id.into(),
            project_id,
            project_path: project_path.into(),
            branch: branch.into(),
            directory: normalize_directory(directory)?,
            include_environments,
            base: BTreeMap::new(),
        })
    }

    /// Nomes (relativos à raiz do workspace) dos arquivos versionados.
    pub fn tracked_files(&self) -> Vec<&'static str> {
        let mut files = VERSIONED_FILES.to_vec();
        if self.include_environments {
            files.push(ENVIRONMENTS_FILE);
        }
        files
    }

    /// Caminho do arquivo dentro do repositório.
    pub fn remote_path(&self, file_name: &str) -> String {
        if self.directory.is_empty() {
            file_name.to_string()
        } else {
            format!("{}/{}", self.directory, file_name)
        }
    }
}

fn normalize_directory(input: &str) -> Result<String, GitlabAccountError> {
    let trimmed = input.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let invalid = trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'));
    if invalid {
        return Err(GitlabAccountError::InvalidDirectory);
    }
    Ok(trimmed.to_string())
}

/// Situação de um arquivo versionado, pela comparação de três conteúdos:
/// o da última sincronização (base), o local e o remoto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    Clean,
    LocalAdded,
    LocalModified,
    LocalDeleted,
    /// Mudou (ou foi apagado) só no remoto; uma atualização o aplica.
    RemoteChanged,
    /// Mudou nos dois lados com conteúdos diferentes.
    Conflict,
}

impl FileState {
    pub fn is_local_change(self) -> bool {
        matches!(
            self,
            Self::LocalAdded | Self::LocalModified | Self::LocalDeleted
        )
    }
}

/// Classifica um arquivo a partir dos hashes (`None` = ausente).
pub fn classify(base: Option<&str>, local: Option<&str>, remote: Option<&str>) -> FileState {
    if local == remote {
        return FileState::Clean;
    }
    if local == base {
        return FileState::RemoteChanged;
    }
    if remote == base {
        return match (base, local) {
            (_, None) => FileState::LocalDeleted,
            (None, Some(_)) => FileState::LocalAdded,
            (Some(_), Some(_)) => FileState::LocalModified,
        };
    }
    FileState::Conflict
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

    #[test]
    fn link_builds_remote_paths_and_tracked_files() {
        let link = WorkspaceLink::new("a", 7, "eq/proj", "main", "/alcy/", false).unwrap();
        assert_eq!(link.directory, "alcy");
        assert_eq!(
            link.remote_path("alcy-collections.json"),
            "alcy/alcy-collections.json"
        );
        assert_eq!(link.tracked_files().len(), 5);
        assert!(link.tracked_files().contains(&VALUE_MONITORS_FILE));

        let root = WorkspaceLink::new("a", 7, "eq/proj", "main", "", true).unwrap();
        assert_eq!(root.remote_path("alcy-flows.json"), "alcy-flows.json");
        assert!(root.tracked_files().contains(&ENVIRONMENTS_FILE));

        assert_eq!(
            WorkspaceLink::new("a", 7, "p", "main", "a/../b", false),
            Err(GitlabAccountError::InvalidDirectory)
        );
    }

    #[test]
    fn classifies_every_combination() {
        // Iguais (incluindo ausentes) => limpo.
        assert_eq!(classify(Some("a"), Some("a"), Some("a")), FileState::Clean);
        assert_eq!(classify(None, None, None), FileState::Clean);
        // Mudou nos dois lados para o mesmo conteúdo => limpo.
        assert_eq!(classify(Some("a"), Some("b"), Some("b")), FileState::Clean);
        // Só local.
        assert_eq!(
            classify(Some("a"), Some("b"), Some("a")),
            FileState::LocalModified
        );
        assert_eq!(classify(None, Some("b"), None), FileState::LocalAdded);
        assert_eq!(
            classify(Some("a"), None, Some("a")),
            FileState::LocalDeleted
        );
        // Só remoto.
        assert_eq!(
            classify(Some("a"), Some("a"), Some("b")),
            FileState::RemoteChanged
        );
        assert_eq!(classify(None, None, Some("b")), FileState::RemoteChanged);
        assert_eq!(
            classify(Some("a"), Some("a"), None),
            FileState::RemoteChanged
        );
        // Divergiram.
        assert_eq!(
            classify(Some("a"), Some("b"), Some("c")),
            FileState::Conflict
        );
        assert_eq!(classify(None, Some("b"), Some("c")), FileState::Conflict);
        assert_eq!(classify(Some("a"), None, Some("c")), FileState::Conflict);
        assert_eq!(classify(Some("a"), Some("b"), None), FileState::Conflict);
    }
}
