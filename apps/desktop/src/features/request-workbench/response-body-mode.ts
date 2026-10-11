import type { ResponseHeader } from '../../bindings/execute-graphql-request'

export type ResponseBodyMode = 'json' | 'xml' | 'html' | 'text'

/**
 * Extrai o `Content-Type` da resposta (sem parâmetros como `; charset=...`),
 * buscando o nome do header de forma case-insensitive — HTTP não garante
 * casing. Reaproveitado pelo visualizador de imagem para montar a data URI
 * (`response-body-mode.ts` é o único lugar que sabe procurar esse header).
 */
export function contentTypeOf(headers: ResponseHeader[]): string | null {
  const header = headers.find((candidate) => candidate.name.toLowerCase() === 'content-type')
  if (!header) return null
  return header.value.split(';', 1)[0].trim().toLowerCase()
}

function looksLikeJson(body: string): boolean {
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

/**
 * Decide como exibir o corpo da resposta: pelo `Content-Type` quando ele é
 * explícito, ou por uma tentativa de detecção pelo próprio corpo quando o
 * header está ausente ou é genérico demais (`text/plain`,
 * `application/octet-stream`). Nunca lança — na dúvida, cai em `'text'`.
 */
export function detectBodyMode(headers: ResponseHeader[], body: string): ResponseBodyMode {
  const contentType = contentTypeOf(headers)

  if (contentType) {
    if (contentType === 'application/json' || contentType.endsWith('+json')) return 'json'
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'html'
    if (contentType === 'application/xml' || contentType === 'text/xml' || contentType.endsWith('+xml')) return 'xml'
    if (contentType !== 'text/plain' && contentType !== 'application/octet-stream') return 'text'
  }

  if (looksLikeJson(body)) return 'json'
  const trimmedBody = body.trim().toLowerCase()
  if (trimmedBody.startsWith('<!doctype html') || trimmedBody.startsWith('<html')) return 'html'
  if (trimmedBody.startsWith('<')) return 'xml'
  return 'text'
}
