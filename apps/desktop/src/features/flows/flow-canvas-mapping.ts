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

export function toFlowNodes(nodes: FlowNodeState[]): FlowNode[] {
  return nodes.map((node): FlowNode => {
    if (isSimpleNode(node)) return simpleFlowNode(node.id, node.position, simpleNodeConfig(node))
    if (node.kind === 'start') {
      return {
        id: node.id,
        type: 'start',
        position: node.position,
        data: {},
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


/** Cor de cada ramo (spec 0087) — a mesma das saídas no rodapé do cartão:
 * verdadeiro/sucesso verde, falha vermelho, corpo do loop âmbar. */
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

/** Seta da edge na cor do ramo de onde ela sai. A cor vai inline no marker
 * (o xyflow não pinta a seta pela classe da edge), então precisa ser uma
 * variável CSS, não um valor fixo, para acompanhar o tema. */
export function edgeMarker(sourceHandle: string | null | undefined): EdgeMarker {
  return {
    type: MarkerType.ArrowClosed,
    color: isFlowSourceHandle(sourceHandle) ? BRANCH_EDGE_COLOR[sourceHandle] : 'var(--text-muted)',
  }
}

/** Arredonda o deslocamento do canvas para pixels inteiros ao fim de cada
 * pan/zoom (inclusive o `fitView` inicial). O xyflow não arredonda o
 * `translate` do viewport, e com meio pixel o WebKitGTK desenha os nodes
 * borrados. Depois de arredondado, o próximo fim de movimento já chega
 * inteiro, então não entra em laço. */
export function snapViewportToWholePixels(instance: Pick<ReactFlowInstance, 'setViewport'> | null, viewport: Viewport) {
  const x = Math.round(viewport.x)
  const y = Math.round(viewport.y)
  if (!instance || (x === viewport.x && y === viewport.y)) return
  void instance.setViewport({ x, y, zoom: viewport.zoom })
}
