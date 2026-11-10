import { describe, expect, it } from 'vitest'
import {
  buildEditorSearchReplacements,
  findEditorSearchMatches,
  mapRangeThroughTextChange,
  searchSeedFromSelection,
} from './editor-search'

const defaults = { matchCase: false, wholeWord: false, regularExpression: false }
const regex = { ...defaults, regularExpression: true }

function replaceIn(text: string, query: string, replacement: string, options = defaults, preserveCase = false): string {
  return buildEditorSearchReplacements(text, query, options, { replacement, preserveCase })
    .reverse()
    .reduce((current, change) => current.slice(0, change.from) + change.insert + current.slice(change.to), text)
}

describe('buildEditorSearchReplacements', () => {
  it('keeps the replacement literal outside regular expressions', () => {
    expect(replaceIn('a.b', 'a', '$& $1 \\n')).toBe('$& $1 \\n.b')
  })

  it('expands groups and escapes in a regular expression', () => {
    expect(replaceIn('id-12', '(\\w+)-(\\d+)', '$2:$1', regex)).toBe('12:id')
    expect(replaceIn('id-12', '(?<name>\\w+)-\\d+', '$<name>!', regex)).toBe('id!')
    expect(replaceIn('ab', 'ab', '[$&] $$ $0', regex)).toBe('[ab] $ ab')
    expect(replaceIn('a,b', ',', '\\n\\t\\\\', regex)).toBe('a\n\t\\b')
  })

  it('leaves a reference to a missing group as typed and reads $12 as group 1 then 2', () => {
    expect(replaceIn('ab', '(a)b', '$2', regex)).toBe('$2')
    expect(replaceIn('ab', '(a)b', '$12', regex)).toBe('a2')
    expect(replaceIn('ab', 'ab', '$<missing>', regex)).toBe('$<missing>')
  })

  it('treats anchors per line in a regular expression', () => {
    expect(replaceIn('one\ntwo', '^', '> ', regex)).toBe('one\ntwo')
    expect(replaceIn('one\ntwo', '^\\w', 'X', regex)).toBe('Xne\nXwo')
  })

  it('preserves the case of each occurrence when asked', () => {
    expect(replaceIn('foo Foo FOO', 'foo', 'bar', defaults, true)).toBe('bar Bar BAR')
    expect(replaceIn('foo', 'foo', 'BaR', defaults, true)).toBe('bar')
    expect(replaceIn('F', 'f', 'bar', defaults, true)).toBe('Bar')
    expect(replaceIn('12', '12', 'bAr', defaults, true)).toBe('bAr')
  })

  it('replaces past the cap the search stops at', () => {
    const text = 'a '.repeat(10_001)
    expect(findEditorSearchMatches(text, 'a', defaults).limited).toBe(true)
    expect(buildEditorSearchReplacements(text, 'a', defaults, { replacement: 'b', preserveCase: false })).toHaveLength(10_001)
  })

  it('only touches occurrences inside the scope and honours whole word', () => {
    const changes = buildEditorSearchReplacements(
      'cat cat catalog cat',
      'cat',
      { ...defaults, wholeWord: true },
      { replacement: 'dog', preserveCase: false },
      { from: 4, to: 15 },
    )
    expect(changes).toEqual([{ from: 4, to: 7, insert: 'dog' }])
  })

  it('returns nothing for an empty query or an invalid expression', () => {
    expect(buildEditorSearchReplacements('text', '', defaults, { replacement: 'x', preserveCase: false })).toEqual([])
    expect(buildEditorSearchReplacements('text', '[', regex, { replacement: 'x', preserveCase: false })).toEqual([])
  })
})

describe('mapRangeThroughTextChange', () => {
  const range = { from: 4, to: 8 }

  it('shifts the range for an edit before it and keeps it for one after it', () => {
    expect(mapRangeThroughTextChange(range, 'abcdEFGHij', 'XXabcdEFGHij')).toEqual({ from: 6, to: 10 })
    expect(mapRangeThroughTextChange(range, 'abcdEFGHij', 'abcdEFGHijXX')).toEqual(range)
  })

  it('grows or shrinks the range for an edit inside it', () => {
    expect(mapRangeThroughTextChange(range, 'abcdEFGHij', 'abcdEXXFGHij')).toEqual({ from: 4, to: 10 })
    expect(mapRangeThroughTextChange(range, 'abcdEFGHij', 'abcdEHij')).toEqual({ from: 4, to: 6 })
  })

  it('drops the range when an edit crosses a boundary or empties it', () => {
    expect(mapRangeThroughTextChange(range, 'abcdEFGHij', 'abXXGHij')).toBeNull()
    expect(mapRangeThroughTextChange(range, 'abcdEFGHij', 'abcdij')).toBeNull()
  })
})

describe('findEditorSearchMatches scope', () => {
  it('keeps only occurrences fully inside the scope', () => {
    expect(findEditorSearchMatches('alpha alpha alpha', 'alpha', defaults, { from: 3, to: 12 }).matches).toEqual([{ from: 6, to: 11 }])
  })
})

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
