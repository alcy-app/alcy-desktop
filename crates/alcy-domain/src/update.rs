use thiserror::Error;

use crate::gitlab::normalize_instance_url;

/// Preferências de atualização do app. A origem das releases não é uma
/// preferência: vem fixa no build (`ALCY_UPDATE_PROVIDER`/`ALCY_UPDATE_URL`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSettings {
    /// Verifica se há versão nova ao abrir o app (a instalação sempre depende
    /// de confirmação do usuário).
    pub check_on_startup: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            check_on_startup: true,
        }
    }
}

/// De onde vêm as releases do app. Fixa no build, escolhida por quem
/// distribui o Alcy; trocar de plataforma é só trocar a origem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateSource {
    /// Projeto GitLab, inclusive privado (acesso pela conta conectada).
    Gitlab { project_url: String },
    /// Repositório público do GitHub.
    Github { owner: String, repo: String },
    /// URL direta do manifesto do updater, em qualquer hospedagem.
    Manifest { url: String },
    /// Serviço de releases do Alcy (`services/alcy-releases-api`); guarda a
    /// URL base, sem barra final.
    ReleaseServer { base_url: String },
}

impl UpdateSource {
    pub fn gitlab(project_url: &str) -> Result<Self, UpdateSourceError> {
        Ok(Self::Gitlab {
            project_url: normalize_project_url(project_url)?,
        })
    }

    /// Aceita `owner/repo` ou a URL do repositório no GitHub.
    pub fn github(repository: &str) -> Result<Self, UpdateSourceError> {
        let trimmed = repository.trim();
        let path = ["https://github.com/", "http://github.com/", "github.com/"]
            .iter()
            .find_map(|prefix| trimmed.strip_prefix(prefix))
            .unwrap_or(trimmed)
            .trim_end_matches('/')
            .trim_end_matches(".git");

        let valid_segment = |segment: &str| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        match path.split('/').collect::<Vec<_>>().as_slice() {
            [owner, repo] if valid_segment(owner) && valid_segment(repo) => Ok(Self::Github {
                owner: (*owner).to_string(),
                repo: (*repo).to_string(),
            }),
            _ => Err(UpdateSourceError::InvalidRepository),
        }
    }

    pub fn manifest(url: &str) -> Result<Self, UpdateSourceError> {
        let url = url.trim();
        if !is_http_url(url) {
            return Err(UpdateSourceError::InvalidManifestUrl);
        }
        Ok(Self::Manifest {
            url: url.to_string(),
        })
    }

    /// Aceita a URL base do serviço, inclusive em subcaminho; as rotas da
    /// API são acrescentadas a ela, então não pode ter query nem fragmento.
    pub fn release_server(url: &str) -> Result<Self, UpdateSourceError> {
        let url = url.trim().trim_end_matches('/');
        if !is_http_url(url) || url.contains(['?', '#']) {
            return Err(UpdateSourceError::InvalidReleaseServerUrl);
        }
        Ok(Self::ReleaseServer {
            base_url: url.to_string(),
        })
    }
}

/// `http://` ou `https://` com host e sem espaços.
fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let has_host = ["http://", "https://"]
        .iter()
        .find_map(|scheme| lower.strip_prefix(scheme))
        .is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/'));
    has_host && !url.contains(char::is_whitespace)
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum UpdateSourceError {
    #[error("a URL do projeto não pode ser vazia")]
    EmptyProjectUrl,
    #[error("a URL do projeto é inválida (ex.: https://gitlab.suaempresa.com/grupo/alcy)")]
    InvalidProjectUrl,
    #[error("o repositório do GitHub deve estar no formato dono/repositorio")]
    InvalidRepository,
    #[error("a URL do manifesto deve começar com http:// ou https://")]
    InvalidManifestUrl,
    #[error(
        "a URL do servidor de releases deve começar com http:// ou https:// e não ter query (ex.: http://alcy-releases.interno:32761)"
    )]
    InvalidReleaseServerUrl,
}

/// Normaliza a URL de um projeto: aceita também o que se copia do navegador
/// (`/-/releases`, `.git`, barra final) e devolve só a raiz do projeto.
pub fn normalize_project_url(input: &str) -> Result<String, UpdateSourceError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(UpdateSourceError::EmptyProjectUrl);
    }
    let valid =
        normalize_instance_url(trimmed).map_err(|_| UpdateSourceError::InvalidProjectUrl)?;

    let without_subpage = valid.split("/-/").next().unwrap_or_default();
    let url = without_subpage
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');

    let has_path = url
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/'))
        .is_some_and(|(_, path)| !path.is_empty());
    if !has_path {
        return Err(UpdateSourceError::InvalidProjectUrl);
    }
    Ok(url.to_string())
}

/// Caminho do projeto (`grupo/sub/projeto`) quando `project_url` pertence à
/// instância `instance_url` — inclusive instâncias servidas em subcaminho.
pub fn project_path_in_instance(project_url: &str, instance_url: &str) -> Option<String> {
    let instance = instance_url.trim_end_matches('/');
    let prefix_matches = project_url
        .get(..instance.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(instance));
    if !prefix_matches {
        return None;
    }
    let path = project_url[instance.len()..].strip_prefix('/')?;
    (!path.is_empty()).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_checking_on_startup() {
        assert!(UpdateSettings::default().check_on_startup);
    }

    #[test]
    fn builds_each_kind_of_source() {
        assert_eq!(
            UpdateSource::gitlab("https://gitlab.corp/grupo/alcy/-/releases"),
            Ok(UpdateSource::Gitlab {
                project_url: "https://gitlab.corp/grupo/alcy".into()
            })
        );
        for repository in [
            "empresa/alcy",
            " https://github.com/empresa/alcy/ ",
            "github.com/empresa/alcy.git",
        ] {
            assert_eq!(
                UpdateSource::github(repository),
                Ok(UpdateSource::Github {
                    owner: "empresa".into(),
                    repo: "alcy".into()
                }),
                "{repository}"
            );
        }
        assert_eq!(
            UpdateSource::manifest(" https://cdn.corp/alcy/latest.json "),
            Ok(UpdateSource::Manifest {
                url: "https://cdn.corp/alcy/latest.json".into()
            })
        );
        for url in [
            "http://alcy-releases.interno:32761",
            " http://alcy-releases.interno:32761/ ",
        ] {
            assert_eq!(
                UpdateSource::release_server(url),
                Ok(UpdateSource::ReleaseServer {
                    base_url: "http://alcy-releases.interno:32761".into()
                }),
                "{url}"
            );
        }
        assert_eq!(
            UpdateSource::release_server("https://corp.com/releases/"),
            Ok(UpdateSource::ReleaseServer {
                base_url: "https://corp.com/releases".into()
            })
        );
    }

    #[test]
    fn rejects_invalid_release_server_urls() {
        for url in [
            "",
            "alcy-releases.interno:32761",
            "ftp://alcy-releases",
            "http://",
            "http:///",
            "http://srv/a b",
            "http://srv/?canal=1",
            "http://srv/#x",
        ] {
            assert_eq!(
                UpdateSource::release_server(url),
                Err(UpdateSourceError::InvalidReleaseServerUrl),
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_invalid_github_repositories_and_manifest_urls() {
        for repository in [
            "",
            "empresa",
            "empresa/alcy/extra",
            "empresa/al cy",
            "/alcy",
        ] {
            assert_eq!(
                UpdateSource::github(repository),
                Err(UpdateSourceError::InvalidRepository),
                "{repository}"
            );
        }
        for url in [
            "",
            "cdn.corp/latest.json",
            "ftp://cdn/latest.json",
            "https://",
            "https://cdn/a b.json",
        ] {
            assert_eq!(
                UpdateSource::manifest(url),
                Err(UpdateSourceError::InvalidManifestUrl),
                "{url}"
            );
        }
    }

    #[test]
    fn normalizes_urls_copied_from_the_browser() {
        for input in [
            "https://gitlab.corp/grupo/alcy",
            " https://gitlab.corp/grupo/alcy/ ",
            "https://gitlab.corp/grupo/alcy.git",
            "https://gitlab.corp/grupo/alcy/-/releases",
            "https://gitlab.corp/grupo/alcy/-/releases/v1.0.0",
        ] {
            assert_eq!(
                normalize_project_url(input),
                Ok("https://gitlab.corp/grupo/alcy".to_string()),
                "{input}"
            );
        }
    }

    #[test]
    fn rejects_empty_urls_and_urls_without_a_project() {
        assert_eq!(
            normalize_project_url("  "),
            Err(UpdateSourceError::EmptyProjectUrl)
        );
        for input in [
            "gitlab.corp/grupo/alcy",
            "ftp://gitlab.corp/grupo/alcy",
            "https://gitlab.corp",
            "https://gitlab.corp/",
            "https://gitlab.corp/grupo/alcy?tab=1",
        ] {
            assert_eq!(
                normalize_project_url(input),
                Err(UpdateSourceError::InvalidProjectUrl),
                "{input}"
            );
        }
    }

    #[test]
    fn extracts_the_project_path_relative_to_the_instance() {
        assert_eq!(
            project_path_in_instance("https://gitlab.corp/grupo/sub/alcy", "https://gitlab.corp"),
            Some("grupo/sub/alcy".to_string())
        );
        assert_eq!(
            project_path_in_instance(
                "https://corp.com/gitlab/grupo/alcy",
                "https://corp.com/gitlab"
            ),
            Some("grupo/alcy".to_string())
        );
        assert_eq!(
            project_path_in_instance("https://GITLAB.corp/grupo/alcy", "https://gitlab.corp/"),
            Some("grupo/alcy".to_string())
        );
    }

    #[test]
    fn does_not_match_other_instances() {
        assert_eq!(
            project_path_in_instance("https://gitlab.corp/grupo/alcy", "https://gitlab.com"),
            None
        );
        assert_eq!(
            project_path_in_instance(
                "https://gitlab.corp.example/grupo/alcy",
                "https://gitlab.corp"
            ),
            None
        );
        assert_eq!(
            project_path_in_instance("http://gitlab.corp/grupo/alcy", "https://gitlab.corp"),
            None
        );
        assert_eq!(
            project_path_in_instance("https://gitlab.corp", "https://gitlab.corp"),
            None
        );
    }
}
