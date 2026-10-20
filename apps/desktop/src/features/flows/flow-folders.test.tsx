import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { listFlows, type FlowDto } from '../../bindings/list-flows'
import { saveFlows } from '../../bindings/save-flows'
import { useFlowsState } from './use-flows-state'

vi.mock('../../bindings/list-flows', () => ({ listFlows: vi.fn() }))
vi.mock('../../bindings/save-flows', () => ({ saveFlows: vi.fn() }))

const flow: FlowDto = { id: 'flow', name: 'Login', executionKind: 'standard', nodes: [{ id: 'start', kind: 'start', x: 0, y: 0 }], edges: [], createdAtMs: 0, updatedAtMs: 0 }
const folder = { id: 'folder', name: 'Checkout', flowIds: ['flow'] }
function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider>{children}</LanguageProvider> }

beforeEach(() => {
  vi.mocked(listFlows).mockReset().mockResolvedValue({ ok: true, value: { flows: [flow], folders: [folder] } })
  vi.mocked(saveFlows).mockReset().mockResolvedValue({ ok: true })
})

describe('workspace flow folder persistence', () => {
  it('loads folders without rewriting the file and preserves them on explicit graph saves', async () => {
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.folders).toEqual([folder])
    expect(saveFlows).not.toHaveBeenCalled()
    await act(() => result.current.saveGraph('flow', result.current.flows[0].nodes, []))
    expect(saveFlows).toHaveBeenLastCalledWith('/workspace', { flows: [{ ...flow, updatedAtMs: expect.any(Number) }], folders: [folder] })
  })

  it('saves empty folders and folder renames, including a newly created flow', async () => {
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let id = ''
    act(() => { id = result.current.addFolder() })
    act(() => { result.current.renameFolder(id, 'Payments') })
    await act(() => result.current.saveNow())
    expect(saveFlows).toHaveBeenLastCalledWith('/workspace', expect.objectContaining({ folders: [folder, { id, name: 'Payments', flowIds: [] }] }))
    let flowId = ''
    act(() => { flowId = result.current.addFlow(id) })
    await act(() => result.current.saveNow())
    expect(result.current.folders[1].flowIds).toEqual([flowId])
    expect(saveFlows).toHaveBeenLastCalledWith('/workspace', expect.objectContaining({ flows: expect.arrayContaining([expect.objectContaining({ id: flowId })]), folders: [folder, { id, name: 'Payments', flowIds: [flowId] }] }))
  })

  it('moves flows across folders and to the root, cleaning membership on deletion', async () => {
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let id = ''
    act(() => { id = result.current.addFolder() })
    act(() => { result.current.moveFlowToFolder('flow', id) })
    expect(result.current.folders.map((item) => item.flowIds)).toEqual([[], ['flow']])
    act(() => { result.current.moveFlowToFolder('flow', null) })
    expect(result.current.folders.map((item) => item.flowIds)).toEqual([[], []])
    act(() => { result.current.moveFlowToFolder('flow', 'folder') })
    act(() => { result.current.removeFlow('flow') })
    await act(() => result.current.saveNow())
    expect(saveFlows).toHaveBeenLastCalledWith('/workspace', { flows: [], folders: [{ ...folder, flowIds: [] }, { id, name: 'Nova pasta', flowIds: [] }] })
  })

  it('removes folders without removing their flows', async () => {
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => { result.current.removeFolder('folder') })
    await act(() => result.current.saveNow())
    expect(saveFlows).toHaveBeenLastCalledWith('/workspace', { flows: [flow], folders: [] })
  })

  it('reorders flows relative to the target and adopts its folder', async () => {
    vi.mocked(listFlows).mockResolvedValueOnce({ ok: true, value: { flows: [flow, { ...flow, id: 'other', name: 'Other' }], folders: [folder] } })
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => { result.current.moveFlow('other', 'flow', 'before') })
    expect(result.current.flows.map((item) => item.id)).toEqual(['other', 'flow'])
    expect(result.current.folders[0].flowIds).toEqual(['flow', 'other'])
  })

  it('reports autosave failures and does not announce a successful save', async () => {
    vi.mocked(saveFlows).mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'Disk full' } })
    const onSaved = vi.fn()
    const { result } = renderHook(() => useFlowsState('/workspace', onSaved), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => { result.current.addFolder() })
    await waitFor(() => expect(result.current.saveError).toBe('Disk full'))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('does not save after an unreadable manifest', async () => {
    vi.mocked(listFlows).mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'Invalid folders' } })
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => { result.current.addFolder() })
    await expect(result.current.saveNow()).rejects.toThrow('Invalid folders')
    expect(saveFlows).not.toHaveBeenCalled()
  })
})
