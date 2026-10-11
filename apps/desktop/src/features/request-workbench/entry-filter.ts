import type { ConsoleEntry } from './use-console-state'

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'error'

const STATUS_CLASSES: StatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'error']

/** Filtro digitado numa única caixa, no estilo dos filtros do Fiddler. Termos
 * separados por espaço, todos precisam casar (sem diferenciar maiúsculas):
 *
 * - `users` — a URL, o método ou o status contém o texto
 * - `-health` — oculta se a URL contém
 * - `header:json` — algum header (`nome: valor`) contém
 * - `body:ana` — o corpo da requisição ou da resposta contém
 * - `status:4xx` — classe de status (`2xx`, `3xx`, `4xx`, `5xx`, `error`); várias = qualquer uma
 */
export interface ParsedFilter {
  include: string[]
  exclude: string[]
  header: string[]
  body: string[]
  statuses: StatusClass[]
}

export function parseFilter(query: string): ParsedFilter {
  const parsed: ParsedFilter = { include: [], exclude: [], header: [], body: [], statuses: [] }
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (!token) continue
    const separator = token.indexOf(':')
    const key = separator > 0 ? token.slice(0, separator) : ''
    const value = separator > 0 ? token.slice(separator + 1) : ''
    if (key === 'status' && (STATUS_CLASSES as string[]).includes(value)) {
      parsed.statuses.push(value as StatusClass)
    } else if (key === 'header' && value) {
      parsed.header.push(value)
    } else if (key === 'body' && value) {
      parsed.body.push(value)
    } else if (token.startsWith('-') && token.length > 1) {
      parsed.exclude.push(token.slice(1))
    } else {
      parsed.include.push(token)
    }
  }
  return parsed
}

export function statusClassOf(entry: ConsoleEntry): StatusClass {
  if (entry.outcome === 'error' || entry.statusCode === null) return 'error'
  const hundreds = Math.floor(entry.statusCode / 100)
  return hundreds >= 2 && hundreds <= 5 ? (`${hundreds}xx` as StatusClass) : 'error'
}

export function matchesFilter(entry: ConsoleEntry, filter: ParsedFilter): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(statusClassOf(entry))) return false

  const url = entry.endpointUrl.toLowerCase()
  if (filter.exclude.some((term) => url.includes(term))) return false

  if (filter.include.length > 0) {
    const haystack = [url, entry.detail?.method, entry.statusCode, entry.errorKind, entry.scriptMessage]
      .filter((part) => part !== null && part !== undefined)
      .join(' ')
      .toLowerCase()
    if (!filter.include.every((term) => haystack.includes(term))) return false
  }

  const { detail } = entry
  if (filter.header.length > 0) {
    if (!detail) return false
    const haystack = [...detail.requestHeaders, ...detail.responseHeaders]
      .map((item) => `${item.name}: ${item.value}`)
      .join('\n')
      .toLowerCase()
    if (!filter.header.every((term) => haystack.includes(term))) return false
  }

  if (filter.body.length > 0) {
    if (!detail) return false
    const responseBody =
      detail.bodyEncoding !== 'text' ? '' : detail.body.kind === 'inline' ? detail.body.body : detail.body.preview
    const haystack = `${detail.requestBody}\n${responseBody}`.toLowerCase()
    if (!filter.body.every((term) => haystack.includes(term))) return false
  }

  return true
}
