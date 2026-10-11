import { describe, expect, it } from 'vitest'
import { definedVariables } from './defined-variables'

describe('definedVariables', () => {
  it('descarta linhas sem nome', () => {
    const rows = [
      { name: 'baseUrl', value: 'a' },
      { name: '', value: '' },
      { name: '  ', value: 'rascunho' },
    ]

    expect(definedVariables(rows)).toEqual([{ name: 'baseUrl', value: 'a' }])
  })

  it('preserva o array quando não há o que remover', () => {
    const rows = [{ name: 'token', value: 'x' }]

    expect(definedVariables(rows)).toBe(rows)
  })
})
