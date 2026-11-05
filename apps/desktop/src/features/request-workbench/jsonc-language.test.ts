import { ensureSyntaxTree, foldable } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { findJsonComments } from './json-comments'
import { commentedLineStarts, jsoncLanguageSupport } from './jsonc-language'

function stateWith(doc: string) {
  return EditorState.create({ doc, extensions: jsoncLanguageSupport() })
}

/** Names of the syntax nodes, without error nodes. */
function nodes(state: EditorState): string[] {
  const names: string[] = []
  ensureSyntaxTree(state, state.doc.length, 5000)?.iterate({
    enter: (node) => {
      names.push(node.name)
    },
  })
  return names
}

const COMMENTED = '{\n  // brace } and "quote\n  "a": {"b": 1},\n  /* "x": [ */\n  "c": [3]\n}'

describe('jsoncLanguageSupport', () => {
  it('parses the JSON around comments holding braces and quotes', () => {
    const names = nodes(stateWith(COMMENTED))
    expect(names).not.toContain('⚠')
    expect(names.filter((name) => name === 'Property')).toHaveLength(3)
  })

  it('reparses text that a new comment covers after an edit elsewhere', () => {
    let state = stateWith('{\n  "a": 1,\n  "b": {"c": 2}\n}')
    expect(nodes(state).filter((name) => name === 'Property')).toHaveLength(3)
    state = state.update({ changes: { from: 2, insert: '/*' } }).state
    state = state.update({ changes: { from: state.doc.length - 2, insert: '*/' } }).state
    expect(nodes(state).filter((name) => name === 'Property')).toHaveLength(0)
  })

  it('keeps folding of objects after a commented line', () => {
    const state = stateWith('{\n  // } "\n  "a": {\n    "b": 1\n  }\n}')
    ensureSyntaxTree(state, state.doc.length, 5000)
    const line = state.doc.line(3)
    expect(foldable(state, line.from, line.to)).toEqual({ from: line.to, to: state.doc.line(5).from + 2 })
  })

  it('offers // and /* */ as comment tokens', () => {
    expect(stateWith('{}').languageDataAt('commentTokens', 1)).toEqual([{ line: '//', block: { open: '/*', close: '*/' } }])
  })
})

describe('commentedLineStarts', () => {
  it('lists lines holding only comments, block lines included, not code with a comment', () => {
    const doc = '{\n  // a\n  "b": 1, // c\n  /* d\n  e */\n  /* f */ "g": 2\n}'
    const state = stateWith(doc)
    const lines = commentedLineStarts(state.doc, findJsonComments(doc)).map((start) => state.doc.lineAt(start).number)
    expect(lines).toEqual([2, 4, 5])
  })
})

describe('comment decorations', () => {
  it('marks comments and commented lines in the editor', () => {
    const view = new EditorView({ state: stateWith('{\n  // "a": 1\n  "b": 2 // c\n}') })
    const lines = view.contentDOM.querySelectorAll('.cm-line')
    expect(lines[1].classList.contains('cm-json-commented-line')).toBe(true)
    expect(lines[2].classList.contains('cm-json-commented-line')).toBe(false)
    expect([...view.contentDOM.querySelectorAll('.cm-json-comment')].map((node) => node.textContent)).toEqual(['// "a": 1', '// c'])
    view.destroy()
  })
})
