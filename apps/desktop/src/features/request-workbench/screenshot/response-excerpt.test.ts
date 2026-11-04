import { describe, expect, it } from 'vitest'
import { jsonLanguage } from '@codemirror/lang-json'
import { excerptFromSelection, excerptLastLine } from './response-excerpt'
import { highlightTreeRange } from './screenshot-highlight'

const doc = ['{', '  "user": {', '    "name": "Ana",', '    "roles": [', '      "admin"', '    ]', '  }', '}'].join('\n')

/** Selection of `doc` from `needle` up to the end of `endNeedle`, as the response view reports it. */
function select(needle: string, endNeedle: string) {
  const from = doc.indexOf(needle)
  const to = doc.indexOf(endNeedle, from) + endNeedle.length
  const before = doc.slice(0, from)
  const startLine = before.split('\n').length
  const startColumn = from - (before.lastIndexOf('\n') + 1)
  return { from, text: doc.slice(from, to), startLine, startColumn }
}

describe('excerptFromSelection', () => {
  it('removes the indentation the selected lines share and keeps their line numbers', () => {
    const { text, startLine, startColumn } = select('    "roles"', ']')
    const excerpt = excerptFromSelection({ text, startLine, startColumn, language: 'json' })
    expect(excerpt?.lines).toEqual(['"roles": [', '  "admin"', ']'])
    expect(excerpt?.firstLine).toBe(4)
    expect(excerpt && excerptLastLine(excerpt)).toBe(6)
  })

  it('keeps the column of a selection that starts mid-line aligned with the lines below', () => {
    const { text, startLine, startColumn } = select('[', ']')
    const excerpt = excerptFromSelection({ text, startLine, startColumn, language: 'json' })
    // `[` sits at column 13 of its line; the closing bracket at column 4.
    expect(excerpt?.lines).toEqual(['         [', '  "admin"', ']'])
  })

  it('drops blank lines at either end, renumbering from the first kept line', () => {
    const excerpt = excerptFromSelection({ text: '\n  "a": 1,\n  "b": 2\n\n', startLine: 10, startColumn: 3, language: 'json' })
    expect(excerpt?.lines).toEqual(['"a": 1,', '"b": 2'])
    expect(excerpt?.firstLine).toBe(11)
  })

  it('returns null for a whitespace-only selection', () => {
    expect(excerptFromSelection({ text: '  \n\t\n', startLine: 1, startColumn: 0, language: 'text' })).toBeNull()
  })

  it('keeps the colors the fragment has in the whole document', () => {
    const { from, text, startLine, startColumn } = select('"name"', '"Ana"')
    const spans = highlightTreeRange(jsonLanguage.parser.parse(doc), text, from)
    const excerpt = excerptFromSelection({ text, spans, startLine, startColumn, language: 'json' })
    expect(excerpt?.spans).toEqual([[
      { text: '"name"', tone: 'key' },
      { text: ':', tone: 'punctuation' },
      { text: ' ', tone: 'plain' },
      { text: '"Ana"', tone: 'string' },
    ]])
  })

  it('spans rebuild the dedented lines', () => {
    const { from, text, startLine, startColumn } = select('  "user"', '  }')
    const spans = highlightTreeRange(jsonLanguage.parser.parse(doc), text, from)
    const excerpt = excerptFromSelection({ text, spans, startLine, startColumn, language: 'json' })
    expect(excerpt?.spans.map((line) => line.map((span) => span.text).join(''))).toEqual(excerpt?.lines)
    expect(excerpt?.lines[0]).toBe('"user": {')
  })
})
