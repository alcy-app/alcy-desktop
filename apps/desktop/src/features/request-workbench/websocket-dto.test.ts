import { describe, expect, it } from 'vitest'
import type { HistoryEntryDetailDto } from '../../bindings/get-history-entry'
import type { SavedRequestDto } from '../../bindings/list-collections'
import { historyDetailToContent, historyDetailToExecutionState } from './history'
import { websocketResultOf } from './request-workbench.types'
import { requestFromDto, requestToDto } from './use-collections-state'

const dto: SavedRequestDto = {
  id: 'r1',
  name: 'Chat',
  protocol: 'websocket',
  endpoint: 'wss://chat.test/:room',
  method: 'get',
  body: '{"join": "{{user}}"}',
  variables: '',
  headers: [{ name: 'X-Tenant', value: 'acme', enabled: true }],
  authentication: { type: 'inherit' },
  preRequestScript: '',
  postResponseScript: '',
  routeParams: [{ name: 'room', value: 'general' }],
  websocket: { subprotocols: ['chat.v2'], messageFormat: 'json', waitMs: 2000, expectedMessages: 0 },
}

describe('WebSocket requests through the saved DTO and history', () => {
  it('round-trips the call and keeps the message as the body', () => {
    const summary = requestFromDto(dto)
    expect(summary.protocol).toBe('websocket')
    expect(summary.content.websocket).toEqual({ ...dto.websocket, message: dto.body })
    expect(summary.content.routeParams).toEqual(dto.routeParams)

    const back = requestToDto(summary)
    expect(back.body).toBe(dto.body)
    expect(back.websocket).toEqual(dto.websocket)
    expect(back.restBody).toBeNull()
    expect(back.grpc).toBeUndefined()
  })

  it('reopens a history entry with its call and how it closed', () => {
    const detail: HistoryEntryDetailDto = {
      id: 'h1',
      protocol: 'websocket',
      endpoint: 'wss://chat.test/general',
      method: 'get',
      body: 'hello',
      restBody: null,
      variables: '',
      headers: [],
      authentication: { type: 'none' },
      executedAtMs: 1,
      websocket: { subprotocols: [], messageFormat: 'text', waitMs: null, expectedMessages: null },
      outcome: {
        type: 'success',
        statusCode: 101,
        durationMs: 40,
        sizeBytes: 9,
        body: { kind: 'inline', body: '[\n{"a":1},\n"b"\n]' },
        bodyEncoding: 'text',
        headers: [
          { name: 'upgrade', value: 'websocket' },
          { name: 'websocket-close-code', value: '4001' },
          { name: 'websocket-close-reason', value: 'bye' },
          { name: 'websocket-closed-by', value: 'server' },
        ],
        graphqlErrors: [],
        bodyTruncated: false,
        responseStored: true,
      },
    }

    expect(historyDetailToContent(detail).websocket?.message).toBe('hello')
    const state = historyDetailToExecutionState(detail)
    const result = state.status === 'success' ? websocketResultOf(state.result) : null
    expect(result?.close).toEqual({ code: 4001, reason: 'bye', closedBy: 'server' })
    expect(result?.receivedCount).toBe(2)
    expect(result?.headers).toEqual([{ name: 'upgrade', value: 'websocket' }])
  })
})
