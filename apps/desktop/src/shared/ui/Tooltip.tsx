import type { ReactNode } from 'react'
import { useTooltip } from './use-tooltip'
import type { TooltipSide } from './use-tooltip'

interface TooltipProps {
  label: string
  side?: TooltipSide
  /** Classe extra no host, para posicionamento específico do ponto de uso. */
  className?: string
  /** Exibe somente ao passar o mouse, ignorando o foco. Útil em barras de
   * navegação com ícones. */
  hoverOnly?: boolean
  multiline?: boolean
  children: ReactNode
}

/**
 * Envolve o conteúdo num `<span>` host que dispara o tooltip. Use quando o
 * alvo não aceita os handlers diretamente — por exemplo, um botão `disabled`,
 * que não recebe eventos de mouse em todos os webviews. Nos demais casos,
 * prefira `useTooltip` no próprio elemento (ou o tooltip embutido em `IconButton`).
 */
export function Tooltip({ label, side = 'bottom', className, hoverOnly = false, multiline = false, children }: TooltipProps) {
  const { triggerProps, tooltip } = useTooltip(label, { side, hoverOnly, multiline })
  const classes = ['ui-tooltip-host', className].filter(Boolean).join(' ')

  return (
    <span className={classes} {...triggerProps}>
      {children}
      {tooltip}
    </span>
  )
}
