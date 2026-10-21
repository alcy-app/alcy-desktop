import { MarkerType } from '@xyflow/react'
import type { Edge, EdgeMarker, ReactFlowInstance, Viewport } from '@xyflow/react'
import type { BlockNodeType } from './BlockNode'
import { isFlowSourceHandle, isSimpleNode, isSimpleNodeKind, simpleNodeConfig } from './flows.types'
import type { FlowEdgeState, FlowNodeState, FlowSourceHandle } from './flows.types'
import type { IfNodeType } from './IfNode'
import type { RequestNodeType } from './RequestNode'
import { simpleFlowNode } from './simple-node-types'
import type { SimpleFlowNodeType } from './simple-node-types'
import type { StartNodeType } from './StartNode'

export type FlowNode = StartNodeType | BlockNodeType | RequestNodeType | IfNodeType | SimpleFlowNodeType

export function isSimpleFlowNode(node: FlowNode): node is SimpleFlowNodeType {
  return isSimpleNodeKind(node.type)
}

/** Every connected leaf is an endpoint, including the leaves of separate branches. */
export function terminalFlowNodeIds(nodes: readonly { id: string; type?: string }[], edges: readonly { source: string; target: string }[]): Set<string> {
  const eligible = new Set(nodes.filter((node) => node.type !== 'note' && node.type !== 'start').map((node) => node.id))
  const known = new Set(nodes.filter((node) => node.type !== 'note').map((node) => node.id))
  const incoming = new Set<string>()
  const outgoing = new Set<string>()
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue
    incoming.add(edge.target)
    outgoing.add(edge.source)
  }
  return new Set([...eligible].filter((id) => incoming.has(id) && !outgoing.has(id)))
}

export function toFlowNodes(nodes: FlowNodeState[]): FlowNode[] {
  return nodes.map((node): FlowNode => {
    if (isSimpleNode(node)) return simpleFlowNode(node.id, node.position, simpleNodeConfig(node))
    if (node.kind === 'start') {
      return {
        id: node.id,
        type: 'start',
        position: node.position,
        data: { form: node.form },
        deletable: false,
      }
    }
    if (node.kind === 'request') {
      return {
        id: node.id,
        type: 'request',
        position: node.position,
        data: {
          requestId: node.requestId,
          request: null,
          runStatus: { status: 'idle' },
          collections: [],
          environmentVariables: [],
          onSelectRequest: () => {},
          onOpenSettings: () => {},
          onDelete: () => {},
          onDuplicate: () => {},
        },
      }
    }
    if (node.kind === 'if') {
      return {
        id: node.id,
        type: 'if',
        position: node.position,
        data: {
          condition: node.condition,
          runStatus: { status: 'idle' },
          onOpenSettings: () => {},
          onDelete: () => {},
          onDuplicate: () => {},
        },
      }
    }
    if (node.kind === 'load') {
      return {
        id: node.id,
        type: 'block',
        position: node.position,
        data: { label: node.label, loadKind: node.loadKind, loadConfig: node.config, onOpenSettings: () => {}, onDelete: () => {}, onDuplicate: () => {} },
      }
    }
    return {
      id: node.id,
      type: 'block',
      position: node.position,
      data: { label: node.label, onOpenSettings: () => {}, onDelete: () => {}, onDuplicate: () => {} },
    }
  })
}

export function toFlowEdges(edges: FlowEdgeState[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    sourceHandle: edge.sourceHandle,
    markerEnd: edgeMarker(edge.sourceHandle),
  }))
}


/** Branch marker colors: success is green, failure is red, and loop bodies are amber (spec 0087). */
const BRANCH_EDGE_COLOR: Record<FlowSourceHandle, string> = {
  true: 'var(--success)',
  success: 'var(--success)',
  failure: 'var(--error)',
  loop: 'var(--warning)',
  false: 'var(--text-muted)',
  done: 'var(--text-muted)',
  iteration: 'var(--success)',
  passed: 'var(--success)',
  failed: 'var(--error)',
  body: 'var(--warning)',
}

/** React Flow markers need inline CSS variables to follow the theme; edge classes do not color their arrows. */
export function edgeMarker(sourceHandle: string | null | undefined): EdgeMarker {
  return {
    type: MarkerType.ArrowClosed,
    color: isFlowSourceHandle(sourceHandle) ? BRANCH_EDGE_COLOR[sourceHandle] : 'var(--text-muted)',
  }
}

/** Round viewport offsets after pan, zoom and initial fitView to prevent blurry fractional-pixel rendering in WebKitGTK. Whole-pixel offsets avoid a feedback loop. */
export function snapViewportToWholePixels(instance: Pick<ReactFlowInstance, 'setViewport'> | null, viewport: Viewport) {
  const x = Math.round(viewport.x)
  const y = Math.round(viewport.y)
  if (!instance || (x === viewport.x && y === viewport.y)) return
  void instance.setViewport({ x, y, zoom: viewport.zoom })
}
