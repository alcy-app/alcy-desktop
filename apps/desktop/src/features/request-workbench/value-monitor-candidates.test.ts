import { describe, expect, it } from 'vitest'
import { lastFieldKey, monitorCandidates } from './value-monitor-candidates'

describe('lastFieldKey', () => {
  it('uses the last key and drops the array marker', () => {
    expect(lastFieldKey('nome')).toBe('nome')
    expect(lastFieldKey('usuario.nome')).toBe('nome')
    expect(lastFieldKey('itens[].tags[]')).toBe('tags')
  })
})

describe('monitorCandidates', () => {
  const text = '{\n  "nome": "Ana",\n  "itens": [{ "nome": "Bia", "idade": 3 }],\n  "tags": ["nome"]\n}'

  it('returns only values whose last key is monitored, with range and literal', () => {
    const { candidates, truncated } = monitorCandidates(text, ['nome'])
    expect(truncated).toBe(false)
    expect(candidates.map((candidate) => [candidate.path, candidate.literal])).toEqual([
      [['nome'], '"Ana"'],
      [['itens', 0, 'nome'], '"Bia"'],
    ])
    const first = candidates[0]
    expect(text.slice(first.from, first.to)).toBe('"Ana"')
  })

  it('returns array items and empty arrays as values of the key that holds them', () => {
    const movies = '{"filmes": [{"tags": ["history", 3]}, {"tags": []}, {"tags": [{"tags": "x"}]}]}'
    const { candidates } = monitorCandidates(movies, ['tags'])
    expect(candidates.map((candidate) => [candidate.path, candidate.literal])).toEqual([
      [['filmes', 0, 'tags', 0], '"history"'],
      [['filmes', 0, 'tags', 1], '3'],
      [['filmes', 1, 'tags'], '[]'],
      [['filmes', 2, 'tags', 0, 'tags'], '"x"'],
    ])
  })

  it('returns nothing without keys or with invalid JSON', () => {
    expect(monitorCandidates(text, []).candidates).toEqual([])
    expect(monitorCandidates('{"nome": ', ['nome']).candidates).toEqual([])
  })
})
