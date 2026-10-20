import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

type Axis = 'horizontal' | 'vertical'

interface UseResizablePanelOptions {
  initialSize: number
  minSize: number
  maxSize: number
  axis: Axis
  /** Use reverse when a positive drag reduces size, such as a response panel measured upward from its lower edge. */
  direction?: 'forward' | 'reverse'
  /** Persist panel size in localStorage under this optional key. */
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

/** Resize a panel by dragging its divider. */
export function useResizablePanel({
  initialSize,
  minSize,
  maxSize,
  axis,
  direction = 'forward',
  storageKey,
}: UseResizablePanelOptions) {
  const [storedSize, setSize] = useState(() => loadPersistedSize(storageKey, minSize, maxSize) ?? initialSize)
  // Clamp size to the available space so dragging starts from the visible dimensions after a window resize.
  const size = Math.min(maxSize, Math.max(minSize, storedSize))
  const [isResizing, setIsResizing] = useState(false)
  const dragState = useRef<{ start: number; startSize: number } | null>(null)
  const sizeRef = useRef(size)

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    if (!isResizing) return

    // Batch pointer movement into one update per animation frame to avoid rerendering the whole workbench several times per frame.
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
          // Storage failure affects persistence only; resizing remains available in the current session.
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
      // Prevent text selection and hover highlighting while dragging the divider.
      event.preventDefault()
      dragState.current = { start: axis === 'horizontal' ? event.clientX : event.clientY, startSize: size }
      setIsResizing(true)
    },
    [axis, size],
  )

  const changeSize = (next: number) => {
    const clamped = Math.min(maxSize, Math.max(minSize, next))
    setSize(clamped)
    if (storageKey) {
      try { window.localStorage.setItem(storageKey, String(clamped)) } catch { /* Resizing remains available when storage is unavailable. */ }
    }
  }
  return { size, isResizing, startResizing, setSize: changeSize }
}
