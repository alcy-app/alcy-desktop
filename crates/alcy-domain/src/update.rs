use thiserror::Error;

/// The app's update preferences. Where releases come from is not a
/// preference: it is fixed in the build (`ALCY_UPDATE_PROVIDER`/`ALCY_UPDATE_URL`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSettings {
    /// Checks for a new version when the app opens (installing always waits
    /// for the user to confirm).
    pub check_on_startup: bool,
    /// Offers preview (pre-release) versions too, when the newest release is
    /// one, instead of only stable ones.
    pub include_prereleases: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            check_on_startup: true,
            include_prereleases: false,
        }
    }
}

/// Is a release tag (`v1.2.0-preview01`, `1.2.0`) a pre-release? Follows
/// SemVer: a version is a pre-release when a `-` comes before any build
/// metadata (`+`). Tags that are not versions count as stable.
pub fn is_prerelease_tag(tag: &str) -> bool {
    let version = tag.trim().trim_start_matches(['v', 'V']);
    let without_build = version.split('+').next().unwrap_or(version);
    version.starts_with(|c: char| c.is_ascii_digit()) && without_build.contains('-')
}

/// De onde vêm as releases do app. Fixa no build, escolhida por quem
/// distribui o Alcy; trocar de plataforma é só trocar a origem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateSource {
    /// Repositório público do GitHub.
    Github { owner: String, repo: String },
    /// URL direta do manifesto do updater, em qualquer hospedagem.
    Manifest { url: String },
    /// Serviço de releases do Alcy (`services/alcy-releases-api`); guarda a
    /// URL base, sem barra final.
    ReleaseServer { base_url: String },
}

impl UpdateSource {
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
    #[error("o repositório do GitHub deve estar no formato dono/repositorio")]
    InvalidRepository,
    #[error("a URL do manifesto deve começar com http:// ou https://")]
    InvalidManifestUrl,
    #[error(
        "a URL do servidor de releases deve começar com http:// ou https:// e não ter query (ex.: http://alcy-releases.interno:32761)"
    )]
    InvalidReleaseServerUrl,
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
    fn detects_pre_release_tags() {
        for tag in [
            "v0.9.0-preview01",
            "0.9.0-rc.1",
            "V1.0.0-beta+build.5",
            " v2.0.0-alpha ",
        ] {
            assert!(is_prerelease_tag(tag), "{tag}");
        }
        for tag in [
            "v0.9.0",
            "0.9.0",
            "1.0.0+build-5",
            "release-2026",
            "latest",
            "",
        ] {
            assert!(!is_prerelease_tag(tag), "{tag}");
        }
    }
}
