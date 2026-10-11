/// Identifica o protocolo de um documento de requisição.
///
/// O domínio conhece apenas o identificador do protocolo, nunca conceitos
/// específicos dele (ex.: campos de uma query GraphQL). Interpretar o corpo
/// do documento é responsabilidade da camada específica do protocolo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolId {
    GraphQl,
    Rest,
}

/// Corpo opaco de uma requisição, rotulado pelo protocolo ao qual pertence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestDocument {
    pub protocol: ProtocolId,
    pub body: String,
}

impl RequestDocument {
    pub fn new(protocol: ProtocolId, body: impl Into<String>) -> Self {
        Self {
            protocol,
            body: body.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_document_with_its_protocol_and_body() {
        let document = RequestDocument::new(ProtocolId::GraphQl, "query { ping }");

        assert_eq!(document.protocol, ProtocolId::GraphQl);
        assert_eq!(document.body, "query { ping }");
    }
}
