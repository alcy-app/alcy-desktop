import { describe, expect, it } from 'vitest'
import { appendWebSocketEvent, emptyWebSocketStream } from './websocket-stream'

describe('appendWebSocketEvent', () => {
  it('follows the connection status from its events', () => {
    let stream = appendWebSocketEvent(emptyWebSocketStream, { type: 'opened', status: 101, headers: [], subprotocol: null, elapsedMs: 4 })
    expect(stream.status).toBe('open')
    stream = appendWebSocketEvent(stream, { type: 'closed', code: 1000, reason: '', closedBy: 'client', elapsedMs: 9 })
    expect(stream.status).toBe('closed')
    expect(stream.events).toHaveLength(2)
  })

  it('keeps the live view bounded and counts what it dropped', () => {
    let stream = emptyWebSocketStream
    for (let index = 0; index < 520; index++) {
      stream = appendWebSocketEvent(stream, { type: 'message', direction: 'received', index, format: 'text', data: 'x', truncated: false, sizeBytes: 1, elapsedMs: index })
    }
    expect(stream.events).toHaveLength(500)
    expect(stream.dropped).toBe(20)
    const big = 'y'.repeat(600 * 1024)
    stream = appendWebSocketEvent(stream, { type: 'message', direction: 'received', index: 520, format: 'text', data: big, truncated: false, sizeBytes: big.length, elapsedMs: 1 })
    stream = appendWebSocketEvent(stream, { type: 'message', direction: 'received', index: 521, format: 'text', data: big, truncated: false, sizeBytes: big.length, elapsedMs: 1 })
    expect(stream.events.reduce((sum, event) => sum + (event.type === 'message' ? event.data.length : 0), 0)).toBeLessThanOrEqual(1024 * 1024)
  })
})
