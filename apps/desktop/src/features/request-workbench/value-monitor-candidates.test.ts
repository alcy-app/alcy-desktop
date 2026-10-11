import { describe, expect, it } from 'vitest'
import { lastFieldKey, monitorCandidates } from './value-monitor-candidates'

describe('lastFieldKey', () => {
  it('usa a última chave e descarta o marcador de array', () => {
    expect(lastFieldKey('nome')).toBe('nome')
    expect(lastFieldKey('usuario.nome')).toBe('nome')
    expect(lastFieldKey('itens[].tags[]')).toBe('tags')
  })
})

describe('monitorCandidates', () => {
  const text = '{\n  "nome": "Ana",\n  "itens": [{ "nome": "Bia", "idade": 3 }],\n  "tags": ["nome"]\n}'

  it('devolve só valores cuja última chave é monitorada, com faixa e literal', () => {
    const { candidates, truncated } = monitorCandidates(text, ['nome'])
    expect(truncated).toBe(false)
    expect(candidates.map((candidate) => [candidate.path, candidate.literal])).toEqual([
      [['nome'], '"Ana"'],
      [['itens', 0, 'nome'], '"Bia"'],
    ])
    const first = candidates[0]
    expect(text.slice(first.from, first.to)).toBe('"Ana"')
  })

  it('não devolve nada sem chaves ou com JSON inválido', () => {
    expect(monitorCandidates(text, []).candidates).toEqual([])
    expect(monitorCandidates('{"nome": ', ['nome']).candidates).toEqual([])
  })
})
