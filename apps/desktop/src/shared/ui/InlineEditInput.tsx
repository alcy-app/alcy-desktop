import { forwardRef, type InputHTMLAttributes } from 'react'
import './inline-edit-input.css'

type InlineEditInputProps = InputHTMLAttributes<HTMLInputElement>

/** Input sem moldura, com sublinhado que aparece no foco — para renomear inline. */
export const InlineEditInput = forwardRef<HTMLInputElement, InlineEditInputProps>(function InlineEditInput(
  { className, ...rest },
  ref,
) {
  const classes = className ? `ui-inline-edit-input ${className}` : 'ui-inline-edit-input'
  return <input ref={ref} className={classes} {...rest} />
})
