import type { FlowNodeOutputDto } from '../../bindings/get-flow-node-output'

/** Um campo navegável do output de um node. `path` é o caminho depois de
 * `response.` na gramática de referência (`status`, `headers.<nome>`,
 * `body.a.b.0`); `null` quando o campo não pode ser referenciado (a chave
 * tem `.`, que o resolvedor usa como separador, ou o pai já não é
 * referenciável). */
export interface OutputEntry {
  key: string
  path: string | null
  value: unknown
}

export type ValueKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export function kindOf(value: unknown): ValueKind {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'boolean'
}

export function isContainer(value: unknown): boolean {
  const kind = kindOf(value)
  return kind === 'object' || kind === 'array'
}

/** Filhos de um objeto/array, cada um com seu caminho de referência. */
export function childEntries(value: unknown, path: string | null): OutputEntry[] {
  const pairs: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : value && typeof value === 'object'
      ? Object.entries(value)
      : []
  return pairs.map(([key, child]) => ({
    key,
    path: path !== null && key !== '' && !key.includes('.') ? `${path}.${key}` : null,
    value: child,
  }))
}

/** Corpo como JSON quando é completo e válido; `undefined` caso contrário
 * (texto puro ou corpo truncado). */
export function parseBody(output: FlowNodeOutputDto): unknown | undefined {
  if (output.truncated || output.bodyEncoding === 'base64') return undefined
  try {
    return JSON.parse(output.body)
  } catch {
    return undefined
  }
}

/** Raízes da árvore: `status`, `headers` e `body`, como na gramática de
 * referência de nodes — ou `method`/`path` no lugar de `status` para a chamada
 * recebida por um bloco "Aguardar chamada" (spec 0121). `headers` não é
 * referenciável sozinho (a gramática pede o nome), só cada header. */
export function outputRoots(output: FlowNodeOutputDto): OutputEntry[] {
  const headers: Record<string, string> = {}
  for (const header of output.headers) headers[header.name] = header.value

  const parsed = parseBody(output)
  const head: OutputEntry[] = output.request
    ? [
        { key: 'method', path: 'method', value: output.request.method },
        { key: 'path', path: 'path', value: output.request.path },
      ]
    : [{ key: 'status', path: 'status', value: output.statusCode }]
  return [
    ...head,
    { key: 'headers', path: null, value: headers },
    { key: 'body', path: 'body', value: parsed === undefined ? output.body : parsed },
  ]
}

/** Filhos de `headers` usam `headers.<nome>` mesmo com a raiz não referenciável. */
export function childrenOfRoot(root: OutputEntry): OutputEntry[] {
  if (root.key !== 'headers') return childEntries(root.value, root.path)
  return childEntries(root.value, 'headers')
}

/** `scope` é `request` para a chamada recebida por um bloco "Aguardar chamada". */
export function referenceFor(nodeId: string, path: string, scope: 'response' | 'request' = 'response'): string {
  return `{{nodes.${nodeId}.${scope}.${path}}}`
}

const PREVIEW_LIMIT = 80

/** Texto curto que resume um valor na linha da árvore. */
export function summarize(value: unknown): string {
  const kind = kindOf(value)
  if (kind === 'array') return `${(value as unknown[]).length} items`
  if (kind === 'object') return `${Object.keys(value as object).length} keys`
  if (kind === 'null') return 'null'
  const text = kind === 'string' ? (value as string) : String(value)
  const single = text.replace(/\s+/g, ' ')
  const cut = single.length > PREVIEW_LIMIT ? `${single.slice(0, PREVIEW_LIMIT)}…` : single
  return kind === 'string' ? `"${cut}"` : cut
}
