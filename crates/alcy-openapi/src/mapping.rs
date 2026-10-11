//! Documento OpenAPI (`document.rs`) → árvore de domínio
//! (`Collection`/`Folder`/`SavedRequest`, `alcy-domain`).

use std::collections::{HashMap, HashSet};

use alcy_domain::{
    Authentication, Collection, DocsRef, Endpoint, Folder, HeaderEntry, HttpMethod, ProtocolId,
    Request, RequestDocument, SavedRequest,
};
use serde_json::Value;

use crate::docs::DocsBuilder;
use crate::document::{
    Components, OpenApiDocument, Operation, Parameter, ParameterOrRef, RequestBody,
    SecurityRequirement, resolve_parameter, resolve_request_body,
};
use crate::{OpenApiError, OpenApiImport};

const FALLBACK_TITLE: &str = "Imported API";

struct IdGenerator {
    next: u64,
}

impl IdGenerator {
    fn new() -> Self {
        Self { next: 1 }
    }

    fn next(&mut self, prefix: &str) -> String {
        let id = format!("openapi-{prefix}-{}", self.next);
        self.next += 1;
        id
    }
}

/// Um ramo da árvore derivada dos segmentos de `paths`, com seu próprio
/// conjunto de nomes de requisição para deduplicação.
struct PathBucket {
    name: Option<String>,
    folders: Vec<PathBucket>,
    requests: Vec<SavedRequest>,
    used_names: HashSet<String>,
}

impl PathBucket {
    fn root() -> Self {
        Self {
            name: None,
            folders: Vec::new(),
            requests: Vec::new(),
            used_names: HashSet::new(),
        }
    }

    fn at_path<'a>(&'a mut self, segments: &[&str]) -> &'a mut Self {
        let Some((segment, remaining)) = segments.split_first() else {
            return self;
        };
        let index = self
            .folders
            .iter()
            .position(|folder| folder.name.as_deref() == Some(*segment))
            .unwrap_or_else(|| {
                self.folders.push(Self {
                    name: Some((*segment).to_string()),
                    folders: Vec::new(),
                    requests: Vec::new(),
                    used_names: HashSet::new(),
                });
                self.folders.len() - 1
            });
        self.folders[index].at_path(remaining)
    }

    fn into_folder(self, ids: &mut IdGenerator) -> Result<Folder, OpenApiError> {
        let folders = self
            .folders
            .into_iter()
            .map(|folder| folder.into_folder(ids))
            .collect::<Result<Vec<_>, _>>()?;
        Folder::new(
            ids.next("folder"),
            self.name.unwrap_or_default(),
            folders,
            self.requests,
        )
        .map_err(OpenApiError::from)
    }
}

/// Dados do documento constantes para toda operação (mesmos `components` e
/// prefixo de URL base) — agrupados para não estourar o limite de
/// argumentos de `build_saved_request`.
struct DocumentContext<'a> {
    components: &'a Components,
    base_url: &'a str,
    default_security: &'a [SecurityRequirement],
}

pub(crate) fn map_document(document: OpenApiDocument) -> Result<OpenApiImport, OpenApiError> {
    let mut ids = IdGenerator::new();
    let mut docs = DocsBuilder::new(&document.components);
    let mut root = PathBucket::root();
    let base_url = base_url_prefix(&document);
    let context = DocumentContext {
        components: &document.components,
        base_url: &base_url,
        default_security: &document.security,
    };

    for (path, path_item) in &document.paths {
        let path_params =
            merge_parameters(&document.components, &path_item.parameters, &HashMap::new());

        for (method_name, operation) in path_item.operations() {
            let Some(method) = http_method_for(method_name) else {
                continue;
            };

            let parameters =
                merge_parameters(&document.components, &operation.parameters, &path_params);
            let candidate_name = request_name(method_name, path, operation);

            let segments = path
                .split('/')
                .map(str::trim)
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>();
            let bucket = root.at_path(&segments);

            let name = dedupe_name(&mut bucket.used_names, candidate_name);
            let docs_key = docs.add_operation(method_name, path, operation, &parameters);
            let mut saved_request = build_saved_request(
                &context,
                &mut ids,
                path,
                method,
                &name,
                operation,
                &parameters,
            )?;
            if let Some(operation_id) = docs_key {
                // `source_id` só existe depois que a fonte é gravada no
                // workspace — quem persiste preenche.
                saved_request = saved_request.with_docs_ref(DocsRef {
                    source_id: String::new(),
                    operation_id,
                });
            }
            bucket.requests.push(saved_request);
        }
    }

    let folders = root
        .folders
        .into_iter()
        .map(|folder| folder.into_folder(&mut ids))
        .collect::<Result<Vec<_>, _>>()?;

    let title = document.info.title.trim();
    let name = if title.is_empty() {
        FALLBACK_TITLE
    } else {
        title
    };

    let collection = Collection::new(ids.next("collection"), name, folders, root.requests)?;

    Ok(OpenApiImport {
        collections: vec![collection],
        docs: docs.finish(name),
    })
}

fn http_method_for(method_name: &str) -> Option<HttpMethod> {
    match method_name {
        "get" => Some(HttpMethod::Get),
        "put" => Some(HttpMethod::Put),
        "post" => Some(HttpMethod::Post),
        "delete" => Some(HttpMethod::Delete),
        "patch" => Some(HttpMethod::Patch),
        "head" => Some(HttpMethod::Head),
        "options" => Some(HttpMethod::Options),
        _ => None,
    }
}

fn request_name(method_name: &str, path: &str, operation: &Operation) -> String {
    if let Some(summary) = non_empty(operation.summary.as_deref()) {
        return summary.to_string();
    }
    if let Some(operation_id) = non_empty(operation.operation_id.as_deref()) {
        return operation_id.to_string();
    }
    format!("{} {path}", method_name.to_uppercase())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn dedupe_name(used: &mut HashSet<String>, candidate: String) -> String {
    if used.insert(candidate.clone()) {
        return candidate;
    }
    let mut attempt_index = 2;
    loop {
        let attempt = format!("{candidate} ({attempt_index})");
        if used.insert(attempt.clone()) {
            return attempt;
        }
        attempt_index += 1;
    }
}

fn merge_parameters(
    components: &Components,
    items: &[ParameterOrRef],
    base: &HashMap<(String, String), Parameter>,
) -> HashMap<(String, String), Parameter> {
    let mut merged = base.clone();
    for item in items {
        if let Some(parameter) = resolve_parameter(components, item) {
            merged.insert(parameter.merge_key(), parameter.clone());
        }
    }
    merged
}

fn parameter_value(parameter: &Parameter) -> String {
    match parameter.example_value() {
        Some(Value::String(value)) => value.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// Reescreve `{id}` (template de path ou de server URL do OpenAPI, ex.
/// `{hostname}`) para `{{id}}` (sintaxe de interpolação de variável já usada
/// em todo o app, ex. `{{baseUrl}}`). Chaves só aparecem em paths/server
/// URLs do OpenAPI como delimitador de variável, então um replace ingênuo é
/// suficiente.
fn rewrite_template_params(value: &str) -> String {
    value.replace('{', "{{").replace('}', "}}")
}

/// Prefixo de URL de toda requisição gerada: usa `servers[0].url` do
/// documento quando presente e não-vazio (variáveis de server, ex.
/// `{hostname}`, viram `{{hostname}}` — mesma sintaxe de interpolação já
/// usada em todo o app), senão cai para `{{baseUrl}}` (mesma convenção do
/// resto do app, ex. `{{baseUrl}}/graphql`). Nunca combina os dois: um
/// documento com `servers` não herda também `{{baseUrl}}`, para não colidir
/// com uma variável de ambiente já usada por outra API/coleção.
fn base_url_prefix(document: &OpenApiDocument) -> String {
    let server_url = document
        .servers
        .first()
        .map(|server| server.url.trim())
        .filter(|url| !url.is_empty());

    match server_url {
        Some(url) => rewrite_template_params(url),
        None => "{{baseUrl}}".to_string(),
    }
}

fn pick_media_type(body: &RequestBody) -> Option<(String, String)> {
    if body.content.is_empty() {
        return None;
    }

    let (media_type, media) = match body.content.get("application/json") {
        Some(media) => ("application/json".to_string(), media),
        None => {
            let (media_type, media) = body.content.iter().next().expect("checked non-empty above");
            (media_type.clone(), media)
        }
    };

    let body_text = media
        .example_value()
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_default())
        .unwrap_or_default();

    Some((media_type, body_text))
}

fn build_saved_request(
    context: &DocumentContext,
    ids: &mut IdGenerator,
    path: &str,
    method: HttpMethod,
    name: &str,
    operation: &Operation,
    parameters: &HashMap<(String, String), Parameter>,
) -> Result<SavedRequest, OpenApiError> {
    let mut headers = Vec::new();
    let mut query_pairs = Vec::new();

    let mut sorted_params: Vec<&Parameter> = parameters.values().collect();
    sorted_params.sort_by(|a, b| a.name.cmp(&b.name));

    for parameter in sorted_params {
        match parameter.location.as_str() {
            "header" => {
                let value = parameter_value(parameter);
                headers.push(HeaderEntry::new(parameter.name.clone(), value, true)?);
            }
            "query" if parameter.required => {
                query_pairs.push(format!("{}={}", parameter.name, parameter_value(parameter)));
            }
            // `path` já foi resolvido diretamente na URL (`rewrite_template_params`);
            // `cookie` e `query` opcional ficam fora do escopo desta fatia.
            _ => {}
        }
    }

    let mut body_text = String::new();
    if let Some(request_body) = &operation.request_body
        && let Some(resolved) = resolve_request_body(context.components, request_body)
        && let Some((media_type, body)) = pick_media_type(resolved)
    {
        headers.push(HeaderEntry::new("Content-Type", media_type, true)?);
        body_text = body;
    }

    let mut url = format!("{}{}", context.base_url, rewrite_template_params(path));
    if !query_pairs.is_empty() {
        url.push('?');
        url.push_str(&query_pairs.join("&"));
    }

    let requirements = operation
        .security
        .as_deref()
        .unwrap_or(context.default_security);
    let authentication = match resolve_security(context.components, requirements) {
        SecurityMapping::Authentication(authentication) => authentication,
        SecurityMapping::ApiKeyHeader(header_name) if !header_name.is_empty() => {
            headers.push(HeaderEntry::new(header_name, "", true)?);
            Authentication::None
        }
        SecurityMapping::ApiKeyHeader(_) | SecurityMapping::None => Authentication::None,
    };

    let endpoint = Endpoint::new(url)?;
    let document = RequestDocument::new(ProtocolId::Rest, body_text);
    let request = Request::new(endpoint, document, "", headers, authentication).with_method(method);

    SavedRequest::new(ids.next("request"), name, request).map_err(OpenApiError::from)
}

/// Resultado de resolver um security scheme: ou mapeia direto para um
/// `Authentication`, ou (caso `apiKey` em header) vira um header comum —
/// não há um método de autenticação dedicado para "só um header fixo",
/// já que a grid de Headers já cobre esse caso.
enum SecurityMapping {
    Authentication(Authentication),
    ApiKeyHeader(String),
    None,
}

/// Mapeia o primeiro security scheme do primeiro requirement. Combinar
/// múltiplos schemes simultâneos (`AND` dentro de um requirement), `apiKey`
/// em `query`/`cookie`, `openIdConnect` e fluxos OAuth2 além de
/// `clientCredentials` ficam fora do escopo — viram `SecurityMapping::None`.
/// Placeholders vazios para credenciais: o documento OpenAPI não carrega
/// segredos.
fn resolve_security(
    components: &Components,
    requirements: &[SecurityRequirement],
) -> SecurityMapping {
    let Some(requirement) = requirements.first() else {
        return SecurityMapping::None;
    };
    let Some((scheme_name, _scopes)) = requirement.iter().next() else {
        return SecurityMapping::None;
    };
    let Some(scheme) = components.security_schemes.get(scheme_name) else {
        return SecurityMapping::None;
    };

    match scheme.scheme_type.as_str() {
        "http" => match scheme.scheme.as_deref() {
            Some("bearer") => SecurityMapping::Authentication(Authentication::Bearer {
                token: String::new(),
            }),
            Some("basic") => SecurityMapping::Authentication(Authentication::Basic {
                username: String::new(),
                password: String::new(),
            }),
            Some("digest") => SecurityMapping::Authentication(Authentication::Digest {
                username: String::new(),
                password: String::new(),
            }),
            _ => SecurityMapping::None,
        },
        "apiKey" if scheme.location.as_deref() == Some("header") => {
            SecurityMapping::ApiKeyHeader(scheme.name.clone().unwrap_or_default())
        }
        "oauth2" => match scheme
            .flows
            .as_ref()
            .and_then(|flows| flows.client_credentials.as_ref())
        {
            Some(flow) => {
                SecurityMapping::Authentication(Authentication::OAuth2ClientCredentials {
                    client_id: String::new(),
                    client_secret: String::new(),
                    token_url: flow.token_url.clone(),
                    scope: String::new(),
                })
            }
            None => SecurityMapping::None,
        },
        _ => SecurityMapping::None,
    }
}
