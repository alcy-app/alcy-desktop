import { flattenScope } from '../collection-runner/runner-plan'
import { findNode, findRequest } from '../request-workbench/collection-tree'
import type { TreeNode } from '../request-workbench/collection-tree'
import type { FlowEdgeState, FlowNodeState } from './flows.types'

/** Distância entre colunas (o cartão tem 280px) e entre linhas da grade. */
const COLUMN_GAP = 360
const ROW_GAP = 220
/** Quebra de linha para uma pasta grande não virar uma fila sem fim. */
const MAX_COLUMNS = 5

/** Requisições que um item da árvore gera no flow (spec 0095): a própria
 * requisição, ou todas as de uma coleção/pasta na ordem da sidebar (a mesma
 * do runner). `null` quando o item não existe mais. */
export function requestIdsForItem(collections: TreeNode[], itemId: string): { name: string; requestIds: string[] } | null {
  const request = findRequest(collections, itemId)
  if (request) return { name: request.name, requestIds: [request.id] }
  const node = findNode(collections, itemId)
  if (!node) return null
  return { name: node.name, requestIds: flattenScope(node).map((item) => item.id) }
}

/** Nodes `request` encadeados pela saída de sucesso, em grade a partir de
 * `origin`. Com `connectFromNodeId`, liga esse node (o `Start`) ao primeiro. */
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
      x: origin.x + (index % MAX_COLUMNS) * COLUMN_GAP,
      y: origin.y + Math.floor(index / MAX_COLUMNS) * ROW_GAP,
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

/** Id do node `start` quando ele ainda não tem nenhuma saída. */
export function startWithoutOutput(nodes: FlowNodeState[], edges: FlowEdgeState[]): string | null {
  const start = nodes.find((node) => node.kind === 'start')
  if (!start || edges.some((edge) => edge.sourceNodeId === start.id)) return null
  return start.id
}
