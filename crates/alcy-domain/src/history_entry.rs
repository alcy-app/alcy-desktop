use std::time::SystemTime;

use crate::request::Request;
use crate::response::Response;

/// Resultado de uma execução registrada no histórico. Só se registram
/// execuções que de fato saíram pela rede e completaram: sucesso (qualquer
/// status HTTP, com a resposta completa) ou falha de rede/timeout. Um
/// cancelamento ou uma falha de validação antes do envio nunca vira uma
/// `HistoryOutcome` (ver `execute_graphql_request` no command).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryOutcome {
    Success(Response),
    Failed {
        kind: HistoryFailureKind,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryFailureKind {
    Network,
    Timeout,
}

/// Uma execução passada, registrada no histórico local do workspace. Guarda
/// a requisição já resolvida (endpoint, headers, variables e autenticação
/// pós-interpolação de `{{var}}`) — é essa URL resolvida que nomeia a
/// entrada na interface, e é esse conteúdo que permite reabri-la como
/// rascunho sem depender do ambiente que estava ativo no momento.
///
/// `request_id` (requisição salva) e `tab_id` (aba de origem) ligam o envio
/// à requisição que o disparou, para o histórico de envios dela; ambos
/// ficam `None` em entradas sem essa origem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub id: String,
    pub request: Request,
    pub outcome: HistoryOutcome,
    pub executed_at: SystemTime,
    pub request_id: Option<String>,
    pub tab_id: Option<String>,
    /// `true` quando o corpo de resposta guardado no histórico não é o
    /// corpo inteiro (passou do teto de persistência do histórico). Só faz
    /// sentido em uma entrada recarregada do armazenamento.
    pub response_body_truncated: bool,
    /// `true` quando o histórico guardou só o resumo da resposta (status,
    /// tempo e tamanho), sem corpo nem headers — ver
    /// `without_response_details`.
    pub response_omitted: bool,
}

impl HistoryEntry {
    pub fn new(
        id: impl Into<String>,
        request: Request,
        outcome: HistoryOutcome,
        executed_at: SystemTime,
    ) -> Self {
        Self {
            id: id.into(),
            request,
            outcome,
            executed_at,
            request_id: None,
            tab_id: None,
            response_body_truncated: false,
            response_omitted: false,
        }
    }

    pub fn with_source(mut self, request_id: Option<String>, tab_id: Option<String>) -> Self {
        self.request_id = request_id;
        self.tab_id = tab_id;
        self
    }

    /// Descarta o corpo e os headers da resposta, mantendo status, tempo,
    /// tamanho e codificação. Uma falha não tem resposta e fica como está.
    pub fn without_response_details(mut self) -> Self {
        if let HistoryOutcome::Success(response) = &mut self.outcome {
            response.body = String::new();
            response.headers = Vec::new();
            response.request_headers = Vec::new();
            response.cookies = Vec::new();
            self.response_omitted = true;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Authentication, Endpoint, HeaderEntry, ProtocolId, RequestDocument, ResponseHeader,
        ResponseMetadata,
    };

    fn sample_request() -> Request {
        Request::new(
            Endpoint::new("https://api.example.com/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![HeaderEntry::new("Accept", "application/json", true).unwrap()],
            Authentication::None,
        )
    }

    #[test]
    fn builds_a_history_entry_from_a_successful_response() {
        let response = Response::new(
            200,
            42,
            "{\"data\":{}}",
            vec![ResponseHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            ResponseMetadata::default(),
        );
        let executed_at = SystemTime::now();

        let entry = HistoryEntry::new(
            "entry-1",
            sample_request(),
            HistoryOutcome::Success(response.clone()),
            executed_at,
        );

        assert_eq!(entry.id, "entry-1");
        assert_eq!(entry.request, sample_request());
        assert_eq!(entry.outcome, HistoryOutcome::Success(response));
        assert_eq!(entry.executed_at, executed_at);
    }

    #[test]
    fn without_response_details_keeps_only_the_response_summary() {
        let response = Response::new(
            201,
            42,
            "{\"id\":1}",
            vec![ResponseHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            ResponseMetadata::default(),
        );
        let size_bytes = response.size_bytes;

        let entry = HistoryEntry::new(
            "entry-1",
            sample_request(),
            HistoryOutcome::Success(response),
            SystemTime::now(),
        )
        .without_response_details();

        assert!(entry.response_omitted);
        let HistoryOutcome::Success(stored) = entry.outcome else {
            panic!("a entrada continua sendo um sucesso");
        };
        assert_eq!((stored.status_code, stored.duration_ms), (201, 42));
        assert_eq!(stored.size_bytes, size_bytes);
        assert!(stored.body.is_empty() && stored.headers.is_empty());
    }

    #[test]
    fn without_response_details_leaves_a_failure_untouched() {
        let outcome = HistoryOutcome::Failed {
            kind: HistoryFailureKind::Timeout,
            message: "timeout".to_string(),
        };
        let entry = HistoryEntry::new(
            "entry-1",
            sample_request(),
            outcome.clone(),
            SystemTime::now(),
        )
        .without_response_details();

        assert!(!entry.response_omitted);
        assert_eq!(entry.outcome, outcome);
    }

    #[test]
    fn builds_a_history_entry_from_a_network_failure() {
        let entry = HistoryEntry::new(
            "entry-2",
            sample_request(),
            HistoryOutcome::Failed {
                kind: HistoryFailureKind::Network,
                message: "connection refused".to_string(),
            },
            SystemTime::now(),
        );

        assert_eq!(
            entry.outcome,
            HistoryOutcome::Failed {
                kind: HistoryFailureKind::Network,
                message: "connection refused".to_string(),
            }
        );
    }
}
