import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelLoadFlow } from '../../bindings/cancel-load-flow'
import { getLoadFlowRunState, releaseClosedLoadFlowSessions, useLoadFlowRunSession } from './load-flow-run-session'

vi.mock('../../bindings/cancel-load-flow', () => ({ cancelLoadFlow: vi.fn().mockResolvedValue(undefined) }))
afterEach(() => { releaseClosedLoadFlowSessions('/load-session-tests', []); releaseClosedLoadFlowSessions('/other-load-tests', []); vi.clearAllMocks() })

describe('load flow session lifetime', () => {
  it('keeps receiving progress after switching away from a canvas', () => {
    const first = renderHook(() => useLoadFlowRunSession('/load-session-tests', 'flow'))
    const session = first.result.current.session
    act(() => session.update({ runId: 'run', isRunning: true }))
    first.unmount()
    session.update({ progress: { ...session.state.progress, requests: 12 } })
    const second = renderHook(() => useLoadFlowRunSession('/load-session-tests', 'flow'))
    expect(second.result.current.state).toMatchObject({ runId: 'run', isRunning: true, progress: { requests: 12 } })
    expect(cancelLoadFlow).not.toHaveBeenCalled()
    second.unmount()
  })

  it('cancels only the closed tab and isolates identical flow ids by workspace', () => {
    const first = renderHook(() => useLoadFlowRunSession('/load-session-tests', 'flow'))
    const second = renderHook(() => useLoadFlowRunSession('/other-load-tests', 'flow'))
    act(() => first.result.current.session.update({ runId: 'first', isRunning: true }))
    expect(second.result.current.state.runId).toBeNull()
    const closed = first.result.current.session
    first.unmount()
    releaseClosedLoadFlowSessions('/load-session-tests', [])
    expect(cancelLoadFlow).toHaveBeenCalledWith('first')
    expect(getLoadFlowRunState('/load-session-tests', 'flow')).toBeUndefined()
    closed.update({ error: 'late event' })
    expect(closed.state.error).toBeNull()
    expect(getLoadFlowRunState('/other-load-tests', 'flow')).toBeDefined()
    second.unmount()
  })
})
