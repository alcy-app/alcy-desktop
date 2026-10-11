import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../../test-utils'
import type { ExecuteRestRequestOutput } from '../../../bindings/execute-rest-request'
import { emptyAuthorizationState } from '../authorization-state'
import { emptyBodyState } from '../body-state'
import type { ExecutionState } from '../request-workbench.types'
import { SCREENSHOT_PALETTES } from '../screenshot/screenshot-palette'
import { ShareScreenshotModal } from './ShareScreenshotModal'

const drawScreenshot = vi.fn()
const pickExportFile = vi.fn()
const exportPng = vi.fn()
const serializeCollections = vi.fn()

/** PNG mínimo (assinatura + IEND), para o chunk de importação ter onde entrar. */
const MINIMAL_PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]

// O jsdom não tem canvas: o desenho e a conversão para PNG são simulados.
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

function renderModal(execution: ExecutionState = { status: 'success', result }) {
  return render(
    <ShareScreenshotModal
      tab={tab}
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
