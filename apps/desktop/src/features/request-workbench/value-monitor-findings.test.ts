import { describe, expect, it } from 'vitest'
import { highlightsFrom } from './use-value-monitor-findings'
import { highlightAt } from './value-monitor-highlight'

const candidates = [
  { from: 10, to: 15, path: ['nome'], literal: '"Ana"' },
  { from: 30, to: 41, path: ['itens', 0, 'nome'], literal: '"Ana Maria"' },
]

describe('highlightsFrom', () => {
  it('agrupa os resultados por valor e marca reprovados', () => {
    const highlights = highlightsFrom(candidates, [
      { valueIndex: 1, monitorId: 'a', field: 'nome', failedRuleIds: ['letras'] },
      { valueIndex: 0, monitorId: 'a', field: 'nome', failedRuleIds: [] },
      { valueIndex: 1, monitorId: 'b', field: 'itens.nome', failedRuleIds: [] },
    ])
    expect(highlights.map((highlight) => [highlight.from, highlight.failed, highlight.results.length])).toEqual([
      [10, false, 1],
      [30, true, 2],
    ])
  })

  it('ignora índices que não existem', () => {
    expect(highlightsFrom(candidates, [{ valueIndex: 9, monitorId: 'a', field: 'nome', failedRuleIds: [] }])).toEqual([])
  })
})

describe('highlightAt', () => {
  it('acha o destaque que contém a posição', () => {
    const highlights = highlightsFrom(candidates, [
      { valueIndex: 0, monitorId: 'a', field: 'nome', failedRuleIds: [] },
      { valueIndex: 1, monitorId: 'a', field: 'nome', failedRuleIds: [] },
    ])
    expect(highlightAt(highlights, 12)?.from).toBe(10)
    expect(highlightAt(highlights, 41)?.from).toBe(30)
    expect(highlightAt(highlights, 20)).toBeNull()
  })
})
