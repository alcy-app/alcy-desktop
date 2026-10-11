import type { HTMLAttributes } from 'react'
import './badge.css'

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  const classes = ['ui-badge', `ui-badge--${tone}`, className].filter(Boolean).join(' ')
  return <span className={classes} {...rest} />
}
