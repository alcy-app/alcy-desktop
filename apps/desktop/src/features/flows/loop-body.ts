import type { FlowEdgeState } from './flows.types'

/** Nodes alcançáveis pelas edges `loop` de `whileId` — o corpo do loop,
 * inclusive corpos aninhados. Espelha `loop_bodies` em
 * `crates/alcy-app/src/flow_graph.rs` (ADR 0033). */
export function loopBodyOf(whileId: string, edges: FlowEdgeState[]): Set<string> {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.sourceNodeId) ?? []
    list.push(edge.targetNodeId)
    outgoing.set(edge.sourceNodeId, list)
  }
  const body = new Set<string>()
  const queue = edges.filter((edge) => edge.sourceNodeId === whileId && edge.sourceHandle === 'loop').map((edge) => edge.targetNodeId)
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (body.has(current)) continue
    body.add(current)
    queue.push(...(outgoing.get(current) ?? []))
  }
  return body
}

/** `while`s cujo corpo está aberto: uma edge sai do corpo para fora, ou entra
 * nele por outro caminho que não a própria saída `loop`. O motor rejeita o
 * run nesses casos; o canvas usa isso para recusar a conexão antes. */
export function whilesWithOpenBody(whileIds: string[], edges: FlowEdgeState[]): Set<string> {
  const open = new Set<string>()
  for (const whileId of whileIds) {
    const body = loopBodyOf(whileId, edges)
    const crossesBoundary = edges.some((edge) => {
      const sourceInside = body.has(edge.sourceNodeId)
      const targetInside = body.has(edge.targetNodeId)
      const isOwnLoopEdge = edge.sourceNodeId === whileId && edge.sourceHandle === 'loop'
      return (sourceInside && !targetInside) || (!sourceInside && targetInside && !isOwnLoopEdge)
    })
    if (crossesBoundary) open.add(whileId)
  }
  return open
}
