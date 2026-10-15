//! Recorte de uma coleção (ou pasta) no formato que o runtime do webclient
//! lê. É um contrato próprio, versionado em `SNAPSHOT_VERSION`, e não o
//! formato persistido das coleções: só leva o que o navegador consegue
//! executar.

use alcy_domain::{
    Authentication, BodyPayload, Collection, EnvironmentVariable, Folder, FormDataFieldValue,
    HttpMethod, ProtocolId, RawBodyLanguage, SavedRequest,
};
use serde::Serialize;

use crate::WebclientError;

/// Versão do contrato lido por `apps/desktop/src/webclient/data.ts`.
pub const SNAPSHOT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransportMode {
    /// Usa o servidor quando a página foi servida por ele; senão, envia direto.
    Auto,
    /// `fetch` do navegador, sujeito a CORS.
    Direct,
    /// `POST /__alcy/proxy` do `alcy-webclient-server`.
    Server,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebclientSnapshot {
    pub version: u32,
    /// Identifica este export; o runtime usa como chave do "Lembrar neste
    /// navegador", para exports diferentes não misturarem credenciais.
    pub export_id: String,
    pub title: String,
    pub transport: TransportMode,
    pub environment: Option<SnapshotEnvironment>,
    pub credentials: Vec<crate::Credential>,
    pub root: SnapshotFolder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEnvironment {
    pub name: String,
    pub variables: Vec<SnapshotVariable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotVariable {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFolder {
    pub id: String,
    pub name: String,
    pub variables: Vec<SnapshotVariable>,
    pub authentication: SnapshotAuthentication,
    pub folders: Vec<SnapshotFolder>,
    pub requests: Vec<SnapshotRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotProtocol {
    Graphql,
    Rest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    pub id: String,
    pub name: String,
    pub protocol: SnapshotProtocol,
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<SnapshotField>,
    pub authentication: SnapshotAuthentication,
    /// Query GraphQL, ou o texto do corpo REST (`none`/`raw`).
    pub body: String,
    pub body_payload: SnapshotBody,
    /// Variáveis GraphQL (JSON em texto).
    pub variables: String,
    pub route_parameters: Vec<SnapshotVariable>,
    pub unsupported: Vec<UnsupportedFeature>,
}

/// Header, campo urlencoded ou campo de texto de form-data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotField {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SnapshotBody {
    None,
    Raw {
        language: &'static str,
    },
    UrlEncoded {
        fields: Vec<SnapshotField>,
    },
    /// Campos de arquivo não vão: o caminho local não existe no navegador.
    FormData {
        fields: Vec<SnapshotField>,
    },
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SnapshotAuthentication {
    None,
    Inherit,
    CustomHeader {
        name: String,
        value: String,
    },
    Bearer {
        token: String,
    },
    Basic {
        username: String,
        password: String,
    },
    Digest {
        username: String,
        password: String,
    },
    #[serde(rename = "oauth2ClientCredentials")]
    OAuth2ClientCredentials {
        client_id: String,
        client_secret: String,
        token_url: String,
        scope: String,
    },
}

/// O que a requisição usa e o navegador não executa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnsupportedFeature {
    BinaryBody,
    FormDataFile,
    DigestAuthentication,
    /// gRPC needs HTTP/2 trailers, which browser `fetch` cannot read
    /// (spec 0129).
    Grpc,
}

/// Ambiente escolhido no export, com os valores que o app tem em memória.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportEnvironment {
    pub name: String,
    pub variables: Vec<EnvironmentVariable>,
}

/// Monta a árvore exportada a partir de `collection` ou, com `folder_id`,
/// da pasta indicada. Uma pasta leva consigo o que herda dos ancestrais: as
/// variáveis de escopo (a mais próxima vence, ADR 0031) e a autenticação
/// efetiva, já que os ancestrais não vão no export.
pub fn build_root(
    collection: &Collection,
    folder_id: Option<&str>,
) -> Result<SnapshotFolder, WebclientError> {
    let Some(folder_id) = folder_id else {
        let mut root = folder_node(
            &collection.id,
            collection.name(),
            collection.variables(),
            &collection.authentication,
            collection.folders(),
            collection.requests(),
        );
        if root.authentication == SnapshotAuthentication::Inherit {
            root.authentication = SnapshotAuthentication::None;
        }
        return Ok(root);
    };

    let mut chain = Vec::new();
    let folder = find_folder(collection.folders(), folder_id, &mut chain)
        .ok_or_else(|| WebclientError::FolderNotFound(folder_id.to_string()))?;

    let mut variables: Vec<SnapshotVariable> = Vec::new();
    let ancestor_variables = std::iter::once(collection.variables())
        .chain(chain.iter().map(|ancestor| ancestor.variables()))
        .chain(std::iter::once(folder.variables()));
    for scope in ancestor_variables {
        for variable in scope {
            upsert(&mut variables, to_variable(variable));
        }
    }

    let authentication = std::iter::once(&folder.authentication)
        .chain(chain.iter().rev().map(|ancestor| &ancestor.authentication))
        .chain(std::iter::once(&collection.authentication))
        .find(|authentication| **authentication != Authentication::Inherit)
        .map(to_authentication)
        .unwrap_or(SnapshotAuthentication::None);

    let mut root = folder_node(
        &folder.id,
        folder.name(),
        &[],
        &folder.authentication,
        folder.folders(),
        folder.requests(),
    );
    root.variables = variables;
    root.authentication = authentication;
    Ok(root)
}

/// `chain` termina com os ancestrais da pasta encontrada, da raiz ao pai.
fn find_folder<'a>(
    folders: &'a [Folder],
    id: &str,
    chain: &mut Vec<&'a Folder>,
) -> Option<&'a Folder> {
    for folder in folders {
        if folder.id == id {
            return Some(folder);
        }
        chain.push(folder);
        if let Some(found) = find_folder(folder.folders(), id, chain) {
            return Some(found);
        }
        chain.pop();
    }
    None
}

fn upsert(variables: &mut Vec<SnapshotVariable>, variable: SnapshotVariable) {
    match variables
        .iter_mut()
        .find(|existing| existing.name == variable.name)
    {
        Some(existing) => *existing = variable,
        None => variables.push(variable),
    }
}

fn folder_node(
    id: &str,
    name: &str,
    variables: &[EnvironmentVariable],
    authentication: &Authentication,
    folders: &[Folder],
    requests: &[SavedRequest],
) -> SnapshotFolder {
    SnapshotFolder {
        id: id.to_string(),
        name: name.to_string(),
        variables: variables.iter().map(to_variable).collect(),
        authentication: to_authentication(authentication),
        folders: folders
            .iter()
            .map(|folder| {
                folder_node(
                    &folder.id,
                    folder.name(),
                    folder.variables(),
                    &folder.authentication,
                    folder.folders(),
                    folder.requests(),
                )
            })
            .collect(),
        requests: requests.iter().map(to_request).collect(),
    }
}

pub(crate) fn to_variable(variable: &EnvironmentVariable) -> SnapshotVariable {
    SnapshotVariable {
        name: variable.name().to_string(),
        value: variable.value().to_string(),
    }
}

fn to_authentication(authentication: &Authentication) -> SnapshotAuthentication {
    match authentication.clone() {
        Authentication::None => SnapshotAuthentication::None,
        Authentication::Inherit => SnapshotAuthentication::Inherit,
        Authentication::CustomHeader { name, value } => {
            SnapshotAuthentication::CustomHeader { name, value }
        }
        Authentication::Bearer { token } => SnapshotAuthentication::Bearer { token },
        Authentication::Basic { username, password } => {
            SnapshotAuthentication::Basic { username, password }
        }
        Authentication::Digest { username, password } => {
            SnapshotAuthentication::Digest { username, password }
        }
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => SnapshotAuthentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        },
    }
}

fn method_name(method: HttpMethod) -> &'static str {
    match method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Put => "PUT",
        HttpMethod::Patch => "PATCH",
        HttpMethod::Delete => "DELETE",
        HttpMethod::Head => "HEAD",
        HttpMethod::Options => "OPTIONS",
    }
}

fn language_name(language: RawBodyLanguage) -> &'static str {
    match language {
        RawBodyLanguage::Text => "text",
        RawBodyLanguage::JavaScript => "javascript",
        RawBodyLanguage::Json => "json",
        RawBodyLanguage::Html => "html",
        RawBodyLanguage::Xml => "xml",
    }
}

/// Scripts ficam de fora: o webclient não executa código salvo na coleção.
fn to_request(saved: &SavedRequest) -> SnapshotRequest {
    let request = &saved.request;
    let mut unsupported = Vec::new();
    // A gRPC request is exported so the tree stays whole, but flagged: the
    // browser cannot send it.
    let protocol = match request.document.protocol {
        ProtocolId::GraphQl => SnapshotProtocol::Graphql,
        ProtocolId::Rest => SnapshotProtocol::Rest,
        ProtocolId::Grpc => {
            unsupported.push(UnsupportedFeature::Grpc);
            SnapshotProtocol::Rest
        }
    };
    let body_payload = match protocol {
        SnapshotProtocol::Graphql => SnapshotBody::None,
        SnapshotProtocol::Rest if request.document.protocol == ProtocolId::Grpc => {
            SnapshotBody::None
        }
        SnapshotProtocol::Rest => match &request.body_payload {
            BodyPayload::None => SnapshotBody::None,
            BodyPayload::Raw { language } => SnapshotBody::Raw {
                language: language_name(*language),
            },
            BodyPayload::UrlEncoded(fields) => SnapshotBody::UrlEncoded {
                fields: fields
                    .iter()
                    .map(|field| SnapshotField {
                        name: field.name.clone(),
                        value: field.value.clone(),
                        enabled: field.enabled,
                    })
                    .collect(),
            },
            BodyPayload::FormData(fields) => SnapshotBody::FormData {
                fields: fields
                    .iter()
                    .filter_map(|field| match &field.value {
                        FormDataFieldValue::Text(value) => Some(SnapshotField {
                            name: field.name.clone(),
                            value: value.clone(),
                            enabled: field.enabled,
                        }),
                        FormDataFieldValue::File { .. } => {
                            if !unsupported.contains(&UnsupportedFeature::FormDataFile) {
                                unsupported.push(UnsupportedFeature::FormDataFile);
                            }
                            None
                        }
                    })
                    .collect(),
            },
            BodyPayload::Binary { .. } => {
                unsupported.push(UnsupportedFeature::BinaryBody);
                SnapshotBody::Binary
            }
        },
    };

    SnapshotRequest {
        id: saved.id.clone(),
        name: saved.name().to_string(),
        protocol,
        method: match protocol {
            SnapshotProtocol::Graphql => "POST",
            SnapshotProtocol::Rest => method_name(request.method),
        },
        url: request.endpoint.url().to_string(),
        headers: request
            .headers
            .iter()
            .map(|header| SnapshotField {
                name: header.name().to_string(),
                value: header.value().to_string(),
                enabled: header.enabled,
            })
            .collect(),
        authentication: to_authentication(&request.authentication),
        body: request.document.body.clone(),
        body_payload,
        variables: match protocol {
            SnapshotProtocol::Graphql => request.variables.clone(),
            SnapshotProtocol::Rest => String::new(),
        },
        route_parameters: request
            .route_parameters
            .iter()
            .map(|parameter| SnapshotVariable {
                name: parameter.name.clone(),
                value: parameter.value.clone(),
            })
            .collect(),
        unsupported,
    }
}

/// Marca Digest nas requisições cuja autenticação efetiva é Digest, própria
/// ou herdada dentro do recorte (a raiz já traz a herança dos ancestrais).
pub fn mark_unsupported_authentication(root: &mut SnapshotFolder) {
    fn walk(folder: &mut SnapshotFolder, inherited: &SnapshotAuthentication) {
        let effective = match &folder.authentication {
            SnapshotAuthentication::Inherit => inherited.clone(),
            own => own.clone(),
        };
        for request in &mut folder.requests {
            let request_effective = match &request.authentication {
                SnapshotAuthentication::Inherit => &effective,
                own => own,
            };
            if matches!(request_effective, SnapshotAuthentication::Digest { .. }) {
                request
                    .unsupported
                    .push(UnsupportedFeature::DigestAuthentication);
            }
        }
        for child in &mut folder.folders {
            walk(child, &effective);
        }
    }
    let inherited = SnapshotAuthentication::None;
    walk(root, &inherited);
}

/// Visita as requisições da árvore com a pasta dona e a cadeia de
/// variáveis de escopo (raiz → pasta dona).
pub(crate) fn for_each_request<'a>(
    root: &'a SnapshotFolder,
    visit: &mut impl FnMut(&'a SnapshotRequest, &[&'a SnapshotFolder]),
) {
    fn walk<'a>(
        folder: &'a SnapshotFolder,
        chain: &mut Vec<&'a SnapshotFolder>,
        visit: &mut impl FnMut(&'a SnapshotRequest, &[&'a SnapshotFolder]),
    ) {
        chain.push(folder);
        for request in &folder.requests {
            visit(request, chain);
        }
        for child in &folder.folders {
            walk(child, chain, visit);
        }
        chain.pop();
    }
    let mut chain = Vec::new();
    walk(root, &mut chain, visit);
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Endpoint, Request, RequestDocument};

    fn var(name: &str, value: &str) -> EnvironmentVariable {
        EnvironmentVariable::new(name, value, false).unwrap()
    }

    fn rest(id: &str, name: &str) -> SavedRequest {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::Inherit,
        )
        .with_method(HttpMethod::Get);
        SavedRequest::new(id, name, request).unwrap()
    }

    fn tree() -> Collection {
        let inner = Folder::new("inner", "Inner", vec![], vec![rest("r2", "Two")])
            .unwrap()
            .with_variables(vec![var("level", "inner")])
            .unwrap();
        let outer = Folder::new("outer", "Outer", vec![inner], vec![rest("r1", "One")])
            .unwrap()
            .with_authentication(Authentication::Bearer {
                token: "outer-token".into(),
            })
            .with_variables(vec![var("level", "outer"), var("only_outer", "x")])
            .unwrap();
        Collection::new("c", "Collection", vec![outer], vec![])
            .unwrap()
            .with_authentication(Authentication::Basic {
                username: "u".into(),
                password: "p".into(),
            })
            .with_variables(vec![
                var("baseUrl", "https://api.test"),
                var("level", "root"),
            ])
            .unwrap()
    }

    #[test]
    fn exports_the_whole_collection_as_root() {
        let root = build_root(&tree(), None).unwrap();

        assert_eq!(root.id, "c");
        assert_eq!(root.folders[0].id, "outer");
        assert_eq!(root.folders[0].folders[0].requests[0].id, "r2");
        assert_eq!(root.variables.len(), 2);
    }

    #[test]
    fn a_folder_carries_inherited_variables_and_authentication() {
        let root = build_root(&tree(), Some("inner")).unwrap();

        assert_eq!(root.id, "inner");
        let value = |name: &str| {
            root.variables
                .iter()
                .find(|variable| variable.name == name)
                .map(|variable| variable.value.clone())
        };
        assert_eq!(value("level").as_deref(), Some("inner"));
        assert_eq!(value("only_outer").as_deref(), Some("x"));
        assert_eq!(value("baseUrl").as_deref(), Some("https://api.test"));
        assert_eq!(
            root.authentication,
            SnapshotAuthentication::Bearer {
                token: "outer-token".into()
            }
        );
    }

    #[test]
    fn unknown_folder_is_an_error() {
        assert_eq!(
            build_root(&tree(), Some("missing")),
            Err(WebclientError::FolderNotFound("missing".into()))
        );
    }

    #[test]
    fn file_bodies_and_digest_are_marked_unsupported() {
        let binary = SavedRequest::new(
            "bin",
            "Binary",
            Request::new(
                Endpoint::new("https://api.test/upload").unwrap(),
                RequestDocument::new(ProtocolId::Rest, ""),
                "",
                vec![],
                Authentication::Digest {
                    username: "u".into(),
                    password: "p".into(),
                },
            )
            .with_body_payload(BodyPayload::Binary {
                file_path: "/tmp/file.bin".into(),
            }),
        )
        .unwrap();
        let collection = Collection::new("c", "C", vec![], vec![binary]).unwrap();

        let mut root = build_root(&collection, None).unwrap();
        mark_unsupported_authentication(&mut root);

        assert_eq!(root.requests[0].body_payload, SnapshotBody::Binary);
        assert_eq!(
            root.requests[0].unsupported,
            vec![
                UnsupportedFeature::BinaryBody,
                UnsupportedFeature::DigestAuthentication
            ]
        );
    }

    #[test]
    fn exports_a_grpc_request_flagged_as_unsupported() {
        let grpc = SavedRequest::new(
            "g1",
            "Say hello",
            Request::new(
                Endpoint::new("localhost:50051").unwrap(),
                RequestDocument::new(ProtocolId::Grpc, r#"{"name": "ana"}"#),
                "",
                vec![],
                Authentication::None,
            ),
        )
        .unwrap();
        let collection = Collection::new("c", "C", vec![], vec![grpc]).unwrap();

        let root = build_root(&collection, None).unwrap();

        assert_eq!(root.requests[0].unsupported, vec![UnsupportedFeature::Grpc]);
        assert_eq!(root.requests[0].body_payload, SnapshotBody::None);
    }
}
