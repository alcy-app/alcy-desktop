import { describe, expect, it } from 'vitest'
import { harRedactionContext, redactRecordedEntry, type RecordedEntry } from './har-redaction'
import type { ConsoleEntryDetail } from './use-console-state'

const MASK = '••••••••'

function detail(overrides: Partial<ConsoleEntryDetail> = {}): ConsoleEntryDetail {
  return {
    method: 'post',
    requestBody: '',
    durationMs: 10,
    requestHeaders: [],
    cookies: [],
    connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
    finalUrl: null,
    waitingMs: 1,
    responseHeaders: [],
    body: { kind: 'inline', body: '{"token":"s3cr3t"}' },
    bodyEncoding: 'text',
    ...overrides,
  }
}

function recorded(overrides: Partial<RecordedEntry> = {}): RecordedEntry {
  return {
    id: '1',
    kind: 'request',
    endpointUrl: 'https://api.test/users?key=s3cr3t',
    executedAtMs: 0,
    durationMs: 10,
    outcome: 'success',
    statusCode: 200,
    hasGraphqlErrors: false,
    errorKind: null,
    scriptMessage: null,
    detail: detail(),
    redaction: { sensitiveValues: [{ name: 'apiKey', value: 's3cr3t' }], secretHeaderNames: [] },
    ...overrides,
  }
}

describe('redactRecordedEntry', () => {
  it('mascara headers de autorização mantendo o esquema', () => {
    const entry = redactRecordedEntry(
      recorded({
        detail: detail({
          requestHeaders: [
            { name: 'Authorization', value: 'Bearer abc.def' },
            { name: 'proxy-authorization', value: 'Basic dXNlcjpwYXNz' },
            { name: 'X-Other', value: 'opaque' },
          ],
        }),
      }),
    )
    expect(entry.detail?.requestHeaders).toEqual([
      { name: 'Authorization', value: `Bearer ${MASK}` },
      { name: 'proxy-authorization', value: `Basic ${MASK}` },
      { name: 'X-Other', value: 'opaque' },
    ])
  })

  it('mascara o header da auth customizada e headers com nome de credencial', () => {
    const entry = redactRecordedEntry(
      recorded({
        detail: detail({
          requestHeaders: [
            { name: 'X-Tenant-Auth', value: 'tenant-key' },
            { name: 'x-api-key', value: 'k1' },
            { name: 'X-Access-Token', value: 't1' },
            { name: 'Accept', value: 'application/json' },
          ],
          responseHeaders: [{ name: 'X-Refresh-Token', value: 'r1' }, { name: 'Content-Type', value: 'application/json' }],
        }),
        redaction: { sensitiveValues: [], secretHeaderNames: ['x-tenant-auth'] },
      }),
    )
    expect(entry.detail?.requestHeaders.map((header) => header.value)).toEqual([MASK, MASK, MASK, 'application/json'])
    expect(entry.detail?.responseHeaders.map((header) => header.value)).toEqual([MASK, 'application/json'])
  })

  it('troca valores de variáveis sensíveis por {{nome}} na URL, nos headers e no corpo da requisição', () => {
    const entry = redactRecordedEntry(
      recorded({
        detail: detail({
          requestBody: '{"key":"s3cr3t"}',
          finalUrl: 'https://api.test/next?key=s3cr3t',
          requestHeaders: [{ name: 'X-Trace', value: 'id-s3cr3t' }],
        }),
      }),
    )
    expect(entry.endpointUrl).toBe('https://api.test/users?key={{apiKey}}')
    expect(entry.detail?.finalUrl).toBe('https://api.test/next?key={{apiKey}}')
    expect(entry.detail?.requestBody).toBe('{"key":"{{apiKey}}"}')
    expect(entry.detail?.requestHeaders[0].value).toBe('id-{{apiKey}}')
  })

  it('troca primeiro o valor mais longo e ignora valores vazios', () => {
    const entry = redactRecordedEntry(
      recorded({
        endpointUrl: 'https://api.test/?a=abc&b=abcdef',
        redaction: {
          sensitiveValues: [
            { name: 'short', value: 'abc' },
            { name: 'empty', value: '' },
            { name: 'long', value: 'abcdef' },
          ],
          secretHeaderNames: [],
        },
      }),
    )
    expect(entry.endpointUrl).toBe('https://api.test/?a={{short}}&b={{long}}')
  })

  it('mascara os valores de cookies e preserva os atributos do Set-Cookie', () => {
    const entry = redactRecordedEntry(
      recorded({
        detail: detail({
          requestHeaders: [{ name: 'Cookie', value: 'sid=abc; theme=dark' }],
          responseHeaders: [{ name: 'Set-Cookie', value: 'sid=xyz; Path=/; HttpOnly' }],
          cookies: [
            {
              name: 'sid',
              value: 'xyz',
              domain: null,
              path: '/',
              expires: null,
              maxAgeSeconds: null,
              secure: false,
              httpOnly: true,
              sameSite: null,
            },
          ],
        }),
      }),
    )
    expect(entry.detail?.requestHeaders[0].value).toBe(`sid=${MASK}; theme=${MASK}`)
    expect(entry.detail?.responseHeaders[0].value).toBe(`sid=${MASK}; Path=/; HttpOnly`)
    expect(entry.detail?.cookies[0]).toMatchObject({ name: 'sid', value: MASK, path: '/', httpOnly: true })
  })

  it('não altera o corpo da resposta nem a entrada original', () => {
    const original = recorded({ detail: detail({ requestHeaders: [{ name: 'Authorization', value: 'Bearer abc' }] }) })
    const entry = redactRecordedEntry(original)
    expect(entry.detail?.body).toBe(original.detail?.body)
    expect(original.detail?.requestHeaders[0].value).toBe('Bearer abc')
    expect(original.endpointUrl).toBe('https://api.test/users?key=s3cr3t')
  })
})

describe('harRedactionContext', () => {
  it('reúne as variáveis sensíveis, os valores do script para elas e o header da auth customizada', () => {
    const context = harRedactionContext(
      [
        { name: 'token', value: 'old', sensitive: true },
        { name: 'baseUrl', value: 'https://api.test', sensitive: false },
        { name: 'headerName', value: 'X-Tenant', sensitive: false },
      ],
      [
        { name: 'token', value: 'new' },
        { name: 'userId', value: '42' },
      ],
      { type: 'customHeader', name: '{{headerName}}-Auth', value: '{{token}}' },
    )
    expect(context).toEqual({
      sensitiveValues: [
        { name: 'token', value: 'old' },
        { name: 'token', value: 'new' },
      ],
      secretHeaderNames: ['X-Tenant-Auth'],
    })
  })

  it('não lista header extra quando a autenticação não é customizada', () => {
    expect(harRedactionContext([], [], { type: 'bearer', token: 'abc' }).secretHeaderNames).toEqual([])
    expect(harRedactionContext([], [], undefined).secretHeaderNames).toEqual([])
  })
})
