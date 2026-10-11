import type { PointerEvent } from 'react'
import './resize-handle.css'

interface ResizeHandleProps {
  onPointerDown: (event: PointerEvent) => void
  ariaLabel: string
  /** Orientação visual da alça: uma barra vertical redimensiona largura, uma horizontal redimensiona altura. */
  orientation: 'horizontal' | 'vertical'
}

export function ResizeHandle({ onPointerDown, ariaLabel, orientation }: ResizeHandleProps) {
  return (
    <div
      className={`resize-handle resize-handle--${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
    />
  )
}
