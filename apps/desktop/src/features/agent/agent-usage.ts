import { useEffect, useReducer, useState } from 'react'
import { getAgentUsage, type AgentUsageDto } from '../../bindings/agent-settings'

/** Local calendar day as `YYYY-MM-DD`, the key the token usage is counted under (ADR 0065). */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local days of the week of `date` up to it, Monday first. */
export function weekDays(date: Date): string[] {
  const sinceMonday = (date.getDay() + 6) % 7
  return Array.from({ length: sinceMonday + 1 }, (_, index) => {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday + index)
    return localDay(day)
  })
}

export type UsageLevel = 'ok' | 'warning' | 'exceeded'

/** Warns from 80% of the limit on; without a limit there is nothing to warn about. */
export function usageLevel(used: number, limit: number | null): UsageLevel {
  if (limit === null) return 'ok'
  if (used >= limit) return 'exceeded'
  return used >= limit * 0.8 ? 'warning' : 'ok'
}

/**
 * Today's and this week's tokens of a provider. Reloads when the provider
 * changes, after each turn and when the window regains focus (a new day).
 */
export function useAgentUsage(providerId: string | null, running: boolean): AgentUsageDto | null {
  const [loaded, setLoaded] = useState<{ providerId: string; usage: AgentUsageDto } | null>(null)
  const [revision, refresh] = useReducer((value: number) => value + 1, 0)

  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  useEffect(() => {
    if (!providerId || running) return
    let cancelled = false
    const now = new Date()
    void getAgentUsage(providerId, localDay(now), weekDays(now)).then((result) => {
      if (!cancelled && result.ok) setLoaded({ providerId, usage: result.value })
    })
    return () => {
      cancelled = true
    }
  }, [providerId, running, revision])

  return loaded && loaded.providerId === providerId ? loaded.usage : null
}
