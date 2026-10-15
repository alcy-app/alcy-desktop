import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import type { HistoryEntrySummaryDto } from '../../../bindings/list-history'
import { HistoryPanel } from './HistoryPanel'

const LONG_URL = 'https://api.example.com/v1/organizations/acme/projects/alcy/requests?include=headers,body&page=2'

const ENTRIES: HistoryEntrySummaryDto[] = [
  {
    origin: 'collection',
    id: 'request-1',
    protocol: 'rest',
    endpoint: LONG_URL,
    executedAtMs: Date.UTC(2026, 8, 25, 12),
    outcome: { type: 'success', statusCode: 200, durationMs: 12, sizeBytes: 34 },
  },
  {
    origin: 'flow',
    id: 'flow-1',
    flowName: 'Fluxo de login',
    executedAtMs: Date.UTC(2026, 8, 25, 11),
    durationMs: 50,
    status: 'completed',
  },
]

function renderPanel() {
  render(<HistoryPanel entries={ENTRIES} loaded activeComponentKind={null} onRestore={() => {}} onRefresh={() => {}} />)
}

describe('HistoryPanel', () => {
  it('mostra a URL completa num tooltip ao passar o mouse na URL', async () => {
    renderPanel()
    fireEvent.mouseEnter(screen.getByText(LONG_URL))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent(LONG_URL)
    expect(tooltip).toHaveClass('ui-tooltip--multiline')
  })

  it('keeps the filter toolbar pinned outside the scrolling body that holds the entries', () => {
    renderPanel()

    const toolbar = document.querySelector('.sidebar-panel-toolbar') as HTMLElement
    const scrollBody = document.querySelector('.sidebar-panel-scroll') as HTMLElement
    expect(toolbar).toContainElement(screen.getByRole('button', { name: 'Filtrar histórico' }))
    expect(toolbar).not.toContainElement(scrollBody)
    expect(scrollBody).toContainElement(screen.getByText('Fluxo de login'))
  })

  it('renders the empty state inside the scrolling body', () => {
    render(<HistoryPanel entries={[]} loaded activeComponentKind={null} onRestore={() => {}} onRefresh={() => {}} />)

    const scrollBody = document.querySelector('.sidebar-panel-scroll') as HTMLElement
    expect(scrollBody).toContainElement(screen.getByText('Nenhuma requisição executada ainda.'))
  })

  it('não mostra tooltip de URL no nome de um flow', async () => {
    renderPanel()
    fireEvent.mouseEnter(screen.getByText('Fluxo de login'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('HistoryPanel — runner', () => {
  it('mostra um run do runner com o placar e abre o relatório', () => {
    const onRestore = vi.fn()
    render(
      <HistoryPanel
        entries={[
          {
            origin: 'runner',
            id: 'run-1',
            scopeName: 'Loja',
            executedAtMs: Date.UTC(2026, 8, 25, 10),
            durationMs: 900,
            status: 'failed',
            passed: 2,
            total: 3,
          },
        ]}
        loaded
        activeComponentKind={null}
        onRestore={onRestore}
        onRefresh={() => {}}
      />,
    )

    expect(screen.getByText('Loja')).toBeInTheDocument()
    expect(screen.getByText('2/3')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Runner' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Abrir run de Loja' }))
    expect(onRestore).toHaveBeenCalledWith('run-1')
  })
})

describe('HistoryPanel — carga', () => {
  it('mostra um relatório de carga e o abre sob demanda', () => {
    const onRestore = vi.fn()
    render(
      <HistoryPanel
        entries={[{
          origin: 'load',
          id: 'load-1',
          flowId: 'flow-1',
          flowName: 'Carga de login',
          executedAtMs: Date.UTC(2026, 8, 25, 10),
          durationMs: 900,
          status: 'completed',
          passed: true,
          requests: 12,
          failedRequests: 1,
        }]}
        loaded
        activeComponentKind={null}
        onRestore={onRestore}
        onRefresh={() => {}}
      />,
    )

    expect(screen.getByText('Carga de login')).toBeInTheDocument()
    expect(screen.getByText('12 requisições, 1 erros')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Carga' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Abrir resultado de carga de Carga de login' }))
    expect(onRestore).toHaveBeenCalledWith('load-1')
  })
})
