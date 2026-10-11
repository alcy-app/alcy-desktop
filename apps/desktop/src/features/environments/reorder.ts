import type { SiblingEdge } from '../../shared/use-pointer-drag'

/** Move o item `draggedId` para antes/depois de `targetId`. Devolve o próprio `items` quando nada
 * muda (ids desconhecidos ou posição final igual à atual), para que quem chama possa evitar uma
 * atualização de estado — e, com ela, um salvamento — sem efeito. */
export function moveById<T extends { id: string }>(
  items: T[],
  draggedId: string,
  targetId: string,
  edge: SiblingEdge,
): T[] {
  if (draggedId === targetId) return items
  const fromIndex = items.findIndex((item) => item.id === draggedId)
  if (fromIndex === -1 || !items.some((item) => item.id === targetId)) return items

  const next = [...items]
  const [dragged] = next.splice(fromIndex, 1)
  const targetIndex = next.findIndex((item) => item.id === targetId)
  const insertIndex = edge === 'after' ? targetIndex + 1 : targetIndex
  if (insertIndex === fromIndex) return items
  next.splice(insertIndex, 0, dragged)
  return next
}

/** Tecla de reordenação pelo teclado na alça de arraste. */
export type ReorderKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export function isReorderKey(key: string): key is ReorderKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'
}

/** Traduz uma tecla de reordenação no mesmo movimento "antes/depois de um alvo" do arraste, para
 * que teclado e mouse passem pelo mesmo caminho. `null` quando o item já está no limite. */
export function keyboardMove(
  ids: string[],
  id: string,
  key: ReorderKey,
): { targetId: string; edge: SiblingEdge; position: number } | null {
  const index = ids.indexOf(id)
  if (index === -1) return null
  const last = ids.length - 1

  switch (key) {
    case 'ArrowUp':
      return index > 0 ? { targetId: ids[index - 1], edge: 'before', position: index } : null
    case 'ArrowDown':
      return index < last ? { targetId: ids[index + 1], edge: 'after', position: index + 2 } : null
    case 'Home':
      return index > 0 ? { targetId: ids[0], edge: 'before', position: 1 } : null
    case 'End':
      return index < last ? { targetId: ids[last], edge: 'after', position: ids.length } : null
  }
}
