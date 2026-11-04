import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../../test-utils'
import type { ExecuteRestRequestOutput } from '../../../bindings/execute-rest-request'
import { emptyAuthorizationState } from '../authorization-state'
import { emptyBodyState } from '../body-state'
import { emptyGrpcCall } from '../collection-tree'
import type { SnippetTab } from '../code-snippets/snippet-request'
import type { ScreenshotLayout } from '../screenshot/screenshot-layout'
import type { ExecutionState } from '../request-workbench.types'
import { SCREENSHOT_PALETTES } from '../screenshot/screenshot-palette'
import { ShareScreenshotModal } from './ShareScreenshotModal'

const drawScreenshot = vi.fn()
const pickExportFile = vi.fn()
const exportPng = vi.fn()
const serializeCollections = vi.fn()

/** Minimal PNG signature and IEND for embedding an import text chunk. */
const MINIMAL_PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]

// jsdom has no canvas; drawing and PNG encoding are mocked.
vi.mock('../screenshot/screenshot-render', () => ({
  ensureScreenshotFonts: () => Promise.resolve(),
  createMeasure: () => (text: string, font: { size: number }) => text.length * font.size * 0.6,
  drawScreenshot: (...args: unknown[]) => drawScreenshot(...args),
  canvasToPng: () => Promise.resolve(new Blob([new Uint8Array(MINIMAL_PNG)], { type: 'image/png' })),
}))

vi.mock('../../../bindings/serialize-collections', () => ({
  serializeCollections: (...args: unknown[]) => serializeCollections(...args),
}))

vi.mock('../../../bindings/pick-export-file', () => ({
  pickExportFile: (...args: unknown[]) => pickExportFile(...args),
}))

vi.mock('../../../bindings/export-png', () => ({
  exportPng: (...args: unknown[]) => exportPng(...args),
}))

const tab = {
  protocol: 'rest' as const,
  method: 'get' as const,
  endpointUrl: '{{baseUrl}}/users',
  query: '',
  variables: '',
  headers: [],
  routeParams: [],
  body: { ...emptyBodyState, type: 'none' as const },
  authorization: { ...emptyAuthorizationState },
}

const result: ExecuteRestRequestOutput = {
  statusCode: 200,
  durationMs: 12,
  sizeBytes: 20,
  body: { kind: 'inline', body: '{"ok":true}' },
  bodyEncoding: 'text',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  requestHeaders: [],
  cookies: [],
  connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
  finalUrl: null,
  waitingMs: 5,
  environmentChanges: [],
  scopedChanges: [],
  scriptLogs: [],
  scriptError: null,
  testResults: [],
}

function renderModal(execution: ExecutionState = { status: 'success', result }, requestTab: SnippetTab = tab) {
  return render(
    <ShareScreenshotModal
      tab={requestTab}
      execution={execution}
      inheritedAuthentication={undefined}
      environmentVariables={[{ name: 'baseUrl', value: 'https://api.test', sensitive: false }]}
      requestName="Listar usuários"
      environmentName="Homologação"
      onClose={() => {}}
    />,
  )
}

function renderPasswordModal() {
  return render(
    <ShareScreenshotModal
      tab={{ ...tab, body: { ...emptyBodyState, type: 'raw', raw: '{"password":"abc"}', rawLanguage: 'json' } }}
      execution={{ status: 'success', result }}
      inheritedAuthentication={undefined}
      environmentVariables={[]}
      requestName="Login"
      environmentName={null}
      onClose={() => {}}
    />,
  )
}

const lastPalette = () => drawScreenshot.mock.calls[drawScreenshot.mock.calls.length - 1][2]

describe('ShareScreenshotModal', () => {
  beforeEach(() => {
    drawScreenshot.mockReset().mockReturnValue(true)
    pickExportFile.mockReset()
    exportPng.mockReset()
    serializeCollections.mockReset().mockResolvedValue({ ok: true, value: '{"version":1}' })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('previews and saves a gRPC image with protocol labels and a reimportable request', async () => {
    const grpc = { ...emptyGrpcCall, service: 'test.Greeter', method: 'SayHello', message: '{"greeting":"Ada"}', deadlineMs: 2500 }
    pickExportFile.mockResolvedValue('/tmp/grpc.png')
    exportPng.mockResolvedValue({ ok: true })
    renderModal({ status: 'success', result: {
      status: { code: 0, codeName: 'OK', message: '' }, durationMs: 20, sizeBytes: 20, messageCount: 1,
      body: { kind: 'inline', body: '{"reply":"Hello"}' }, headers: [{ name: 'x-server', value: 'test' }], trailers: [{ name: 'x-trailer', value: 'done' }],
    } }, { ...tab, protocol: 'grpc', endpointUrl: 'grpc://localhost:50051', grpc })

    expect(screen.getByRole('checkbox', { name: 'URL, serviço e método' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Mensagem da requisição' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Mensagens recebidas' })).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Metadata da resposta e trailers' }))
    await waitFor(() => expect(drawScreenshot).toHaveBeenCalled())
    const layout = drawScreenshot.mock.calls.at(-1)![1] as ScreenshotLayout
    const text = layout.ops.flatMap((op) => op.kind === 'text' ? [op.text] : [])
    expect(text).toEqual(expect.arrayContaining(['gRPC', 'test.Greeter/SayHello', 'gRPC 0 OK', 'Metadata', 'Metadata final', 'Mensagens']))
    expect(text.some((value) => value.startsWith('HTTP '))).toBe(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))
    expect(await screen.findByText('Imagem salva.')).toBeInTheDocument()
    expect(serializeCollections).toHaveBeenCalledWith([expect.objectContaining({ requests: [expect.objectContaining({
      protocol: 'grpc', body: grpc.message, grpc: { service: grpc.service, method: grpc.method, deadlineMs: 2500, schemaSource: { type: 'reflection' } },
    })] })])
    expect(exportPng).toHaveBeenCalledWith('/tmp/grpc.png', expect.any(Uint8Array))
  })

  it('shares only a selected excerpt, with its context fields and its line range', async () => {
    pickExportFile.mockResolvedValue('/tmp/trecho.png')
    exportPng.mockResolvedValue({ ok: true })
    render(
      <ShareScreenshotModal
        tab={tab}
        execution={{ status: 'success', result }}
        inheritedAuthentication={undefined}
        environmentVariables={[{ name: 'baseUrl', value: 'https://api.test', sensitive: false }]}
        requestName="Listar usuários"
        environmentName="Homologação"
        excerpt={{ lines: ['"ok": true'], spans: [[{ text: '"ok": true', tone: 'plain' }]], firstLine: 2, language: 'json' }}
        onClose={() => {}}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Compartilhar seleção como imagem' })).toBeInTheDocument()
    expect(screen.getByText('Linha 2')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Organização' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Corpo da resposta' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Headers da requisição' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Status, tempo e tamanho' })).toBeChecked()

    await waitFor(() => expect(drawScreenshot).toHaveBeenCalled())
    const layout = drawScreenshot.mock.calls.at(-1)![1] as ScreenshotLayout
    const text = layout.ops.flatMap((op) => op.kind === 'text' ? [op.text] : [])
    expect(text).toEqual(expect.arrayContaining(['Listar usuários', 'GET', 'HTTP 200', 'Body  ·  Linha 2']))
    expect(text).not.toContain('REQUISIÇÃO')
    const code = layout.ops.flatMap((op) => op.kind === 'code' ? [op.spans.map((span) => span.text).join('')] : [])
    expect(code).toEqual(['2', '"ok": true'])

    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))
    expect(await screen.findByText('Imagem salva.')).toBeInTheDocument()
    expect(pickExportFile).toHaveBeenCalledWith(expect.stringMatching(/^Listar usuários-L2-2-\d{8}-\d{4}$/), 'png')
  })

  it('desenha a prévia no tema escolhido e lembra as opções', async () => {
    const { unmount } = renderModal()
    expect(screen.getByRole('img', { name: 'Prévia da imagem' })).toBeInTheDocument()
    await waitFor(() => expect(drawScreenshot).toHaveBeenCalled())
    expect(lastPalette()).toBe(SCREENSHOT_PALETTES.light)

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Tema' })).getByRole('radio', { name: 'Escuro' }))
    await waitFor(() => expect(lastPalette()).toBe(SCREENSHOT_PALETTES.dark))
    unmount()

    renderModal()
    expect(within(screen.getByRole('radiogroup', { name: 'Tema' })).getByRole('radio', { name: 'Escuro' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('desabilita os campos de resposta antes do envio', () => {
    renderModal({ status: 'idle' })
    expect(screen.getByRole('checkbox', { name: 'Corpo da resposta' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Corpo da requisição' })).toBeEnabled()
    expect(screen.getByText('Envie a requisição para incluir a resposta.')).toBeInTheDocument()
  })

  it('sem campos marcados, avisa e desabilita as ações', () => {
    renderModal()
    for (const name of ['Nome, ambiente e data', 'Método e URL', 'Status, tempo e tamanho', 'Corpo da requisição', 'Corpo da resposta']) {
      fireEvent.click(screen.getByRole('checkbox', { name }))
    }
    expect(screen.getByText('Selecione ao menos um campo para gerar a imagem.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copiar imagem' })).toBeDisabled()
  })

  it('salva o PNG no arquivo escolhido', async () => {
    pickExportFile.mockResolvedValue('/tmp/evidencia.png')
    exportPng.mockResolvedValue({ ok: true })
    renderModal()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))

    expect(await screen.findByText('Imagem salva.')).toBeInTheDocument()
    expect(pickExportFile).toHaveBeenCalledWith(expect.stringMatching(/^Listar usuários-\d{8}-\d{4}$/), 'png')
    const [path, bytes] = exportPng.mock.calls[0] as [string, Uint8Array]
    expect(path).toBe('/tmp/evidencia.png')
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('iTXtalcy.collections')
    expect(text).toContain('{"version":1}')
    expect(Array.from(bytes.subarray(-12))).toEqual(MINIMAL_PNG.slice(-12))
    expect(serializeCollections).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Listar usuários', requests: [expect.objectContaining({ endpoint: '{{baseUrl}}/users' })] }),
    ])
  })

  it('salva a imagem sem dados de importação quando a opção é desmarcada', async () => {
    pickExportFile.mockResolvedValue('/tmp/evidencia.png')
    exportPng.mockResolvedValue({ ok: true })
    renderModal()
    const option = screen.getByRole('checkbox', { name: 'Incluir metadados para importação no Alcy' })
    expect(option).toBeChecked()
    fireEvent.click(option)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))

    expect(await screen.findByText('Imagem salva.')).toBeInTheDocument()
    expect(exportPng).toHaveBeenCalledWith('/tmp/evidencia.png', new Uint8Array(MINIMAL_PNG))
    expect(serializeCollections).not.toHaveBeenCalled()
  })

  it('pergunta se deve esvaziar campos suspeitos e exporta metadados sanitizados', async () => {
    pickExportFile.mockResolvedValue('/tmp/login.png')
    exportPng.mockResolvedValue({ ok: true })
    renderPasswordModal()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))

    expect(pickExportFile).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Possível credencial nos metadados' })
    expect(dialog).toHaveTextContent('Deseja deixar os campos suspeitos vazios antes de exportar?')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Esvaziar e exportar' }))

    expect(await screen.findByText('Imagem salva.')).toBeInTheDocument()
    expect(serializeCollections).toHaveBeenCalledWith([
      expect.objectContaining({
        requests: [expect.objectContaining({ body: '{"password":""}', restBody: expect.objectContaining({ content: '{"password":""}' }) })],
      }),
    ])
  })

  it('permite exportar os metadados sem esvaziar os campos suspeitos', async () => {
    pickExportFile.mockResolvedValue('/tmp/login.png')
    exportPng.mockResolvedValue({ ok: true })
    renderPasswordModal()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))
    const dialog = screen.getByRole('dialog', { name: 'Possível credencial nos metadados' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar sem alterar' }))

    expect(await screen.findByText('Imagem salva.')).toBeInTheDocument()
    expect(serializeCollections).toHaveBeenCalledWith([
      expect.objectContaining({
        requests: [expect.objectContaining({ body: '{"password":"abc"}' })],
      }),
    ])
  })

  it('avisa quando os dados de importação não podem ser gerados', async () => {
    pickExportFile.mockResolvedValue('/tmp/evidencia.png')
    serializeCollections.mockResolvedValue({ ok: false, error: { kind: 'invalid', message: 'nome vazio' } })
    renderModal()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))

    expect(await screen.findByText('Não foi possível incluir os dados de importação: nome vazio')).toBeInTheDocument()
    expect(exportPng).not.toHaveBeenCalled()
  })

  it('mostra o erro ao falhar a gravação', async () => {
    pickExportFile.mockResolvedValue('/tmp/evidencia.png')
    exportPng.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disco cheio' } })
    renderModal()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar PNG' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Salvar PNG' }))

    expect(await screen.findByText('Não foi possível salvar a imagem: disco cheio')).toBeInTheDocument()
  })

  it('copia a imagem para a área de transferência', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write } })
    vi.stubGlobal(
      'ClipboardItem',
      class {
        readonly items: Record<string, unknown>
        constructor(items: Record<string, unknown>) {
          this.items = items
        }
      },
    )
    renderModal()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copiar imagem' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Copiar imagem' }))

    expect(await screen.findByText('Imagem copiada.')).toBeInTheDocument()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('sugere salvar quando a cópia de imagem não é suportada', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write: vi.fn().mockRejectedValue(new Error('não suportado')) } })
    vi.stubGlobal('ClipboardItem', class {})
    renderModal()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copiar imagem' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Copiar imagem' }))

    expect(await screen.findByText('Não foi possível copiar a imagem. Use "Salvar PNG".')).toBeInTheDocument()
  })
})
