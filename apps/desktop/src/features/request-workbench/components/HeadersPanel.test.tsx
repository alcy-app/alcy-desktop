import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '../../../test-utils'
import { TOOLTIP_DELAY_MS } from '../../../shared/ui/use-tooltip'
import { HeadersPanel } from './HeadersPanel'

const noop = () => {}

describe('HeadersPanel — edição em massa', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mostra as linhas como texto, marcando as desativadas com //', () => {
    render(
      <HeadersPanel
        headers={[
          { id: 'h1', name: 'Accept', value: 'json', enabled: true },
          { id: 'h2', name: 'X-Off', value: '1', enabled: false },
        ]}
        onAdd={noop}
        onUpdate={noop}
        onRemove={noop}
        onReplaceAll={noop}
        environmentVariables={[]}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: /edição em massa/i }))
    expect(screen.getByRole('textbox')).toHaveValue('Accept:json\n// X-Off:1')
  })

  it('mantém headers automáticos ocultos por padrão e mostra como somente leitura', () => {
    vi.useFakeTimers()
    render(
      <HeadersPanel
        headers={[]}
        generatedHeaders={[{ name: 'Authorization', value: 'Bearer token' }]}
        onAdd={noop}
        onUpdate={noop}
        onRemove={noop}
        onReplaceAll={noop}
        environmentVariables={[]}
      />,
    )

    expect(screen.queryByText('Authorization')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /mostrar headers automáticos/i }))

    const row = screen.getByText('Authorization').closest('tr')
    expect(row).toHaveClass('rw-header-row--generated')
    expect(screen.getByLabelText('Header automático Authorization')).toBeDisabled()
    expect(screen.getByText('Automático')).toBeInTheDocument()

    fireEvent.mouseEnter(row!)
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('aba Authorization')
  })

  it('mostra o botão de cookies da sessão só quando há cookies', () => {
    const onOpenSessionCookies = vi.fn()
    const props = {
      headers: [],
      onAdd: noop,
      onUpdate: noop,
      onRemove: noop,
      onReplaceAll: noop,
      environmentVariables: [],
      onOpenSessionCookies,
    }
    const { rerender } = render(<HeadersPanel {...props} sessionCookieCount={0} />)
    expect(screen.queryByRole('button', { name: /cookies/i })).not.toBeInTheDocument()

    rerender(<HeadersPanel {...props} sessionCookieCount={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cookies (2)' }))
    expect(onOpenSessionCookies).toHaveBeenCalled()
  })

  it('avisa quando um header manual será sobrescrito sem bloquear edição', () => {
    vi.useFakeTimers()
    const onUpdate = vi.fn()
    render(
      <HeadersPanel
        headers={[{ id: 'h1', name: 'authorization', value: 'Bearer manual', enabled: true }]}
        overwrittenHeaderNames={['Authorization']}
        onAdd={noop}
        onUpdate={onUpdate}
        onRemove={noop}
        onReplaceAll={noop}
        environmentVariables={[]}
      />,
    )

    const nameInput = screen.getByDisplayValue('authorization')
    const row = nameInput.closest('tr')
    expect(row).toHaveClass('rw-header-row--duplicate')
    expect(nameInput).not.toBeDisabled()

    fireEvent.change(nameInput, { target: { value: 'X-Authorization' } })
    expect(onUpdate).toHaveBeenCalledWith('h1', { name: 'X-Authorization' })

    fireEvent.mouseEnter(row!)
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('será sobrescrito')
  })

  it('envia as linhas interpretadas a cada alteração do texto', () => {
    const onReplaceAll = vi.fn()
    render(<HeadersPanel headers={[]} onAdd={noop} onUpdate={noop} onRemove={noop} onReplaceAll={onReplaceAll} environmentVariables={[]} />)
    fireEvent.click(screen.getByRole('radio', { name: /edição em massa/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A: 1\n// B: 2' } })
    expect(onReplaceAll).toHaveBeenLastCalledWith([
      { name: 'A', value: '1', enabled: true },
      { name: 'B', value: '2', enabled: false },
    ])
  })
})
