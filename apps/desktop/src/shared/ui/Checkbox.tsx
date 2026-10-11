import { forwardRef, type InputHTMLAttributes } from 'react'
import './checkbox.css'

type CheckboxProps = InputHTMLAttributes<HTMLInputElement>

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ className, ...rest }, ref) {
  const classes = className ? `ui-checkbox ${className}` : 'ui-checkbox'
  return (
    <span className={classes}>
      <input ref={ref} type="checkbox" className="ui-checkbox-input" {...rest} />
      <span className="ui-checkbox-control" aria-hidden="true">
        <svg className="ui-checkbox-icon" viewBox="0 0 16 16" focusable="false">
          <path className="ui-checkbox-check" d="M3.75 8.25 6.75 11 12.25 5.5" />
          <path className="ui-checkbox-indeterminate" d="M4 8h8" />
        </svg>
      </span>
    </span>
  )
})
