import type { Cookie, ResponseHeader } from '../../bindings/execute-graphql-request'
import type { ConsoleEntry } from './use-console-state'

const HAR_CREATOR = { name: 'Alcy', version: '1.0' }

function harHeaders(headers: ResponseHeader[]) {
  return headers.map(({ name, value }) => ({ name, value }))
}

function harCookies(cookies: Cookie[]) {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    ...(cookie.path ? { path: cookie.path } : {}),
    ...(cookie.domain ? { domain: cookie.domain } : {}),
    ...(cookie.expires ? { expires: cookie.expires } : {}),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
  }))
}

function headerValue(headers: ResponseHeader[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value
}

/** `remoteAddress` vem como `ip:porta`; HAR espera só o IP. */
function ipOf(address: string): string {
  const bracketed = address.match(/^\[(.+)\]:\d+$/)
  if (bracketed) return bracketed[1]
  return /^[^:]+:\d+$/.test(address) ? address.slice(0, address.lastIndexOf(':')) : address
}

/** `httpVersion` é obrigatório no HAR; o backend pode devolvê-lo vazio. */
function httpVersionOf(detail: ConsoleEntry['detail']): string {
  return detail?.connection.httpVersion || 'HTTP/1.1'
}

/** HAR mede `size`/`bodySize` em bytes, não em caracteres. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function queryString(url: string) {
  try {
    return Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

function harEntry(entry: ConsoleEntry) {
  const { detail } = entry
  const url = detail?.finalUrl ?? entry.endpointUrl
  const durationMs = detail?.durationMs ?? entry.durationMs ?? 0
  const waitMs = detail?.waitingMs ?? 0
  const requestHeaders = detail?.requestHeaders ?? []

  const request = {
    method: (detail?.method ?? 'POST').toUpperCase(),
    url,
    httpVersion: httpVersionOf(detail),
    cookies: [],
    headers: harHeaders(requestHeaders),
    queryString: queryString(url),
    ...(detail?.requestBody
      ? {
          postData: {
            mimeType: headerValue(requestHeaders, 'content-type') ?? 'application/json',
            text: detail.requestBody,
          },
        }
      : {}),
    headersSize: -1,
    bodySize: detail ? byteLength(detail.requestBody) : -1,
  }

  let content: { size: number; mimeType: string; text?: string; encoding?: string; comment?: string }
  if (detail) {
    const mimeType = headerValue(detail.responseHeaders, 'content-type') ?? ''
    if (detail.body.kind === 'inline') {
      content = {
        size: byteLength(detail.body.body),
        mimeType,
        text: detail.body.body,
        ...(detail.bodyEncoding === 'base64' ? { encoding: 'base64' } : {}),
      }
    } else {
      content = {
        size: detail.body.totalBytes,
        mimeType,
        text: detail.body.preview,
        ...(detail.bodyEncoding === 'base64' ? { encoding: 'base64' } : {}),
        comment: 'Body truncated: only the preview was recorded.',
      }
    }
  } else {
    content = { size: 0, mimeType: '' }
  }

  const response = {
    status: detail ? (entry.statusCode ?? 0) : 0,
    statusText: '',
    httpVersion: httpVersionOf(detail),
    cookies: harCookies(detail?.cookies ?? []),
    headers: harHeaders(detail?.responseHeaders ?? []),
    content,
    redirectURL: '',
    headersSize: -1,
    bodySize: content.size,
    ...(detail ? {} : { comment: entry.errorKind ?? 'error' }),
  }

  return {
    startedDateTime: new Date(entry.executedAtMs).toISOString(),
    time: durationMs,
    request,
    response,
    cache: {},
    timings: {
      send: 0,
      wait: waitMs,
      receive: Math.max(durationMs - waitMs, 0),
    },
    ...(detail?.connection.remoteAddress ? { serverIPAddress: ipOf(detail.connection.remoteAddress) } : {}),
  }
}

/** Serializa as entradas gravadas como HAR 1.2. Espera ordem cronológica. */
export function buildHar(entries: ConsoleEntry[]): string {
  return JSON.stringify(
    { log: { version: '1.2', creator: HAR_CREATOR, entries: entries.map(harEntry) } },
    null,
    2,
  )
}
