import { describe, expect, it } from 'vitest'
import { localDay, usageLevel, weekDays } from './agent-usage'

describe('agent usage calendar', () => {
  it('names local days and the week so far, Monday first', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(weekDays(new Date(2026, 9, 29))).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'])
    expect(weekDays(new Date(2026, 10, 1))).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(weekDays(new Date(2026, 9, 26))).toEqual(['2026-10-26'])
  })

  it('warns from 80% of a limit and only when there is one', () => {
    expect(usageLevel(1_000_000, null)).toBe('ok')
    expect(usageLevel(79, 100)).toBe('ok')
    expect(usageLevel(80, 100)).toBe('warning')
    expect(usageLevel(100, 100)).toBe('exceeded')
  })
})
