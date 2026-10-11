import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '../../test-utils'
import type { CollectionRunEventDto, RunStepDto } from '../../bindings/execute-collection-run'
import type { CollectionRunDetailDto } from '../../bindings/get-collection-run-history'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { RequestProtocol, TreeNode } from '../request-workbench/collection-tree'
import { CollectionRunner } from './CollectionRunner'
import type { RunnerTab } from './CollectionRunner'

const executeCollectionRun = vi.fn()
vi.mock('../../bindings/execute-collection-run', () => ({
  executeCollectionRun: (...args: unknown[]) => executeCollectionRun(...args),
}))
vi.mock('../../bindings/cancel-collection-run', () => ({ cancelCollectionRun: vi.fn() }))
vi.mock('../../bindings/get-collection-run-output', () => ({ getCollectionRunOutput: vi.fn(async () => null) }))
const exportCollectionRunReport = vi.fn<(input: unknown) => Promise<{ ok: true }>>(async () => ({ ok: true }))
vi.mock('../../bindings/export-collection-run-report', () => ({
  exportCollectionRunReport: (input: unknown) => exportCollectionRunReport(input),
}))
vi.mock('../../bindings/pick-report-file', () => ({ pickReportFile: vi.fn(async () => '/tmp/loja.html') }))

function request(id: string, name: string, protocol: RequestProtocol = 'rest') {
  return { id, name, protocol, content: emptyRequestContent(protocol) }
}

const collections: TreeNode[] = [
  {
    id: 'shop',
    name: 'Loja',
    authentication: { type: 'none' },
    variables: [],
    folders: [
      { id: 'auth', name: 'Auth', authentication: { type: 'inherit' }, variables: [], folders: [], requests: [request('login', 'Login')] },
    ],
    requests: [request('products', 'Produtos', 'graphql')],
  },
]

function step(position: number, overrides: Partial<RunStepDto> = {}): RunStepDto {
  return {
    iteration: 0,
    position,
    requestId: position === 0 ? 'login' : 'products',
    name: position === 0 ? 'Login' : 'Produtos',
    protocol: position === 0 ? 'rest' : 'graphql',
    method: position === 0 ? 'get' : 'post',
    resolvedUrl: `https://api.test/${position}`,
    outcome: 'passed',
    statusCode: 200,
    durationMs: 20,
    sizeBytes: 10,
    errorMessage: null,
    tests: [],
    logs: [],
    hasOutput: false,
    ...overrides,
  }
}

function renderRunner(tab: RunnerTab, overrides: Partial<Parameters<typeof CollectionRunner>[0]> = {}) {
  const props = {
    tab,
    hidden: false,
    collections,
    rootPath: '/ws',
    environmentVariables: [{ name: 'baseUrl', value: 'https://api.test', sensitive: false }],
    environmentName: 'Dev',
    onBeforeRun: vi.fn(async () => {}),
    onEnvironmentChanges: vi.fn(),
    onRunFinished: vi.fn(),
    onStepLogged: vi.fn(),
    ...overrides,
  }
  render(<CollectionRunner {...props} />)
  return props
}

const liveTab: RunnerTab = { id: 'runner:shop', label: 'Runner · Loja', scopeId: 'shop', report: null }

beforeEach(() => {
  executeCollectionRun.mockReset()
})

describe('CollectionRunner — configuração', () => {
  it('lista as requisições na ordem da sidebar e permite pular algumas', () => {
    renderRunner(liveTab)

    const list = screen.getByRole('list', { name: 'Requisições do run' })
    const names = within(list)
      .getAllByText(/Login|Produtos/)
      .map((element) => element.textContent)
    expect(names).toEqual(['Login', 'Produtos'])
    expect(screen.getByText('Auth')).toBeInTheDocument()
    expect(screen.getByText('2 de 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Incluir Login no run' }))
    expect(screen.getByText('1 de 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Executar \(1\)/ })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }))
    expect(screen.getByRole('button', { name: /Executar \(0\)/ })).toBeDisabled()
  })

  it('valida iterações e delay', () => {
    renderRunner(liveTab)

    fireEvent.change(screen.getByLabelText('Iterações'), { target: { value: '0' } })
    expect(screen.getByText('Entre 1 e 1000.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Executar \(2\)/ })).toBeDisabled()
  })

  it('mostra um aviso quando a coleção foi removida', () => {
    renderRunner({ ...liveTab, scopeId: 'gone' })

    expect(screen.getByText('Esta coleção foi removida.')).toBeInTheDocument()
  })
})

describe('CollectionRunner — execução', () => {
  it('envia o plano e as opções, acompanha o progresso e devolve as variáveis', async () => {
    let emit: (event: CollectionRunEventDto) => void = () => {}
    let finish: () => void = () => {}
    executeCollectionRun.mockImplementation((_input: unknown, onEvent: (event: CollectionRunEventDto) => void) => {
      emit = onEvent
      return new Promise((resolve) => {
        finish = () => resolve({ ok: true })
      })
    })
    const props = renderRunner(liveTab)

    fireEvent.change(screen.getByLabelText('Delay'), { target: { value: '250' } })
    fireEvent.click(screen.getByText('Parar no primeiro erro'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Executar \(2\)/ }))
    })

    expect(props.onBeforeRun).toHaveBeenCalled()
    const [input] = executeCollectionRun.mock.calls[0] as [Record<string, unknown>]
    expect(input).toMatchObject({
      rootPath: '/ws',
      scopeName: 'Loja',
      requestIds: ['login', 'products'],
      dataFilePath: null,
      options: { iterations: 1, delayMs: 250, stopOnError: true, httpErrorsFail: true, saveToHistory: true },
    })
    expect(screen.getByRole('button', { name: /Cancelar/ })).toBeInTheDocument()

    await act(async () => {
      emit({ type: 'runStarted', iterations: 1, requestsPerIteration: 2 })
      emit({ type: 'requestFinished', step: step(0) })
      emit({
        type: 'requestFinished',
        step: step(1, {
          outcome: 'failed',
          tests: [{ name: 'tem produtos', passed: false, message: 'esperado 3, recebido 0' }],
        }),
      })
      emit({
        type: 'runFinished',
        cancelled: false,
        stoppedOnError: false,
        environmentChanges: [{ name: 'token', value: 'abc' }], scopedChanges: [],
      })
      finish()
    })

    expect(screen.getByText('Com falhas')).toBeInTheDocument()
    expect(screen.getByText('Filtrar por:')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Todas 2' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Passaram 1' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Falharam 1' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Puladas 0' })).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()
    // Testes: no resumo do run e nos fatos da requisição selecionada.
    expect(screen.getAllByText('0/1')).toHaveLength(2)
    // A primeira falha fica selecionada no detalhe.
    expect(screen.getByText('esperado 3, recebido 0')).toBeInTheDocument()
    expect(props.onEnvironmentChanges).toHaveBeenCalledWith([{ name: 'token', value: 'abc' }])
    expect(props.onRunFinished).toHaveBeenCalled()
    expect(props.onStepLogged).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /Executar novamente/ })).toBeInTheDocument()
  })

  it('mostra o erro quando o run não consegue começar', async () => {
    executeCollectionRun.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'sem acesso' } })
    renderRunner(liveTab)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Executar \(2\)/ }))
    })

    expect(screen.getByText('Falha ao ler as coleções: sem acesso')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Requisições do run' })).toBeInTheDocument()
  })
})

describe('CollectionRunner — relatório do histórico', () => {
  it('mostra o run gravado sem executar nada', () => {
    const report: CollectionRunDetailDto = {
      id: 'run-1',
      scopeName: 'Loja',
      environmentName: 'Staging',
      startedAtMs: Date.UTC(2026, 8, 25, 10),
      finishedAtMs: Date.UTC(2026, 8, 25, 10, 1),
      cancelled: false,
      stoppedOnError: true,
      iterations: 1,
      options: {
        iterations: 1,
        delayMs: 0,
        stopOnError: true,
        httpErrorsFail: true,
        keepVariableValues: true,
        shareCookies: true,
        persistResponses: true,
        disableLogs: false,
        dataFileName: 'usuarios.csv',
      },
      plan: [
        { requestId: 'login', name: 'Login', protocol: 'rest', method: 'get' },
        { requestId: 'products', name: 'Produtos', protocol: 'graphql', method: 'post' },
      ],
      steps: [step(0, { outcome: 'error', statusCode: null, errorMessage: 'falha de rede: recusada' })],
      outputs: [],
    }
    renderRunner({ id: 'runner-run:run-1', label: 'Runner · Loja', scopeId: null, report })

    expect(screen.getByText('Interrompido')).toBeInTheDocument()
    // A segunda requisição não rodou: aparece como pulada no filtro.
    expect(screen.getByRole('radio', { name: 'Puladas 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Puladas 1' }))
    expect(screen.getByRole('radio', { name: 'Puladas 1' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Não executada')).toBeInTheDocument()
    expect(screen.getByText('O run parou antes desta requisição.')).toBeInTheDocument()
    expect(screen.getByText('Do histórico')).toBeInTheDocument()
    expect(screen.getByText('usuarios.csv')).toBeInTheDocument()
    expect(screen.getByText('Staging')).toBeInTheDocument()
    expect(executeCollectionRun).not.toHaveBeenCalled()
  })

  it('exporta o relatório no formato escolhido', async () => {
    const report: CollectionRunDetailDto = {
      id: 'run-2',
      scopeName: 'Loja',
      environmentName: null,
      startedAtMs: 0,
      finishedAtMs: 10,
      cancelled: false,
      stoppedOnError: false,
      iterations: 1,
      options: {
        iterations: 1,
        delayMs: 0,
        stopOnError: false,
        httpErrorsFail: true,
        keepVariableValues: true,
        shareCookies: true,
        persistResponses: true,
        disableLogs: false,
        dataFileName: null,
      },
      plan: [],
      steps: [step(0)],
      outputs: [],
    }
    renderRunner({ id: 'runner-run:run-2', label: 'Runner · Loja', scopeId: null, report })

    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'JUnit XML' }))
    })

    expect(exportCollectionRunReport).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: '/ws', runId: 'run-2', path: '/tmp/loja.html', format: 'junit' }),
    )
    expect(await screen.findByText('Relatório salvo.')).toBeInTheDocument()
  })
})
