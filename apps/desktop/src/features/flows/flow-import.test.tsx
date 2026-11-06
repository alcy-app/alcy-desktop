import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { listFlows, type FlowDto } from '../../bindings/list-flows'
import { saveFlows } from '../../bindings/save-flows'
import { pickFlowImportFile, readFlowImport } from '../../bindings/import-flow'
import type { FlowImportAnalysis } from '../../bindings/import-flow'
import type { LoadTestImportAnalysisDto } from '../../bindings/load-test-import'
import { useFlowsState } from './use-flows-state'
import { useFlowImport } from './use-flow-import'

vi.mock('../../bindings/list-flows', () => ({ listFlows: vi.fn() }))
vi.mock('../../bindings/save-flows', () => ({ saveFlows: vi.fn() }))
vi.mock('../../bindings/import-flow', () => ({ pickFlowImportFile: vi.fn(), readFlowImport: vi.fn() }))

const existing: FlowDto = { id: 'existing', name: 'Existing', executionKind: 'standard', nodes: [{ id: 'start', kind: 'start', x: 0, y: 0 }], edges: [], createdAtMs: 0, updatedAtMs: 0 }
const imported: FlowDto = { ...existing, id: 'imported', name: 'Imported' }
const folder = { id: 'folder', name: 'Folder', flowIds: ['existing'] }
function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider>{children}</LanguageProvider> }

beforeEach(() => {
  vi.mocked(listFlows).mockReset().mockResolvedValue({ ok: true, value: { flows: [existing], folders: [folder] } })
  vi.mocked(saveFlows).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(pickFlowImportFile).mockReset().mockResolvedValue('/imports/example.json')
  vi.mocked(readFlowImport).mockReset().mockResolvedValue({ type: 'alcy', flow: imported })
})

async function setup(loadTestingEnabled = false) {
  const onImported = vi.fn()
  const onError = vi.fn()
  const onLoadTest = vi.fn()
  const hook = renderHook(({ rootPath }) => {
    const state = useFlowsState(rootPath)
    const importing = useFlowImport({ rootPath, loadTestingEnabled, onImport: state.importFlow, onImported, onError, onLoadTest })
    return { ...importing, state }
  }, { wrapper, initialProps: { rootPath: '/workspace' } })
  await waitFor(() => expect(hook.result.current.state.loaded).toBe(true))
  return { ...hook, onImported, onError, onLoadTest }
}

describe('flow document import', () => {
  it('preserves current edits and folders and only opens the copy after saving', async () => {
    const { result, onImported } = await setup()
    act(() => result.current.state.renameFlow('existing', 'Unsaved edit'))
    let finish: ((value: { ok: true }) => void) | undefined
    vi.mocked(saveFlows).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(saveFlows).toHaveBeenCalled())
    expect(onImported).not.toHaveBeenCalled()
    expect(result.current.state.flows).toHaveLength(1)
    expect(saveFlows).toHaveBeenCalledWith('/workspace', { flows: [expect.objectContaining({ id: 'existing', name: 'Unsaved edit' }), expect.objectContaining({ id: 'imported' })], folders: [folder] })
    await act(async () => { finish?.({ ok: true }) })
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('imported'))
    expect(result.current.state.flows).toHaveLength(2)
    expect(result.current.state.folders).toEqual([folder])
  })

  it('keeps the workspace intact when persistence fails', async () => {
    const { result, onError, onImported } = await setup()
    vi.mocked(saveFlows).mockResolvedValueOnce({ ok: false, error: { kind: 'storage', message: 'Disk full' } })
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Disk full'))
    expect(result.current.state.flows.map((flow) => flow.id)).toEqual(['existing'])
    expect(onImported).not.toHaveBeenCalled()
  })

  it('does not read or save when selection is cancelled', async () => {
    const { result } = await setup()
    vi.mocked(pickFlowImportFile).mockResolvedValue(null)
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(result.current.importingFlow).toBe(false))
    expect(readFlowImport).not.toHaveBeenCalled()
    expect(saveFlows).not.toHaveBeenCalled()
  })

  it('reports malformed files without saving', async () => {
    const { result, onError } = await setup()
    vi.mocked(readFlowImport).mockRejectedValue({ kind: 'invalid', message: 'Unsupported version' })
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Unsupported version'))
    expect(saveFlows).not.toHaveBeenCalled()
  })

  it('ignores a stale read even after navigating away and back', async () => {
    const { result, rerender, onImported } = await setup()
    let finish: ((flow: FlowImportAnalysis) => void) | undefined
    vi.mocked(readFlowImport).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(readFlowImport).toHaveBeenCalled())
    rerender({ rootPath: '/other' })
    rerender({ rootPath: '/workspace' })
    await act(async () => { finish?.({ type: 'alcy', flow: imported }) })
    expect(saveFlows).not.toHaveBeenCalled()
    expect(onImported).not.toHaveBeenCalled()
  })

  it('rejects load flows when load testing is disabled', async () => {
    const { result, onError } = await setup()
    vi.mocked(readFlowImport).mockResolvedValue({ type: 'alcy', flow: { ...imported, executionKind: 'load' } })
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('carga')))
    expect(saveFlows).not.toHaveBeenCalled()
  })

  it('prevents duplicate imports while selecting a file', async () => {
    const { result } = await setup()
    let select: ((path: string | null) => void) | undefined
    vi.mocked(pickFlowImportFile).mockImplementationOnce(() => new Promise((resolve) => { select = resolve }))
    act(() => { result.current.importFlowFile(); result.current.importFlowFile() })
    expect(result.current.importingFlow).toBe(false)
    expect(pickFlowImportFile).toHaveBeenCalledOnce()
    await act(async () => { select?.('/imports/example.json') })
    await waitFor(() => expect(result.current.state.flows).toHaveLength(2))
    expect(pickFlowImportFile).toHaveBeenCalledOnce()
    expect(readFlowImport).toHaveBeenCalledOnce()
  })

  it('does not overwrite an existing identity', async () => {
    const { result, onError } = await setup()
    vi.mocked(readFlowImport).mockResolvedValue({ type: 'alcy', flow: { ...imported, id: 'existing' } })
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(saveFlows).not.toHaveBeenCalled()
    expect(result.current.state.flows[0].name).toBe('Existing')
  })

  it.each(['k6', 'jmeter'] as const)('routes detected %s content to the existing load import review', async (format) => {
    const { result, onLoadTest, onImported } = await setup(true)
    const analysis: LoadTestImportAnalysisDto = { format, analysisHash: 'hash', flow: { ...imported, executionKind: 'load' }, destinations: [], blocks: 1, assets: [], requiredVariables: [] }
    vi.mocked(readFlowImport).mockResolvedValue({ type: 'loadTest', analysis })
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(onLoadTest).toHaveBeenCalledWith('/imports/example.json', analysis))
    expect(pickFlowImportFile).toHaveBeenCalledWith(true)
    expect(saveFlows).not.toHaveBeenCalled()
    expect(onImported).not.toHaveBeenCalled()
  })

  it('preserves load parser diagnostics from the common selector', async () => {
    const { result, onError } = await setup(true)
    vi.mocked(readFlowImport).mockRejectedValue({ kind: 'incompatible', diagnostics: [{ line: 2, column: 4, message: 'Unsupported statement' }] })
    act(() => result.current.importFlowFile())
    await waitFor(() => expect(onError).toHaveBeenCalledWith('L2:4: Unsupported statement'))
    expect(saveFlows).not.toHaveBeenCalled()
  })
})
