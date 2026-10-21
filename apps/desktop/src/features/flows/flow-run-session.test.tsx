import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelFlow } from '../../bindings/cancel-flow'
import { releaseFlowRun } from '../../bindings/flow-forms'
import { releaseClosedFlowSessions, useFlowRunSession } from './flow-run-session'

vi.mock('../../bindings/cancel-flow', () => ({ cancelFlow: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../bindings/flow-forms', () => ({ releaseFlowRun: vi.fn().mockResolvedValue(undefined) }))
afterEach(() => { releaseClosedFlowSessions('/session-tests', []); vi.clearAllMocks() })

describe('flow run session lifetime', () => {
  it('retains pending interactions, drafts and panel mode across unmounting and remounting a tab', () => {
    const first = renderHook(() => useFlowRunSession('/session-tests', 'flow'))
    act(() => {
      first.result.current.session.setIsRunning(true)
      first.result.current.session.setFlowExecutionId('run-1')
      first.result.current.session.setStatuses({ human: { status: 'waitingForHuman', waitId: 'wait-1' } })
      first.result.current.session.setFormDrafts({ 'wait-1': { quantity: 3 } })
      first.result.current.session.setViewMode('panels')
    })
    first.unmount()
    const second = renderHook(() => useFlowRunSession('/session-tests', 'flow'))
    expect(second.result.current.state).toMatchObject({ flowExecutionId: 'run-1', isRunning: true, viewMode: 'panels', formDrafts: { 'wait-1': { quantity: 3 } }, statuses: { human: { status: 'waitingForHuman' } } })
    expect(cancelFlow).not.toHaveBeenCalled()
    second.unmount()
  })

  it('isolates flows and releases native outputs only after a closed execution finishes', () => {
    const first = renderHook(() => useFlowRunSession('/session-tests', 'first'))
    const second = renderHook(() => useFlowRunSession('/session-tests', 'second'))
    act(() => { first.result.current.session.setIsRunning(true); first.result.current.session.setFlowExecutionId('run-first') })
    expect(second.result.current.state.flowExecutionId).toBeNull()
    const session = first.result.current.session
    first.unmount()
    releaseClosedFlowSessions('/session-tests', ['second'])
    expect(cancelFlow).toHaveBeenCalledWith('run-first')
    expect(releaseFlowRun).not.toHaveBeenCalled()
    act(() => session.setIsRunning(false))
    expect(releaseFlowRun).toHaveBeenCalledWith('run-first')
    second.unmount()
  })
})
