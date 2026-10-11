import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
  it('abre com Ctrl+F no editor de request, navega e fecha com Escape', () => {
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

  it('volta o foco para a busca com Ctrl+F e usa Enter para navegar só com o foco na busca', () => {
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

    // No editor, Enter quebra a linha em vez de ir para a próxima ocorrência.
    editor.focus()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(screen.getByText('1 de 3')).toBeInTheDocument()
    expect(editor.querySelectorAll('.cm-line')).toHaveLength(2)

    input.focus()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('2 de 3')).toBeInTheDocument()
  })

  it('não move o cursor enquanto o conteúdo é editado com a busca aberta', () => {
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

  it('abre pelo ícone na response e avança entre resultados', () => {
    const { container } = render(<ResponseCodeView text='{"name":"Ana","other":"Ana"}' language="json" />)

    fireEvent.click(screen.getByRole('button', { name: 'Localizar no editor' }))
    const input = screen.getByRole('textbox', { name: 'Texto para localizar' })
    fireEvent.change(input, { target: { value: 'Ana' } })

    expect(screen.getByText('1 de 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Próximo resultado' }))
    expect(screen.getByText('2 de 2')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-editor-search-match--active')).toHaveLength(1)
  })
})
