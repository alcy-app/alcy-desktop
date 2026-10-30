import { describe, expect, it } from 'vitest'
import type { RequestSendDto } from '../../bindings/list-request-sends'
import { orderPair } from './send-history'

function send(id: string, executedAtMs: number): RequestSendDto {
  return {
    id,
    executedAtMs,
    protocol: 'rest',
    endpoint: 'https://api.example.com',
    method: 'get',
    outcome: { type: 'success', statusCode: 200, durationMs: 1, sizeBytes: 1, responseStored: true },
    baseline: false,
  }
}

describe('orderPair', () => {
  it('põe o envio mais antigo como base, em qualquer ordem', () => {
    const older = send('old', 1)
    const newer = send('new', 2)

    expect(orderPair(newer, older)).toEqual({ base: older, target: newer })
    expect(orderPair(older, newer)).toEqual({ base: older, target: newer })
  })
})
