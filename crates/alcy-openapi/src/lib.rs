//! Importação de documentos OpenAPI 3.0/3.1 (JSON ou YAML) como coleções de
//! requisições REST (`alcy-domain`). Não executa requisições nem conhece
//! `alcy-graphql`/`alcy-rest` — só interpreta um documento e produz árvores
//! de domínio, paralelo às outras capabilities de protocolo
//! (`ARCHITECTURE.md`).

mod docs;
mod document;
mod mapping;

use alcy_domain::{
    ApiDocsSource, Collection, CollectionError, EndpointError, FolderError, HeaderError,
    SavedRequestError,
};
use serde_json::Value;
use thiserror::Error;

use document::OpenApiDocument;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OpenApiError {
    /// Não é um erro de verdade — sinaliza que `raw` não parece um
    /// documento OpenAPI 3.x, para quem chama decidir tentar outro formato
    /// (`alcy_storage::import_collections_from_str`). Não carrega mensagem
    /// porque nunca chega à interface.
    #[error("documento não é OpenAPI")]
    NotOpenApi,
    #[error("documento OpenAPI inválido: {0}")]
    InvalidSyntax(String),
    #[error("versão do documento não suportada: {0}")]
    UnsupportedVersion(String),
    #[error("documento OpenAPI rejeitado: {0}")]
    DomainRejected(String),
}

impl From<EndpointError> for OpenApiError {
    fn from(error: EndpointError) -> Self {
        Self::DomainRejected(error.to_string())
    }
}

impl From<HeaderError> for OpenApiError {
    fn from(error: HeaderError) -> Self {
        Self::DomainRejected(error.to_string())
    }
}

impl From<SavedRequestError> for OpenApiError {
    fn from(error: SavedRequestError) -> Self {
        Self::DomainRejected(error.to_string())
    }
}

impl From<FolderError> for OpenApiError {
    fn from(error: FolderError) -> Self {
        Self::DomainRejected(error.to_string())
    }
}

impl From<CollectionError> for OpenApiError {
    fn from(error: CollectionError) -> Self {
        Self::DomainRejected(error.to_string())
    }
}

/// Resultado da importação: a coleção gerada e a documentação das
/// operações (ADR 0035). Cada requisição documentada sai com um `docs_ref`
/// de `source_id` vazio, preenchido por quem grava a fonte no workspace.
#[derive(Debug, PartialEq, Eq)]
pub struct OpenApiImport {
    pub collections: Vec<Collection>,
    pub docs: ApiDocsSource,
}

/// Interpreta `raw` (JSON ou YAML) como um documento OpenAPI 3.x e o
/// converte numa única `Collection` (pastas pelos segmentos do caminho, requisições REST por
/// operação) mais a documentação de cada operação.
///
/// Detecção e parsing acontecem num único parse de `raw`: um documento
/// grande (dezenas de MB) só é tokenizado uma vez, nunca duas — quem chama
/// não precisa (e não deve) sniffar o formato antes com um parse próprio;
/// `OpenApiError::NotOpenApi` já é esse sinal, sem custo extra.
pub fn parse_document(raw: &str) -> Result<OpenApiImport, OpenApiError> {
    let value = parse_to_value(raw)?;

    match value.get("openapi").and_then(Value::as_str) {
        Some(version) if version.starts_with("3.") => {}
        Some(version) => return Err(OpenApiError::UnsupportedVersion(version.to_string())),
        None if value.get("swagger").is_some() => {
            return Err(OpenApiError::UnsupportedVersion("swagger 2.0".to_string()));
        }
        None => return Err(OpenApiError::NotOpenApi),
    }

    let document: OpenApiDocument = serde_json::from_value(value)
        .map_err(|error| OpenApiError::InvalidSyntax(error.to_string()))?;

    mapping::map_document(document)
}

/// JSON é um subconjunto válido de YAML 1.2, então um único parser YAML
/// cobre os dois formatos aceitos por esta fatia (spec 0031) sem precisar
/// de dois caminhos de parsing separados.
fn parse_to_value(raw: &str) -> Result<Value, OpenApiError> {
    yaml_serde::from_str(raw).map_err(|error| OpenApiError::InvalidSyntax(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{Authentication, Collection, Folder, SavedRequest};

    fn first_request_in_folders(folders: &[Folder]) -> Option<&SavedRequest> {
        folders.iter().find_map(|folder| {
            folder
                .requests()
                .first()
                .or_else(|| first_request_in_folders(folder.folders()))
        })
    }

    fn first_request(collection: &Collection) -> &SavedRequest {
        collection
            .requests()
            .first()
            .or_else(|| first_request_in_folders(collection.folders()))
            .expect("fixture has at least one request")
    }

    const MINIMAL_JSON: &str = r#"{
        "openapi": "3.0.3",
        "info": {"title": "Pet Store"},
        "paths": {
            "/pets": {
                "get": {"summary": "List pets"}
            }
        }
    }"#;

    const MINIMAL_YAML: &str = "
openapi: 3.0.3
info:
  title: Pet Store
paths:
  /pets:
    get:
      summary: List pets
";

    #[test]
    fn parses_a_json_openapi_document() {
        assert!(parse_document(MINIMAL_JSON).is_ok());
    }

    #[test]
    fn parses_a_yaml_openapi_document() {
        assert!(parse_document(MINIMAL_YAML).is_ok());
    }

    #[test]
    fn signals_not_openapi_for_an_alcy_format_file_without_reparsing_it() {
        let alcy_format = r#"{"version": 1, "collections": []}"#;
        assert_eq!(parse_document(alcy_format), Err(OpenApiError::NotOpenApi));
    }

    #[test]
    fn rejects_garbage_as_invalid_syntax() {
        let error = parse_document("not json or yaml: {[").unwrap_err();
        assert!(matches!(error, OpenApiError::InvalidSyntax(_)));
    }

    #[test]
    fn parses_json_and_yaml_into_the_same_collection() {
        let from_json = parse_document(MINIMAL_JSON).unwrap().collections;
        let from_yaml = parse_document(MINIMAL_YAML).unwrap().collections;

        assert_eq!(from_json.len(), 1);
        assert_eq!(from_json[0].name(), "Pet Store");
        assert_eq!(from_json[0].folders()[0].requests().len(), 1);
        assert_eq!(first_request(&from_json[0]).name(), "List pets");
        assert_eq!(from_json[0].name(), from_yaml[0].name());
        assert_eq!(from_json[0], from_yaml[0]);
    }

    #[test]
    fn falls_back_to_a_default_title_when_info_title_is_empty() {
        let raw = r#"{"openapi": "3.1.0", "info": {"title": ""}, "paths": {}}"#;
        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(collections[0].name(), "Imported API");
    }

    #[test]
    fn rejects_swagger_2_0() {
        let raw = r#"{"swagger": "2.0", "info": {"title": "Old API"}, "paths": {}}"#;
        let error = parse_document(raw).unwrap_err();

        assert!(matches!(error, OpenApiError::UnsupportedVersion(_)));
    }

    #[test]
    fn skips_the_trace_method_which_has_no_http_method_equivalent() {
        let raw = r#"{
            "openapi": "3.1.0",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "get": {"summary": "List pets"},
                    "trace": {"summary": "Trace pets"}
                }
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(collections[0].folders()[0].requests().len(), 1);
        assert_eq!(first_request(&collections[0]).name(), "List pets");
    }

    #[test]
    fn groups_operations_by_path_segments_into_folders() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "get": {"summary": "List pets", "tags": ["Pets", "Animals"]},
                    "post": {"summary": "Create pet", "tags": ["Pets"]}
                },
                "/health": {
                    "get": {"summary": "Health check"}
                }
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let collection = &collections[0];

        assert!(collection.requests().is_empty());
        assert_eq!(collection.folders().len(), 2);
        let pets = collection
            .folders()
            .iter()
            .find(|folder| folder.name() == "pets")
            .unwrap();
        let health = collection
            .folders()
            .iter()
            .find(|folder| folder.name() == "health")
            .unwrap();
        assert_eq!(pets.requests().len(), 2);
        assert_eq!(health.requests()[0].name(), "Health check");
    }

    #[test]
    fn shares_path_prefixes_and_keeps_parameter_segments() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "Trips"},
            "paths": {
                "/api/v1/trips": {"get": {"summary": "List trips"}},
                "/api/v1/trips/{id}": {"get": {"summary": "Get trip"}}
            }
        }"#;

        let collection = &parse_document(raw).unwrap().collections[0];
        let api = &collection.folders()[0];
        let v1 = &api.folders()[0];
        let trips = &v1.folders()[0];

        assert_eq!(api.name(), "api");
        assert_eq!(v1.name(), "v1");
        assert_eq!(trips.name(), "trips");
        assert_eq!(trips.requests()[0].name(), "List trips");
        assert_eq!(trips.folders()[0].name(), "{id}");
        assert_eq!(trips.folders()[0].requests()[0].name(), "Get trip");
    }

    #[test]
    fn falls_back_to_operation_id_then_to_method_and_path_for_the_request_name() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "get": {"operationId": "listPets"},
                    "post": {}
                }
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let names: Vec<&str> = collections[0].folders()[0]
            .requests()
            .iter()
            .map(|r| r.name())
            .collect();

        assert!(names.contains(&"listPets"));
        assert!(names.contains(&"POST /pets"));
    }

    #[test]
    fn allows_equal_request_names_in_different_path_folders() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/a": {"get": {"summary": "Ping"}},
                "/b": {"get": {"summary": "Ping"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let mut names: Vec<&str> = collections[0]
            .folders()
            .iter()
            .map(|folder| folder.requests()[0].name())
            .collect();
        names.sort();

        assert_eq!(names, vec!["Ping", "Ping"]);
    }

    #[test]
    fn rewrites_path_template_params_into_alcy_interpolation_syntax() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets/{id}": {"get": {"summary": "Get pet"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.endpoint.url(),
            "{{baseUrl}}/pets/{{id}}"
        );
    }

    #[test]
    fn maps_required_query_params_into_the_url_and_headers_into_header_entries() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "get": {
                        "summary": "List pets",
                        "parameters": [
                            {"name": "limit", "in": "query", "required": true, "example": 10},
                            {"name": "page", "in": "query", "required": false, "example": 1},
                            {"name": "X-Trace-Id", "in": "header", "example": "abc"}
                        ]
                    }
                }
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert_eq!(request.endpoint.url(), "{{baseUrl}}/pets?limit=10");
        assert_eq!(request.headers.len(), 1);
        assert_eq!(request.headers[0].name(), "X-Trace-Id");
        assert_eq!(request.headers[0].value(), "abc");
    }

    #[test]
    fn merges_path_level_parameters_with_operation_level_overrides() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "parameters": [
                        {"name": "limit", "in": "query", "required": true, "example": 5}
                    ],
                    "get": {
                        "summary": "List pets",
                        "parameters": [
                            {"name": "limit", "in": "query", "required": true, "example": 50}
                        ]
                    }
                }
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert_eq!(request.endpoint.url(), "{{baseUrl}}/pets?limit=50");
    }

    #[test]
    fn resolves_a_ref_parameter_from_components() {
        let raw = r##"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "get": {
                        "summary": "List pets",
                        "parameters": [{"$ref": "#/components/parameters/Limit"}]
                    }
                }
            },
            "components": {
                "parameters": {
                    "Limit": {"name": "limit", "in": "query", "required": true, "example": 25}
                }
            }
        }"##;

        let collections = parse_document(raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert_eq!(request.endpoint.url(), "{{baseUrl}}/pets?limit=25");
    }

    #[test]
    fn maps_a_request_body_example_and_content_type_header() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "post": {
                        "summary": "Create pet",
                        "requestBody": {
                            "content": {
                                "application/json": {"example": {"name": "Rex"}}
                            }
                        }
                    }
                }
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert!(request.document.body.contains("\"name\": \"Rex\""));
        assert_eq!(request.headers.len(), 1);
        assert_eq!(request.headers[0].name(), "Content-Type");
        assert_eq!(request.headers[0].value(), "application/json");
    }

    #[test]
    fn resolves_a_ref_request_body_from_components() {
        let raw = r##"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {
                    "post": {
                        "summary": "Create pet",
                        "requestBody": {"$ref": "#/components/requestBodies/Pet"}
                    }
                }
            },
            "components": {
                "requestBodies": {
                    "Pet": {"content": {"application/json": {"example": {"name": "Rex"}}}}
                }
            }
        }"##;

        let collections = parse_document(raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert!(request.document.body.contains("Rex"));
    }

    #[test]
    fn leaves_body_empty_and_no_content_type_header_without_a_request_body() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {"get": {"summary": "List pets"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert_eq!(request.document.body, "");
        assert!(request.headers.is_empty());
    }

    #[test]
    fn uses_the_first_server_url_instead_of_base_url_when_present() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "servers": [{"url": "https://api.example.com/v3"}],
            "paths": {
                "/pets": {"get": {"summary": "List pets"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.endpoint.url(),
            "https://api.example.com/v3/pets"
        );
    }

    #[test]
    fn rewrites_server_variables_into_alcy_interpolation_syntax() {
        // Mesma forma usada pela API REST do GitHub Enterprise Server.
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "GitHub v3 REST API"},
            "servers": [{
                "url": "{protocol}://{hostname}/api/v3",
                "variables": {
                    "protocol": {"default": "http"},
                    "hostname": {"default": "HOSTNAME"}
                }
            }],
            "paths": {
                "/": {"get": {"operationId": "meta/root"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.endpoint.url(),
            "{{protocol}}://{{hostname}}/api/v3/"
        );
    }

    #[test]
    fn falls_back_to_base_url_when_there_are_no_servers() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {"get": {"summary": "List pets"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.endpoint.url(),
            "{{baseUrl}}/pets"
        );
    }

    #[test]
    fn falls_back_to_base_url_when_the_first_server_url_is_empty() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "servers": [{"url": ""}],
            "paths": {
                "/pets": {"get": {"summary": "List pets"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.endpoint.url(),
            "{{baseUrl}}/pets"
        );
    }

    #[test]
    fn all_imported_requests_have_no_authentication() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {"get": {"summary": "List pets"}}
            }
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::None
        );
    }

    fn document_with_security_scheme(security_scheme: &str) -> String {
        format!(
            r#"{{
                "openapi": "3.0.3",
                "info": {{"title": "X"}},
                "paths": {{
                    "/pets": {{"get": {{"summary": "List pets"}}}}
                }},
                "components": {{"securitySchemes": {{"main": {security_scheme}}}}},
                "security": [{{"main": []}}]
            }}"#
        )
    }

    #[test]
    fn maps_an_http_bearer_scheme_to_bearer_authentication_with_an_empty_token() {
        let raw = document_with_security_scheme(r#"{"type": "http", "scheme": "bearer"}"#);

        let collections = parse_document(&raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::Bearer {
                token: String::new()
            }
        );
    }

    #[test]
    fn maps_an_http_basic_scheme_to_basic_authentication_with_empty_credentials() {
        let raw = document_with_security_scheme(r#"{"type": "http", "scheme": "basic"}"#);

        let collections = parse_document(&raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::Basic {
                username: String::new(),
                password: String::new()
            }
        );
    }

    #[test]
    fn maps_an_http_digest_scheme_to_digest_authentication_with_empty_credentials() {
        let raw = document_with_security_scheme(r#"{"type": "http", "scheme": "digest"}"#);

        let collections = parse_document(&raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::Digest {
                username: String::new(),
                password: String::new()
            }
        );
    }

    #[test]
    fn maps_a_header_api_key_scheme_to_a_plain_header_with_its_name_and_an_empty_value() {
        let raw = document_with_security_scheme(
            r#"{"type": "apiKey", "in": "header", "name": "X-Api-Key"}"#,
        );

        let collections = parse_document(&raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert_eq!(request.authentication, Authentication::None);
        assert!(
            request
                .headers
                .iter()
                .any(|header| header.name() == "X-Api-Key" && header.value().is_empty())
        );
    }

    #[test]
    fn does_not_map_a_query_api_key_scheme() {
        let raw = document_with_security_scheme(
            r#"{"type": "apiKey", "in": "query", "name": "api_key"}"#,
        );

        let collections = parse_document(&raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::None
        );
    }

    #[test]
    fn maps_an_oauth2_client_credentials_scheme_with_its_token_url() {
        let raw = document_with_security_scheme(
            r#"{
                "type": "oauth2",
                "flows": {
                    "clientCredentials": {
                        "tokenUrl": "https://auth.example.com/token",
                        "scopes": {}
                    }
                }
            }"#,
        );

        let collections = parse_document(&raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::OAuth2ClientCredentials {
                client_id: String::new(),
                client_secret: String::new(),
                token_url: "https://auth.example.com/token".to_string(),
                scope: String::new(),
            }
        );
    }

    #[test]
    fn does_not_map_an_oauth2_scheme_without_a_client_credentials_flow() {
        let raw = document_with_security_scheme(
            r#"{
                "type": "oauth2",
                "flows": {
                    "implicit": {
                        "authorizationUrl": "https://auth.example.com/authorize",
                        "scopes": {}
                    }
                }
            }"#,
        );

        let collections = parse_document(&raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::None
        );
    }

    #[test]
    fn does_not_map_an_open_id_connect_scheme() {
        let raw = document_with_security_scheme(
            r#"{"type": "openIdConnect", "openIdConnectUrl": "https://auth.example.com/.well-known/openid-configuration"}"#,
        );

        let collections = parse_document(&raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::None
        );
    }

    #[test]
    fn an_operation_level_empty_security_override_disables_the_document_level_default() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {"get": {"summary": "List pets", "security": []}}
            },
            "components": {"securitySchemes": {"main": {"type": "http", "scheme": "bearer"}}},
            "security": [{"main": []}]
        }"#;

        let collections = parse_document(raw).unwrap().collections;

        assert_eq!(
            first_request(&collections[0]).request.authentication,
            Authentication::None
        );
    }

    #[test]
    fn an_operation_level_security_overrides_the_document_level_default() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/pets": {"get": {"summary": "List pets", "security": [{"apiKeyScheme": []}]}}
            },
            "components": {"securitySchemes": {
                "main": {"type": "http", "scheme": "bearer"},
                "apiKeyScheme": {"type": "apiKey", "in": "header", "name": "X-Api-Key"}
            }},
            "security": [{"main": []}]
        }"#;

        let collections = parse_document(raw).unwrap().collections;
        let request = &first_request(&collections[0]).request;

        assert_eq!(request.authentication, Authentication::None);
        assert!(
            request
                .headers
                .iter()
                .any(|header| header.name() == "X-Api-Key" && header.value().is_empty())
        );
    }

    const DOCUMENTED_YAML: &str = "
openapi: 3.0.3
info:
  title: Pet Store
paths:
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        description: Id do pet
        schema: {type: integer, format: int64}
    put:
      operationId: updatePet
      summary: Atualiza um pet
      description: Substitui o pet inteiro.
      deprecated: true
      parameters:
        - name: dryRun
          in: query
          schema: {type: boolean, default: false}
        - name: X-Trace
          in: header
          description: Rastreamento
          schema: {type: string}
        - name: session
          in: cookie
          schema: {type: string}
      requestBody:
        $ref: '#/components/requestBodies/PetBody'
      responses:
        '200':
          description: Pet atualizado
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Pet'}
        '404':
          $ref: '#/components/responses/NotFound'
components:
  requestBodies:
    PetBody:
      description: Pet a gravar
      required: true
      content:
        application/json:
          schema: {$ref: '#/components/schemas/Pet'}
  responses:
    NotFound:
      description: Não encontrado
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        name: {type: string}
        category: {$ref: '#/components/schemas/Category'}
    Category:
      type: object
      properties:
        name: {type: string}
    Unused:
      type: object
";

    #[test]
    fn documents_parameters_body_responses_and_reachable_schemas() {
        let import = parse_document(DOCUMENTED_YAML).unwrap();
        let docs = &import.docs;

        assert_eq!(docs.title, "Pet Store");
        assert_eq!(docs.kind, alcy_domain::ApiDocsSourceKind::OpenApi);
        let operation = &docs.operations["updatePet"];
        assert_eq!(operation.summary, "Atualiza um pet");
        assert_eq!(operation.description, "Substitui o pet inteiro.");
        assert!(operation.deprecated);

        let parameters: Vec<_> = operation
            .parameters
            .iter()
            .map(|parameter| {
                (
                    parameter.name.as_str(),
                    parameter.location,
                    parameter.required,
                )
            })
            .collect();
        use alcy_domain::ParameterLocation::*;
        assert_eq!(
            parameters,
            vec![
                ("petId", Path, true),
                ("dryRun", Query, false),
                ("X-Trace", Header, false),
                ("session", Cookie, false),
            ]
        );
        assert_eq!(operation.parameters[0].description, "Id do pet");
        assert_eq!(
            operation.parameters[1]
                .schema
                .as_ref()
                .unwrap()
                .default
                .as_deref(),
            Some("false")
        );

        let body = operation.request_body.as_ref().unwrap();
        assert_eq!(body.description, "Pet a gravar");
        assert!(body.required);
        assert_eq!(body.content[0].media_type, "application/json");
        assert_eq!(
            body.content[0].schema.as_ref().unwrap().ref_name.as_deref(),
            Some("Pet")
        );

        let statuses: Vec<_> = operation
            .responses
            .iter()
            .map(|response| (response.status.as_str(), response.description.as_str()))
            .collect();
        assert_eq!(
            statuses,
            vec![("200", "Pet atualizado"), ("404", "Não encontrado")]
        );

        assert_eq!(
            docs.schemas.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["Category", "Pet"]
        );
    }

    #[test]
    fn documented_requests_point_to_their_operation() {
        let import = parse_document(DOCUMENTED_YAML).unwrap();
        let request = first_request(&import.collections[0]);

        let docs_ref = request.docs_ref.as_ref().unwrap();
        assert_eq!(docs_ref.operation_id, "updatePet");
        assert!(docs_ref.source_id.is_empty());
    }

    #[test]
    fn operations_without_operation_id_use_method_and_path_and_duplicates_are_disambiguated() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {
                "/a": {"get": {"operationId": "same", "summary": "A"}},
                "/b": {"get": {"operationId": "same", "summary": "B"}},
                "/c": {"post": {"summary": "C"}}
            }
        }"#;

        let import = parse_document(raw).unwrap();

        assert_eq!(
            import
                .docs
                .operations
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["GET /b", "POST /c", "same"]
        );
    }

    #[test]
    fn operations_with_nothing_to_document_get_no_reference() {
        let raw = r#"{
            "openapi": "3.0.3",
            "info": {"title": "X"},
            "paths": {"/a": {"get": {}}}
        }"#;

        let import = parse_document(raw).unwrap();

        assert!(import.docs.operations.is_empty());
        assert!(first_request(&import.collections[0]).docs_ref.is_none());
    }
}
