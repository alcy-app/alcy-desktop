//! Prévia do export para o diálogo: o que vai, o que fica de fora e os hosts
//! que o servidor precisa liberar (`--allow-host`).

use std::collections::BTreeSet;

use serde::Serialize;

use crate::Credential;
use crate::snapshot::{
    SnapshotAuthentication, SnapshotEnvironment, SnapshotFolder, SnapshotVariable,
    UnsupportedFeature, for_each_request,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebclientSummary {
    pub request_count: usize,
    pub folder_count: usize,
    pub credentials: Vec<Credential>,
    pub unsupported: Vec<UnsupportedItem>,
    /// Hosts das URLs e dos token URLs de OAuth2, resolvidos com as
    /// variáveis do export.
    pub hosts: Vec<String>,
    /// Alguma URL depende de variável sem valor, então `hosts` pode estar
    /// incompleto.
    pub has_unresolved_hosts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedItem {
    pub request_id: String,
    pub request_name: String,
    pub feature: UnsupportedFeature,
}

/// `root` e `environment` são os de antes da redação: os hosts usam os
/// valores reais, que não saem do app por aqui.
pub(crate) fn summarize(
    root: &SnapshotFolder,
    environment: Option<&SnapshotEnvironment>,
    credentials: Vec<Credential>,
) -> WebclientSummary {
    let mut request_count = 0;
    let mut unsupported = Vec::new();
    let mut hosts = BTreeSet::new();
    let mut has_unresolved_hosts = false;

    for_each_request(root, &mut |request, chain| {
        request_count += 1;
        for feature in &request.unsupported {
            unsupported.push(UnsupportedItem {
                request_id: request.id.clone(),
                request_name: request.name.clone(),
                feature: *feature,
            });
        }

        let mut variables: Vec<&SnapshotVariable> = environment
            .map(|environment| environment.variables.iter().collect())
            .unwrap_or_default();
        for folder in chain {
            for variable in &folder.variables {
                variables.retain(|existing| existing.name != variable.name);
                variables.push(variable);
            }
        }

        let mut urls = vec![request.url.as_str()];
        let authentication = std::iter::once(&request.authentication)
            .chain(chain.iter().rev().map(|folder| &folder.authentication))
            .find(|authentication| **authentication != SnapshotAuthentication::Inherit);
        if let Some(SnapshotAuthentication::OAuth2ClientCredentials { token_url, .. }) =
            authentication
        {
            urls.push(token_url);
        }
        for url in urls {
            match host_of(&resolve(url, &variables)) {
                Some(host) => {
                    hosts.insert(host);
                }
                None => has_unresolved_hosts = true,
            }
        }
    });

    WebclientSummary {
        request_count,
        folder_count: count_folders(root),
        credentials,
        unsupported,
        hosts: hosts.into_iter().collect(),
        has_unresolved_hosts,
    }
}

fn count_folders(folder: &SnapshotFolder) -> usize {
    folder
        .folders
        .iter()
        .map(|child| 1 + count_folders(child))
        .sum()
}

/// Substitui `{{nome}}` pelo valor; nomes sem valor ficam como estão.
fn resolve(template: &str, variables: &[&SnapshotVariable]) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            result.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let name = after_open[..end].trim();
        match variables.iter().find(|variable| variable.name == name) {
            Some(variable) => result.push_str(&variable.value),
            None => result.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after_open[end + 2..];
    }
    result.push_str(rest);
    result
}

/// Host (sem porta nem usuário) de uma URL absoluta http(s). `None` quando a
/// URL ainda tem variável não resolvida ou não é http(s).
fn host_of(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = if let Some(bracketed) = host_port.strip_prefix('[') {
        format!("[{}]", bracketed.split(']').next()?)
    } else {
        host_port.split(':').next()?.to_string()
    };
    if host.is_empty() || host.contains("{{") {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_hosts_without_port_or_user() {
        assert_eq!(
            host_of("https://user:pw@API.test:8443/a?b#c").as_deref(),
            Some("api.test")
        );
        assert_eq!(host_of("http://[::1]:8080/").as_deref(), Some("[::1]"));
        assert_eq!(host_of("{{baseUrl}}/users"), None);
        assert_eq!(host_of("ftp://files.test"), None);
    }

    #[test]
    fn resolves_known_variables_only() {
        let base = SnapshotVariable {
            name: "baseUrl".into(),
            value: "https://api.test".into(),
        };
        assert_eq!(
            resolve("{{ baseUrl }}/x/{{id}}", &[&base]),
            "https://api.test/x/{{id}}"
        );
    }
}
