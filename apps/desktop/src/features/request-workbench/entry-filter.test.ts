import { describe, expect, it } from 'vitest'
import { matchesFilter, parseFilter, statusClassOf } from './entry-filter'
import type { ConsoleEntry } from './use-console-state'

function entry(overrides: Partial<ConsoleEntry> = {}, body = '{"user":"ana"}'): ConsoleEntry {
  return {
    id: '1',
    kind: 'request',
    endpointUrl: 'https://api.test/users',
    executedAtMs: 0,
    durationMs: 10,
    outcome: 'success',
    statusCode: 200,
    hasGraphqlErrors: false,
    errorKind: null,
    scriptMessage: null,
    detail: {
      method: 'get',
      requestBody: 'req-payload',
      durationMs: 10,
      requestHeaders: [{ name: 'Accept', value: 'application/json' }],
      cookies: [],
      connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
      finalUrl: null,
      waitingMs: 1,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: { kind: 'inline', body },
      bodyEncoding: 'text',
    },
    ...overrides,
  }
}

const matches = (query: string, e: ConsoleEntry = entry()) => matchesFilter(e, parseFilter(query))

describe('parseFilter / matchesFilter', () => {
  it('matches everything with an empty query', () => {
    expect(matches('')).toBe(true)
    expect(matches('   ')).toBe(true)
  })

  it('requires every plain term to match URL, method or status', () => {
    expect(matches('users get 200')).toBe(true)
    expect(matches('users orders')).toBe(false)
    expect(matches('USERS')).toBe(true)
  })

  it('hides calls whose URL contains a -term', () => {
    expect(matches('-users')).toBe(false)
    expect(matches('-orders')).toBe(true)
    expect(matches('users -orders')).toBe(true)
  })

  it('filters by header:', () => {
    expect(matches('header:text/html')).toBe(true)
    expect(matches('header:authorization')).toBe(false)
    expect(matches('header:accept', entry({ detail: null }))).toBe(false)
  })

  it('filters by body: over request and response', () => {
    expect(matches('body:ANA')).toBe(true)
    expect(matches('body:req-payload')).toBe(true)
    expect(matches('body:bob')).toBe(false)
  })

  it('ignores base64 response bodies for body:', () => {
    const binary = entry({}, 'ana')
    if (binary.detail) binary.detail.bodyEncoding = 'base64'
    expect(matches('body:ana', binary)).toBe(false)
  })

  it('filters by status: class, any of several', () => {
    const failed = entry({ outcome: 'error', statusCode: null, errorKind: 'network', detail: null })
    expect(statusClassOf(entry({ statusCode: 404 }))).toBe('4xx')
    expect(statusClassOf(failed)).toBe('error')
    expect(matches('status:4xx status:5xx')).toBe(false)
    expect(matches('status:2xx status:5xx')).toBe(true)
    expect(matches('status:error', failed)).toBe(true)
  })

  it('treats unknown prefixes as plain text', () => {
    expect(parseFilter('foo:bar').include).toEqual(['foo:bar'])
    expect(parseFilter('-').include).toEqual(['-'])
  })
})
