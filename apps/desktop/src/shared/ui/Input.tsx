import { forwardRef, type InputHTMLAttributes } from 'react'
import './forms.css'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Usa a fonte monoespaçada (URLs, valores técnicos). */
  mono?: boolean
}

/** Without `autoComplete`, the webview would list values typed before (e.g.
 * past commit messages) under the field, as a browser does; pass one to opt in. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono, className, autoComplete = 'off', ...rest }, ref) {
  const classes = ['ui-input', mono ? 'ui-input--mono' : null, className].filter(Boolean).join(' ')
  return <input ref={ref} className={classes} autoComplete={autoComplete} {...rest} />
})
