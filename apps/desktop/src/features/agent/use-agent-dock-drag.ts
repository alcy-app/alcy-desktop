import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { AgentDock } from './use-agent-preferences'

const DRAG_THRESHOLD_PX = 4

/** Header parts that keep their own pointer behavior instead of starting a drag. */
const NON_DRAGGABLE = 'button, a, input, textarea, select, [role="dialog"], [role="menu"]'

export interface DockRect {
  left: number
  top: number
  width: number
  height: number
}

export interface AgentDockPreview {
  dock: AgentDock
  rect: DockRect
}

/** The side of `region` nearest to the pointer: where the panel would land. */
export function dockAt(point: { x: number; y: number }, region: DockRect): AgentDock {
  const distances: [AgentDock, number][] = [
    ['right', region.left + region.width - point.x],
    ['left', point.x - region.left],
    ['bottom', region.top + region.height - point.y],
  ]
  return distances.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest))[0]
}

/** The smallest rect holding every laid-out rect given; hidden elements (no size) are left out. */
export function unionRect(rects: ReadonlyArray<Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'> | null | undefined>): DockRect | null {
  const laidOut = rects.filter((rect): rect is NonNullable<typeof rect> => !!rect && (rect.width > 0 || rect.height > 0))
  if (laidOut.length === 0) return null
  const left = Math.min(...laidOut.map((rect) => rect.left))
  const top = Math.min(...laidOut.map((rect) => rect.top))
  const right = Math.max(...laidOut.map((rect) => rect.right))
  const bottom = Math.max(...laidOut.map((rect) => rect.bottom))
  return { left, top, width: right - left, height: bottom - top }
}

/** Where the panel would sit in `region` when docked at `dock`, sized `size` across that side. */
export function dockPreviewRect(dock: AgentDock, region: DockRect, size: number): DockRect {
  if (dock === 'bottom') {
    const height = Math.min(size, region.height)
    return { left: region.left, top: region.top + region.height - height, width: region.width, height }
  }
  const width = Math.min(size, region.width)
  return { left: dock === 'left' ? region.left : region.left + region.width - width, top: region.top, width, height: region.height }
}

interface UseAgentDockDragOptions {
  /** The area the panel docks around, measured when a drag starts: its nearest side is the target. */
  measureRegion: () => DockRect | null
  /** Where the panel would land at `dock`, for the preview; `null` when it cannot be told. */
  previewRect: (dock: AgentDock) => DockRect | null
  onDock: (dock: AgentDock) => void
}

interface DragState {
  startX: number
  startY: number
  region: DockRect
  preview: AgentDockPreview | null
}

/**
 * Moves the agent panel by dragging its header, with pointer events like
 * `useResizablePanel`: a press on the header starts, `pointermove`/`pointerup`
 * on `window` drive the rest. Past a small threshold the nearest side is
 * previewed; releasing docks there and Escape cancels.
 */
export function useAgentDockDrag({ measureRegion, previewRect, onDock }: UseAgentDockDragOptions) {
  const [drag, setDragState] = useState<DragState | null>(null)
  // Mirrors `drag` for the window listeners, which read it on every event.
  const dragRef = useRef<DragState | null>(null)
  const setDrag = useCallback((next: DragState | null) => {
    dragRef.current = next
    setDragState(next)
  }, [])
  const latestRef = useRef({ previewRect, onDock })
  useEffect(() => {
    latestRef.current = { previewRect, onDock }
  })
  const isDragging = drag !== null

  useEffect(() => {
    if (!isDragging) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragRef.current
      if (!current) return
      if (!current.preview && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD_PX) return
      const dock = dockAt({ x: event.clientX, y: event.clientY }, current.region)
      if (current.preview?.dock === dock) return
      const rect = latestRef.current.previewRect(dock) ?? current.region
      setDrag({ ...current, preview: { dock, rect } })
    }
    const finish = (commit: boolean) => {
      // A press released before the threshold was a click: nothing moves.
      const dock = commit ? dragRef.current?.preview?.dock : undefined
      setDrag(null)
      if (dock) latestRef.current.onDock(dock)
    }
    const handlePointerUp = () => finish(true)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isDragging, setDrag])

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      if (event.target instanceof Element && event.target.closest(NON_DRAGGABLE)) return
      const region = measureRegion()
      if (!region) return
      // No text selection while dragging the header.
      event.preventDefault()
      setDrag({ startX: event.clientX, startY: event.clientY, region, preview: null })
    },
    [measureRegion, setDrag],
  )

  return { preview: drag?.preview ?? null, startDrag }
}
