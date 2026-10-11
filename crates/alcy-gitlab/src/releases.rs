//! Projetos e releases usados como origem de atualizações do Alcy.

use alcy_app::RemoteError;
use percent_encoding::utf8_percent_encode;
use serde::Deserialize;
use url::Url;

use crate::client::{GitlabSession, PATH_SEGMENT, check, parse_json};

/// Nome do asset link da release que aponta para o manifesto do updater.
pub const UPDATE_MANIFEST_ASSET: &str = "latest.json";

/// Quantas releases buscar para achar a mais recente já publicada (as
/// "futuras", com `released_at` adiante, são ignoradas).
const RELEASES_WINDOW: &str = "5";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GitlabProjectInfo {
    pub id: u64,
    pub name: String,
    pub path_with_namespace: String,
    pub web_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GitlabReleaseLink {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitlabRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub released_at: Option<String>,
    pub web_url: Option<String>,
    pub links: Vec<GitlabReleaseLink>,
}

impl GitlabRelease {
    /// URL do manifesto do updater anexado à release, se houver. Usa o
    /// destino real do link: o `direct_asset_url` pode ser uma rota web
    /// (`/-/releases/.../downloads/...`), que não aceita o token da API.
    pub fn manifest_url(&self) -> Option<&str> {
        self.links
            .iter()
            .find(|link| link.name.eq_ignore_ascii_case(UPDATE_MANIFEST_ASSET))
            .map(|link| link.url.as_str())
    }
}

#[derive(Deserialize)]
struct ReleaseLinks {
    #[serde(rename = "self")]
    web: Option<String>,
}

#[derive(Deserialize)]
struct ReleaseAssets {
    #[serde(default)]
    links: Vec<GitlabReleaseLink>,
}

#[derive(Deserialize)]
struct RawRelease {
    tag_name: String,
    name: Option<String>,
    description: Option<String>,
    released_at: Option<String>,
    #[serde(default)]
    upcoming_release: bool,
    #[serde(rename = "_links")]
    links: Option<ReleaseLinks>,
    assets: Option<ReleaseAssets>,
}

impl From<RawRelease> for GitlabRelease {
    fn from(raw: RawRelease) -> Self {
        Self {
            tag_name: raw.tag_name,
            name: raw.name,
            description: raw.description,
            released_at: raw.released_at,
            web_url: raw.links.and_then(|links| links.web),
            links: raw.assets.map(|assets| assets.links).unwrap_or_default(),
        }
    }
}

/// `candidate` está na mesma origem (esquema, host e porta) da instância?
/// O token da conta só pode ser enviado para URLs que passem aqui.
pub fn is_instance_url(instance_url: &str, candidate: &str) -> bool {
    match (Url::parse(instance_url), Url::parse(candidate)) {
        (Ok(instance), Ok(candidate)) => instance.origin() == candidate.origin(),
        _ => false,
    }
}

impl GitlabSession<'_> {
    /// Projeto pelo caminho (`grupo/sub/projeto`).
    pub async fn project_by_path(&self, path: &str) -> Result<GitlabProjectInfo, RemoteError> {
        let encoded = utf8_percent_encode(path, PATH_SEGMENT);
        let url = self.api_url(&format!("/projects/{encoded}"));
        let response = self
            .send(|client, token| client.get(&url).bearer_auth(token))
            .await?;
        parse_json(check(response).await?).await
    }

    /// Release publicada mais recente do projeto (`None` se não houver).
    pub async fn latest_release(
        &self,
        project_id: u64,
    ) -> Result<Option<GitlabRelease>, RemoteError> {
        let url = self.api_url(&format!("/projects/{project_id}/releases"));
        let response = self
            .send(|client, token| {
                client.get(&url).bearer_auth(token).query(&[
                    ("order_by", "released_at"),
                    ("sort", "desc"),
                    ("per_page", RELEASES_WINDOW),
                ])
            })
            .await?;
        let releases: Vec<RawRelease> = parse_json(check(response).await?).await?;
        Ok(releases
            .into_iter()
            .find(|release| !release.upcoming_release)
            .map(GitlabRelease::from))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(name: &str, url: &str) -> GitlabReleaseLink {
        GitlabReleaseLink {
            name: name.into(),
            url: url.into(),
        }
    }

    fn release(links: Vec<GitlabReleaseLink>) -> GitlabRelease {
        GitlabRelease {
            tag_name: "v1.0.0".into(),
            name: None,
            description: None,
            released_at: None,
            web_url: None,
            links,
        }
    }

    #[test]
    fn finds_the_manifest_link_by_its_real_target() {
        let with_manifest = release(vec![
            link("Alcy_1.0.0_x64-setup.exe", "https://h/a.exe"),
            link(
                "latest.json",
                "https://h/api/v4/projects/1/packages/generic/alcy/1.0.0/latest.json",
            ),
        ]);
        assert_eq!(
            with_manifest.manifest_url(),
            Some("https://h/api/v4/projects/1/packages/generic/alcy/1.0.0/latest.json")
        );

        let upper_case = release(vec![link("LATEST.JSON", "https://h/l.json")]);
        assert_eq!(upper_case.manifest_url(), Some("https://h/l.json"));

        assert_eq!(release(vec![]).manifest_url(), None);
    }

    #[test]
    fn instance_urls_must_share_scheme_host_and_port() {
        let base = "https://gitlab.corp";
        assert!(is_instance_url(base, "https://gitlab.corp/api/v4/x"));
        assert!(is_instance_url(base, "https://GITLAB.corp:443/x"));
        assert!(is_instance_url(
            "https://corp.com/gitlab",
            "https://corp.com/other"
        ));
        assert!(!is_instance_url(base, "http://gitlab.corp/x"));
        assert!(!is_instance_url(base, "https://gitlab.corp:8443/x"));
        assert!(!is_instance_url(base, "https://evil.example/x"));
        assert!(!is_instance_url(base, "https://gitlab.corp.evil.example/x"));
        assert!(!is_instance_url(base, "não é url"));
    }
}
