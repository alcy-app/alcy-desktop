import { describe, expect, it } from 'vitest'
import { countLines } from './line-count'

describe('countLines', () => {
  it('conta linhas como o split por quebra de linha', () => {
    for (const text of ['', 'a', 'a\nb', 'a\n', '\n', '\n\n', 'a\r\nb\r\n', '{\n  "a": 1\n}']) {
      expect(countLines(text)).toBe(text.length === 0 ? 0 : text.split('\n').length)
    }
  })
})
