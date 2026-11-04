import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { fireEvent, render, screen } from '../../../test-utils'
import { RequestBodyPanel } from './RequestBodyPanel'
import { ResponseCodeView } from './ResponseCodeView'

function paste(editor: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      types: ['text/plain'],
    },
  })
  fireEvent(editor, event)
}

function EditableRequestBody() {
  const [value, setValue] = useState('Alpha alpha alphabet')
  return <RequestBodyPanel value={value} onChange={setValue} language="none" />
}

describe('EditorSearch', () => {
  it('opens with Ctrl+F in the request editor, navigates and closes with Escape', () => {
    const { container } = render(
      <RequestBodyPanel value="Alpha alpha alphabet" onChange={vi.fn()} language="none" />,
    )
    const editor = screen.getByRole('textbox', { name: 'Corpo da requisição' })

    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('textbox', { name: 'Texto para localizar' })
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: 'alpha' } })
    expect(screen.getByText('1 de 3')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-editor-search-match')).toHaveLength(2)
    expect(container.querySelectorAll('.cm-editor-search-match--active')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Diferenciar maiúsculas e minúsculas' }))
    expect(screen.getByText('1 de 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Palavra inteira' }))
    expect(screen.getByText('1 de 1')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Texto para localizar' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Localizar no editor' })).toBeInTheDocument()
  })

  it('refocuses the search with Ctrl+F and navigates with Enter only from the search field', () => {
    render(<EditableRequestBody />)
    const editor = screen.getByRole('textbox', { name: 'Corpo da requisição' })

    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('textbox', { name: 'Texto para localizar' })
    fireEvent.change(input, { target: { value: 'alpha' } })
    expect(screen.getByText('1 de 3')).toBeInTheDocument()

    editor.focus()
    expect(editor).toHaveFocus()
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    expect(input).toHaveFocus()

    // In the editor, Enter breaks the line instead of moving to the next match.
    editor.focus()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(screen.getByText('1 de 3')).toBeInTheDocument()
    expect(editor.querySelectorAll('.cm-line')).toHaveLength(2)

    input.focus()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('2 de 3')).toBeInTheDocument()
  })

  it('does not move the cursor while the content is edited with the search open', () => {
    render(<EditableRequestBody />)
    const editor = screen.getByRole('textbox', { name: 'Corpo da requisição' })

    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto para localizar' }), {
      target: { value: 'alpha' },
    })

    editor.focus()
    paste(editor, 'Z')
    paste(editor, 'Y')

    expect(editor.textContent).toBe('ZYAlpha alpha alphabet')
  })

  it('opens from the icon in the response and steps through results', () => {
    const { container } = render(<ResponseCodeView text='{"name":"Ana","other":"Ana"}' language="json" />)

    fireEvent.click(screen.getByRole('button', { name: 'Localizar no editor' }))
    const input = screen.getByRole('textbox', { name: 'Texto para localizar' })
    fireEvent.change(input, { target: { value: 'Ana' } })

    expect(screen.getByText('1 de 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Próximo resultado' }))
    expect(screen.getByText('2 de 2')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-editor-search-match--active')).toHaveLength(1)
  })

  it('searches for the selected text when Ctrl+F is pressed over a selection', () => {
    const { container } = render(<ResponseCodeView text="Alpha alpha alphabet" language="none" />)
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    view.dispatch({ selection: { anchor: 6, head: 11 } })

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Corpo da resposta' }), { key: 'f', ctrlKey: true })

    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Texto para localizar' })
    expect(input).toHaveValue('alpha')
    expect(input).toHaveFocus()
    // The selected occurrence is the active one.
    expect(screen.getByText('2 de 3')).toBeInTheDocument()
  })

  it('replaces the query of an open search with the new selection, all selected for typing over', () => {
    const { container } = render(<ResponseCodeView text="Alpha alpha alphabet" language="none" />)
    const editor = screen.getByRole('textbox', { name: 'Corpo da resposta' })
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Texto para localizar' })
    fireEvent.change(input, { target: { value: 'beta' } })

    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    view.dispatch({ selection: { anchor: 12, head: 20 } })
    editor.focus()
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })

    expect(input).toHaveValue('alphabet')
    expect(input).toHaveFocus()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'alphabet'.length])
  })

  it('keeps the previous query when the selection spans lines', () => {
    const { container } = render(<ResponseCodeView text={'Alpha\nalpha'} language="none" />)
    const editor = screen.getByRole('textbox', { name: 'Corpo da resposta' })
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto para localizar' }), { target: { value: 'Alpha' } })

    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    editor.focus()
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })

    expect(screen.getByRole('textbox', { name: 'Texto para localizar' })).toHaveValue('Alpha')
  })
})
