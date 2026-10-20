import type { FlowNode } from './flow-canvas-mapping'
import { flowNodeSize } from './flow-geometry'
import type { LayoutEdge, LayoutGraph } from './flow-layout'
import { LOAD_NODE_DEFINITIONS } from './load-node-config'
import type { LoadNodeKindState } from './flows.types'

/** Convert React Flow's measured presentation into a small worker-safe graph. */
export function flowLayoutModel(nodes: FlowNode[], edges: LayoutEdge[]): LayoutGraph {
  return { edges: edges.map(({ source, target, sourceHandle }) => ({ source, target, sourceHandle })), nodes: nodes.map((node) => {
    let outputs = ['request', 'inlineRequest', 'if', 'while', 'mockWaitRequest', 'mockAssertCalls'].includes(node.type ?? '') ? 2 : 0
    if (node.type === 'block' && node.data.loadKind) {
      const declared = LOAD_NODE_DEFINITIONS[node.data.loadKind as LoadNodeKindState]?.outputs
      outputs = Array.isArray(declared) ? declared.length : 0
    }
    const size = flowNodeSize(node.type ?? 'block', outputs)
    return { id: node.id, kind: node.type ?? 'block', position: { ...node.position }, width: node.measured?.width ?? node.width ?? size.width, height: node.measured?.height ?? node.height ?? size.height }
  }) }
}

export const layoutSignature = (graph: LayoutGraph) => JSON.stringify(graph)
