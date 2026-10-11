import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

const DRAG_THRESHOLD_PX = 4

export interface DragRef<Kind extends string> {
  id: string
  kind: Kind
}

/** Onde, dentro do alvo sob o cursor, o item arrastado seria largado — `'before'`/`'after'` são a
 * metade de cima/esquerda ou baixo/direita (conforme `orientation`), usadas para reordenar como
 * irmão; `'inside'` só existe quando `insideZone` está ligado (o terço do meio do alvo), usada para
 * largar o item dentro do alvo em vez de ao lado dele. */
export type DropEdge = 'before' | 'after' | 'inside'

/** `DropEdge` sem `'inside'` — para reordenar entre irmãos, onde só faz sentido antes/depois do
 * alvo (nunca "para dentro" dele). */
export type SiblingEdge = Exclude<DropEdge, 'inside'>

/** Fração (a partir de cada ponta) reservada para `'before'`/`'after'` quando `insideZone` está
 * ligado — o restante no meio vira `'inside'`. */
const INSIDE_ZONE_EDGE_FRACTION = 0.3

interface UsePointerDragOptions<Kind extends string> {
  /** Nome do atributo `data-*` que marca um elemento como alvo de drop válido (ex.: `data-drop-id`). */
  dropTargetAttribute: string
  /** Nome do atributo `data-*` com o tipo do alvo (ex.: `data-drop-kind`) — permite que o mesmo arraste
   * decida um comportamento diferente conforme o que está sendo largado sobre o quê. */
  dropKindAttribute: string
  /** Eixo comparado à posição do cursor dentro do alvo para calcular `DropEdge` — `'vertical'` (linhas
   * empilhadas, o padrão) compara Y, `'horizontal'` (abas lado a lado) compara X. */
  orientation?: 'vertical' | 'horizontal'
  /** Quando `true`, reserva o terço do meio do alvo para `'inside'` em vez de dividir só em duas
   * metades — usado onde soltar no meio significa "mover para dentro" em vez de "reordenar ao lado". */
  insideZone?: boolean
  /** `point` é a posição do cursor (coordenadas de tela) ao soltar. */
  onDrop: (dragged: DragRef<Kind>, target: DragRef<Kind>, edge: DropEdge, point: { x: number; y: number }) => void
}

interface DragState<Kind extends string> {
  id: string
  kind: Kind
  label: string
  startX: number
  startY: number
  isDragging: boolean
  over: DragRef<Kind> | null
  edge: DropEdge
}

/**
 * Arraste por pointer events (não o HTML5 Drag and Drop nativo — pouco
 * confiável em algumas WebViews Linux ao iniciar sobre texto), mesmo
 * espírito de `useResizablePanel`: `onPointerDown` inicia, `pointermove`/
 * `pointerup` em `window` conduzem o resto. Um limiar de movimento
 * distingue um arraste de um clique normal. O alvo sob o cursor é achado
 * via `document.elementFromPoint` + `closest('[dropTargetAttribute]')`.
 */
export function usePointerDrag<Kind extends string = string>({
  dropTargetAttribute,
  dropKindAttribute,
  orientation = 'vertical',
  insideZone = false,
  onDrop,
}: UsePointerDragOptions<Kind>) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [draggedKind, setDraggedKind] = useState<Kind | null>(null)
  const [draggedLabel, setDraggedLabel] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverKind, setDragOverKind] = useState<Kind | null>(null)
  const [dragOverEdge, setDragOverEdge] = useState<DropEdge | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const dragStateRef = useRef<DragState<Kind> | null>(null)
  // `onDrop` costuma ser recriado a cada render de quem usa o hook; lido por
  // ref, ele não faz os listeners de janela serem removidos e registrados de
  // novo a cada render (inclusive a cada `pointermove` durante o arraste).
  const onDropRef = useRef(onDrop)
  useEffect(() => {
    onDropRef.current = onDrop
  }, [onDrop])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current
      if (!drag) return

      if (!drag.isDragging) {
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
        drag.isDragging = true
        setDraggedId(drag.id)
        setDraggedKind(drag.kind)
        setDraggedLabel(drag.label)
        document.body.style.cursor = 'grabbing'
      }

      setPosition({ x: event.clientX, y: event.clientY })

      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      const element = target?.closest<HTMLElement>(`[${dropTargetAttribute}]`) ?? null
      const rawId = element?.getAttribute(dropTargetAttribute) ?? null
      const rawKind = element?.getAttribute(dropKindAttribute) ?? null
      const over = rawId && rawKind && rawId !== drag.id ? { id: rawId, kind: rawKind as Kind } : null

      let edge: DropEdge = 'before'
      if (element) {
        const rect = element.getBoundingClientRect()
        const fraction =
          orientation === 'horizontal'
            ? (event.clientX - rect.left) / (rect.width || 1)
            : (event.clientY - rect.top) / (rect.height || 1)
        edge = insideZone
          ? fraction < INSIDE_ZONE_EDGE_FRACTION
            ? 'before'
            : fraction > 1 - INSIDE_ZONE_EDGE_FRACTION
              ? 'after'
              : 'inside'
          : fraction < 0.5
            ? 'before'
            : 'after'
      }

      drag.over = over
      drag.edge = edge
      setDragOverId(over?.id ?? null)
      setDragOverKind(over?.kind ?? null)
      setDragOverEdge(over ? edge : null)
    }

    const endDrag = () => {
      dragStateRef.current = null
      document.body.style.cursor = ''
      setDraggedId(null)
      setDraggedKind(null)
      setDraggedLabel(null)
      setDragOverId(null)
      setDragOverKind(null)
      setDragOverEdge(null)
      setPosition(null)
    }

    const handlePointerUp = (event: PointerEvent) => {
      const drag = dragStateRef.current
      if (drag?.isDragging && drag.over) {
        onDropRef.current({ id: drag.id, kind: drag.kind }, drag.over, drag.edge, { x: event.clientX, y: event.clientY })
      }
      endDrag()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      document.body.style.cursor = ''
    }
  }, [dropTargetAttribute, dropKindAttribute, orientation, insideZone])

  const startDrag = useCallback((id: string, kind: Kind, label: string, event: ReactPointerEvent) => {
    dragStateRef.current = {
      id,
      kind,
      label,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
      over: null,
      edge: 'before',
    }
  }, [])

  return { draggedId, draggedKind, draggedLabel, dragOverId, dragOverKind, dragOverEdge, position, startDrag }
}
