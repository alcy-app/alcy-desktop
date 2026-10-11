import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { chainHandlers, useTooltip } from './use-tooltip'
import type { TooltipSide } from './use-tooltip'
import './buttons.css'

type IconButtonSize = 'sm' | 'md'
type IconButtonVariant = 'default' | 'danger'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode
  label: string
  size?: IconButtonSize
  variant?: IconButtonVariant
  /** Mostra `label` num tooltip ao passar o mouse (padrão). */
  tooltip?: boolean
  tooltipSide?: TooltipSide
}

/** Botão só de ícone; `label` vira `aria-label` (o ícone é decorativo) e o tooltip que descreve a ação. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    size = 'sm',
    variant = 'default',
    tooltip: showTooltip = true,
    tooltipSide,
    className,
    type = 'button',
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
    onPointerDown,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const { triggerProps, tooltip } = useTooltip(label, { side: tooltipSide, enabled: showTooltip })
  const classes = [
    'ui-icon-button',
    size === 'md' ? 'ui-icon-button--md' : null,
    variant === 'danger' ? 'ui-icon-button--danger' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <button
        ref={ref}
        type={type}
        className={classes}
        aria-label={label}
        {...rest}
        onMouseEnter={chainHandlers(triggerProps.onMouseEnter, onMouseEnter)}
        onMouseLeave={chainHandlers(triggerProps.onMouseLeave, onMouseLeave)}
        onFocus={chainHandlers(triggerProps.onFocus, onFocus)}
        onBlur={chainHandlers(triggerProps.onBlur, onBlur)}
        onPointerDown={chainHandlers(triggerProps.onPointerDown, onPointerDown)}
        onKeyDown={chainHandlers(triggerProps.onKeyDown, onKeyDown)}
      >
        {icon}
      </button>
      {tooltip}
    </>
  )
})
