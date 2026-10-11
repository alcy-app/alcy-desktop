import { useId, type ReactNode } from 'react'
import './field.css'

interface FieldProps {
  label: string
  htmlFor?: string
  hint?: string
  error?: string
  className?: string
  children: ReactNode | ((id: string) => ReactNode)
}

/** Rótulo + controle + dica/erro opcional, com espaçamento consistente. */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  const generatedId = useId()
  const id = htmlFor ?? generatedId

  return (
    <div className={className ? `ui-field ${className}` : 'ui-field'}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      {typeof children === 'function' ? children(id) : children}
      {error ? <p className="ui-field-error">{error}</p> : hint ? <p className="ui-field-hint">{hint}</p> : null}
    </div>
  )
}
