import { describe, expect, it, vi } from 'vitest'
import { EditorState, EditorSelection as CodeMirrorSelection } from '@codemirror/state'
import { act, render, screen, waitFor } from '../../test-utils'
import { ScriptsPanel } from './components/ScriptsPanel'
import { currentEditorSelection, editorHighlighter, publishEditorSelection, registerEditorHighlighter, revealEditor } from './editor-bridge'

function stateWithSelection(doc: string, from: number, to: number) {
  return EditorState.create({ doc, selection: CodeMirrorSelection.single(from, to) })
}

function renderScripts() {
  return render(
    <ScriptsPanel
      preRequestScript="al.request.url = 'x'"
      postResponseScript="al.test('ok', () => al.expect(al.response.status).toBe(200))"
      onPreRequestScriptChange={vi.fn()}
      onPostResponseScriptChange={vi.fn()}
      execution={{ status: 'idle' }}
      agentEditors
    />,
  )
}

describe('editor bridge', () => {
  it('keeps the latest non-empty selection and clears it only from the same editor', () => {
    publishEditorSelection('response', stateWithSelection('{"id": 42}', 7, 9))
    expect(currentEditorSelection()).toEqual({ slot: 'response', text: '42' })

    publishEditorSelection('body', stateWithSelection('abc', 1, 1))
    expect(currentEditorSelection()).toEqual({ slot: 'response', text: '42' })

    publishEditorSelection('response', stateWithSelection('{"id": 42}', 3, 3))
    expect(currentEditorSelection()).toBeNull()
  })

  it('forgets the selection of an editor that unmounts', () => {
    const unregister = registerEditorHighlighter('query', { highlight: () => 0 })
    publishEditorSelection('query', stateWithSelection('query { me }', 8, 10))
    unregister()
    expect(currentEditorSelection()).toBeNull()
    expect(editorHighlighter('query')).toBeUndefined()
  })

  it('reveals the script editor and highlights text in its search bar', async () => {
    renderScripts()
    await waitFor(() => expect(editorHighlighter('preRequestScript')).toBeDefined())
    expect(editorHighlighter('postResponseScript')).toBeUndefined()

    act(() => revealEditor('postResponseScript'))
    await waitFor(() => expect(editorHighlighter('postResponseScript')).toBeDefined())

    let matches = 0
    act(() => {
      matches = editorHighlighter('postResponseScript')!.highlight('al.')
    })
    expect(matches).toBe(3)
    expect(await screen.findByDisplayValue('al.')).toBeInTheDocument()
  })
})
