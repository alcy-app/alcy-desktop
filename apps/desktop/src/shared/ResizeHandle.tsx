import type { HTMLAttributes, PointerEvent } from 'react'
import './resize-handle.css'

type KeyboardSeparatorProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  'onKeyDown' | 'onDoubleClick' | 'aria-valuenow' | 'aria-valuemin' | 'aria-valuemax'
>

interface ResizeHandleProps extends KeyboardSeparatorProps {
  onPointerDown: (event: PointerEvent) => void
  ariaLabel: string
  /** Visual orientation: a vertical bar resizes width, a horizontal one resizes height. */
  orientation: 'horizontal' | 'vertical'
  /** Extra class, e.g. to place the handle in a grid layout. */
  className?: string
}

/** With `onKeyDown` the handle is also focusable and resizes from the keyboard. */
export function ResizeHandle({ onPointerDown, ariaLabel, orientation, className, ...separatorProps }: ResizeHandleProps) {
  return (
    <div
      className={`resize-handle resize-handle--${orientation}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      tabIndex={separatorProps.onKeyDown ? 0 : undefined}
      onPointerDown={onPointerDown}
      {...separatorProps}
    />
  )
}
