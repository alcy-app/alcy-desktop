import { describe, expect, it } from 'vitest'
import { buildHar } from './har'
import type { ConsoleEntry } from './use-console-state'

function successEntry(overrides: Partial<ConsoleEntry['detail'] & object> = {}): ConsoleEntry {
  return {
    id: '1',
    kind: 'request',
    endpointUrl: 'https://api.test/graphql?x=1',
    executedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5),
    durationMs: 120,
    outcome: 'success',
    statusCode: 200,
    hasGraphqlErrors: false,
    errorKind: null,
    scriptMessage: null,
    detail: {
      method: 'post',
      requestBody: '{"query":"{ ping }"}',
      durationMs: 120,
      requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      cookies: [],
      connection: { remoteAddress: '10.0.0.1:443', httpVersion: 'HTTP/2', tlsCertificatePresent: true, certificateVerificationDisabled: false },
      finalUrl: null,
      waitingMs: 80,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: { kind: 'inline', body: '{"data":{}}' },
      bodyEncoding: 'text',
      ...overrides,
    },
  }
}

function parse(entries: ConsoleEntry[]) {
  return JSON.parse(buildHar(entries)).log
}

describe('buildHar', () => {
  it('produces a HAR 1.2 document with creator and entries', () => {
    const log = parse([successEntry()])
    expect(log.version).toBe('1.2')
    expect(log.creator.name).toBe('Alcy')
    expect(log.entries).toHaveLength(1)
  })

  it('maps request, response and timings', () => {
    const [entry] = parse([successEntry()]).entries
    expect(entry.startedDateTime).toBe('2026-01-02T03:04:05.000Z')
    expect(entry.time).toBe(120)
    expect(entry.request.method).toBe('POST')
    expect(entry.request.queryString).toEqual([{ name: 'x', value: '1' }])
    expect(entry.request.postData).toEqual({ mimeType: 'application/json', text: '{"query":"{ ping }"}' })
    expect(entry.response.status).toBe(200)
    expect(entry.response.content).toMatchObject({ size: 11, mimeType: 'application/json', text: '{"data":{}}' })
    expect(entry.timings).toMatchObject({ wait: 80, receive: 40 })
    expect(entry.serverIPAddress).toBe('10.0.0.1')
  })

  it('marks base64 bodies', () => {
    const [entry] = parse([successEntry({ body: { kind: 'inline', body: 'AAEC' }, bodyEncoding: 'base64' })]).entries
    expect(entry.response.content.encoding).toBe('base64')
  })

  it('records a comment for windowed bodies', () => {
    const [entry] = parse([
      successEntry({ body: { kind: 'windowed', handle: 'h', totalBytes: 9000, preview: 'abc', previewNextOffset: 3 } }),
    ]).entries
    expect(entry.response.content).toMatchObject({ size: 9000, text: 'abc' })
    expect(entry.response.content.comment).toBeTruthy()
  })

  it('records a comment for inline bodies kept only in part', () => {
    const [entry] = parse([successEntry({ body: { kind: 'inline', body: 'abc' }, truncated: true })]).entries
    expect(entry.response.content).toMatchObject({ text: 'abc' })
    expect(entry.response.content.comment).toBeTruthy()
  })

  it('records failed calls with status 0 and the error kind', () => {
    const [entry] = parse([
      { ...successEntry(), outcome: 'error', statusCode: null, errorKind: 'network', durationMs: null, detail: null },
    ]).entries
    expect(entry.response.status).toBe(0)
    expect(entry.response.comment).toBe('network')
  })
})
