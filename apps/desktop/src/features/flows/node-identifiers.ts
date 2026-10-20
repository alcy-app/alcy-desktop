import type { FlowEdgeState, FlowNodeState } from './flows.types'

/** Node IDs already form the reference namespace; keep its existing persisted contract. */
export function availableNodeIdentifier(name: string, nodes: readonly { id: string }[]): string {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'node'
  const prefix = /^[a-z]/.test(base) ? base : `node_${base}`
  const used = new Set(nodes.map((node) => node.id))
  let result = prefix
  for (let index = 2; used.has(result); index++) result = `${prefix}_${index}`
  return result
}

export function identifierError(id: string, previous: string, nodes: readonly { id: string }[]): 'invalid' | 'duplicate' | null {
  if (id === previous) return null
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return 'invalid'
  return nodes.some((node) => node.id === id) ? 'duplicate' : null
}

/** Only rewrite explicit template references, preserving unrelated IDs, text and URLs. */
export function renameNodeReferences<T>(value: T, previous: string, next: string): T {
  if (typeof value === 'string') return value.replace(/\{\{\s*nodes\.([^.\s{}]+)\./g, (match, id: string) => id === previous ? match.replace(`nodes.${previous}.`, `nodes.${next}.`) : match) as T
  if (Array.isArray(value)) return value.map((item: unknown) => renameNodeReferences(item, previous, next)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renameNodeReferences(item, previous, next)])) as T
  return value
}

export function renameGraphNode(nodes: FlowNodeState[], edges: FlowEdgeState[], previous: string, next: string) {
  const renamed = nodes.map((node): FlowNodeState => {
    let updated = renameNodeReferences(node, previous, next)
    if (updated.id === previous) updated = { ...updated, id: next }
    if ('startNodeId' in updated && updated.startNodeId === previous) updated = { ...updated, startNodeId: next }
    // Load configuration is stored as JSON text, so template replacements above also cover its values.
    return updated
  })
  return { nodes: renamed, edges: edges.map((edge) => ({ ...edge, sourceNodeId: edge.sourceNodeId === previous ? next : edge.sourceNodeId, targetNodeId: edge.targetNodeId === previous ? next : edge.targetNodeId })) }
}
