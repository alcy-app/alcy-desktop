import { describe, expect, it } from 'vitest'
import { highlightLines, type HighlightSpan } from './screenshot-highlight'

const joined = (spans: HighlightSpan[]) => spans.map((span) => span.text).join('')

describe('highlightLines', () => {
  it('colore JSON sem perder caracteres, linha a linha', () => {
    const lines = ['{', '  "id": 1,', '  "name": "Ana",', '  "active": true', '}']
    const result = highlightLines(lines, 'json')

    expect(result.map(joined)).toEqual(lines)
    expect(result[1]).toContainEqual({ text: '"id"', tone: 'key' })
    expect(result[1]).toContainEqual({ text: '1', tone: 'number' })
    expect(result[2]).toContainEqual({ text: '"Ana"', tone: 'string' })
    expect(result[3]).toContainEqual({ text: 'true', tone: 'keyword' })
  })

  it('colore GraphQL com o tokenizador do editor', () => {
    const lines = ['query User($id: ID!) {', '  user(id: $id) { name } # comentário', '}']
    const result = highlightLines(lines, 'graphql')

    expect(result.map(joined)).toEqual(lines)
    expect(result[0][0]).toEqual({ text: 'query', tone: 'key' })
    expect(result[1]).toContainEqual({ text: '# comentário', tone: 'comment' })
  })

  it('mantém texto simples e linhas vazias', () => {
    const lines = ['linha 1', '', 'linha 3']
    const result = highlightLines(lines, 'text')

    expect(result.map(joined)).toEqual(lines)
    expect(result[1]).toEqual([])
  })

  it('tolera JSON parcial (prévia de um corpo grande)', () => {
    const lines = ['{', '  "items": [', '    {"id": 1']
    expect(highlightLines(lines, 'json').map(joined)).toEqual(lines)
  })
})
