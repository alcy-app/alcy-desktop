import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { autoCloseBracketsExtension, graphqlAutoCloseExtension, insertIndentOrIndentMore } from './codemirror-shared'

function viewWith(doc: string, selection: EditorSelection) {
  return new EditorView({ state: EditorState.create({ doc, selection }) })
}

describe('insertIndentOrIndentMore', () => {
  it('inserts an indent unit at the cursor when nothing is selected', () => {
    const view = viewWith('ab', EditorSelection.single(1))

    expect(insertIndentOrIndentMore(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a  b')
    expect(view.state.selection.main.head).toBe(3)
    view.destroy()
  })

  it('indents every selected line when there is a selection', () => {
    const view = viewWith('one\ntwo', EditorSelection.single(0, 7))

    expect(insertIndentOrIndentMore(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  one\n  two')
    view.destroy()
  })
})

describe('fechamento automático de pares', () => {
  function editor(extensions: Extension) {
    return new EditorView({ state: EditorState.create({ extensions }) })
  }

  /** Simula a digitação passando pelos `inputHandler`s, como o DOM faria. */
  function type(view: EditorView, text: string) {
    for (const char of text) {
      const { from, to } = view.state.selection.main
      const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, char, () => view.state.update({ changes: { from, to, insert: char } })))
      if (!handled) view.dispatch({ changes: { from, to, insert: char }, selection: { anchor: from + 1 } })
    }
  }

  function typedIn(extensions: Extension, text: string) {
    const view = editor(extensions)
    type(view, text)
    const result = { doc: view.state.doc.toString(), head: view.state.selection.main.head }
    view.destroy()
    return result
  }

  const jsonEditor = [json(), autoCloseBracketsExtension()]
  const scriptEditor = [javascript(), autoCloseBracketsExtension()]

  it.each(['{}', '[]', '""'])('JSON: fecha %s com o cursor entre o par', (pair) => {
    expect(typedIn(jsonEditor, pair[0])).toEqual({ doc: pair, head: 1 })
  })

  it.each(['()', '{}', '[]', "''", '""', '``'])('JavaScript: fecha %s com o cursor entre o par', (pair) => {
    expect(typedIn(scriptEditor, pair[0])).toEqual({ doc: pair, head: 1 })
  })

  it.each(['{}', '()', '[]', '""'])('GraphQL: fecha %s com o cursor entre o par', (pair) => {
    expect(typedIn(graphqlAutoCloseExtension(), pair[0])).toEqual({ doc: pair, head: 1 })
  })

  it('GraphQL: não fecha aspas simples', () => {
    expect(typedIn(graphqlAutoCloseExtension(), "'")).toEqual({ doc: "'", head: 1 })
  })

  it('digitar o fechamento sobre o já inserido apenas avança o cursor', () => {
    expect(typedIn(jsonEditor, '{"a"}')).toEqual({ doc: '{"a"}', head: 5 })
    expect(typedIn(graphqlAutoCloseExtension(), 'user(id: "1")')).toEqual({ doc: 'user(id: "1")', head: 13 })
  })

  it('Backspace entre um par vazio apaga os dois', () => {
    const view = editor(graphqlAutoCloseExtension())
    type(view, '{')
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Backspace' }), 'editor')
    expect(view.state.doc.toString()).toBe('')
    view.destroy()
  })
})
