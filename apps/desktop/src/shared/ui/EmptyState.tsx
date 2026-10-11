import type { ReactNode } from 'react'
import './empty-state.css'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}

/** Estado vazio consistente: ícone discreto + título (+ descrição e ação opcionais). */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      {icon && (
        <div className="ui-empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="ui-empty-state-title">{title}</p>
      {description && <p className="ui-empty-state-description">{description}</p>}
      {action}
    </div>
  )
}
