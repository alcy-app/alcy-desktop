import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FocusEvent, KeyboardEvent, MouseEvent } from 'react'
import { OverlayMotionContext } from './overlay-motion-context'
import './tooltip.css'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export const TOOLTIP_DELAY_MS = 400
const TOOLTIP_GAP_PX = 6
const VIEWPORT_MARGIN_PX = 8

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

interface Size {
  width: number
  height: number
}

/**
 * Center on the requested side, flip when necessary, and clamp the other axis to the viewport.
 */
export function computeTooltipPosition(anchor: Rect, tooltip: Size, side: TooltipSide, viewport: Size) {
  const clamp = (value: number, size: number, limit: number) =>
    Math.max(VIEWPORT_MARGIN_PX, Math.min(value, limit - size - VIEWPORT_MARGIN_PX))
  const anchorBottom = anchor.top + anchor.height
  const anchorRight = anchor.left + anchor.width

  if (side === 'top' || side === 'bottom') {
    const below = anchorBottom + TOOLTIP_GAP_PX
    const above = anchor.top - TOOLTIP_GAP_PX - tooltip.height
    const fitsBelow = below + tooltip.height <= viewport.height - VIEWPORT_MARGIN_PX
    const fitsAbove = above >= VIEWPORT_MARGIN_PX
    const top = side === 'bottom' ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove || !fitsBelow ? above : below
    const left = clamp(anchor.left + anchor.width / 2 - tooltip.width / 2, tooltip.width, viewport.width)
    return { top, left }
  }

  const after = anchorRight + TOOLTIP_GAP_PX
  const before = anchor.left - TOOLTIP_GAP_PX - tooltip.width
  const fitsAfter = after + tooltip.width <= viewport.width - VIEWPORT_MARGIN_PX
  const fitsBefore = before >= VIEWPORT_MARGIN_PX
  const left = side === 'right' ? (fitsAfter || !fitsBefore ? after : before) : fitsBefore || !fitsAfter ? before : after
  const top = clamp(anchor.top + anchor.height / 2 - tooltip.height / 2, tooltip.height, viewport.height)
  return { top, left }
}

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

interface UseTooltipOptions {
  side?: TooltipSide
  /** Ignore focus and show only on hover. */
  hoverOnly?: boolean
  /** Wrap long URLs or paths. */
  multiline?: boolean
  /** Disable the tooltip without changing the caller's hook order. */
  enabled?: boolean
}

export interface TooltipTriggerProps {
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void
  onMouseLeave: (event: MouseEvent<HTMLElement>) => void
  onFocus: (event: FocusEvent<HTMLElement>) => void
  onBlur: (event: FocusEvent<HTMLElement>) => void
  onPointerDown: () => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/**
 * Bind directly to the target without changing its layout. A fixed portal in document.body
 * avoids clipping and stays inside the viewport. Show after a hover or keyboard-focus delay;
 * hide on leave, click or Escape. The originating surface controls overlay motion across portals.
 */
export function useTooltip(label: string, { side = 'bottom', hoverOnly = false, multiline = false, enabled = true }: UseTooltipOptions = {}) {
  const [anchor, setAnchor] = useState<Rect | null>(null)
  const timerRef = useRef<number | null>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const animateOverlay = useContext(OverlayMotionContext)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const hide = useCallback(() => {
    cancel()
    setAnchor(null)
  }, [cancel])

  const scheduleShow = (target: HTMLElement) => {
    cancel()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (!target.isConnected) return
      const { top, left, width, height } = target.getBoundingClientRect()
      setAnchor({ top, left, width, height })
    }, TOOLTIP_DELAY_MS)
  }

  useEffect(() => cancel, [cancel])

  const visible = enabled && anchor !== null && label.length > 0

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    // A fixed tooltip would lose its anchor when any container scrolls.
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [visible, hide])

  // Measure and position the mounted tooltip before painting.
  useLayoutEffect(() => {
    const element = tooltipRef.current
    if (!visible || !element || !anchor) return
    const { width, height } = element.getBoundingClientRect()
    const position = computeTooltipPosition(anchor, { width, height }, side, {
      width: window.innerWidth,
      height: window.innerHeight,
    })
    element.style.top = `${position.top}px`
    element.style.left = `${position.left}px`
  }, [visible, anchor, side, label])

  const triggerProps: TooltipTriggerProps = {
    onMouseEnter: (event) => {
      if (enabled) scheduleShow(event.currentTarget)
    },
    onMouseLeave: hide,
    onFocus: (event) => {
      // Wrapper spans receive bubbled focus; the focused element is event.target.
      if (enabled && !hoverOnly && isFocusVisible(event.target)) scheduleShow(event.currentTarget)
    },
    onBlur: hide,
    onPointerDown: hide,
    onKeyDown: (event) => {
      if (event.key === 'Escape') hide()
    },
  }

  const tooltip = visible
    ? createPortal(
        <span ref={tooltipRef} role="tooltip" className={['ui-tooltip', multiline ? 'ui-tooltip--multiline' : null, !animateOverlay ? 'ui-tooltip--static' : null].filter(Boolean).join(' ')}>
          {label}
        </span>,
        document.body,
      )
    : null

  return { triggerProps, tooltip }
}

/** Chain tooltip and caller handlers without overwriting either. */
export function chainHandlers<E>(first: ((event: E) => void) | undefined, second: ((event: E) => void) | undefined) {
  return (event: E) => {
    first?.(event)
    second?.(event)
  }
}
