import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { exportWebclient, previewWebclientExport, type WebclientSummary } from '../../bindings/export-webclient'
import { pickExportFile } from '../../bindings/pick-export-file'
import type { EnvironmentState } from '../environments/environments.types'
import { ExportWebclientModal } from './ExportWebclientModal'

vi.mock('../../bindings/export-webclient', () => ({
  previewWebclientExport: vi.fn(),
  exportWebclient: vi.fn(),
}))
vi.mock('../../bindings/pick-export-file', () => ({
  pickExportFile: vi.fn(),
}))

const summary: WebclientSummary = {
  requestCount: 2,
  folderCount: 1,
  credentials: [
    { id: 'variable:token', owner: null, target: { kind: 'variable', name: 'token' }, included: false },
    { id: 'header:r1:x-api-key', owner: 'List', target: { kind: 'header', nodeId: 'r1', name: 'X-Api-Key' }, included: false },
  ],
  unsupported: [{ requestId: 'r2', requestName: 'Upload', feature: 'binaryBody' }],
  hosts: ['api.test'],
  hasUnresolvedHosts: false,
}

const environments: EnvironmentState[] = [
  {
    id: 'env1',
    name: 'Prod',
    variables: [
      { id: 'v1', name: 'token', value: 'secret', sensitive: true },
      { id: 'v2', name: '', value: 'draft', sensitive: false },
    ],
  },
]

const source = {
  collection: { id: 'c1', name: 'API', folders: [], requests: [], authentication: { type: 'none' as const }, variables: [] },
  folderId: 'f1',
  name: 'Orders',
}

function renderModal(onClose = vi.fn()) {
  render(<ExportWebclientModal source={source} environments={environments} activeEnvironmentId="env1" onClose={onClose} />)
  return onClose
}

beforeEach(() => {
  vi.mocked(previewWebclientExport).mockReset().mockResolvedValue({ ok: true, value: summary })
  vi.mocked(exportWebclient).mockReset().mockResolvedValue({ ok: true, value: null })
  vi.mocked(pickExportFile).mockReset().mockResolvedValue('/tmp/orders.html')
})

describe('ExportWebclientModal', () => {
  it('previews with the active environment and without sensitive data', async () => {
    renderModal()

    expect(await screen.findByText('Variável {{token}}')).toBeInTheDocument()
    expect(screen.getByText('Header X-Api-Key · List')).toBeInTheDocument()
    expect(screen.getByText('Upload: corpo binário (arquivo local)')).toBeInTheDocument()
    expect(previewWebclientExport).toHaveBeenCalledWith(
      {
        collection: source.collection,
        folderId: 'f1',
        environment: { name: 'Prod', variables: [{ name: 'token', value: 'secret', sensitive: true }] },
      },
      false,
    )
  })

  it('exports without sensitive data by default', async () => {
    renderModal()
    await screen.findByText('Variável {{token}}')

    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }))

    await waitFor(() => expect(exportWebclient).toHaveBeenCalled())
    expect(pickExportFile).toHaveBeenCalledWith('Orders', 'html')
    expect(vi.mocked(exportWebclient).mock.calls[0][0]).toMatchObject({
      path: '/tmp/orders.html',
      title: 'Orders',
      transport: 'auto',
      includeSensitive: false,
      sensitiveConfirmed: false,
      password: null,
    })
  })

  it('requires a second confirmation to include sensitive data', async () => {
    renderModal()
    await screen.findByText('Variável {{token}}')
    const exportButton = screen.getByRole('button', { name: 'Exportar' })

    fireEvent.click(screen.getByLabelText('Incluir dados sensíveis'))
    await waitFor(() => expect(previewWebclientExport).toHaveBeenLastCalledWith(expect.anything(), true))
    expect(screen.getByText('Sem senha, eles ficam legíveis no próprio HTML.')).toBeInTheDocument()
    await waitFor(() => expect(exportButton).toBeDisabled())

    fireEvent.click(screen.getByLabelText('Confirmo a exportação desses dados sensíveis'))
    await waitFor(() => expect(exportButton).toBeEnabled())
    fireEvent.click(exportButton)

    await waitFor(() =>
      expect(vi.mocked(exportWebclient).mock.calls[0][0]).toMatchObject({ includeSensitive: true, sensitiveConfirmed: true }),
    )
  })

  it('validates the password before exporting', async () => {
    renderModal()
    await screen.findByText('Variável {{token}}')
    const exportButton = screen.getByRole('button', { name: 'Exportar' })

    fireEvent.change(screen.getByLabelText('Senha (opcional)'), { target: { value: 'short' } })
    expect(screen.getByText('Use pelo menos 8 caracteres.')).toBeInTheDocument()
    expect(exportButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Senha (opcional)'), { target: { value: 'long enough' } })
    fireEvent.change(screen.getByLabelText('Confirmar senha'), { target: { value: 'long enougX' } })
    expect(screen.getByText('As senhas não conferem.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Confirmar senha'), { target: { value: 'long enough' } })
    fireEvent.click(exportButton)

    await waitFor(() => expect(vi.mocked(exportWebclient).mock.calls[0][0]).toMatchObject({ password: 'long enough' }))
  })

  it('shows a preview error', async () => {
    vi.mocked(previewWebclientExport).mockResolvedValue({ ok: false, error: { kind: 'noRequests' } })
    renderModal()

    expect(await screen.findByText('Não há requisições para exportar.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exportar' })).toBeDisabled()
  })
})
