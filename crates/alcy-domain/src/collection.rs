use std::collections::HashSet;

use thiserror::Error;

use crate::api_docs::DocsRef;
use crate::authentication::Authentication;
use crate::body_payload::RawBodyLanguage;
use crate::environment::EnvironmentVariable;
use crate::request::Request;

/// Uma requisição salva dentro de uma coleção ou pasta. Guarda a
/// identidade e a requisição completa (endpoint, documento, variables,
/// headers e autenticação, spec 0002) que será carregada de volta no
/// editor ao abrir esta requisição.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedRequest {
    pub id: String,
    name: String,
    pub request: Request,
    /// Documentação importada desta chamada (ADR 0035), quando houver.
    pub docs_ref: Option<DocsRef>,
    /// Named calls saved under this request (spec 0156).
    examples: Vec<RequestExample>,
}

/// A response header stored in an example. Examples only document a call, so
/// unlike `HeaderEntry` it accepts any text, including a row still being typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExampleResponseHeader {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

/// The response an example documents, written by hand or saved from a send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExampleResponse {
    pub status_code: u16,
    pub headers: Vec<ExampleResponseHeader>,
    pub body: String,
    pub language: RawBodyLanguage,
}

/// A named call of a saved request: its own copy of the request (with the
/// example's id and name) and the response it documents (spec 0156).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestExample {
    pub request: SavedRequest,
    pub response: ExampleResponse,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SavedRequestError {
    #[error("nome da requisição não pode ser vazio")]
    EmptyName,
}

impl SavedRequest {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        request: Request,
    ) -> Result<Self, SavedRequestError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(SavedRequestError::EmptyName);
        }

        Ok(Self {
            id: id.into(),
            name,
            request,
            docs_ref: None,
            examples: Vec::new(),
        })
    }

    pub fn with_docs_ref(mut self, docs_ref: DocsRef) -> Self {
        self.docs_ref = Some(docs_ref);
        self
    }

    pub fn with_examples(mut self, examples: Vec<RequestExample>) -> Self {
        self.examples = examples;
        self
    }

    pub fn examples(&self) -> &[RequestExample] {
        &self.examples
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

/// Uma pasta dentro de uma coleção (ou de outra pasta), usada para
/// organizar requisições. Pode conter subpastas e requisições salvas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    name: String,
    folders: Vec<Folder>,
    requests: Vec<SavedRequest>,
    /// Autenticação herdada pelas requisições descendentes que usam
    /// `Authentication::Inherit`.
    pub authentication: Authentication,
    /// Variáveis de escopo local, herdadas pelas requisições descendentes
    /// (ADR 0031).
    variables: Vec<EnvironmentVariable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FolderError {
    #[error("nome da pasta não pode ser vazio")]
    EmptyName,
    #[error("pasta '{0}' duplicada no mesmo nível")]
    DuplicateFolderName(String),
    #[error("variável '{0}' duplicada na pasta")]
    DuplicateVariable(String),
}

impl Folder {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        folders: Vec<Folder>,
        requests: Vec<SavedRequest>,
    ) -> Result<Self, FolderError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(FolderError::EmptyName);
        }
        reject_duplicate_folder_names(&folders).map_err(FolderError::DuplicateFolderName)?;

        Ok(Self {
            id: id.into(),
            name,
            folders,
            requests,
            authentication: Authentication::Inherit,
            variables: Vec::new(),
        })
    }

    pub fn with_authentication(mut self, authentication: Authentication) -> Self {
        self.authentication = authentication;
        self
    }

    /// Define as variáveis da pasta. Variáveis locais nunca são sensíveis
    /// (ADR 0031), então a flag é descartada.
    pub fn with_variables(
        mut self,
        variables: Vec<EnvironmentVariable>,
    ) -> Result<Self, FolderError> {
        self.variables = local_variables(variables).map_err(FolderError::DuplicateVariable)?;
        Ok(self)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn folders(&self) -> &[Folder] {
        &self.folders
    }

    pub fn requests(&self) -> &[SavedRequest] {
        &self.requests
    }

    pub fn variables(&self) -> &[EnvironmentVariable] {
        &self.variables
    }
}

/// Cor de identificação de um rótulo, escolhida numa paleta fixa para
/// continuar legível nos temas claro e escuro (ADR 0060).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LabelColor {
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
    Pink,
}

impl LabelColor {
    pub const ALL: [LabelColor; 9] = [
        LabelColor::Gray,
        LabelColor::Red,
        LabelColor::Orange,
        LabelColor::Yellow,
        LabelColor::Green,
        LabelColor::Teal,
        LabelColor::Blue,
        LabelColor::Purple,
        LabelColor::Pink,
    ];

    /// Chave estável usada no arquivo persistido e no IPC.
    pub fn as_key(self) -> &'static str {
        match self {
            LabelColor::Gray => "gray",
            LabelColor::Red => "red",
            LabelColor::Orange => "orange",
            LabelColor::Yellow => "yellow",
            LabelColor::Green => "green",
            LabelColor::Teal => "teal",
            LabelColor::Blue => "blue",
            LabelColor::Purple => "purple",
            LabelColor::Pink => "pink",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|color| color.as_key() == key)
    }
}

/// Rótulo atribuído a uma coleção para agrupá-la e filtrá-la (ADR 0060).
/// O catálogo do workspace é a união dos rótulos das coleções.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionLabel {
    name: String,
    pub color: LabelColor,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CollectionLabelError {
    #[error("nome do rótulo não pode ser vazio")]
    EmptyName,
}

impl CollectionLabel {
    pub fn new(name: impl Into<String>, color: LabelColor) -> Result<Self, CollectionLabelError> {
        let name = name.into().trim().to_string();
        if name.is_empty() {
            return Err(CollectionLabelError::EmptyName);
        }
        Ok(Self { name, color })
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

/// Uma coleção: a raiz endereçável que o usuário cria dentro de um
/// workspace para organizar requisições em pastas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    pub id: String,
    name: String,
    folders: Vec<Folder>,
    requests: Vec<SavedRequest>,
    /// Autenticação herdada pelas requisições descendentes que usam
    /// `Authentication::Inherit`.
    pub authentication: Authentication,
    /// Variáveis de escopo local, herdadas pelas requisições descendentes
    /// (ADR 0031).
    variables: Vec<EnvironmentVariable>,
    /// Rótulos da coleção, sem nomes repetidos (ADR 0060).
    labels: Vec<CollectionLabel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CollectionError {
    #[error("nome da coleção não pode ser vazio")]
    EmptyName,
    #[error("pasta '{0}' duplicada no mesmo nível")]
    DuplicateFolderName(String),
    #[error("variável '{0}' duplicada na coleção")]
    DuplicateVariable(String),
    #[error("rótulo '{0}' duplicado na coleção")]
    DuplicateLabel(String),
}

impl Collection {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        folders: Vec<Folder>,
        requests: Vec<SavedRequest>,
    ) -> Result<Self, CollectionError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(CollectionError::EmptyName);
        }
        reject_duplicate_folder_names(&folders).map_err(CollectionError::DuplicateFolderName)?;

        Ok(Self {
            id: id.into(),
            name,
            folders,
            requests,
            authentication: Authentication::Inherit,
            variables: Vec::new(),
            labels: Vec::new(),
        })
    }

    pub fn with_authentication(mut self, authentication: Authentication) -> Self {
        self.authentication = authentication;
        self
    }

    /// Define as variáveis da coleção. Variáveis locais nunca são sensíveis
    /// (ADR 0031), então a flag é descartada.
    pub fn with_variables(
        mut self,
        variables: Vec<EnvironmentVariable>,
    ) -> Result<Self, CollectionError> {
        self.variables = local_variables(variables).map_err(CollectionError::DuplicateVariable)?;
        Ok(self)
    }

    /// Define os rótulos da coleção. Nomes são comparados sem diferenciar
    /// maiúsculas de minúsculas, como no filtro da interface.
    pub fn with_labels(mut self, labels: Vec<CollectionLabel>) -> Result<Self, CollectionError> {
        let mut seen = HashSet::new();
        for label in &labels {
            if !seen.insert(label.name().to_lowercase()) {
                return Err(CollectionError::DuplicateLabel(label.name().to_string()));
            }
        }
        self.labels = labels;
        Ok(self)
    }

    pub fn labels(&self) -> &[CollectionLabel] {
        &self.labels
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn folders(&self) -> &[Folder] {
        &self.folders
    }

    pub fn requests(&self) -> &[SavedRequest] {
        &self.requests
    }

    pub fn variables(&self) -> &[EnvironmentVariable] {
        &self.variables
    }
}

/// Busca recursiva por uma requisição salva em toda a floresta de coleções,
/// por id — espelha `findRequest` do frontend
/// (`apps/desktop/src/features/request-workbench/collection-tree.ts`), que
/// também não precisa do id da coleção porque o id de uma requisição já é
/// único em todo o workspace. Usada pelo motor de execução de flows para
/// resolver um node `FlowNodeKind::Request` ao vivo (spec 0043).
pub fn find_saved_request<'a>(collections: &'a [Collection], id: &str) -> Option<&'a SavedRequest> {
    collections.iter().find_map(|collection| {
        find_in_requests_and_folders(&collection.requests, &collection.folders, id)
    })
}

/// Autenticação efetiva de uma requisição salva: a da própria requisição
/// se não for `Inherit`; senão a da pasta/coleção ancestral mais próxima
/// que não seja `Inherit`; sem nenhuma, `None`. Id desconhecido também
/// resulta em `None`.
pub fn effective_authentication(collections: &[Collection], request_id: &str) -> Authentication {
    collections
        .iter()
        .find_map(|collection| {
            let mut chain = vec![&collection.authentication];
            resolve_in(
                &collection.requests,
                &collection.folders,
                request_id,
                &mut chain,
            )
        })
        .unwrap_or(Authentication::None)
}

/// `chain` guarda as autenticações dos ancestrais, da raiz ao pai direto.
fn resolve_in<'a>(
    requests: &'a [SavedRequest],
    folders: &'a [Folder],
    id: &str,
    chain: &mut Vec<&'a Authentication>,
) -> Option<Authentication> {
    if let Some(saved) = requests.iter().find(|request| request.id == id) {
        let own = &saved.request.authentication;
        let resolved = std::iter::once(own)
            .chain(chain.iter().rev().copied())
            .find(|auth| **auth != Authentication::Inherit)
            .cloned()
            .unwrap_or(Authentication::None);
        return Some(resolved);
    }
    for folder in folders {
        chain.push(&folder.authentication);
        let found = resolve_in(&folder.requests, &folder.folders, id, chain);
        chain.pop();
        if found.is_some() {
            return found;
        }
    }
    None
}

fn find_in_requests_and_folders<'a>(
    requests: &'a [SavedRequest],
    folders: &'a [Folder],
    id: &str,
) -> Option<&'a SavedRequest> {
    if let Some(request) = requests.iter().find(|request| request.id == id) {
        return Some(request);
    }
    folders
        .iter()
        .find_map(|folder| find_in_requests_and_folders(&folder.requests, &folder.folders, id))
}

/// Valida nomes únicos e zera `sensitive` — o escopo local não guarda
/// segredos (ADR 0031). Devolve o nome duplicado como erro.
fn local_variables(
    variables: Vec<EnvironmentVariable>,
) -> Result<Vec<EnvironmentVariable>, String> {
    let mut seen = HashSet::new();
    for variable in &variables {
        if !seen.insert(variable.name()) {
            return Err(variable.name().to_string());
        }
    }
    Ok(variables
        .into_iter()
        .map(|mut variable| {
            variable.sensitive = false;
            variable
        })
        .collect())
}

fn reject_duplicate_folder_names(folders: &[Folder]) -> Result<(), String> {
    let mut seen = HashSet::new();
    for folder in folders {
        if !seen.insert(folder.name()) {
            return Err(folder.name().to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Authentication, Endpoint, HeaderEntry, ProtocolId, RequestDocument};

    fn sample_request() -> Request {
        Request::new(
            Endpoint::new("{{baseUrl}}/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![HeaderEntry::new("Accept", "application/json", true).unwrap()],
            Authentication::None,
        )
    }

    #[test]
    fn accepts_a_valid_folder_without_subfolders_or_requests() {
        let folder = Folder::new("folder-1", "Authentication", vec![], vec![]).unwrap();

        assert_eq!(folder.id, "folder-1");
        assert_eq!(folder.name(), "Authentication");
        assert!(folder.folders().is_empty());
        assert!(folder.requests().is_empty());
    }

    #[test]
    fn accepts_nested_folders_several_levels_deep() {
        let leaf = Folder::new("folder-3", "Refresh token", vec![], vec![]).unwrap();
        let middle = Folder::new("folder-2", "Authentication", vec![leaf.clone()], vec![]).unwrap();
        let root = Folder::new("folder-1", "Customer API", vec![middle.clone()], vec![]).unwrap();

        assert_eq!(root.folders(), std::slice::from_ref(&middle));
        assert_eq!(root.folders()[0].folders(), [leaf]);
    }

    #[test]
    fn rejects_an_empty_folder_name() {
        assert_eq!(
            Folder::new("folder-1", "", vec![], vec![]),
            Err(FolderError::EmptyName)
        );
        assert_eq!(
            Folder::new("folder-1", "   ", vec![], vec![]),
            Err(FolderError::EmptyName)
        );
    }

    #[test]
    fn rejects_duplicate_subfolder_names_at_the_same_level() {
        let subfolders = vec![
            Folder::new("folder-2", "Customers", vec![], vec![]).unwrap(),
            Folder::new("folder-3", "Customers", vec![], vec![]).unwrap(),
        ];

        assert_eq!(
            Folder::new("folder-1", "Customer API", subfolders, vec![]),
            Err(FolderError::DuplicateFolderName("Customers".to_string()))
        );
    }

    #[test]
    fn allows_the_same_folder_name_at_different_levels() {
        let inner = Folder::new("folder-2", "Orders", vec![], vec![]).unwrap();
        let outer = Folder::new("folder-1", "Orders", vec![inner], vec![]).unwrap();

        assert_eq!(outer.name(), "Orders");
        assert_eq!(outer.folders()[0].name(), "Orders");
    }

    #[test]
    fn accepts_a_folder_with_requests() {
        let requests =
            vec![SavedRequest::new("request-1", "List orders", sample_request()).unwrap()];

        let folder = Folder::new("folder-1", "Orders", vec![], requests.clone()).unwrap();

        assert_eq!(folder.requests(), requests.as_slice());
    }

    #[test]
    fn allows_duplicate_request_names_in_a_folder() {
        let requests = vec![
            SavedRequest::new("request-1", "List orders", sample_request()).unwrap(),
            SavedRequest::new("request-2", "List orders", sample_request()).unwrap(),
        ];

        let folder = Folder::new("folder-1", "Orders", vec![], requests).unwrap();

        assert_eq!(folder.requests()[0].name(), "List orders");
        assert_eq!(folder.requests()[1].name(), "List orders");
    }

    #[test]
    fn allows_a_folder_and_a_request_to_share_a_name() {
        let requests = vec![SavedRequest::new("request-1", "Orders", sample_request()).unwrap()];
        let folders = vec![Folder::new("folder-2", "Orders", vec![], vec![]).unwrap()];

        let folder = Folder::new("folder-1", "Root", folders, requests).unwrap();

        assert_eq!(folder.folders()[0].name(), "Orders");
        assert_eq!(folder.requests()[0].name(), "Orders");
    }

    #[test]
    fn accepts_a_valid_collection() {
        let folders = vec![Folder::new("folder-1", "Authentication", vec![], vec![]).unwrap()];

        let collection =
            Collection::new("collection-1", "Customer API", folders.clone(), vec![]).unwrap();

        assert_eq!(collection.id, "collection-1");
        assert_eq!(collection.name(), "Customer API");
        assert_eq!(collection.folders(), folders.as_slice());
        assert!(collection.requests().is_empty());
    }

    #[test]
    fn rejects_an_empty_collection_name() {
        assert_eq!(
            Collection::new("collection-1", "", vec![], vec![]),
            Err(CollectionError::EmptyName)
        );
    }

    #[test]
    fn rejects_duplicate_folder_names_in_a_collection() {
        let folders = vec![
            Folder::new("folder-1", "Orders", vec![], vec![]).unwrap(),
            Folder::new("folder-2", "Orders", vec![], vec![]).unwrap(),
        ];

        assert_eq!(
            Collection::new("collection-1", "Customer API", folders, vec![]),
            Err(CollectionError::DuplicateFolderName("Orders".to_string()))
        );
    }

    #[test]
    fn allows_duplicate_request_names_in_a_collection() {
        let requests = vec![
            SavedRequest::new("request-1", "Ping", sample_request()).unwrap(),
            SavedRequest::new("request-2", "Ping", sample_request()).unwrap(),
        ];

        let collection = Collection::new("collection-1", "Customer API", vec![], requests).unwrap();

        assert_eq!(collection.requests().len(), 2);
    }

    #[test]
    fn rejects_an_empty_request_name() {
        assert_eq!(
            SavedRequest::new("request-1", "", sample_request()),
            Err(SavedRequestError::EmptyName)
        );
    }

    #[test]
    fn keeps_the_full_request_content_on_a_saved_request() {
        let request = sample_request();
        let saved = SavedRequest::new("request-1", "Ping", request.clone()).unwrap();

        assert_eq!(saved.request, request);
    }

    #[test]
    fn find_saved_request_locates_a_request_nested_inside_folders() {
        let nested = SavedRequest::new("request-nested", "Nested", sample_request()).unwrap();
        let inner_folder = Folder::new("folder-2", "Inner", vec![], vec![nested]).unwrap();
        let outer_folder = Folder::new("folder-1", "Outer", vec![inner_folder], vec![]).unwrap();
        let collections = vec![
            Collection::new("collection-1", "Customer API", vec![outer_folder], vec![]).unwrap(),
        ];

        let found = find_saved_request(&collections, "request-nested").unwrap();

        assert_eq!(found.name(), "Nested");
    }

    #[test]
    fn find_saved_request_locates_a_request_directly_on_a_collection() {
        let request = SavedRequest::new("request-1", "Ping", sample_request()).unwrap();
        let collections =
            vec![Collection::new("collection-1", "Customer API", vec![], vec![request]).unwrap()];

        let found = find_saved_request(&collections, "request-1").unwrap();

        assert_eq!(found.name(), "Ping");
    }

    fn request_with(auth: Authentication) -> Request {
        let mut request = sample_request();
        request.authentication = auth;
        request
    }

    fn bearer(token: &str) -> Authentication {
        Authentication::Bearer {
            token: token.to_string(),
        }
    }

    #[test]
    fn effective_authentication_prefers_the_request_own_setting() {
        let saved = SavedRequest::new("r", "Ping", request_with(bearer("own"))).unwrap();
        let collection = Collection::new("c", "API", vec![], vec![saved])
            .unwrap()
            .with_authentication(bearer("collection"));

        assert_eq!(effective_authentication(&[collection], "r"), bearer("own"));
    }

    #[test]
    fn effective_authentication_uses_the_closest_non_inherit_ancestor() {
        let saved = SavedRequest::new("r", "Ping", request_with(Authentication::Inherit)).unwrap();
        let inner = Folder::new("f2", "Inner", vec![], vec![saved]).unwrap();
        let middle = Folder::new("f1", "Middle", vec![inner], vec![])
            .unwrap()
            .with_authentication(bearer("middle"));
        let collection = Collection::new("c", "API", vec![middle], vec![])
            .unwrap()
            .with_authentication(bearer("collection"));

        assert_eq!(
            effective_authentication(&[collection], "r"),
            bearer("middle")
        );
    }

    #[test]
    fn effective_authentication_falls_back_to_none_when_everything_inherits() {
        let saved = SavedRequest::new("r", "Ping", request_with(Authentication::Inherit)).unwrap();
        let collection = Collection::new("c", "API", vec![], vec![saved]).unwrap();

        assert_eq!(
            effective_authentication(&[collection], "r"),
            Authentication::None
        );
        assert_eq!(
            effective_authentication(&[], "missing"),
            Authentication::None
        );
    }

    #[test]
    fn rejects_duplicate_variables_in_a_folder_or_collection() {
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "a", false).unwrap(),
            EnvironmentVariable::new("baseUrl", "b", false).unwrap(),
        ];

        assert_eq!(
            Folder::new("f", "Orders", vec![], vec![])
                .unwrap()
                .with_variables(variables.clone()),
            Err(FolderError::DuplicateVariable("baseUrl".to_string()))
        );
        assert_eq!(
            Collection::new("c", "API", vec![], vec![])
                .unwrap()
                .with_variables(variables),
            Err(CollectionError::DuplicateVariable("baseUrl".to_string()))
        );
    }

    #[test]
    fn local_variables_drop_the_sensitive_flag() {
        let collection = Collection::new("c", "API", vec![], vec![])
            .unwrap()
            .with_variables(vec![EnvironmentVariable::new("token", "x", true).unwrap()])
            .unwrap();

        assert!(!collection.variables()[0].sensitive);
    }

    #[test]
    fn labels_trim_names_and_reject_empty_ones() {
        assert_eq!(
            CollectionLabel::new("  Produção ", LabelColor::Red)
                .unwrap()
                .name(),
            "Produção"
        );
        assert_eq!(
            CollectionLabel::new("   ", LabelColor::Red),
            Err(CollectionLabelError::EmptyName)
        );
    }

    #[test]
    fn collection_rejects_duplicate_labels_ignoring_case() {
        let labels = vec![
            CollectionLabel::new("Interno", LabelColor::Blue).unwrap(),
            CollectionLabel::new("interno", LabelColor::Green).unwrap(),
        ];

        assert_eq!(
            Collection::new("c", "API", vec![], vec![])
                .unwrap()
                .with_labels(labels),
            Err(CollectionError::DuplicateLabel("interno".to_string()))
        );
    }

    #[test]
    fn collection_keeps_labels_in_order() {
        let labels = vec![
            CollectionLabel::new("Pagamentos", LabelColor::Green).unwrap(),
            CollectionLabel::new("Legado", LabelColor::Gray).unwrap(),
        ];
        let collection = Collection::new("c", "API", vec![], vec![])
            .unwrap()
            .with_labels(labels.clone())
            .unwrap();

        assert_eq!(collection.labels(), labels.as_slice());
    }

    #[test]
    fn label_color_keys_round_trip() {
        for color in LabelColor::ALL {
            assert_eq!(LabelColor::from_key(color.as_key()), Some(color));
        }
        assert_eq!(LabelColor::from_key("magenta"), None);
    }

    #[test]
    fn find_saved_request_returns_none_for_an_unknown_id() {
        let collections =
            vec![Collection::new("collection-1", "Customer API", vec![], vec![]).unwrap()];

        assert_eq!(find_saved_request(&collections, "missing"), None);
    }
}
