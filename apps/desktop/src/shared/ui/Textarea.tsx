import { forwardRef, type TextareaHTMLAttributes } from 'react'
import './forms.css'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, className, ...rest },
  ref,
) {
  const classes = ['ui-textarea', mono ? 'ui-textarea--mono' : null, className].filter(Boolean).join(' ')
  return <textarea ref={ref} className={classes} {...rest} />
})
