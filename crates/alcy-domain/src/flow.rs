use std::collections::{HashMap, HashSet};
use std::time::SystemTime;

use thiserror::Error;

use crate::{MockServer, SavedRequest};

/// Tipo de execução de um flow. Flows existentes continuam sendo `Standard`;
/// `Load` habilita controladores e nós próprios de teste de carga.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowExecutionKind {
    Standard,
    Load,
}

/// Tipo fechado dos blocos de carga. A configuração de cada bloco é mantida
/// como JSON validado pela capability de carga: o domínio preserva a forma do
/// grafo sem conhecer detalhes de HTTP, métricas ou formatos importados.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadNodeKind {
    Scenario,
    Request,
    Script,
    Repeat,
    ForEach,
    OncePerVu,
    TimeBox,
    Select,
    Group,
    Timer,
    Dataset,
    ConfigureSession,
    Extract,
    Check,
    Metric,
    Threshold,
}

impl LoadNodeKind {
    pub fn requires_body(self) -> bool {
        matches!(
            self,
            Self::Scenario
                | Self::Repeat
                | Self::ForEach
                | Self::OncePerVu
                | Self::TimeBox
                | Self::Select
                | Self::Group
        )
    }

    pub fn allows_handle(self, handle: Option<&str>) -> bool {
        match self {
            Self::Scenario => matches!(handle, Some("iteration") | Some("done")),
            Self::Threshold => matches!(handle, Some("passed") | Some("failed")),
            Self::Request => matches!(handle, Some("success") | Some("failure")),
            kind if kind.requires_body() => matches!(handle, Some("body") | Some("done")),
            _ => handle.is_none(),
        }
    }
}

/// Um bloco de carga no canvas. `config` é JSON canônico, produzido pelo
/// importador ou pelo inspector; nenhum conteúdo é executado ao ser salvo ou
/// importado. A validação semântica cabe ao motor de carga.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadNode {
    pub kind: LoadNodeKind,
    pub label: String,
    pub config: String,
}

/// Posição de um node no canvas do flow — coordenadas livres, sem unidade
/// de domínio (o significado de "pixel" é da camada de apresentação).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlowPosition {
    pub x: f64,
    pub y: f64,
}

/// Operador de comparação de uma `Condition` — conjunto fechado e pequeno de
/// propósito (spec 0047): comparação simples entre dois valores já
/// resolvíveis hoje (referência `{{nodes.<id>...}}` ou variável de
/// ambiente), não uma linguagem de expressão genérica.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparisonOperator {
    Equals,
    NotEquals,
    GreaterThan,
    LessThan,
}

/// Condição de um node `If`: `left`/`right` são strings de template (podem
/// conter `{{...}}`, resolvidas com a mesma máquina de substituição já usada
/// para requisições) comparadas com `operator`. A avaliação em si
/// (numérica quando os dois lados parseiam como número, textual caso
/// contrário) é responsabilidade do motor de execução (`alcy-app`), não do
/// domínio — este tipo só carrega os dados.
#[derive(Debug, Clone, PartialEq)]
pub struct Condition {
    pub left: String,
    pub operator: ComparisonOperator,
    pub right: String,
}

/// Operação de uma atribuição de um node `SetVariables` (spec 0083).
#[derive(Debug, Clone, PartialEq)]
pub enum VariableOperation {
    /// Define a variável com `value` — um template (`{{...}}`) resolvido no
    /// momento em que o node roda.
    Set { value: String },
    /// Soma `by` ao valor atual da variável (ausente conta como 0). Existe
    /// para contadores sem introduzir uma linguagem de expressão.
    Increment { by: f64 },
}

/// Uma atribuição de variável local de um run de flow. O nome não é
/// validado aqui — um nome inválido faz o node falhar na execução, para que
/// o flow continue salvável enquanto o usuário ainda está editando.
#[derive(Debug, Clone, PartialEq)]
pub struct VariableAssignment {
    pub name: String,
    pub operation: VariableOperation,
}

/// Mock server ligado por um node `MockStart` (spec 0120): um mock salvo do
/// workspace, resolvido ao vivo pelo id no momento da execução, ou um mock
/// avulso definido no próprio flow (cópia completa, como `InlineRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockServerSource {
    Saved { server_id: String },
    Inline { server: Box<MockServer> },
}

/// Comparação de um node `MockAssertCalls` entre as chamadas recebidas pela
/// rota e o número esperado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockCallCountOperator {
    Equals,
    AtLeast,
    AtMost,
}

/// Tipo de um node do flow. Enum fechado (não uma string livre) para que
/// adicionar tipos de node reais (ex.: requisição HTTP/GraphQL) no futuro
/// seja uma migração versionada e deliberada, não um valor arbitrário
/// vindo do frontend.
#[derive(Debug, Clone, PartialEq)]
pub enum FlowNodeKind {
    /// Node inicial, único por flow, não removível pela UI.
    Start,
    /// Bloco genérico sem comportamento de execução nesta etapa.
    Block { label: String },
    /// Referência a uma requisição salva de uma coleção, resolvida ao vivo
    /// pelo `request_id` no momento da execução (não uma cópia snapshot) —
    /// para refletir renomeações/edições feitas na coleção depois que o
    /// node foi criado (spec 0043). Tem duas saídas nomeadas — `"success"` (resposta com status < 400) e
    /// `"failure"` (erro de transporte ou status >= 400).
    Request { request_id: String },
    /// Ramifica a execução: avalia `condition` e só o ramo correspondente
    /// (edges saindo deste node com `source_handle` `"true"`/`"false"`)
    /// roda — o outro é pulado (spec 0047).
    If { condition: Condition },
    /// Anotação livre no canvas (spec 0083): não executa e não se conecta —
    /// `Flow::new` rejeita edges que entram ou saem dela. `width`/`height`
    /// são o tamanho da nota no canvas.
    Note {
        text: String,
        width: f64,
        height: f64,
    },
    /// Escreve `message` (template) no log do run.
    Log { message: String },
    /// Resolve `template` e mostra o valor no próprio node.
    Display { template: String },
    /// Espera `duration_ms` antes de seguir, sem bloquear ramos paralelos.
    Sleep { duration_ms: u64 },
    /// Define variáveis locais do run, visíveis como `{{nome}}` para os
    /// nodes seguintes e descartadas ao fim do run.
    SetVariables {
        assignments: Vec<VariableAssignment>,
    },
    /// Repete o corpo — nodes alcançáveis pelas edges `"loop"` — enquanto
    /// `condition` for verdadeira, até `max_iterations`; depois segue pelas
    /// edges `"done"` (spec 0084, ADR 0033).
    While {
        condition: Condition,
        max_iterations: u32,
    },
    /// Encerra o `While` mais interno que o contém: o que ainda não começou
    /// no corpo é pulado e o loop sai por `"done"` (spec 0085). Sem saídas.
    Break,
    /// Encerra só a iteração atual do `While` mais interno: o que ainda não
    /// começou no corpo é pulado e a condição é reavaliada. Sem saídas.
    Continue,
    /// Requisição definida no próprio flow, sem coleção (spec 0086) — cópia
    /// completa, editada no mesmo editor das requisições salvas. `id` e nome
    /// vêm junto, mas o id não aponta para nenhuma coleção. Mesmas saídas
    /// `"success"`/`"failure"` de `Request`.
    InlineRequest { request: Box<SavedRequest> },
    /// Bloco do motor de carga. Só é aceito em flows `Load`.
    Load { node: LoadNode },
    /// Liga um mock server durante o run (spec 0120). Os demais nodes de
    /// mock apontam para este node por `start_node_id`, não para o servidor,
    /// para que salvo e avulso funcionem igual. Ao fim do run o motor
    /// desliga o que este node ligou.
    MockStart { source: MockServerSource },
    /// Desliga o mock ligado pelo node `start_node_id`.
    MockStop { start_node_id: String },
    /// Espera a próxima chamada recebida pela rota `route_id` — saída
    /// `"true"` quando chega, `"false"` quando `timeout_ms` se esgota.
    MockWaitRequest {
        start_node_id: String,
        route_id: String,
        timeout_ms: u64,
    },
    /// Força a rota a responder com `response_id` (padrão ou alternativa)
    /// até o fim do run; `None` volta às regras normais.
    MockSetResponse {
        start_node_id: String,
        route_id: String,
        response_id: Option<String>,
    },
    /// Compara as chamadas recebidas pela rota desde que o run ligou o mock
    /// com `count` — saída `"true"` quando passa, `"false"` quando não.
    MockAssertCalls {
        start_node_id: String,
        route_id: String,
        operator: MockCallCountOperator,
        count: u32,
    },
}

impl FlowNodeKind {
    pub fn is_mock(&self) -> bool {
        matches!(
            self,
            Self::MockStart { .. }
                | Self::MockStop { .. }
                | Self::MockWaitRequest { .. }
                | Self::MockSetResponse { .. }
                | Self::MockAssertCalls { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlowNode {
    pub id: String,
    pub kind: FlowNodeKind,
    pub position: FlowPosition,
}

/// `source_handle` distingue qual saída de um node de múltiplas saídas uma
/// edge representa: `If` tem `Some("true")`/`Some("false")`, `Request` tem
/// `Some("success")`/`Some("failure")`, `While` tem `Some("loop")`/
/// `Some("done")` e `MockWaitRequest`/`MockAssertCalls` reaproveitam
/// `Some("true")`/`Some("false")`; toda edge saindo de qualquer outro
/// tipo de node é `None` (saída única, sem ambiguidade). Validado por
/// `Flow::new` contra o `FlowNodeKind` do node de origem.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowEdge {
    pub id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub source_handle: Option<String>,
}

/// Um flow: um diagrama nomeado de nodes conectados por edges, com posição
/// livre no canvas. O resultado de uma execução não faz parte do flow — é
/// reportado pelo motor (`alcy-app`) e gravado à parte no histórico.
#[derive(Debug, Clone, PartialEq)]
pub struct Flow {
    pub id: String,
    name: String,
    execution_kind: FlowExecutionKind,
    nodes: Vec<FlowNode>,
    edges: Vec<FlowEdge>,
    pub created_at: SystemTime,
    pub updated_at: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FlowError {
    #[error("nome do flow não pode ser vazio")]
    EmptyName,
    #[error("node '{0}' duplicado")]
    DuplicateNodeId(String),
    #[error("edge referencia node inexistente '{0}'")]
    EdgeReferencesUnknownNode(String),
    #[error(
        "edge '{0}' tem um handle de origem incompatível com o node de onde sai (nodes `If`, `MockWaitRequest` e `MockAssertCalls` exigem \"true\" ou \"false\"; nodes `Request` exigem \"success\" ou \"failure\"; nodes `While` exigem \"loop\" ou \"done\"; qualquer outro tipo de node exige nenhum handle)"
    )]
    InvalidEdgeHandle(String),
    #[error("edge '{0}' se conecta a uma anotação, que não tem entradas nem saídas")]
    NoteCannotConnect(String),
    #[error("edge '{0}' sai de um Break/Continue, que não tem saídas")]
    LoopControlHasNoOutput(String),
    #[error("node de carga '{0}' só é permitido em um flow de carga")]
    LoadNodeInStandardFlow(String),
    #[error("node de mock server '{0}' não é permitido em um flow de carga")]
    MockNodeInLoadFlow(String),
}

impl Flow {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        nodes: Vec<FlowNode>,
        edges: Vec<FlowEdge>,
        created_at: SystemTime,
        updated_at: SystemTime,
    ) -> Result<Self, FlowError> {
        Self::new_with_execution_kind(
            id,
            name,
            FlowExecutionKind::Standard,
            nodes,
            edges,
            created_at,
            updated_at,
        )
    }

    pub fn new_with_execution_kind(
        id: impl Into<String>,
        name: impl Into<String>,
        execution_kind: FlowExecutionKind,
        nodes: Vec<FlowNode>,
        edges: Vec<FlowEdge>,
        created_at: SystemTime,
        updated_at: SystemTime,
    ) -> Result<Self, FlowError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(FlowError::EmptyName);
        }

        let mut seen_node_ids = HashSet::new();
        for node in &nodes {
            if !seen_node_ids.insert(node.id.as_str()) {
                return Err(FlowError::DuplicateNodeId(node.id.clone()));
            }
        }

        if execution_kind == FlowExecutionKind::Standard
            && let Some(node) = nodes
                .iter()
                .find(|node| matches!(node.kind, FlowNodeKind::Load { .. }))
        {
            return Err(FlowError::LoadNodeInStandardFlow(node.id.clone()));
        }
        if execution_kind == FlowExecutionKind::Load
            && let Some(node) = nodes.iter().find(|node| node.kind.is_mock())
        {
            return Err(FlowError::MockNodeInLoadFlow(node.id.clone()));
        }

        let kind_by_id: HashMap<&str, &FlowNodeKind> = nodes
            .iter()
            .map(|node| (node.id.as_str(), &node.kind))
            .collect();

        for edge in &edges {
            if !seen_node_ids.contains(edge.source_node_id.as_str()) {
                return Err(FlowError::EdgeReferencesUnknownNode(
                    edge.source_node_id.clone(),
                ));
            }
            if !seen_node_ids.contains(edge.target_node_id.as_str()) {
                return Err(FlowError::EdgeReferencesUnknownNode(
                    edge.target_node_id.clone(),
                ));
            }

            let is_note =
                |node_id: &str| matches!(kind_by_id.get(node_id), Some(FlowNodeKind::Note { .. }));
            if is_note(&edge.source_node_id) || is_note(&edge.target_node_id) {
                return Err(FlowError::NoteCannotConnect(edge.id.clone()));
            }
            if matches!(
                kind_by_id.get(edge.source_node_id.as_str()),
                Some(FlowNodeKind::Break | FlowNodeKind::Continue)
            ) {
                return Err(FlowError::LoopControlHasNoOutput(edge.id.clone()));
            }

            let source_kind = kind_by_id.get(edge.source_node_id.as_str());
            let handle_is_valid = match source_kind {
                Some(
                    FlowNodeKind::If { .. }
                    | FlowNodeKind::MockWaitRequest { .. }
                    | FlowNodeKind::MockAssertCalls { .. },
                ) => {
                    matches!(edge.source_handle.as_deref(), Some("true") | Some("false"))
                }
                Some(FlowNodeKind::Request { .. } | FlowNodeKind::InlineRequest { .. }) => {
                    matches!(
                        edge.source_handle.as_deref(),
                        Some("success") | Some("failure")
                    )
                }
                Some(FlowNodeKind::While { .. }) => {
                    matches!(edge.source_handle.as_deref(), Some("loop") | Some("done"))
                }
                Some(FlowNodeKind::Load { node }) => {
                    node.kind.allows_handle(edge.source_handle.as_deref())
                }
                _ => edge.source_handle.is_none(),
            };
            if !handle_is_valid {
                return Err(FlowError::InvalidEdgeHandle(edge.id.clone()));
            }
        }

        Ok(Self {
            id: id.into(),
            name,
            execution_kind,
            nodes,
            edges,
            created_at,
            updated_at,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn execution_kind(&self) -> FlowExecutionKind {
        self.execution_kind
    }

    pub fn nodes(&self) -> &[FlowNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[FlowEdge] {
        &self.edges
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_node() -> FlowNode {
        FlowNode {
            id: "start".to_string(),
            kind: FlowNodeKind::Start,
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    fn block_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::Block {
                label: "Block".to_string(),
            },
            position: FlowPosition { x: 100.0, y: 0.0 },
        }
    }

    #[test]
    fn accepts_a_valid_flow() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), block_node("block-1")],
            vec![FlowEdge {
                id: "edge-1".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "block-1".to_string(),
                source_handle: None,
            }],
            now,
            now,
        )
        .unwrap();

        assert_eq!(flow.name(), "My flow");
        assert_eq!(flow.nodes().len(), 2);
        assert_eq!(flow.edges().len(), 1);
    }

    #[test]
    fn rejects_an_empty_name() {
        let now = SystemTime::now();
        assert_eq!(
            Flow::new("flow-1", "", vec![start_node()], vec![], now, now),
            Err(FlowError::EmptyName)
        );
        assert_eq!(
            Flow::new("flow-1", "   ", vec![start_node()], vec![], now, now),
            Err(FlowError::EmptyName)
        );
    }

    #[test]
    fn rejects_duplicate_node_ids() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), start_node()],
            vec![],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::DuplicateNodeId("start".to_string()));
    }

    #[test]
    fn rejects_an_edge_referencing_an_unknown_node() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node()],
            vec![FlowEdge {
                id: "edge-1".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "missing".to_string(),
                source_handle: None,
            }],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(
            error,
            FlowError::EdgeReferencesUnknownNode("missing".to_string())
        );
    }

    fn if_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::If {
                condition: Condition {
                    left: "{{nodes.a.response.status}}".to_string(),
                    operator: ComparisonOperator::Equals,
                    right: "200".to_string(),
                },
            },
            position: FlowPosition { x: 200.0, y: 0.0 },
        }
    }

    #[test]
    fn accepts_true_and_false_edges_leaving_an_if_node() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                if_node("if-1"),
                block_node("a"),
                block_node("b"),
            ],
            vec![
                FlowEdge {
                    id: "edge-1".to_string(),
                    source_node_id: "start".to_string(),
                    target_node_id: "if-1".to_string(),
                    source_handle: None,
                },
                FlowEdge {
                    id: "edge-2".to_string(),
                    source_node_id: "if-1".to_string(),
                    target_node_id: "a".to_string(),
                    source_handle: Some("true".to_string()),
                },
                FlowEdge {
                    id: "edge-3".to_string(),
                    source_node_id: "if-1".to_string(),
                    target_node_id: "b".to_string(),
                    source_handle: Some("false".to_string()),
                },
            ],
            now,
            now,
        )
        .unwrap();

        assert_eq!(flow.edges().len(), 3);
    }

    #[test]
    fn rejects_an_edge_leaving_an_if_node_without_a_true_or_false_handle() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), if_node("if-1"), block_node("a")],
            vec![
                FlowEdge {
                    id: "edge-1".to_string(),
                    source_node_id: "start".to_string(),
                    target_node_id: "if-1".to_string(),
                    source_handle: None,
                },
                FlowEdge {
                    id: "edge-2".to_string(),
                    source_node_id: "if-1".to_string(),
                    target_node_id: "a".to_string(),
                    source_handle: None,
                },
            ],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-2".to_string()));
    }

    fn request_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::Request {
                request_id: "request-1".to_string(),
            },
            position: FlowPosition { x: 200.0, y: 0.0 },
        }
    }

    fn edge_with_handle(id: &str, source: &str, target: &str, handle: Option<&str>) -> FlowEdge {
        FlowEdge {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: handle.map(str::to_string),
        }
    }

    #[test]
    fn accepts_success_and_failure_edges_leaving_a_request_node() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                request_node("req-1"),
                block_node("a"),
                block_node("b"),
            ],
            vec![
                edge_with_handle("edge-1", "start", "req-1", None),
                edge_with_handle("edge-2", "req-1", "a", Some("success")),
                edge_with_handle("edge-3", "req-1", "b", Some("failure")),
            ],
            now,
            now,
        )
        .unwrap();

        assert_eq!(flow.edges().len(), 3);
    }

    #[test]
    fn rejects_an_edge_leaving_a_request_node_without_a_success_or_failure_handle() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), request_node("req-1"), block_node("a")],
            vec![edge_with_handle("edge-1", "req-1", "a", None)],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_an_if_handle_on_an_edge_leaving_a_request_node() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), request_node("req-1"), block_node("a")],
            vec![edge_with_handle("edge-1", "req-1", "a", Some("true"))],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_a_handle_on_an_edge_leaving_a_non_if_node() {
        let now = SystemTime::now();
        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), block_node("a")],
            vec![FlowEdge {
                id: "edge-1".to_string(),
                source_node_id: "start".to_string(),
                target_node_id: "a".to_string(),
                source_handle: Some("true".to_string()),
            }],
            now,
            now,
        )
        .unwrap_err();

        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_an_edge_touching_a_note() {
        let now = SystemTime::now();
        let note = FlowNode {
            id: "note-1".to_string(),
            kind: FlowNodeKind::Note {
                text: "lembrete".to_string(),
                width: 200.0,
                height: 120.0,
            },
            position: FlowPosition { x: 0.0, y: 200.0 },
        };

        let into_note = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), note.clone()],
            vec![edge_with_handle("edge-1", "start", "note-1", None)],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(
            into_note,
            FlowError::NoteCannotConnect("edge-1".to_string())
        );

        let out_of_note = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), note, block_node("a")],
            vec![edge_with_handle("edge-2", "note-1", "a", None)],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(
            out_of_note,
            FlowError::NoteCannotConnect("edge-2".to_string())
        );
    }

    #[test]
    fn accepts_loop_and_done_edges_leaving_a_while_node_and_rejects_others() {
        let now = SystemTime::now();
        let while_node = FlowNode {
            id: "while-1".to_string(),
            kind: FlowNodeKind::While {
                condition: Condition {
                    left: "{{i}}".to_string(),
                    operator: ComparisonOperator::LessThan,
                    right: "3".to_string(),
                },
                max_iterations: 100,
            },
            position: FlowPosition { x: 0.0, y: 0.0 },
        };

        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                while_node.clone(),
                block_node("a"),
                block_node("b"),
            ],
            vec![
                edge_with_handle("edge-1", "start", "while-1", None),
                edge_with_handle("edge-2", "while-1", "a", Some("loop")),
                edge_with_handle("edge-3", "while-1", "b", Some("done")),
            ],
            now,
            now,
        )
        .unwrap();
        assert_eq!(flow.edges().len(), 3);

        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), while_node, block_node("a")],
            vec![edge_with_handle("edge-1", "while-1", "a", Some("true"))],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_an_edge_leaving_a_break_or_continue_node() {
        let now = SystemTime::now();
        for kind in [FlowNodeKind::Break, FlowNodeKind::Continue] {
            let control = FlowNode {
                id: "control".to_string(),
                kind,
                position: FlowPosition { x: 0.0, y: 0.0 },
            };
            let error = Flow::new(
                "flow-1",
                "My flow",
                vec![start_node(), control, block_node("a")],
                vec![
                    edge_with_handle("edge-1", "start", "control", None),
                    edge_with_handle("edge-2", "control", "a", None),
                ],
                now,
                now,
            )
            .unwrap_err();
            assert_eq!(
                error,
                FlowError::LoopControlHasNoOutput("edge-2".to_string())
            );
        }
    }

    fn mock_wait_node(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind: FlowNodeKind::MockWaitRequest {
                start_node_id: "mock-1".to_string(),
                route_id: "route-1".to_string(),
                timeout_ms: 1_000,
            },
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn accepts_true_and_false_edges_leaving_mock_branch_nodes_and_rejects_others() {
        let now = SystemTime::now();
        let flow = Flow::new(
            "flow-1",
            "My flow",
            vec![
                start_node(),
                mock_wait_node("wait-1"),
                block_node("a"),
                block_node("b"),
            ],
            vec![
                edge_with_handle("edge-1", "start", "wait-1", None),
                edge_with_handle("edge-2", "wait-1", "a", Some("true")),
                edge_with_handle("edge-3", "wait-1", "b", Some("false")),
            ],
            now,
            now,
        )
        .unwrap();
        assert_eq!(flow.edges().len(), 3);

        let error = Flow::new(
            "flow-1",
            "My flow",
            vec![start_node(), mock_wait_node("wait-1"), block_node("a")],
            vec![edge_with_handle("edge-1", "wait-1", "a", None)],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(error, FlowError::InvalidEdgeHandle("edge-1".to_string()));
    }

    #[test]
    fn rejects_mock_nodes_in_a_load_flow() {
        let now = SystemTime::now();
        let error = Flow::new_with_execution_kind(
            "flow-1",
            "My flow",
            FlowExecutionKind::Load,
            vec![start_node(), mock_wait_node("wait-1")],
            vec![],
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(error, FlowError::MockNodeInLoadFlow("wait-1".to_string()));
    }
}
