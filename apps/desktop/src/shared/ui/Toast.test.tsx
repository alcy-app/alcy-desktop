import { act, fireEvent, render, screen } from '../../test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToast } from './use-toast'

function Trigger({ text, kind }: { text: string; kind?: 'success' | 'error' }) {
  const { showToast } = useToast()
  return <button onClick={() => showToast(text, kind)}>{`mostrar ${text}`}</button>
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('junta a mesma mensagem em um único toast com contador, em vez de empilhar', () => {
    render(
      <>
        <Trigger text="Falha ao salvar." kind="error" />
        <Trigger text="Outra falha." kind="error" />
      </>,
    )

    const button = screen.getByRole('button', { name: 'mostrar Falha ao salvar.' })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'mostrar Outra falha.' }))

    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]).toHaveTextContent('Falha ao salvar.')
    expect(screen.getByLabelText('Repetido 3 vezes')).toHaveTextContent('×3')
    expect(alerts[1]).not.toHaveTextContent('×')
  })

  it('reinicia o tempo de um toast de sucesso quando a mesma mensagem se repete', () => {
    render(<Trigger text="Collections importadas." />)
    const button = screen.getByRole('button', { name: 'mostrar Collections importadas.' })

    fireEvent.click(button)
    act(() => vi.advanceTimersByTime(2500))
    fireEvent.click(button)
    act(() => vi.advanceTimersByTime(2500))

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('×2')

    act(() => vi.advanceTimersByTime(1000))
    act(() => vi.advanceTimersByTime(300))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
