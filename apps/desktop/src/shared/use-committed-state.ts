import { useCallback, useLayoutEffect, useRef } from 'react'

interface CommittedState<T> {
  scope: string
  value: T
  ready: boolean
  error: string | null
  cancelPending(): void
  persist(value: T): Promise<void>
  apply(value: T): void
  restorePending(): void
}

/** Explicit saves acknowledge native persistence before publishing state to other callers. */
export function useCommittedState<T>(source: CommittedState<T>) {
  const latest = useRef(source)
  const busy = useRef(false)
  const active = useRef(true)
  useLayoutEffect(() => { latest.current = source })
  useLayoutEffect(() => { active.current = true; return () => { active.current = false } }, [])
  return useCallback(async (change: (current: T) => T) => {
    if (busy.current) throw new Error('A save is already in progress. Read the resource and try again.')
    const initial = latest.current
    if (!initial.ready || initial.error) throw new Error(initial.error ?? 'Resources are not loaded.')
    busy.current = true
    let cancelledPending = false
    try {
      const before = JSON.stringify(initial.value)
      const next = change(initial.value)
      initial.cancelPending()
      cancelledPending = true
      await initial.persist(next)
      if (!active.current || latest.current.scope !== initial.scope) throw new Error('The workspace is no longer available.')
      if (JSON.stringify(latest.current.value) !== before) {
        // A manual edit won the race: keep it in the interface and restore it on disk.
        latest.current.cancelPending()
        await initial.persist(latest.current.value)
        throw new Error('The resource changed while saving. Read it again before retrying.')
      }
      initial.apply(next)
    } catch (error) {
      if (cancelledPending && active.current && latest.current.scope === initial.scope) latest.current.restorePending()
      throw error
    } finally { busy.current = false }
  }, [])
}
