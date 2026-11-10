import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { installNativeTextUndo } from '../../../shared/native-text-undo'
import { clearSavedEditorStates } from '../editor-state-cache'
import { fireEvent, render, screen } from '../../../test-utils'
import { RequestBodyPanel } from './RequestBodyPanel'

function paste(editor: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), types: ['text/plain'] },
  })
  fireEvent(editor, event)
}

function viewOf(container: HTMLElement): EditorView {
  return EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
}

function EditableBody({ initial, historyKey }: { initial: string; historyKey?: string }) {
  const [value, setValue] = useState(initial)
  return <RequestBodyPanel value={value} onChange={setValue} language="none" historyKey={historyKey} />
}

const KEY = 'tab-1\nbody'

afterEach(() => clearSavedEditorStates())

describe('RequestBodyPanel undo history', () => {
  it('undoes a paste with Ctrl+Z through the editor history, not the native field command', () => {
    const runCommand = vi.fn()
    const uninstall = installNativeTextUndo(window, runCommand)
    try {
      const { container } = render(<EditableBody initial="" />)
      const editor = screen.getByRole('textbox', { name: 'Corpo da requisição' })

      paste(editor, '{"a": 1}')
      expect(viewOf(container).state.doc.toString()).toBe('{"a": 1}')

      fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
      expect(viewOf(container).state.doc.toString()).toBe('')
      expect(runCommand).not.toHaveBeenCalled()
    } finally {
      uninstall()
    }
  })

  it('keeps the history across a remount with the same key and text', () => {
    const first = render(<EditableBody initial="first" historyKey={KEY} />)
    const view = viewOf(first.container)
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nsecond' } })
    const edited = view.state.doc.toString()
    first.unmount()

    const second = render(<RequestBodyPanel value={edited} onChange={vi.fn()} language="none" historyKey={KEY} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Corpo da requisição' }), { key: 'z', ctrlKey: true })
    expect(viewOf(second.container).state.doc.toString()).toBe('first')
  })

  it('starts a new history when the text changed while unmounted', () => {
    const first = render(<EditableBody initial="first" historyKey={KEY} />)
    const view = viewOf(first.container)
    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })
    first.unmount()

    const second = render(<RequestBodyPanel value="other request" onChange={vi.fn()} language="none" historyKey={KEY} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Corpo da requisição' }), { key: 'z', ctrlKey: true })
    expect(viewOf(second.container).state.doc.toString()).toBe('other request')
  })
})
