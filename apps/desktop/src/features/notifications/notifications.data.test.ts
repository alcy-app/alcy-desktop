import { describe, expect, it } from 'vitest'
import { NOTIFICATIONS } from './notifications.data'

describe('NOTIFICATIONS', () => {
  it('usa ids únicos', () => {
    const ids = NOTIFICATIONS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(NOTIFICATIONS.map((item) => [item.id, item] as const))('%s tem data ISO válida e textos preenchidos', (_, item) => {
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isNaN(new Date(item.date).getTime())).toBe(false)
    for (const text of [...Object.values(item.title), ...Object.values(item.message)]) {
      expect(text.trim()).not.toBe('')
    }
  })
})
