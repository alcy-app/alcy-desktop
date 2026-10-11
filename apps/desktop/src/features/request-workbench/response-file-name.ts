import type { ResponseBodyEncoding, ResponseHeader } from '../../bindings/execute-graphql-request'
import { contentTypeOf } from './response-body-mode'

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** Troca o que não é válido em nome de arquivo no Windows (o mais restritivo)
 * por `-`; pontos e espaços nas pontas também são removidos. */
function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '')
}

/** Nome sugerido pelo servidor no `Content-Disposition`, preferindo a forma
 * estendida (`filename*=UTF-8''...`, RFC 6266) à simples. */
function contentDispositionFileName(headers: ResponseHeader[]): string | null {
  const header = headers.find((candidate) => candidate.name.toLowerCase() === 'content-disposition')
  if (!header) return null
  const extended = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header.value)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // Codificação inválida: tenta a forma simples.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header.value)
  const value = plain?.[1] ?? plain?.[2]
  return value?.trim() || null
}

function extensionFor(headers: ResponseHeader[], encoding: ResponseBodyEncoding): string {
  const contentType = contentTypeOf(headers)
  if (contentType) {
    const known = EXTENSION_BY_CONTENT_TYPE[contentType]
    if (known) return known
    if (contentType.endsWith('+json')) return 'json'
    if (contentType.endsWith('+xml')) return 'xml'
  }
  return encoding === 'base64' ? 'bin' : 'txt'
}

/** Nome sugerido ao baixar uma resposta: o do `Content-Disposition`, quando o
 * servidor manda um; senão `<nome da requisição>.<extensão do Content-Type>`. */
export function responseFileName(requestName: string, headers: ResponseHeader[], encoding: ResponseBodyEncoding): string {
  const fromServer = contentDispositionFileName(headers)
  const sanitizedFromServer = fromServer ? sanitizeFileName(fromServer) : ''
  if (sanitizedFromServer) return sanitizedFromServer
  const base = sanitizeFileName(requestName) || 'response'
  return `${base}.${extensionFor(headers, encoding)}`
}
