import { useCallback, useMemo, useState } from 'react'

/** State of one pseudo-tab: what it shows (`null` while closed) and whether it is in front. */
export interface PseudoTabState<T> {
  target: T | null
  active: boolean
  /** Shows `target` and brings the tab to the front. */
  open: (target: T) => void
  activate: () => void
  deactivate: () => void
  close: () => void
}

export function usePseudoTab<T>(): PseudoTabState<T> {
  const [target, setTarget] = useState<T | null>(null)
  const [active, setActive] = useState(false)
  const open = useCallback((next: T) => {
    setTarget(next)
    setActive(true)
  }, [])
  const activate = useCallback(() => setActive(true), [])
  const deactivate = useCallback(() => setActive(false), [])
  const close = useCallback(() => {
    setTarget(null)
    setActive(false)
  }, [])
  return useMemo(() => ({ target, active, open, activate, deactivate, close }), [target, active, open, activate, deactivate, close])
}
