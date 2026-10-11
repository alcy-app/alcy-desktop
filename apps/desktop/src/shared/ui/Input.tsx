import { forwardRef, type InputHTMLAttributes } from 'react'
import './forms.css'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Usa a fonte monoespaçada (URLs, valores técnicos). */
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono, className, ...rest }, ref) {
  const classes = ['ui-input', mono ? 'ui-input--mono' : null, className].filter(Boolean).join(' ')
  return <input ref={ref} className={classes} {...rest} />
})
