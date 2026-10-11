use thiserror::Error;

/// Endereço de destino de uma requisição.
///
/// Guarda o texto como digitado pelo usuário, incluindo eventuais
/// placeholders de interpolação de ambiente (ex.: `{{baseUrl}}/graphql`).
/// A resolução desses placeholders e a validação de sintaxe de URL
/// acontecem em uma camada superior, depois da interpolação.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EndpointError {
    #[error("endpoint URL não pode ser vazio")]
    Empty,
}

impl Endpoint {
    pub fn new(url: impl Into<String>) -> Result<Self, EndpointError> {
        let url = url.into();
        if url.trim().is_empty() {
            return Err(EndpointError::Empty);
        }
        Ok(Self { url })
    }

    /// Endereço de uma requisição salva, como o usuário o deixou — pode estar
    /// vazio: uma requisição recém-criada nasce sem URL (spec 0089). A
    /// execução continua exigindo um endereço: ela resolve as variáveis e
    /// valida o resultado com [`Endpoint::new`].
    pub fn saved(url: impl Into<String>) -> Self {
        Self { url: url.into() }
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_non_empty_url() {
        let endpoint = Endpoint::new("{{baseUrl}}/graphql").unwrap();
        assert_eq!(endpoint.url(), "{{baseUrl}}/graphql");
    }

    #[test]
    fn rejects_an_empty_url() {
        assert_eq!(Endpoint::new(""), Err(EndpointError::Empty));
        assert_eq!(Endpoint::new("   "), Err(EndpointError::Empty));
    }

    #[test]
    fn saved_keeps_an_empty_url() {
        assert_eq!(Endpoint::saved("").url(), "");
        assert_eq!(
            Endpoint::saved("{{baseUrl}}/users").url(),
            "{{baseUrl}}/users"
        );
    }
}
