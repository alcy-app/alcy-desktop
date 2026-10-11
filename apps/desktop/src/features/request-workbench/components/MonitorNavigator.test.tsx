import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import type { MonitorHighlight } from '../use-value-monitor-findings'
import { MonitorNavigator } from './MonitorNavigator'

function highlight(from: number, field: string, failed: boolean): MonitorHighlight {
  return {
    from,
    to: from + 3,
    path: [field],
    failed,
    results: [{ monitorId: 'm', field, failedRuleIds: failed ? ['r'] : [] }],
  }
}

describe('MonitorNavigator', () => {
  it('percorre só os reprovados por padrão', () => {
    const onReveal = vi.fn()
    const highlights = [highlight(0, 'nome', false), highlight(10, 'nome', true), highlight(20, 'email', true)]
    render(<MonitorNavigator findings={{ status: 'ready', highlights, truncated: false }} onReveal={onReveal} />)

    expect(screen.getByText('2 reprovados')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Próxima ocorrência' }))
    expect(onReveal).toHaveBeenLastCalledWith(highlights[1])
    expect(screen.getByText('1/2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Próxima ocorrência' }))
    expect(onReveal).toHaveBeenLastCalledWith(highlights[2])
    fireEvent.click(screen.getByRole('button', { name: 'Ocorrência anterior' }))
    expect(onReveal).toHaveBeenLastCalledWith(highlights[1])
  })

  it('filtra por campo e inclui aprovados pelo menu', () => {
    const onReveal = vi.fn()
    const highlights = [highlight(0, 'nome', false), highlight(10, 'nome', true), highlight(20, 'email', true)]
    render(<MonitorNavigator findings={{ status: 'ready', highlights, truncated: false }} onReveal={onReveal} />)

    fireEvent.click(screen.getByRole('button', { name: 'Filtrar por campo monitorado' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'email' }))
    expect(screen.getByText('1 reprovado')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filtrar por campo monitorado' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'nome' }))
    fireEvent.click(screen.getByRole('button', { name: 'Filtrar por campo monitorado' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Incluir aprovados' }))
    expect(screen.getByText('2 ocorrências')).toBeInTheDocument()
  })

  it('resume quando tudo foi aprovado e explica estados sem destaque', () => {
    const { rerender } = render(
      <MonitorNavigator findings={{ status: 'ready', highlights: [highlight(0, 'nome', false)], truncated: false }} onReveal={vi.fn()} />,
    )
    expect(screen.getByText('1 aprovado')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Próxima ocorrência' })).toBeNull()

    rerender(<MonitorNavigator findings={{ status: 'partial' }} onReveal={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Carregue a resposta completa para monitorar.')
  })
})
