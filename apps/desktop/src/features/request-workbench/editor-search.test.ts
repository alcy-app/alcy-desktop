import { describe, expect, it } from 'vitest'
import { findEditorSearchMatches } from './editor-search'

const defaults = { matchCase: false, wholeWord: false, regularExpression: false }

describe('findEditorSearchMatches', () => {
  it('localiza todas as ocorrências sem diferenciar maiúsculas por padrão', () => {
    expect(findEditorSearchMatches('Alpha alpha alphabet', 'alpha', defaults).matches).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ])
  })

  it('filtra por maiúsculas e palavra inteira', () => {
    const result = findEditorSearchMatches('Alpha alpha alphabet', 'alpha', {
      ...defaults,
      matchCase: true,
      wholeWord: true,
    })

    expect(result.matches).toEqual([{ from: 6, to: 11 }])
  })

  it('aceita expressão regular e informa quando ela é inválida', () => {
    expect(findEditorSearchMatches('id-12 id-345', 'id-\\d+', { ...defaults, regularExpression: true }).matches).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 12 },
    ])
    expect(findEditorSearchMatches('texto', '[', { ...defaults, regularExpression: true })).toMatchObject({
      matches: [],
      invalidRegularExpression: true,
    })
  })
})
