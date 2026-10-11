import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { Spinner } from './icons'
import './buttons.css'

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'success'
type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
}

/** Botão de texto com variante/tamanho consistentes; use `IconButton` para botões só de ícone. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'sm', isLoading = false, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  const classes = [
    'ui-button',
    `ui-button--${variant}`,
    `ui-button--${size}`,
    isLoading ? 'ui-button--loading' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...rest}
    >
      {isLoading && <Spinner size={size === 'md' ? 16 : 14} />}
      {children}
    </button>
  )
})
