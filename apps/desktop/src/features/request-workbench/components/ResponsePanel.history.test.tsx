import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../../test-utils'
import type { ResponseComparisonDto } from '../../../bindings/compare-request-sends'
import type { RequestSendDto } from '../../../bindings/list-request-sends'
import type { ExecutionState } from '../request-workbench.types'
import { ResponsePanel } from './ResponsePanel'

const listRequestSends = vi.fn()
const compareRequestSends = vi.fn()
const setSendBaseline = vi.fn()
const getHistoryEntry = vi.fn()

vi.mock('../../../bindings/list-request-sends', () => ({
  listRequestSends: (...args: unknown[]) => listRequestSends(...args),
}))
vi.mock('../../../bindings/compare-request-sends', () => ({
  compareRequestSends: (...args: unknown[]) => compareRequestSends(...args),
}))
vi.mock('../../../bindings/set-send-baseline', () => ({
  setSendBaseline: (...args: unknown[]) => setSendBaseline(...args),
}))
vi.mock('../../../bindings/get-history-entry', () => ({
  getHistoryEntry: (...args: unknown[]) => getHistoryEntry(...args),
}))
vi.mock('../../../bindings/release-response-body', () => ({
  releaseResponseBody: () => Promise.resolve(),
}))

const SOURCE = { rootPath: '/ws', requestId: 'req-1', tabId: 'tab-1' }

const CURRENT: ExecutionState = {
  status: 'success',
  result: {
    statusCode: 200,
    durationMs: 5,
    sizeBytes: 2,
    body: { kind: 'inline', body: '{"a":2}' },
    bodyEncoding: 'text',
    headers: [],
    requestHeaders: [],
    cookies: [],
    connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
    finalUrl: null,
    waitingMs: 0,
    environmentChanges: [],
    scopedChanges: [],
    scriptLogs: [],
    scriptError: null,
    testResults: [],
  },
}

function send(id: string, executedAtMs: number, overrides: Partial<RequestSendDto> = {}): RequestSendDto {
  return {
    id,
    executedAtMs,
    protocol: 'rest',
    endpoint: 'https://api.example.com/users',
    method: 'get',
    outcome: { type: 'success', statusCode: 200, durationMs: 12, sizeBytes: 34, responseStored: true },
    baseline: false,
    ...overrides,
  }
}

function comparison(overrides: Partial<ResponseComparisonDto> = {}): ResponseComparisonDto {
  return {
    identical: false,
    base: { type: 'response', statusCode: 200 },
    target: { type: 'response', statusCode: 200 },
    body: {
      hunks: [
        {
          baseStart: 1,
          targetStart: 1,
          lines: [
            { kind: 'context', text: '{' },
            { kind: 'removed', text: '  "a": 1' },
            { kind: 'added', text: '  "a": 2' },
          ],
        },
      ],
      tooLarge: false,
      binary: false,
      truncated: false,
    },
    ...overrides,
  }
}

function renderPanel(onOpenHistorySettings?: () => void) {
  render(
    <ResponsePanel
      execution={CURRENT}
      onClear={() => {}}
      layout="bottom"
      onToggleLayout={() => {}}
      sendsSource={SOURCE}
      currentSendId="current"
      onOpenHistorySettings={onOpenHistorySettings}
    />,
  )
}

async function openHistory() {
  fireEvent.click(screen.getByRole('button', { name: 'Histórico de envios desta requisição' }))
  return screen.findByRole('menu', { name: 'Histórico de envios desta requisição' })
}

function pastRows(menu: HTMLElement) {
  return within(menu).getAllByRole('menuitemradio')
}

async function openActions(menu: HTMLElement, index: number) {
  fireEvent.click(within(menu).getAllByRole('button', { name: /^Ações do envio de/ })[index])
  return within(menu).findByRole('menu', { name: /^Ações do envio de/ })
}

describe('ResponsePanel — histórico de envios', () => {
  beforeEach(() => {
    listRequestSends.mockReset()
    compareRequestSends.mockReset()
    setSendBaseline.mockReset()
    getHistoryEntry.mockReset()
    listRequestSends.mockResolvedValue({
      ok: true,
      value: [send('current', 3000), send('previous', 2000), send('first', 1000)],
    })
    compareRequestSends.mockResolvedValue({ ok: true, value: comparison() })
    setSendBaseline.mockResolvedValue({ ok: true })
  })

  it('só lista os envios ao abrir o menu, com a atual primeiro', async () => {
    renderPanel()
    expect(listRequestSends).not.toHaveBeenCalled()

    const menu = await openHistory()

    expect(listRequestSends).toHaveBeenCalledWith(SOURCE)
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))
    expect(pastRows(menu)[0]).toHaveTextContent('Atual')
    expect(pastRows(menu)[0]).toHaveAttribute('aria-checked', 'true')
    // O seletor de modo só aparece na comparação, não no menu.
    expect(within(menu).queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('mostra método e URL ao passar o mouse sobre um envio', async () => {
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    fireEvent.mouseEnter(pastRows(menu)[1].parentElement as HTMLElement)

    expect(within(menu).getByText('https://api.example.com/users')).toBeInTheDocument()
    expect(within(menu).getByText('GET')).toBeInTheDocument()
  })

  it('abre a resposta de um envio anterior e volta para a atual', async () => {
    getHistoryEntry.mockResolvedValue({
      ok: true,
      value: {
        protocol: 'rest',
        endpoint: 'https://api.example.com/users',
        method: 'get',
        body: '',
        variables: '',
        headers: [],
        authentication: { type: 'none' },
        restBody: null,
        outcome: {
          type: 'success',
          statusCode: 404,
          durationMs: 9,
          sizeBytes: 7,
          body: { kind: 'inline', body: '{"a":1}' },
          bodyEncoding: 'text',
          headers: [],
          graphqlErrors: [],
        },
      },
    })
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    fireEvent.click(pastRows(menu)[1])

    expect(await screen.findByText('HTTP 404')).toBeInTheDocument()
    expect(getHistoryEntry).toHaveBeenCalledWith('/ws', 'previous')
    expect(screen.getByText(/Exibindo o envio de/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a atual' }))
    expect(await screen.findByText('HTTP 200')).toBeInTheDocument()
  })

  it('mostra o resumo e oferece a configuração quando o envio não guardou a resposta', async () => {
    getHistoryEntry.mockResolvedValue({
      ok: true,
      value: {
        protocol: 'rest',
        endpoint: 'https://api.example.com/users',
        method: 'get',
        body: '',
        variables: '',
        headers: [],
        authentication: { type: 'none' },
        restBody: null,
        outcome: {
          type: 'success',
          statusCode: 201,
          durationMs: 9,
          sizeBytes: 7,
          body: { kind: 'inline', body: '' },
          bodyEncoding: 'text',
          headers: [],
          graphqlErrors: [],
          bodyTruncated: false,
          responseStored: false,
        },
      },
    })
    const onOpenHistorySettings = vi.fn()
    renderPanel(onOpenHistorySettings)
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    fireEvent.click(pastRows(menu)[1])

    // Como num envio comum, o resumo e as abas continuam; o aviso fica no lugar do conteúdo.
    const body = await screen.findByRole('tabpanel', { name: 'Body' })
    expect(within(body).getByText('Resposta não armazenada')).toBeInTheDocument()
    expect(screen.getByText('HTTP 201')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Headers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copiar resposta' })).toBeDisabled()

    fireEvent.click(within(body).getByRole('button', { name: 'Alterar configuração' }))
    expect(onOpenHistorySettings).toHaveBeenCalledTimes(1)
  })

  it('explica quando um dos envios comparados não guardou a resposta', async () => {
    compareRequestSends.mockResolvedValue({ ok: false, error: { kind: 'responseNotStored' } })
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    const actions = await openActions(menu, 1)
    fireEvent.click(within(actions).getByRole('menuitem', { name: 'Comparar com a atual' }))

    expect(await screen.findByText(/a resposta de um dos envios não foi armazenada/)).toBeInTheDocument()
  })

  it('abre o menu de ações de um envio com o botão direito', async () => {
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    fireEvent.contextMenu(pastRows(menu)[1].parentElement as HTMLElement)

    const actions = await within(menu).findByRole('menu', { name: /^Ações do envio de/ })
    expect(within(actions).getByRole('menuitem', { name: 'Comparar com a atual' })).toBeInTheDocument()
    expect(within(actions).getByRole('menuitem', { name: 'Definir como baseline' })).toBeInTheDocument()
  })

  it('compara um envio com a atual mostrando só o diff, sem seletor de modo nem veredito', async () => {
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    const actions = await openActions(menu, 1)
    fireEvent.click(within(actions).getByRole('menuitem', { name: 'Comparar com a atual' }))

    expect(await screen.findByText('"a": 1', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('"a": 2', { exact: false })).toBeInTheDocument()
    expect(compareRequestSends).toHaveBeenCalledWith({ rootPath: '/ws', baseId: 'previous', targetId: 'current' })
    expect(screen.queryByRole('group', { name: 'Formato de exibição do corpo' })).not.toBeInTheDocument()
    expect(screen.queryByText(/As respostas são/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Fechar comparação' }))
    expect(await screen.findByText('HTTP 200')).toBeInTheDocument()
  })

  it('explica quando o corpo não tem diferenças', async () => {
    compareRequestSends.mockResolvedValue({
      ok: true,
      value: comparison({ identical: true, body: { hunks: [], tooLarge: false, binary: false, truncated: false } }),
    })
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    const actions = await openActions(menu, 1)
    fireEvent.click(within(actions).getByRole('menuitem', { name: 'Comparar com a atual' }))

    expect(await screen.findByText('Sem diferenças no corpo.')).toBeInTheDocument()
  })

  it('marca um baseline, mostra o badge só nele e compara contra ele', async () => {
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    const actions = await openActions(menu, 2)
    fireEvent.click(within(actions).getByRole('menuitem', { name: 'Definir como baseline' }))

    expect(setSendBaseline).toHaveBeenCalledWith(SOURCE, 'first')
    expect(await within(pastRows(menu)[2]).findByText('Baseline')).toBeInTheDocument()
    expect(within(menu).getAllByText('Baseline')).toHaveLength(1)
    expect(within(menu).queryByText(/= baseline|≠ baseline/)).not.toBeInTheDocument()

    const currentActions = await openActions(menu, 0)
    fireEvent.click(within(currentActions).getByRole('menuitem', { name: 'Comparar com o baseline' }))

    await waitFor(() =>
      expect(compareRequestSends).toHaveBeenLastCalledWith(expect.objectContaining({ baseId: 'first', targetId: 'current' })),
    )
  })

  it('avisa quando não há envio anterior', async () => {
    listRequestSends.mockResolvedValue({ ok: true, value: [send('current', 3000)] })
    renderPanel()

    const menu = await openHistory()

    expect(await within(menu).findByText('Nenhum envio anterior.')).toBeInTheDocument()
  })

  it('não lista envios cuja resposta não foi guardada', async () => {
    listRequestSends.mockResolvedValue({
      ok: true,
      value: [
        send('current', 4000),
        send('unstored', 3000, {
          outcome: { type: 'success', statusCode: 500, durationMs: 12, sizeBytes: 34, responseStored: false },
        }),
        send('stored', 2000, {
          outcome: { type: 'success', statusCode: 201, durationMs: 12, sizeBytes: 34, responseStored: true },
        }),
      ],
    })
    renderPanel()

    const menu = await openHistory()

    await waitFor(() => expect(pastRows(menu)).toHaveLength(2))
    expect(within(menu).getByText('201')).toBeInTheDocument()
    expect(within(menu).queryByText('500')).not.toBeInTheDocument()
  })

  it('mostra erro quando a lista não carrega', async () => {
    listRequestSends.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'x' } })
    renderPanel()

    const menu = await openHistory()

    expect(await within(menu).findByText('Não foi possível carregar os envios.')).toBeInTheDocument()
  })

  it('explica quando um dos envios comparados não teve resposta', async () => {
    compareRequestSends.mockResolvedValue({
      ok: true,
      value: comparison({
        base: { type: 'failed', kind: 'timeout', message: 'timeout' },
        body: { hunks: [], tooLarge: false, binary: false, truncated: false },
      }),
    })
    renderPanel()
    const menu = await openHistory()
    await waitFor(() => expect(pastRows(menu)).toHaveLength(3))

    const actions = await openActions(menu, 1)
    fireEvent.click(within(actions).getByRole('menuitem', { name: 'Comparar com a atual' }))

    expect(await screen.findByText('Um dos envios não teve resposta.')).toBeInTheDocument()
  })
})
