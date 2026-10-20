import { flattenScope } from '../collection-runner/runner-plan'
import { findNode, findRequest } from '../request-workbench/collection-tree'
import type { TreeNode } from '../request-workbench/collection-tree'
import type { FlowEdgeState, FlowNodeState } from './flows.types'
import { FLOW_GEOMETRY as G, flowNodeSize, snapFlowCoordinate } from './flow-geometry'

/** Keep generated chains consistent with compact cards and named terminals. */
const COLUMN_GAP = G.width + G.columnGap
const ROW_GAP = Math.ceil((flowNodeSize('request', 2).height + G.rowGap) / G.grid) * G.grid
/** Wrap large folders instead of creating an unbounded horizontal chain. */
const MAX_COLUMNS = 5

/** Resolve a request or a collection/folder's requests in sidebar and runner
 * order (spec 0095). Return null if the tree item no longer exists. */
export function requestIdsForItem(collections: TreeNode[], itemId: string): { name: string; requestIds: string[] } | null {
  const request = findRequest(collections, itemId)
  if (request) return { name: request.name, requestIds: [request.id] }
  const node = findNode(collections, itemId)
  if (!node) return null
  return { name: node.name, requestIds: flattenScope(node).map((item) => item.id) }
}

/** Arrange request nodes in a grid from origin, linked by their success outputs.
 * Optionally connect the source node (Start) to the first request. */
export function buildRequestChain(
  requestIds: string[],
  origin: { x: number; y: number },
  connectFromNodeId: string | null,
  newId: () => string = () => crypto.randomUUID(),
): { nodes: FlowNodeState[]; edges: FlowEdgeState[] } {
  const nodes: FlowNodeState[] = requestIds.map((requestId, index) => ({
    id: newId(),
    kind: 'request',
    requestId,
    position: {
      x: snapFlowCoordinate(origin.x) + (index % MAX_COLUMNS) * COLUMN_GAP,
      y: snapFlowCoordinate(origin.y) + Math.floor(index / MAX_COLUMNS) * ROW_GAP,
    },
  }))

  const edges: FlowEdgeState[] = []
  if (connectFromNodeId && nodes.length > 0) {
    edges.push({ id: newId(), sourceNodeId: connectFromNodeId, targetNodeId: nodes[0].id })
  }
  for (let index = 1; index < nodes.length; index++) {
    edges.push({ id: newId(), sourceNodeId: nodes[index - 1].id, targetNodeId: nodes[index].id, sourceHandle: 'success' })
  }

  return { nodes, edges }
}

/** Return the Start node ID only while it has no outgoing edges. */
export function startWithoutOutput(nodes: FlowNodeState[], edges: FlowEdgeState[]): string | null {
  const start = nodes.find((node) => node.kind === 'start')
  if (!start || edges.some((edge) => edge.sourceNodeId === start.id)) return null
  return start.id
}
