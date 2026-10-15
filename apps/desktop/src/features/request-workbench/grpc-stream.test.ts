import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrpcCallEventDto } from '../../bindings/execute-grpc-request'
import { appendGrpcEvent, emptyGrpcStream } from './grpc-stream'
import { useWorkbenchState } from './use-workbench-state'

const bindings = vi.hoisted(() => ({ execute: vi.fn(), send: vi.fn(), close: vi.fn(), cancel: vi.fn() }))
vi.mock('../../bindings/execute-grpc-request', () => ({ executeGrpcRequest: bindings.execute, sendGrpcMessage: bindings.send, closeGrpcSend: bindings.close }))
vi.mock('../../bindings/cancel-graphql-request', () => ({ cancelGraphqlRequest: bindings.cancel }))
const noVariables: never[] = []
const noCollections: never[] = []
const message = (index: number): GrpcCallEventDto => ({ type: 'received', index, json: '{}', truncated: false, sizeBytes: 2, elapsedMs: index })

beforeEach(() => {
  vi.clearAllMocks()
  bindings.send.mockResolvedValue({ ok: true, value: null })
  bindings.close.mockResolvedValue({ ok: true, value: null })
})

describe('gRPC stream', () => {
  it('bounds the live transcript by event count and text size', () => {
    let state = emptyGrpcStream
    for (let i = 0; i < 600; i++) state = appendGrpcEvent(state, message(i))
    expect(state.events).toHaveLength(500)
    expect(state.dropped).toBe(100)
    const large = { ...message(600), json: 'x'.repeat(256 * 1024) }
    for (let i = 0; i < 5; i++) state = appendGrpcEvent(state, large)
    expect(state.events).toHaveLength(4)
    expect(state.dropped).toBe(601)
  })

  it('keeps events with their tab, sends edits, preserves validation errors, and closes the stream', async () => {
    let emit!: (event: GrpcCallEventDto) => void
    let finish!: (value: unknown) => void
    bindings.execute.mockImplementation((_input, callback) => {
      emit = callback
      return new Promise((resolve) => { finish = resolve })
    })
    const { result } = renderHook(() => useWorkbenchState(noVariables, '/workspace', noCollections))
    act(() => result.current.newDraftTab('grpc', 'Stream'))
    const tabId = result.current.activeTabId!
    let running!: ReturnType<typeof result.current.sendGrpc>
    act(() => { running = result.current.sendGrpc() })
    act(() => emit({ type: 'started', kind: 'bidiStreaming' }))
    expect(result.current.grpcStream?.accepting).toBe(true)
    act(() => result.current.updateGrpc({ message: '{"name":"second"}' }))
    bindings.send.mockResolvedValueOnce({ ok: false, error: { kind: 'invalidRequest', message: 'invalid message' } })
    await act(async () => { await result.current.controlGrpcStream(false) })
    expect(bindings.send).toHaveBeenCalledWith(expect.any(String), '{"name":"second"}', [], [])
    expect(result.current.grpcStream?.accepting).toBe(true)
    expect(result.current.grpcStream?.error?.kind).toBe('invalidRequest')
    act(() => result.current.newDraftTab('rest', 'Other'))
    act(() => emit(message(0)))
    expect(result.current.grpcStream).toBeUndefined()
    act(() => result.current.selectTab(tabId))
    expect(result.current.grpcStream?.events).toHaveLength(2)
    await act(async () => { await result.current.controlGrpcStream(true) })
    expect(bindings.close).toHaveBeenCalledOnce()
    expect(result.current.grpcStream?.accepting).toBe(false)
    await act(async () => {
      finish({ ok: false, error: { kind: 'cancelled' } })
      await running
    })
    expect(result.current.execution.status).toBe('error')
    expect(result.current.grpcStream?.events).toHaveLength(2)
  })

  it('cancels when a streaming tab is closed and ignores late events', () => {
    let emit!: (event: GrpcCallEventDto) => void
    bindings.execute.mockImplementation((_input, callback) => { emit = callback; return new Promise(() => {}) })
    const { result } = renderHook(() => useWorkbenchState(noVariables, '/workspace', noCollections))
    act(() => result.current.newDraftTab('grpc', 'Stream'))
    act(() => { void result.current.sendGrpc() })
    const id = result.current.activeTab.executionId
    act(() => result.current.closeTab(result.current.activeTabId!))
    expect(bindings.cancel).toHaveBeenCalledWith(id)
    act(() => emit(message(1)))
    expect(result.current.tabs).toHaveLength(0)
  })
})
