import type { HttpMethodInput } from '../../bindings/execute-rest-request'
import { contentTypeFor } from './body-state'
import type { GeneratedHeaderEntry } from './components/HeadersPanel'
import type { BodyState, HeaderEntry } from './request-workbench.types'

interface DefaultGeneratedHeadersInput {
  endpointUrl: string
  method: HttpMethodInput
  body: BodyState
  /** Headers manuais: os habilitados que repetem um nome automático o substituem. */
  headers: HeaderEntry[]
  onSendValue: string
  reason: string
}

const DEFAULT_USER_AGENT = 'Alcy'

/** Sem corpo, esses métodos ainda levam `Content-Length: 0`. */
const METHODS_EXPECTING_BODY = new Set<HttpMethodInput>(['post', 'put', 'patch'])

function hasBody(body: BodyState): boolean {
  switch (body.type) {
    case 'none':
      return false
    case 'raw':
      return body.raw.length > 0
    case 'urlencoded':
      return body.urlEncoded.some((entry) => entry.enabled)
    case 'formData':
      return body.formData.some((entry) => entry.enabled)
    case 'binary':
      return body.binaryFilePath !== ''
  }
}

function hostOf(endpointUrl: string): string | null {
  try {
    return new URL(endpointUrl).host || null
  } catch {
    return null
  }
}

/** Headers que o Alcy envia por conta própria nas requisições REST. */
export function defaultGeneratedHeaders({
  endpointUrl,
  method,
  body,
  headers,
  onSendValue,
  reason,
}: DefaultGeneratedHeadersInput): GeneratedHeaderEntry[] {
  const defined = new Set(headers.filter((header) => header.enabled).map((header) => header.name.trim().toLowerCase()))
  const entries: GeneratedHeaderEntry[] = [
    { name: 'User-Agent', value: DEFAULT_USER_AGENT, reason },
    { name: 'Accept', value: '*/*', reason },
    { name: 'Cache-Control', value: 'no-cache', reason },
    { name: 'Accept-Encoding', value: 'gzip, deflate, br', reason },
    { name: 'Host', value: hostOf(endpointUrl) ?? onSendValue, reason },
    { name: 'Connection', value: 'keep-alive', reason },
  ]
  if (hasBody(body)) {
    // Binary e form-data só conhecem o tipo (mime do arquivo, boundary) no envio.
    const contentType = body.type === 'raw' || body.type === 'urlencoded' ? contentTypeFor(body.type, body.rawLanguage) : null
    entries.push({ name: 'Content-Type', value: contentType ?? onSendValue, reason })
    entries.push({ name: 'Content-Length', value: onSendValue, reason })
  } else if (METHODS_EXPECTING_BODY.has(method)) {
    entries.push({ name: 'Content-Length', value: '0', reason })
  }
  return entries.filter((entry) => !defined.has(entry.name.toLowerCase()))
}
