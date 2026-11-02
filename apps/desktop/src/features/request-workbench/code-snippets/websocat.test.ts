import { describe, expect, it } from 'vitest'
import type { SnippetRequest } from './snippet-request'
import { generateWebsocatSnippet } from './websocat'

function request(overrides: Partial<SnippetRequest> = {}): SnippetRequest {
  return {
    method: 'GET',
    url: 'wss://chat.example.com/socket',
    headers: [{ name: 'Authorization', value: 'Bearer abc' }],
    body: { type: 'text', text: '{"join": "it\'s"}' },
    digest: null,
    notes: [],
    websocket: { subprotocols: ['chat.v2'], messageFormat: 'json' },
    ...overrides,
  }
}

describe('generateWebsocatSnippet', () => {
  it('pipes the message into a connection that stays open', () => {
    expect(generateWebsocatSnippet(request())).toBe(
      `printf '%s\\n' '{"join": "it'\\''s"}' | websocat -n \\\n  --protocol 'chat.v2' \\\n  -H 'Authorization: Bearer abc' \\\n  'wss://chat.example.com/socket'`,
    )
  })

  it('decodes a binary message and connects without input when there is no message', () => {
    expect(
      generateWebsocatSnippet(request({ body: { type: 'text', text: 'AA E=' }, websocket: { subprotocols: [], messageFormat: 'binary' }, headers: [] })),
    ).toBe(`printf '%s' 'AAE=' | base64 -d | websocat -n \\\n  --binary \\\n  'wss://chat.example.com/socket'`)
    expect(generateWebsocatSnippet(request({ body: { type: 'none' }, headers: [], websocket: { subprotocols: [], messageFormat: 'text' } }))).toBe(
      `websocat -n \\\n  'wss://chat.example.com/socket'`,
    )
  })
})
