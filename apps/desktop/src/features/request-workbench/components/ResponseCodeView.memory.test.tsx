import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { foldEffect, foldedRanges } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import * as formatOffMainThreadModule from '../format-off-main-thread'
import { resetResponseViewMemoryForTests } from '../response-view-memory'
import { ResponseCodeView, WORKER_FORMAT_THRESHOLD_BYTES } from './ResponseCodeView'

const BODY = '{"alpha":1,"beta":{"alpha":2},"gamma":"alpha"}'

function editorView(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)
  if (!view) throw new Error('editor view not found')
  return view
}

function foldCount(view: EditorView): number {
  let count = 0
  foldedRanges(view.state).between(0, view.state.doc.length, () => {
    count++
  })
  return count
}

describe('ResponseCodeView view memory', () => {
  // Before, not after: the testing-library cleanup unmounts (and so remembers) after each test.
  beforeEach(() => resetResponseViewMemoryForTests())

  it('restores the open search, its options and the active match when the same response mounts again', () => {
    const first = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Corpo da resposta' }), { key: 'f', ctrlKey: true })
    const input = screen.getByRole('textbox', { name: 'Texto para localizar' })
    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Palavra inteira' }))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('2 de 3')).toBeInTheDocument()
    first.unmount()

    const { container } = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />)

    const restored = screen.getByRole('textbox', { name: 'Texto para localizar' })
    expect(restored).toHaveValue('alpha')
    expect(restored).not.toHaveFocus()
    expect(screen.getByRole('button', { name: 'Palavra inteira' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('2 de 3')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-editor-search-match--active')).toHaveLength(1)
  })

  it('restores the cursor and folds, and keeps a closed search closed', () => {
    const first = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />)
    const view = editorView(first.container)
    const betaLine = view.state.doc.line(3)
    view.dispatch({ selection: { anchor: betaLine.from + 2, head: betaLine.to }, effects: foldEffect.of({ from: betaLine.to, to: view.state.doc.line(5).from + 2 }) })
    first.unmount()

    const { container } = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />)
    const restored = editorView(container)

    expect(restored.state.selection.main.anchor).toBe(betaLine.from + 2)
    expect(restored.state.selection.main.head).toBe(betaLine.to)
    expect(foldCount(restored)).toBe(1)
    expect(screen.queryByRole('textbox', { name: 'Texto para localizar' })).not.toBeInTheDocument()
  })

  it('restores under StrictMode, which creates the view twice', () => {
    const first = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />)
    const view = editorView(first.container)
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from } })
    const expected = view.state.doc.line(4).from
    first.unmount()

    const { container } = render(
      <StrictMode>
        <ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />
      </StrictMode>,
    )

    expect(editorView(container).state.selection.main.head).toBe(expected)
  })

  it('starts fresh for another response, and without a key', () => {
    const first = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Corpo da resposta' }), { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto para localizar' }), { target: { value: 'alpha' } })
    first.unmount()

    const other = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-2" />)
    expect(screen.queryByRole('textbox', { name: 'Texto para localizar' })).not.toBeInTheDocument()
    other.unmount()

    render(<ResponseCodeView text={BODY} language="json" />)
    expect(screen.queryByRole('textbox', { name: 'Texto para localizar' })).not.toBeInTheDocument()
  })

  it('does not apply positions to a different document', () => {
    const first = render(<ResponseCodeView text={BODY} language="json" viewMemoryKey="tab-1" />)
    const view = editorView(first.container)
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    first.unmount()

    const { container } = render(<ResponseCodeView text='{"a":1}' language="json" viewMemoryKey="tab-1" />)

    expect(editorView(container).state.selection.main.head).toBe(0)
  })

  it('waits for an off-main-thread format to restore the cursor of the formatted body', async () => {
    const text = `{"value":"${'a'.repeat(WORKER_FORMAT_THRESHOLD_BYTES + 1024)}"}`
    const formatted = 'LINE ONE\nLINE TWO\nLINE THREE'
    const spy = vi.spyOn(formatOffMainThreadModule, 'formatOffMainThread').mockImplementation(() => Promise.resolve(formatted))

    const first = render(<ResponseCodeView text={text} language="json" viewMemoryKey="tab-1" />)
    await screen.findByText('LINE TWO')
    const view = editorView(first.container)
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    first.unmount()

    const { container } = render(<ResponseCodeView text={text} language="json" viewMemoryKey="tab-1" />)
    // The raw body shows first; the position refers to the formatted one.
    expect(editorView(container).state.selection.main.head).toBe(0)
    await screen.findByText('LINE TWO')
    await waitFor(() => expect(editorView(container).state.selection.main.head).toBe(formatted.indexOf('LINE THREE')))

    spy.mockRestore()
  })
})
