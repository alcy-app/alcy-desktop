import type { DropEdge } from '../../shared/use-pointer-drag'
import type { RequestProtocol, TreeNode } from '../request-workbench/collection-tree'

/** Uma requisição do escopo do runner, na ordem padrão de execução. */
export interface RunnerPlanItem {
  id: string
  name: string
  protocol: RequestProtocol
  method: string
  /** Pastas entre o escopo e a requisição (sem o próprio escopo). */
  path: string[]
}

/** Achata uma coleção/pasta na ordem da sidebar: subpastas primeiro (em
 * profundidade), depois as requisições do próprio nível. */
export function flattenScope(node: TreeNode, path: string[] = []): RunnerPlanItem[] {
  return [
    ...node.folders.flatMap((folder) => flattenScope(folder, [...path, folder.name])),
    ...node.requests.map((request) => ({
      id: request.id,
      name: request.name,
      protocol: request.protocol,
      method: request.content.method,
      path,
    })),
  ]
}

/** Ordem vigente reconciliada com o escopo atual: mantém a ordem escolhida
 * para o que ainda existe, descarta o que foi removido e acrescenta no fim,
 * na ordem natural, o que foi criado depois. */
export function reconcileOrder(order: string[], items: RunnerPlanItem[]): string[] {
  const existing = new Set(items.map((item) => item.id))
  const kept = order.filter((id) => existing.has(id))
  const known = new Set(kept)
  return [...kept, ...items.filter((item) => !known.has(item.id)).map((item) => item.id)]
}

/** Move `draggedId` para antes/depois de `targetId`. */
export function reorderPlan(order: string[], draggedId: string, targetId: string, edge: DropEdge): string[] {
  if (draggedId === targetId) return order
  const fromIndex = order.indexOf(draggedId)
  if (fromIndex === -1 || !order.includes(targetId)) return order
  const next = [...order]
  next.splice(fromIndex, 1)
  const targetIndex = next.indexOf(targetId)
  next.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, draggedId)
  return next
}

/** Ids selecionados, na ordem de execução. */
export function selectedInOrder(order: string[], deselected: ReadonlySet<string>): string[] {
  return order.filter((id) => !deselected.has(id))
}

/** Id da coleção (raiz) que contém a requisição, ou `null`. */
export function rootCollectionOf(collections: TreeNode[], requestId: string): TreeNode | null {
  const contains = (node: TreeNode): boolean =>
    node.requests.some((request) => request.id === requestId) || node.folders.some(contains)
  return collections.find(contains) ?? null
}

/** Nomes do caminho da coleção até o nó (inclusive), ou `null` se não existir. */
export function scopePath(collections: TreeNode[], id: string): string[] | null {
  for (const node of collections) {
    if (node.id === id) return [node.name]
    const nested = scopePath(node.folders, id)
    if (nested) return [node.name, ...nested]
  }
  return null
}
