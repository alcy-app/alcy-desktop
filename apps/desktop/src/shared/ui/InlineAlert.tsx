import type { ReactNode } from 'react'
import './inline-alert.css'

interface InlineAlertProps {
  children: ReactNode
  className?: string
}

/** Banner de erro inline, para mensagens de formulário/ação que não justificam um toast. */
export function InlineAlert({ children, className }: InlineAlertProps) {
  const classes = className ? `ui-inline-alert ${className}` : 'ui-inline-alert'
  return (
    <div className={classes} role="alert">
      {children}
    </div>
  )
}
