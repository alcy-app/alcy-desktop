/**
 * Envio das chamadas: direto pelo `fetch` do navegador (sujeito a CORS) ou
 * pelo `alcy-webclient-server`, que repete a chamada a partir do servidor
 * (contrato em `services/alcy-webclient-server/src/proxy.rs`).
 */

import type { HttpCall, OAuth2Step } from './build-request'

export const PROXY_PATH = '/__alcy/proxy'
export const HEALTH_PATH = '/__alcy/health'
/** Mesmo teto de corpo do servidor. */
export const RESPONSE_LIMIT_BYTES = 20 * 1024 * 1024

export type SendMode = 'direct' | 'server'

export interface HttpResult {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  size: number
  truncated: boolean
  durationMs: number
}

export type TransportFailure =
  | { kind: 'aborted' }
  /** No modo direto, quase sempre CORS (o navegador não diz o motivo). */
  | { kind: 'network'; mode: SendMode; message: string }
  | { kind: 'server'; status: number; code: string; message: string }
  | { kind: 'oauth2'; message: string }

export class TransportError extends Error {
  readonly failure: TransportFailure

  constructor(failure: TransportFailure) {
    super(failure.kind)
    this.failure = failure
  }
}

type Fetch = typeof fetch

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function formData(fields: [string, string][]): FormData {
  const data = new FormData()
  for (const [name, value] of fields) data.append(name, value)
  return data
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/** O webclient foi servido pelo `alcy-webclient-server` (e não aberto como arquivo). */
export async function detectServer(fetchImpl: Fetch = fetch, protocol = window.location.protocol): Promise<boolean> {
  if (protocol !== 'http:' && protocol !== 'https:') return false
  try {
    const response = await fetchImpl(HEALTH_PATH, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return false
    const health: unknown = await response.json()
    return typeof health === 'object' && health !== null && (health as { service?: unknown }).service === 'alcy-webclient-server'
  } catch {
    return false
  }
}

/** Lê o corpo até `RESPONSE_LIMIT_BYTES`; o resto é descartado. */
async function readLimited(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer())
    return { bytes: all.subarray(0, RESPONSE_LIMIT_BYTES), truncated: all.length > RESPONSE_LIMIT_BYTES }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > RESPONSE_LIMIT_BYTES) {
      chunks.push(value.subarray(0, RESPONSE_LIMIT_BYTES - size))
      size = RESPONSE_LIMIT_BYTES
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    size += value.length
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, truncated }
}

async function sendDirect(call: HttpCall, signal: AbortSignal, fetchImpl: Fetch): Promise<HttpResult> {
  const started = performance.now()
  const allowsBody = call.method !== 'GET' && call.method !== 'HEAD'
  let body: BodyInit | undefined
  if (allowsBody && call.body.kind === 'text') body = call.body.text
  if (allowsBody && call.body.kind === 'multipart') body = formData(call.body.fields)
  let response: Response
  try {
    response = await fetchImpl(call.url, {
      method: call.method,
      headers: call.headers,
      body,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
    })
  } catch (error) {
    if (isAbort(error)) throw new TransportError({ kind: 'aborted' })
    throw new TransportError({ kind: 'network', mode: 'direct', message: error instanceof Error ? error.message : String(error) })
  }
  const { bytes, truncated } = await readLimited(response)
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: new TextDecoder().decode(bytes),
    size: bytes.length,
    truncated,
    durationMs: Math.round(performance.now() - started),
  }
}

async function callBytes(call: HttpCall): Promise<{ headers: [string, string][]; body: Uint8Array | null }> {
  if (call.body.kind === 'none') return { headers: call.headers, body: null }
  if (call.body.kind === 'text') return { headers: call.headers, body: new TextEncoder().encode(call.body.text) }
  // Multipart serializado pelo próprio navegador, com o boundary no Content-Type.
  const encoded = new Response(formData(call.body.fields))
  const contentType = encoded.headers.get('content-type')
  const headers: [string, string][] = contentType ? [...call.headers, ['Content-Type', contentType]] : call.headers
  return { headers, body: new Uint8Array(await encoded.arrayBuffer()) }
}

interface ProxyResponse {
  status: number
  statusText: string
  headers: [string, string][]
  bodyBase64: string
  truncated: boolean
  durationMs: number
}

async function sendViaServer(call: HttpCall, signal: AbortSignal, fetchImpl: Fetch): Promise<HttpResult> {
  const { headers, body } = await callBytes(call)
  let response: Response
  try {
    response = await fetchImpl(PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: call.method, url: call.url, headers, bodyBase64: body ? toBase64(body) : null }),
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch (error) {
    if (isAbort(error)) throw new TransportError({ kind: 'aborted' })
    throw new TransportError({ kind: 'network', mode: 'server', message: error instanceof Error ? error.message : String(error) })
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error) {
    if (isAbort(error)) throw new TransportError({ kind: 'aborted' })
    parsed = null
  }
  if (!response.ok) {
    const failure = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error
    throw new TransportError({
      kind: 'server',
      status: response.status,
      code: typeof failure?.code === 'string' ? failure.code : 'unknown',
      message: typeof failure?.message === 'string' ? failure.message : response.statusText,
    })
  }
  const result = parsed as ProxyResponse
  const bytes = fromBase64(result.bodyBase64)
  return {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    body: new TextDecoder().decode(bytes),
    size: bytes.length,
    truncated: result.truncated,
    durationMs: result.durationMs,
  }
}

export function send(call: HttpCall, mode: SendMode, signal: AbortSignal, fetchImpl: Fetch = fetch): Promise<HttpResult> {
  return mode === 'server' ? sendViaServer(call, signal, fetchImpl) : sendDirect(call, signal, fetchImpl)
}

/** Busca o token `client_credentials` (cliente autenticado por Basic, como no app). */
async function fetchOAuth2Token(step: OAuth2Step, mode: SendMode, signal: AbortSignal, fetchImpl: Fetch): Promise<string> {
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (step.scope.trim() !== '') form.set('scope', step.scope)
  let credentials = ''
  for (const byte of new TextEncoder().encode(`${step.clientId}:${step.clientSecret}`)) credentials += String.fromCharCode(byte)
  const result = await send(
    {
      method: 'POST',
      url: step.tokenUrl,
      headers: [
        ['Authorization', `Basic ${btoa(credentials)}`],
        ['Content-Type', 'application/x-www-form-urlencoded'],
      ],
      body: { kind: 'text', text: form.toString() },
    },
    mode,
    signal,
    fetchImpl,
  )
  if (result.status < 200 || result.status >= 300) {
    throw new TransportError({ kind: 'oauth2', message: `HTTP ${result.status} ${result.statusText}`.trim() })
  }
  try {
    const token: unknown = (JSON.parse(result.body) as { access_token?: unknown }).access_token
    if (typeof token === 'string' && token !== '') return token
  } catch {
    // cai no erro abaixo
  }
  throw new TransportError({ kind: 'oauth2', message: 'access_token' })
}

/** Executa a chamada, buscando antes o token OAuth2 quando houver. */
export async function execute(
  call: HttpCall,
  oauth2: OAuth2Step | null,
  mode: SendMode,
  signal: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<HttpResult> {
  if (!oauth2) return send(call, mode, signal, fetchImpl)
  const token = await fetchOAuth2Token(oauth2, mode, signal, fetchImpl)
  const headers: [string, string][] = [
    ...call.headers.filter(([name]) => name.toLowerCase() !== 'authorization'),
    ['Authorization', `Bearer ${token}`],
  ]
  return send({ ...call, headers }, mode, signal, fetchImpl)
}
