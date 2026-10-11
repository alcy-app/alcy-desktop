import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MAX_CONSOLE_BODY_CHARS, useConsoleState } from './use-console-state'
import type { ConsoleEntryInput } from './use-console-state'

function requestEntry(requestBody: string, body: string, bodyEncoding: 'text' | 'base64' = 'text'): ConsoleEntryInput {
  return {
    kind: 'request',
    endpointUrl: 'https://api.test',
    executedAtMs: 0,
    durationMs: 1,
    outcome: 'success',
    statusCode: 200,
    hasGraphqlErrors: false,
    errorKind: null,
    scriptMessage: null,
    detail: {
      method: 'post',
      requestBody,
      durationMs: 1,
      requestHeaders: [],
      cookies: [],
      connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
      finalUrl: null,
      waitingMs: 0,
      responseHeaders: [],
      body: { kind: 'inline', body },
      bodyEncoding,
    },
  }
}

describe('useConsoleState', () => {
  it('guarda inteiros os corpos dentro do teto', () => {
    const { result } = renderHook(() => useConsoleState())
    act(() => result.current.append(requestEntry('{"a":1}', '{"ok":true}')))

    const detail = result.current.entries[0].detail
    expect(detail?.requestBody).toBe('{"a":1}')
    expect(detail?.body).toEqual({ kind: 'inline', body: '{"ok":true}' })
    expect(detail?.truncated).toBeUndefined()
  })

  it('corta corpos de texto acima do teto e marca a entrada', () => {
    const { result } = renderHook(() => useConsoleState())
    const big = 'x'.repeat(MAX_CONSOLE_BODY_CHARS + 10)
    act(() => result.current.append(requestEntry(big, big)))

    const detail = result.current.entries[0].detail
    expect(detail?.requestBody).toHaveLength(MAX_CONSOLE_BODY_CHARS)
    expect(detail?.body.kind === 'inline' && detail.body.body).toHaveLength(MAX_CONSOLE_BODY_CHARS)
    expect(detail?.truncated).toBe(true)
  })

  it('não corta imagens em base64, que não decodificariam', () => {
    const { result } = renderHook(() => useConsoleState())
    const image = 'A'.repeat(MAX_CONSOLE_BODY_CHARS + 10)
    act(() => result.current.append(requestEntry('', image, 'base64')))

    const detail = result.current.entries[0].detail
    expect(detail?.body).toEqual({ kind: 'inline', body: image })
    expect(detail?.truncated).toBeUndefined()
  })
})
