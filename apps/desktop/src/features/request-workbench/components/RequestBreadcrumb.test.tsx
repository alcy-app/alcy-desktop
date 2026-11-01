import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import { RequestBreadcrumb } from './RequestBreadcrumb'

function startRename() {
  fireEvent.click(screen.getByRole('button', { name: 'Renomear requisição Get Models' }))
  return screen.getByRole('textbox', { name: 'Nome' })
}

describe('RequestBreadcrumb', () => {
  it('renames the request from the last segment with Enter', () => {
    const onRename = vi.fn()
    render(<RequestBreadcrumb segments={['Ollama', 'Get Models']} protocol="rest" onRename={onRename} />)

    const input = startRename()
    expect(input).toHaveValue('Get Models')
    fireEvent.change(input, { target: { value: '  List Models  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRename).toHaveBeenCalledExactlyOnceWith('List Models')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('saves when the field loses focus', () => {
    const onRename = vi.fn()
    render(<RequestBreadcrumb segments={['Ollama', 'Get Models']} protocol="rest" onRename={onRename} />)

    const input = startRename()
    fireEvent.change(input, { target: { value: 'List Models' } })
    fireEvent.blur(input)

    expect(onRename).toHaveBeenCalledExactlyOnceWith('List Models')
  })

  it('discards the draft with Escape, an empty name or an unchanged name', () => {
    const onRename = vi.fn()
    render(<RequestBreadcrumb segments={['Ollama', 'Get Models']} protocol="rest" onRename={onRename} />)

    let input = startRename()
    fireEvent.change(input, { target: { value: 'List Models' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Renomear requisição Get Models' })).toBeInTheDocument()

    input = startRename()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    input = startRename()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRename).not.toHaveBeenCalled()
  })

  it('keeps the name read-only without a rename handler', () => {
    render(<RequestBreadcrumb segments={['Flow', 'login']} protocol="rest" />)

    expect(screen.getByText('login')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
