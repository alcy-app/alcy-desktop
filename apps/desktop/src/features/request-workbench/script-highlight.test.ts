import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { reservedIdentifierDecorations } from './script-highlight'

function highlightedTexts(doc: string): string[] {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: javascript() }) })
  ensureSyntaxTree(view.state, doc.length, 1000)
  const texts: string[] = []
  reservedIdentifierDecorations(view).between(0, doc.length, (from, to) => {
    texts.push(`${from}:${view.state.sliceDoc(from, to)}`)
  })
  view.destroy()
  return texts
}

describe('reservedIdentifierDecorations', () => {
  it('destaca o objeto global al', () => {
    expect(highlightedTexts('al.environment.set("x", al.response.status)')).toEqual(['0:al', '24:al'])
  })

  it('ignora al como propriedade, em strings, comentários e dentro de outros nomes', () => {
    expect(highlightedTexts('obj.al; "al"; // al\nconst alpha = 1')).toEqual([])
  })
})
