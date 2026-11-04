import { describe, expect, it } from 'vitest'
import { findEditorSearchMatches, searchSeedFromSelection } from './editor-search'

const defaults = { matchCase: false, wholeWord: false, regularExpression: false }

describe('findEditorSearchMatches', () => {
  it('finds every occurrence, case-insensitive by default', () => {
    expect(findEditorSearchMatches('Alpha alpha alphabet', 'alpha', defaults).matches).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ])
  })

  it('filters by case and whole word', () => {
    const result = findEditorSearchMatches('Alpha alpha alphabet', 'alpha', {
      ...defaults,
      matchCase: true,
      wholeWord: true,
    })

    expect(result.matches).toEqual([{ from: 6, to: 11 }])
  })

  it('accepts a regular expression and reports an invalid one', () => {
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

describe('searchSeedFromSelection', () => {
  it('uses a single-line selection as is, escaped for a regular expression search', () => {
    expect(searchSeedFromSelection('items[0].id', false)).toBe('items[0].id')
    expect(searchSeedFromSelection('items[0].id', true)).toBe('items\\[0\\]\\.id')
  })

  it('ignores empty, multi-line and oversized selections', () => {
    expect(searchSeedFromSelection('', false)).toBeNull()
    expect(searchSeedFromSelection('first\nsecond', false)).toBeNull()
    expect(searchSeedFromSelection('a'.repeat(1_001), false)).toBeNull()
  })
})
