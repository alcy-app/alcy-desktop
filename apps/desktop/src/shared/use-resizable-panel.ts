import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

type Axis = 'horizontal' | 'vertical'

interface UseResizablePanelOptions {
  initialSize: number
  minSize: number
  maxSize: number
  axis: Axis
  /**
   * 'reverse' quando arrastar no sentido positivo do eixo deve reduzir o
   * tamanho — caso da alça acima do painel de resposta, cujo tamanho é
   * medido de baixo para cima.
   */
  direction?: 'forward' | 'reverse'
  /** Quando presente, o tamanho é persistido em localStorage sob esta chave. */
  storageKey?: string
}

function loadPersistedSize(storageKey: string | undefined, minSize: number, maxSize: number): number | null {
  if (!storageKey) return null
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (stored === null) return null
    const parsed = Number(stored)
    if (!Number.isFinite(parsed)) return null
    return Math.min(maxSize, Math.max(minSize, parsed))
  } catch {
    return null
  }
}

/** Redimensionamento de painel por arraste da alça divisória. */
export function useResizablePanel({
  initialSize,
  minSize,
  maxSize,
  axis,
  direction = 'forward',
  storageKey,
}: UseResizablePanelOptions) {
  const [storedSize, setSize] = useState(() => loadPersistedSize(storageKey, minSize, maxSize) ?? initialSize)
  // `maxSize` pode mudar com o espaço disponível (ex.: janela encolhida): o tamanho efetivo
  // acompanha o limite atual, para o arraste partir do que está de fato na tela.
  const size = Math.min(maxSize, Math.max(minSize, storedSize))
  const [isResizing, setIsResizing] = useState(false)
  const dragState = useRef<{ start: number; startSize: number } | null>(null)
  const sizeRef = useRef(size)

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    if (!isResizing) return

    // O tamanho vive no estado do workbench inteiro: aplicar a cada
    // `pointermove` (vários por quadro) renderizava a tela toda várias vezes
    // por quadro. Guarda o último valor e aplica no máximo uma vez por quadro.
    let pendingSize: number | null = null
    let frame: number | null = null
    const flush = () => {
      frame = null
      if (pendingSize !== null) setSize(pendingSize)
      pendingSize = null
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragState.current) return
      const position = axis === 'horizontal' ? event.clientX : event.clientY
      const delta = position - dragState.current.start
      const signedDelta = direction === 'reverse' ? -delta : delta
      pendingSize = Math.min(maxSize, Math.max(minSize, dragState.current.startSize + signedDelta))
      if (frame === null) frame = window.requestAnimationFrame(flush)
    }
    const stopResizing = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (pendingSize !== null) sizeRef.current = pendingSize
      flush()
      dragState.current = null
      setIsResizing(false)
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, String(sizeRef.current))
        } catch {
          // storage indisponível — o tamanho só não persiste entre sessões
        }
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
    }
  }, [isResizing, axis, direction, minSize, maxSize, storageKey])

  const startResizing = useCallback(
    (event: ReactPointerEvent) => {
      // Evita que o arraste inicie seleção de texto/realce de hover nos
      // elementos sobre os quais o cursor passa durante o redimensionamento.
      event.preventDefault()
      dragState.current = { start: axis === 'horizontal' ? event.clientX : event.clientY, startSize: size }
      setIsResizing(true)
    },
    [axis, size],
  )

  return { size, isResizing, startResizing }
}
