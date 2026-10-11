use std::collections::{HashMap, HashSet, VecDeque};

use alcy_domain::{Flow, FlowNodeKind};

use crate::execute_flow::FlowRunError;

/// Saída de um `While` que leva ao corpo do loop (ADR 0033).
pub(crate) const LOOP_HANDLE: &str = "loop";

/// Um sucessor de um node, junto do handle de origem da edge que os liga —
/// `None` para toda edge saindo de um node de saída única;
/// `Some("true"|"false")` para as edges de um `If`, `Some("success"|"failure")`
/// para as de um `Request` e `Some("done")` para a saída de um `While`. O
/// scheduler (`execute_flow.rs`) usa isso para só propagar a execução pelo
/// ramo decidido, sem deixar o ramo não escolhido travado (grau de entrada
/// nunca chegando a zero). As edges `"loop"` de um `While` não entram aqui —
/// ver `FlowGraph::loop_bodies`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Successor {
    pub(crate) target_node_id: String,
    pub(crate) source_handle: Option<String>,
}

/// Forma estrutural de um flow, pronta para um scheduler dinâmico decidir
/// node a node o que despachar em seguida — nenhuma noção de "onda"/camada
/// de execução. Puro/sem I/O — só depende da forma do grafo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FlowGraph {
    /// `source_node_id -> [Successor]`, a partir de todas as edges exceto as
    /// `"loop"` de um `While` (o corpo é disparado pelo próprio `While`).
    pub(crate) successors: HashMap<String, Vec<Successor>>,
    /// Grau de entrada inicial de cada node alcançável a partir do Start
    /// (edges saindo do Start e edges `"loop"` não contam — o Start está
    /// sempre resolvido antes de qualquer node real, e as entradas de um
    /// corpo são disparadas pelo `While`). Um node do nível de cima (sem
    /// dono em `loop_owners`) com grau 0 está pronto assim que o run começa.
    pub(crate) initial_in_degree: HashMap<String, usize>,
    /// Nodes sem caminho a partir do Start.
    pub(crate) unreachable: Vec<String>,
    /// Predecessores reais (diretos ou transitivos, via edge) de cada node
    /// alcançável — usado para validar que `{{nodes.<id>...}}` só resolve
    /// para uma dependência de verdade, não qualquer node que já tenha
    /// terminado.
    pub(crate) ancestors: HashMap<String, HashSet<String>>,
    /// `While -> todos os nodes do corpo` (inclusive os de `While`s
    /// aninhados): o que é alcançável pelas edges `"loop"` dele.
    pub(crate) loop_bodies: HashMap<String, HashSet<String>>,
    /// `node -> While` mais interno cujo corpo o contém. Nodes do nível de
    /// cima não aparecem.
    pub(crate) loop_owners: HashMap<String, String>,
    /// `While -> nodes` dos quais ele é o dono direto — os que precisam
    /// concluir para uma iteração terminar.
    pub(crate) loop_members: HashMap<String, Vec<String>>,
}

/// Calcula a forma do grafo via BFS (alcançabilidade a partir do Start)
/// seguido do algoritmo de Kahn restrito ao subgrafo alcançável — arestas
/// que saem do Start não contam para o grau de entrada de um node, já que o
/// Start está sempre resolvido antes de qualquer node real ser despachado.
/// Um node alcançável que sobra depois do algoritmo de Kahn terminar indica
/// um ciclo alcançável a partir do Start. Depois, delimita o corpo de cada
/// `While` e exige que seja fechado (ADR 0033).
pub(crate) fn build_flow_graph(flow: &Flow) -> Result<FlowGraph, FlowRunError> {
    let start_id = flow
        .nodes()
        .iter()
        .find(|node| matches!(node.kind, FlowNodeKind::Start))
        .map(|node| node.id.as_str())
        .ok_or(FlowRunError::MissingStartNode)?;

    let while_ids: HashSet<&str> = flow
        .nodes()
        .iter()
        .filter(|node| matches!(node.kind, FlowNodeKind::While { .. }))
        .map(|node| node.id.as_str())
        .collect();
    let is_loop_edge = |source: &str, handle: Option<&str>| {
        while_ids.contains(source) && handle == Some(LOOP_HANDLE)
    };

    let mut successors: HashMap<&str, Vec<(&str, Option<&str>)>> = HashMap::new();
    for edge in flow.edges() {
        successors
            .entry(edge.source_node_id.as_str())
            .or_default()
            .push((edge.target_node_id.as_str(), edge.source_handle.as_deref()));
    }

    let mut reachable: HashSet<&str> = HashSet::new();
    let mut visited: HashSet<&str> = HashSet::new();
    visited.insert(start_id);
    let mut queue: VecDeque<&str> = VecDeque::new();
    queue.push_back(start_id);
    while let Some(current) = queue.pop_front() {
        for &(next, _) in successors.get(current).into_iter().flatten() {
            if visited.insert(next) {
                reachable.insert(next);
                queue.push_back(next);
            }
        }
    }

    // Anotações não se conectam (`Flow::new`) e não fazem parte da execução
    // — ficam fora até da lista de inalcançáveis, para não gerar evento.
    let unreachable: Vec<String> = flow
        .nodes()
        .iter()
        .filter(|node| !matches!(node.kind, FlowNodeKind::Note { .. }))
        .map(|node| node.id.as_str())
        .filter(|&id| id != start_id && !reachable.contains(id))
        .map(str::to_string)
        .collect();

    // Grau de entrada com todas as edges (inclusive `"loop"`) — só para o
    // Kahn, que detecta ciclos e calcula ancestrais: os nodes antes de um
    // `While` são ancestrais do corpo dele.
    let mut full_in_degree: HashMap<&str, usize> = reachable.iter().map(|&id| (id, 0)).collect();
    // Grau de entrada do scheduler — sem as edges `"loop"`.
    let mut in_degree: HashMap<&str, usize> = reachable.iter().map(|&id| (id, 0)).collect();
    for edge in flow.edges() {
        if edge.source_node_id == start_id {
            continue;
        }
        let source = edge.source_node_id.as_str();
        let target = edge.target_node_id.as_str();
        if !reachable.contains(source) || !reachable.contains(target) {
            continue;
        }
        if let Some(degree) = full_in_degree.get_mut(target) {
            *degree += 1;
        }
        if !is_loop_edge(source, edge.source_handle.as_deref())
            && let Some(degree) = in_degree.get_mut(target)
        {
            *degree += 1;
        }
    }

    let mut ancestors: HashMap<&str, HashSet<&str>> =
        reachable.iter().map(|&id| (id, HashSet::new())).collect();
    let mut working_in_degree = full_in_degree;
    let mut ready: VecDeque<&str> = working_in_degree
        .iter()
        .filter(|&(_, &degree)| degree == 0)
        .map(|(&id, _)| id)
        .collect();

    let mut processed = 0usize;
    while let Some(node_id) = ready.pop_front() {
        processed += 1;

        let mut node_and_ancestors: HashSet<&str> =
            ancestors.get(node_id).cloned().unwrap_or_default();
        node_and_ancestors.insert(node_id);

        for &(next, _) in successors.get(node_id).into_iter().flatten() {
            let Some(degree) = working_in_degree.get_mut(next) else {
                continue;
            };
            if let Some(next_ancestors) = ancestors.get_mut(next) {
                next_ancestors.extend(node_and_ancestors.iter().copied());
            }
            *degree -= 1;
            if *degree == 0 {
                ready.push_back(next);
            }
        }
    }

    if processed != reachable.len() {
        return Err(FlowRunError::CyclicGraph);
    }

    let loop_bodies = loop_bodies(flow, &successors, &reachable, &while_ids)?;
    let loop_owners = loop_owners(&loop_bodies);
    let mut loop_members: HashMap<String, Vec<String>> = loop_bodies
        .keys()
        .map(|while_id| (while_id.clone(), Vec::new()))
        .collect();
    for (node_id, owner) in &loop_owners {
        if let Some(members) = loop_members.get_mut(owner) {
            members.push(node_id.clone());
        }
    }

    Ok(FlowGraph {
        successors: successors
            .into_iter()
            .map(|(id, targets)| {
                (
                    id.to_string(),
                    targets
                        .into_iter()
                        .filter(|&(_, source_handle)| !is_loop_edge(id, source_handle))
                        .map(|(target_node_id, source_handle)| Successor {
                            target_node_id: target_node_id.to_string(),
                            source_handle: source_handle.map(str::to_string),
                        })
                        .collect(),
                )
            })
            .collect(),
        initial_in_degree: in_degree
            .into_iter()
            .map(|(id, degree)| (id.to_string(), degree))
            .collect(),
        unreachable,
        ancestors: ancestors
            .into_iter()
            .map(|(id, ancestors)| {
                (
                    id.to_string(),
                    ancestors.into_iter().map(str::to_string).collect(),
                )
            })
            .collect(),
        loop_bodies,
        loop_owners,
        loop_members,
    })
}

/// Corpo de cada `While` alcançável: tudo o que é alcançável pelas edges
/// `"loop"` dele. Rejeita um corpo aberto — uma edge saindo do corpo para
/// fora dele, ou entrando nele por outro caminho que não a própria `"loop"`
/// (ADR 0033). Com corpos fechados, corpos de `While`s diferentes são
/// disjuntos ou aninhados.
fn loop_bodies(
    flow: &Flow,
    successors: &HashMap<&str, Vec<(&str, Option<&str>)>>,
    reachable: &HashSet<&str>,
    while_ids: &HashSet<&str>,
) -> Result<HashMap<String, HashSet<String>>, FlowRunError> {
    let mut bodies = HashMap::new();

    for &while_id in while_ids.iter().filter(|&&id| reachable.contains(id)) {
        let mut body: HashSet<&str> = HashSet::new();
        let mut queue: VecDeque<&str> = successors
            .get(while_id)
            .into_iter()
            .flatten()
            .filter(|&&(_, handle)| handle == Some(LOOP_HANDLE))
            .map(|&(target, _)| target)
            .collect();
        while let Some(current) = queue.pop_front() {
            if body.insert(current) {
                for &(next, _) in successors.get(current).into_iter().flatten() {
                    queue.push_back(next);
                }
            }
        }

        for edge in flow.edges() {
            let source_inside = body.contains(edge.source_node_id.as_str());
            let target_inside = body.contains(edge.target_node_id.as_str());
            let is_own_loop_edge = edge.source_node_id == while_id
                && edge.source_handle.as_deref() == Some(LOOP_HANDLE);
            if (source_inside && !target_inside)
                || (!source_inside && target_inside && !is_own_loop_edge)
            {
                return Err(FlowRunError::InvalidLoopBody {
                    while_node_id: while_id.to_string(),
                });
            }
        }

        bodies.insert(
            while_id.to_string(),
            body.into_iter().map(str::to_string).collect(),
        );
    }

    Ok(bodies)
}

/// Dono de cada node dentro de algum corpo: o `While` de menor corpo que o
/// contém — o mais interno, já que corpos são disjuntos ou aninhados.
fn loop_owners(loop_bodies: &HashMap<String, HashSet<String>>) -> HashMap<String, String> {
    let mut owners: HashMap<String, String> = HashMap::new();
    for (while_id, body) in loop_bodies {
        for node_id in body {
            let is_inner = owners
                .get(node_id)
                .and_then(|current| loop_bodies.get(current))
                .is_none_or(|current_body| body.len() < current_body.len());
            if is_inner {
                owners.insert(node_id.clone(), while_id.clone());
            }
        }
    }
    owners
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{FlowEdge, FlowNode, FlowPosition};
    use std::time::SystemTime;

    fn node(id: &str, kind: FlowNodeKind) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            kind,
            position: FlowPosition { x: 0.0, y: 0.0 },
        }
    }

    fn block(id: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::Block {
                label: id.to_string(),
            },
        )
    }

    fn edge(id: &str, source: &str, target: &str) -> FlowEdge {
        FlowEdge {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: None,
        }
    }

    fn handled_edge(id: &str, source: &str, target: &str, source_handle: &str) -> FlowEdge {
        FlowEdge {
            id: id.to_string(),
            source_node_id: source.to_string(),
            target_node_id: target.to_string(),
            source_handle: Some(source_handle.to_string()),
        }
    }

    fn build_flow(nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) -> Flow {
        let now = SystemTime::now();
        Flow::new("flow-1", "My flow", nodes, edges, now, now).unwrap()
    }

    fn ancestors_of<'a>(graph: &'a FlowGraph, node_id: &str) -> HashSet<&'a str> {
        graph
            .ancestors
            .get(node_id)
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn a_flow_with_only_start_has_no_reachable_nodes() {
        let flow = build_flow(vec![node("start", FlowNodeKind::Start)], vec![]);

        let graph = build_flow_graph(&flow).unwrap();

        assert!(graph.initial_in_degree.is_empty());
        assert!(graph.unreachable.is_empty());
    }

    #[test]
    fn nodes_directly_connected_to_start_have_zero_initial_in_degree() {
        let flow = build_flow(
            vec![node("start", FlowNodeKind::Start), block("a"), block("b")],
            vec![edge("e1", "start", "a"), edge("e2", "start", "b")],
        );

        let graph = build_flow_graph(&flow).unwrap();

        assert_eq!(graph.initial_in_degree.get("a"), Some(&0));
        assert_eq!(graph.initial_in_degree.get("b"), Some(&0));
        assert!(ancestors_of(&graph, "a").is_empty());
        assert!(ancestors_of(&graph, "b").is_empty());
    }

    #[test]
    fn a_chain_accumulates_ancestors_along_the_way() {
        let flow = build_flow(
            vec![node("start", FlowNodeKind::Start), block("a"), block("b")],
            vec![edge("e1", "start", "a"), edge("e2", "a", "b")],
        );

        let graph = build_flow_graph(&flow).unwrap();

        assert_eq!(graph.initial_in_degree.get("a"), Some(&0));
        assert_eq!(graph.initial_in_degree.get("b"), Some(&1));
        assert!(ancestors_of(&graph, "a").is_empty());
        assert_eq!(ancestors_of(&graph, "b"), HashSet::from(["a"]));
    }

    #[test]
    fn a_diamond_joins_ancestors_from_both_branches() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                block("a"),
                block("b"),
                block("join"),
            ],
            vec![
                edge("e1", "start", "a"),
                edge("e2", "start", "b"),
                edge("e3", "a", "join"),
                edge("e4", "b", "join"),
            ],
        );

        let graph = build_flow_graph(&flow).unwrap();

        assert_eq!(graph.initial_in_degree.get("join"), Some(&2));
        assert_eq!(ancestors_of(&graph, "join"), HashSet::from(["a", "b"]));
    }

    #[test]
    fn nodes_without_a_path_from_start_are_reported_as_unreachable() {
        let flow = build_flow(
            vec![node("start", FlowNodeKind::Start), block("island")],
            vec![],
        );

        let graph = build_flow_graph(&flow).unwrap();

        assert!(graph.initial_in_degree.is_empty());
        assert_eq!(graph.unreachable, vec!["island".to_string()]);
    }

    #[test]
    fn a_cycle_reachable_from_start_is_reported() {
        let flow = build_flow(
            vec![node("start", FlowNodeKind::Start), block("a"), block("b")],
            vec![
                edge("e1", "start", "a"),
                edge("e2", "a", "b"),
                edge("e3", "b", "a"),
            ],
        );

        let error = build_flow_graph(&flow).unwrap_err();

        assert_eq!(error, FlowRunError::CyclicGraph);
    }

    #[test]
    fn a_cycle_unreachable_from_start_does_not_fail_the_graph() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                block("a"),
                block("island-1"),
                block("island-2"),
            ],
            vec![
                edge("e1", "start", "a"),
                edge("e2", "island-1", "island-2"),
                edge("e3", "island-2", "island-1"),
            ],
        );

        let graph = build_flow_graph(&flow).unwrap();

        assert_eq!(graph.initial_in_degree.get("a"), Some(&0));
        assert_eq!(
            graph.unreachable,
            vec!["island-1".to_string(), "island-2".to_string()]
        );
    }

    #[test]
    fn a_flow_without_a_start_node_is_rejected() {
        let flow = build_flow(vec![block("a")], vec![]);

        let error = build_flow_graph(&flow).unwrap_err();

        assert_eq!(error, FlowRunError::MissingStartNode);
    }

    fn if_node(id: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::If {
                condition: alcy_domain::Condition {
                    left: "1".to_string(),
                    operator: alcy_domain::ComparisonOperator::Equals,
                    right: "1".to_string(),
                },
            },
        )
    }

    #[test]
    fn successors_carry_the_source_handle_of_each_edge() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                if_node("if-1"),
                block("a"),
                block("b"),
            ],
            vec![
                edge("e1", "start", "if-1"),
                handled_edge("e2", "if-1", "a", "true"),
                handled_edge("e3", "if-1", "b", "false"),
            ],
        );

        let graph = build_flow_graph(&flow).unwrap();

        let if_successors = graph.successors.get("if-1").unwrap();
        assert_eq!(
            if_successors
                .iter()
                .find(|successor| successor.target_node_id == "a")
                .and_then(|successor| successor.source_handle.as_deref()),
            Some("true")
        );
        assert_eq!(
            if_successors
                .iter()
                .find(|successor| successor.target_node_id == "b")
                .and_then(|successor| successor.source_handle.as_deref()),
            Some("false")
        );
    }

    fn while_node(id: &str) -> FlowNode {
        node(
            id,
            FlowNodeKind::While {
                condition: alcy_domain::Condition {
                    left: "{{i}}".to_string(),
                    operator: alcy_domain::ComparisonOperator::LessThan,
                    right: "3".to_string(),
                },
                max_iterations: 10,
            },
        )
    }

    #[test]
    fn a_while_body_is_what_its_loop_edges_reach_and_nested_bodies_have_the_innermost_owner() {
        // start -> outer -loop-> a -> inner -loop-> b ; inner -done-> c ; outer -done-> d
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                while_node("outer"),
                while_node("inner"),
                block("a"),
                block("b"),
                block("c"),
                block("d"),
            ],
            vec![
                edge("e1", "start", "outer"),
                handled_edge("e2", "outer", "a", "loop"),
                edge("e3", "a", "inner"),
                handled_edge("e4", "inner", "b", "loop"),
                handled_edge("e5", "inner", "c", "done"),
                handled_edge("e6", "outer", "d", "done"),
            ],
        );

        let graph = build_flow_graph(&flow).unwrap();

        let outer_body: HashSet<&str> = graph.loop_bodies["outer"]
            .iter()
            .map(String::as_str)
            .collect();
        assert_eq!(outer_body, HashSet::from(["a", "inner", "b", "c"]));
        assert_eq!(graph.loop_owners["a"], "outer");
        assert_eq!(graph.loop_owners["inner"], "outer");
        assert_eq!(graph.loop_owners["c"], "outer");
        assert_eq!(graph.loop_owners["b"], "inner");
        assert!(!graph.loop_owners.contains_key("d"));
        // Edges `loop` não contam no grau de entrada nem viram sucessores.
        assert_eq!(graph.initial_in_degree["a"], 0);
        assert_eq!(graph.initial_in_degree["b"], 0);
        assert!(
            graph.successors["outer"]
                .iter()
                .all(|successor| successor.source_handle.as_deref() == Some("done"))
        );
        // Mas o `While` e o que vem antes dele são ancestrais do corpo.
        assert!(ancestors_of(&graph, "b").contains("outer"));
    }

    #[test]
    fn a_body_with_an_edge_leaving_it_is_rejected() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                while_node("w"),
                block("a"),
                block("b"),
            ],
            vec![
                edge("e1", "start", "w"),
                handled_edge("e2", "w", "a", "loop"),
                handled_edge("e3", "w", "b", "done"),
                edge("e4", "a", "b"),
            ],
        );

        assert_eq!(
            build_flow_graph(&flow).unwrap_err(),
            FlowRunError::InvalidLoopBody {
                while_node_id: "w".to_string()
            }
        );
    }

    #[test]
    fn a_body_entered_from_outside_the_loop_edge_is_rejected() {
        let flow = build_flow(
            vec![
                node("start", FlowNodeKind::Start),
                while_node("w"),
                block("a"),
            ],
            vec![
                edge("e1", "start", "w"),
                handled_edge("e2", "w", "a", "loop"),
                edge("e3", "start", "a"),
            ],
        );

        assert_eq!(
            build_flow_graph(&flow).unwrap_err(),
            FlowRunError::InvalidLoopBody {
                while_node_id: "w".to_string()
            }
        );
    }
}
