import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import type { ConsoleEntry } from '../use-console-state'
import { ConsolePanel } from './ConsolePanel'

function entry(overrides: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return {
    id: '1',
    kind: 'request',
    endpointUrl: 'https://api.test/users',
    executedAtMs: 0,
    durationMs: 10,
    outcome: 'error',
    statusCode: null,
    hasGraphqlErrors: false,
    errorKind: 'network',
    scriptMessage: null,
    detail: null,
    ...overrides,
  }
}

function recorder(overrides: Partial<React.ComponentProps<typeof ConsolePanel>['recorder']> = {}) {
  return {
    recording: false,
    exporting: false,
    redactingSensitive: true,
    entries: [],
    onStart: vi.fn(),
    onStop: vi.fn(),
    onClear: vi.fn(),
    onRemove: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  }
}

function renderConsole(entries: ConsoleEntry[]) {
  return render(
    <ConsolePanel
      entries={entries}
      onClear={vi.fn()}
      onRemove={vi.fn()}
      onClose={vi.fn()}
      tab="console"
      onTabChange={vi.fn()}
      recorder={recorder()}
    />,
  )
}

describe('ConsolePanel', () => {
  it('mostra os eventos em ordem cronológica e cada log de script separadamente', () => {
    renderConsole([
      entry({ id: 'request', endpointUrl: 'https://api.test/first' }),
      entry({ id: 'a', kind: 'script', outcome: 'success', errorKind: null, scriptMessage: 'token obtido' }),
      entry({ id: 'b', kind: 'script', outcome: 'success', errorKind: null, scriptMessage: 'fim' }),
    ])

    const rows = screen.getAllByRole('button', { name: 'Ver detalhes da requisição' })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('first')
    expect(rows[1]).toHaveTextContent('token obtido')
    expect(rows[2]).toHaveTextContent('fim')
  })

  it('busca nas mensagens de script e filtra por nível', () => {
    renderConsole([
      entry({ id: 'ok', kind: 'script', outcome: 'success', errorKind: null, scriptMessage: 'token obtido' }),
      entry({ id: 'error', kind: 'script', outcome: 'error', errorKind: null, scriptMessage: 'falha crítica' }),
    ])

    const filter = within(screen.getByRole('tabpanel')).getByLabelText('Filtrar chamadas')
    fireEvent.change(filter, { target: { value: 'crítica' } })
    expect(screen.queryByText('token obtido')).not.toBeInTheDocument()
    expect(screen.getByText('falha crítica')).toBeInTheDocument()

    fireEvent.change(filter, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Erros' }))
    expect(screen.queryByText('token obtido')).not.toBeInTheDocument()
    expect(screen.getByText('falha crítica')).toBeInTheDocument()
  })

  it('pausa o acompanhamento ao rolar e sinaliza novos eventos', () => {
    const first = entry({ id: 'first', endpointUrl: 'https://api.test/first' })
    const view = renderConsole([first])
    const list = screen.getByRole('list', { name: 'Console de requisições' })
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })
    fireEvent.scroll(list)

    view.rerender(
      <ConsolePanel
        entries={[first, entry({ id: 'second', endpointUrl: 'https://api.test/second' })]}
        onClear={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
        tab="console"
        onTabChange={vi.fn()}
        recorder={recorder()}
      />,
    )

    const goToEnd = screen.getByRole('button', { name: 'Ir para o fim · 1 novos' })
    fireEvent.click(goToEnd)
    expect(screen.queryByRole('button', { name: /Ir para o fim/ })).not.toBeInTheDocument()
  })

  it('copia o resumo de um evento do console', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderConsole([entry({ outcome: 'success', errorKind: null, statusCode: 200 })])

    fireEvent.click(screen.getByRole('button', { name: 'Copiar evento' }))
    expect(writeText).toHaveBeenCalledWith('https://api.test/users · 200 · 10 ms')
  })

  it('expande um evento de script para ver a mensagem e a requisição de origem', () => {
    renderConsole([entry({ kind: 'script', outcome: 'success', errorKind: null, scriptMessage: 'olá' })])

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes da requisição' }))

    expect(screen.getAllByText('olá')).toHaveLength(2)
    expect(screen.getByText('https://api.test/users')).toBeInTheDocument()
  })

  it('mostra a falha de script como evento de erro', () => {
    renderConsole([entry({ kind: 'script', outcome: 'error', errorKind: null, scriptMessage: 'boom' })])

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes da requisição' }))

    expect(screen.getByText('Erro no script: boom')).toBeInTheDocument()
  })

  it('uma requisição comum não mostra o selo de script', () => {
    renderConsole([entry()])
    expect(screen.queryByText('Script')).not.toBeInTheDocument()
  })

  it('apresenta estado, métricas e inspetor próprios do gravador HAR', () => {
    const controls = recorder({
      entries: [
        entry({ id: 'ok', outcome: 'success', errorKind: null, statusCode: 200, durationMs: 20 }),
        entry({ id: 'failed', endpointUrl: 'https://api.test/failure', durationMs: null }),
      ],
    })
    render(
      <ConsolePanel
        entries={[]}
        onClear={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
        tab="recording"
        onTabChange={vi.fn()}
        recorder={controls}
      />,
    )

    expect(screen.getByText('Parado')).toBeInTheDocument()
    expect(screen.getByText('Capturas').nextElementSibling).toHaveTextContent('2')
    expect(screen.getByText('Falhas').nextElementSibling).toHaveTextContent('1')

    fireEvent.click(screen.getByRole('button', { name: /api.test\/failure/ }))
    const inspector = screen.getByLabelText('Inspetor da captura HAR')
    expect(within(inspector).getByText('https://api.test/failure')).toBeInTheDocument()
    expect(within(inspector).getByRole('tab', { name: 'Resumo' })).toHaveAttribute('aria-selected', 'true')
  })

  it('indica no gravador se os dados sensíveis estão ocultos ou visíveis', () => {
    const renderRecorder = (redactingSensitive: boolean) =>
      render(
        <ConsolePanel
          entries={[]}
          onClear={vi.fn()}
          onRemove={vi.fn()}
          onClose={vi.fn()}
          tab="recording"
          onTabChange={vi.fn()}
          recorder={recorder({ redactingSensitive })}
        />,
      )

    const { unmount } = renderRecorder(true)
    expect(screen.getByText('Dados sensíveis ocultos')).toBeInTheDocument()
    unmount()

    renderRecorder(false)
    expect(screen.getByText('Dados sensíveis visíveis')).toBeInTheDocument()
  })
})
