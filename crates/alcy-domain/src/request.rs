use crate::{Authentication, BodyPayload, Endpoint, HeaderEntry, HttpMethod, RequestDocument};

/// Política de redirecionamento aplicada por uma execução HTTP. É efêmera:
/// coleções e requisições avulsas continuam com o comportamento padrão de
/// seguir redirects; flows de carga podem escolher explicitamente observar a
/// resposta 3xx original.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RedirectPolicy {
    #[default]
    Follow,
    Manual,
}

/// Valor associado a um placeholder `:nome` no caminho da URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteParameter {
    pub name: String,
    pub value: String,
}

/// Uma requisição pronta para ser executada, ainda não persistida.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub endpoint: Endpoint,
    pub document: RequestDocument,
    pub variables: String,
    pub headers: Vec<HeaderEntry>,
    pub authentication: Authentication,
    pub method: HttpMethod,
    /// Script JavaScript executado antes do envio (vazio = sem script).
    pub pre_request_script: String,
    /// Script JavaScript executado após a resposta (vazio = sem script).
    pub post_response_script: String,
    /// Tipo de corpo REST (none/raw/urlencoded/form-data/binary) — campo
    /// específico de REST que os demais executores simplesmente ignoram
    /// (mesmo padrão de `variables`, específico de GraphQL). Começa em
    /// `Raw` (JSON) para preservar o comportamento de toda requisição já
    /// existente antes deste campo existir.
    pub body_payload: BodyPayload,
    /// Parâmetros substituídos nos placeholders `:nome` do caminho somente
    /// no momento da execução.
    pub route_parameters: Vec<RouteParameter>,
    /// Ignora o limite de tamanho de resposta configurado no executor. Só o
    /// "reenviar sem limite" da interface liga isto, para um envio pontual;
    /// não é persistido.
    pub unlimited_response_size: bool,
    /// Não é persistida nas coleções nesta etapa; o compilador de carga a
    /// define antes de entregar a request ao transporte concreto.
    pub redirect_policy: RedirectPolicy,
}

impl Request {
    pub fn new(
        endpoint: Endpoint,
        document: RequestDocument,
        variables: impl Into<String>,
        headers: Vec<HeaderEntry>,
        authentication: Authentication,
    ) -> Self {
        Self {
            endpoint,
            document,
            variables: variables.into(),
            headers,
            authentication,
            method: HttpMethod::default(),
            pre_request_script: String::new(),
            post_response_script: String::new(),
            body_payload: BodyPayload::default(),
            route_parameters: Vec::new(),
            unlimited_response_size: false,
            redirect_policy: RedirectPolicy::Follow,
        }
    }

    pub fn with_scripts(
        mut self,
        pre_request_script: impl Into<String>,
        post_response_script: impl Into<String>,
    ) -> Self {
        self.pre_request_script = pre_request_script.into();
        self.post_response_script = post_response_script.into();
        self
    }

    pub fn with_method(mut self, method: HttpMethod) -> Self {
        self.method = method;
        self
    }

    pub fn with_unlimited_response_size(mut self, unlimited: bool) -> Self {
        self.unlimited_response_size = unlimited;
        self
    }

    pub fn with_body_payload(mut self, payload: BodyPayload) -> Self {
        self.body_payload = payload;
        self
    }

    pub fn with_redirect_policy(mut self, policy: RedirectPolicy) -> Self {
        self.redirect_policy = policy;
        self
    }

    pub fn with_route_parameters(mut self, parameters: Vec<RouteParameter>) -> Self {
        self.route_parameters = parameters;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProtocolId, RawBodyLanguage};

    #[test]
    fn builds_a_request_from_its_parts() {
        let endpoint = Endpoint::new("{{baseUrl}}/graphql").unwrap();
        let document = RequestDocument::new(ProtocolId::GraphQl, "query { ping }");
        let headers = vec![HeaderEntry::new("Accept", "application/json", true).unwrap()];

        let request = Request::new(
            endpoint.clone(),
            document.clone(),
            "{}",
            headers.clone(),
            Authentication::None,
        );

        assert_eq!(request.endpoint, endpoint);
        assert_eq!(request.document, document);
        assert_eq!(request.variables, "{}");
        assert_eq!(request.headers, headers);
        assert_eq!(request.authentication, Authentication::None);
        assert_eq!(request.method, HttpMethod::Post);
        assert_eq!(
            request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );
    }

    #[test]
    fn with_body_payload_sets_it() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_body_payload(BodyPayload::Binary {
            file_path: "/tmp/photo.png".to_string(),
        });

        assert_eq!(
            request.body_payload,
            BodyPayload::Binary {
                file_path: "/tmp/photo.png".to_string(),
            }
        );
    }

    #[test]
    fn scripts_default_to_empty_and_can_be_set() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        );
        assert_eq!(request.pre_request_script, "");
        assert_eq!(request.post_response_script, "");

        let request = request.with_scripts("a", "b");
        assert_eq!(request.pre_request_script, "a");
        assert_eq!(request.post_response_script, "b");
    }

    #[test]
    fn with_method_overrides_the_default_post_method() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Get);

        assert_eq!(request.method, HttpMethod::Get);
    }
}
