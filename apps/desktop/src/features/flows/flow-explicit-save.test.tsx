import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { useFlowsState } from './use-flows-state'
import type { FlowNodeState } from './flows.types'
import { listFlows } from '../../bindings/list-flows'
import { saveFlows } from '../../bindings/save-flows'

vi.mock('../../bindings/list-flows', () => ({ listFlows: vi.fn() }))
vi.mock('../../bindings/save-flows', () => ({ saveFlows: vi.fn() }))

function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider>{children}</LanguageProvider> }

beforeEach(() => {
  vi.mocked(listFlows).mockResolvedValue({ ok: true, value: { flows: [{ id: 'flow', name: 'Flow', executionKind: 'standard', nodes: [{ id: 'start', kind: 'start', x: 0, y: 0 }], edges: [], createdAtMs: 0, updatedAtMs: 0 }] } })
  vi.mocked(saveFlows).mockReset().mockResolvedValue({ ok: true })
})

describe('explicit flow graph persistence', () => {
  it('waits for persistence before applying the edited graph', async () => {
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const nodes: FlowNodeState[] = [...result.current.flows[0].nodes, { id: 'wait', kind: 'sleep', durationMs: 500, position: { x: 300, y: 0 } }]
    let finish: ((value: { ok: true }) => void) | undefined
    vi.mocked(saveFlows).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let saving: Promise<void>
    act(() => { saving = result.current.saveGraph('flow', nodes, []) })
    expect(result.current.flows[0].nodes).toHaveLength(1)
    await act(async () => { finish?.({ ok: true }); await saving! })
    expect(result.current.flows[0].nodes).toHaveLength(2)
    expect(saveFlows).toHaveBeenCalledWith('/workspace', expect.objectContaining({ flows: [expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ id: 'wait', durationMs: 500 })]) })] }))
  })

  it('propagates disk failures without marking the new graph as persisted', async () => {
    const { result } = renderHook(() => useFlowsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    vi.mocked(saveFlows).mockResolvedValueOnce({ ok: false, error: { kind: 'storage', message: 'Disk full' } })
    await expect(result.current.saveGraph('flow', [], [])).rejects.toThrow('Disk full')
    expect(result.current.flows[0].nodes).toHaveLength(1)
  })
})
