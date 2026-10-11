import { describe, expect, it } from 'vitest'
import { truncateMiddle } from './truncate-middle'

describe('truncateMiddle', () => {
  it('mantém textos curtos', () => {
    expect(truncateMiddle('abc', 5)).toBe('abc')
  })

  it('preserva início e fim com reticências no meio', () => {
    const result = truncateMiddle('abcdefghijklmnop', 9)
    expect(result).toBe('abcd…mnop')
    expect(Array.from(result)).toHaveLength(9)
  })
})
