import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import { RequestBodyPanel } from './RequestBodyPanel'

function EditableBody({ initial, jsonComments = false }: { initial: string; jsonComments?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <RequestBodyPanel value={value} onChange={setValue} language={jsonComments ? 'json' : 'none'} jsonComments={jsonComments} />
      <output data-testid="value">{value}</output>
    </>
  )
}

function renderBody(initial: string, jsonComments = false) {
  const { container } = render(<EditableBody initial={initial} jsonComments={jsonComments} />)
  const content = container.querySelector<HTMLElement>('.cm-content')!
  const view = EditorView.findFromDOM(content)!
  return { content, view }
}

describe('EditorContextMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies the selected text from the right-click menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { content, view } = renderBody('{"id": 42}')
    view.dispatch({ selection: { anchor: 1, head: 5 } })

    fireEvent.contextMenu(content, { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('"id"'))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('disables Copy without a selection', () => {
    const { content } = renderBody('{}')

    fireEvent.contextMenu(content, { clientX: 40, clientY: 60 })

    expect(screen.getByRole('menuitem', { name: 'Copiar' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Colar' })).toBeEnabled()
  })

  it('pastes the clipboard over the selection, as a single undoable edit', async () => {
    const readText = vi.fn().mockResolvedValue('"name"')
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText } })
    const { content, view } = renderBody('{"id": 42}')
    view.dispatch({ selection: { anchor: 1, head: 5 } })

    fireEvent.contextMenu(content, { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Colar' }))

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('{"name": 42}'))
    expect(view.state.selection.main.head).toBe(7)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    const { content } = renderBody('{}')

    fireEvent.contextMenu(content, { clientX: 40, clientY: 60 })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  describe('comments', () => {
    const BODY = '{\n  "id": 42\n}'
    const openMenu = (content: HTMLElement) => fireEvent.contextMenu(content, { clientX: 40, clientY: 60 })

    it('comments everything when nothing is selected, without a shortcut hint', () => {
      const { content } = renderBody(BODY, true)

      openMenu(content)
      const item = screen.getByRole('menuitem', { name: 'Comentar tudo' })
      expect(item.querySelector('kbd')).toBeNull()
      fireEvent.click(item)

      expect(screen.getByTestId('value')).toHaveTextContent(`/* ${BODY} */`, { normalizeWhitespace: false })
      openMenu(content)
      expect(screen.getByRole('menuitem', { name: 'Descomentar tudo' })).toBeInTheDocument()
    })

    it('comments a whole selected line, showing the comment shortcut', () => {
      const { content, view } = renderBody(BODY, true)
      view.dispatch({ selection: { anchor: BODY.indexOf('"id"'), head: BODY.indexOf('\n}') } })

      openMenu(content)
      const item = screen.getByRole('menuitem', { name: 'Comentar linha' })
      expect(item.querySelector('kbd')).toHaveTextContent('Ctrl+/')
      fireEvent.click(item)

      expect(screen.getByTestId('value')).toHaveTextContent('// "id": 42')
    })

    it('comments only the selected text', () => {
      const { content, view } = renderBody(BODY, true)
      view.dispatch({ selection: { anchor: BODY.indexOf('42'), head: BODY.indexOf('42') + 2 } })

      openMenu(content)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Comentar texto selecionado' }))

      expect(screen.getByTestId('value')).toHaveTextContent('"id": /* 42 */')
      openMenu(content)
      expect(screen.getByRole('menuitem', { name: 'Descomentar texto selecionado' })).toBeInTheDocument()
    })

    it('is not offered by editors without comments', () => {
      const { content } = renderBody(BODY)

      openMenu(content)

      expect(screen.queryByRole('menuitem', { name: /Comentar/ })).not.toBeInTheDocument()
    })
  })
})
