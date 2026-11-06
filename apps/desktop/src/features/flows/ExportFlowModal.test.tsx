import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportFlowModal } from './ExportFlowModal'
import { exportFlow, previewFlowExport } from '../../bindings/export-flow'
import { pickExportFile } from '../../bindings/pick-export-file'
import type { FlowExportPreview, FlowExportSource } from '../../bindings/export-flow'

vi.mock('../../bindings/export-flow', () => ({ previewFlowExport: vi.fn(), exportFlow: vi.fn(), flowExportError: () => undefined }))
vi.mock('../../bindings/pick-export-file', () => ({ pickExportFile: vi.fn() }))

const source: FlowExportSource = {
  rootPath: '/workspace', environmentVariables: [],
  flow: { id: 'flow', name: 'Example', executionKind: 'standard', nodes: [], edges: [], createdAtMs: 0, updatedAtMs: 0 },
}
const dependencies: FlowExportPreview = { requestCount: 1, variableCount: 2, emptyVariableCount: 0, canInline: true, hasDependencies: true }

beforeEach(() => {
  vi.mocked(previewFlowExport).mockReset().mockResolvedValue(dependencies)
  vi.mocked(exportFlow).mockReset().mockResolvedValue(undefined)
  vi.mocked(pickExportFile).mockReset().mockResolvedValue('/exports/example.flow.alcy.json')
})

describe('ExportFlowModal', () => {
  it.each([['Manter referências', false], ['Tornar independente', true]] as const)('exports the selected mode: %s', async (label, inline) => {
    const onClose = vi.fn()
    render(<ExportFlowModal source={source} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled())
    expect(pickExportFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(exportFlow).toHaveBeenCalledWith(source, '/exports/example.flow.alcy.json', inline))
    expect(pickExportFile).toHaveBeenCalledWith('Example', 'flow')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('directly exports flows without external dependencies', async () => {
    vi.mocked(previewFlowExport).mockResolvedValue({ ...dependencies, requestCount: 0, variableCount: 0, hasDependencies: false })
    render(<ExportFlowModal source={source} onClose={vi.fn()} />)
    await waitFor(() => expect(exportFlow).toHaveBeenCalledWith(source, '/exports/example.flow.alcy.json', false))
  })

  it('does not export when the file picker is cancelled', async () => {
    vi.mocked(pickExportFile).mockResolvedValue(null)
    const onClose = vi.fn()
    render(<ExportFlowModal source={source} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manter referências' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Manter referências' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(exportFlow).not.toHaveBeenCalled()
  })

  it('keeps unsupported conversions unavailable and explains empty values', async () => {
    vi.mocked(previewFlowExport).mockResolvedValue({ ...dependencies, canInline: false, emptyVariableCount: 1 })
    render(<ExportFlowModal source={source} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/sensível\(is\) ou indisponível/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Tornar independente' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Manter referências' })).toBeEnabled()
  })

  it('shows failures and allows a retry', async () => {
    vi.mocked(exportFlow).mockRejectedValueOnce(new Error('write failure'))
    render(<ExportFlowModal source={source} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manter referências' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Manter referências' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível exportar o flow.')
    fireEvent.click(screen.getByRole('button', { name: 'Manter referências' }))
    await waitFor(() => expect(exportFlow).toHaveBeenCalledTimes(2))
  })
})
