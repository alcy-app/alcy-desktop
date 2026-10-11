import { forwardRef, type SelectHTMLAttributes } from 'react'
import { ChevronDownIcon } from './icons'
import './forms.css'

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>

/** `<select>` sem chrome nativo (appearance: none) com chevron próprio. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, ...rest }, ref) {
  return (
    <span className="ui-select-wrapper">
      <select ref={ref} className={className ? `ui-select ${className}` : 'ui-select'} {...rest} />
      <ChevronDownIcon size={12} className="ui-select-chevron" />
    </span>
  )
})
