import { grpcCodeName } from '../request-workbench/grpc-status'
import type { FlowNodeOutputDto } from '../../bindings/get-flow-node-output'

/** A navigable output field. path follows response in a reference; null means its key or ancestor cannot be referenced because it contains a dot. */
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

/** Object/array children with reference paths. */
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

/** Parse complete valid JSON; return undefined for plain text, binary or truncated bodies. */
export function parseBody(output: FlowNodeOutputDto): unknown | undefined {
  if (output.truncated || output.bodyEncoding === 'base64') return undefined
  try {
    return JSON.parse(output.body)
  } catch {
    return undefined
  }
}

/** Reference roots: status, headers, body and gRPC fields. Captured calls use method/path instead of status. Only individual headers can be referenced. */
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
  const grpcCode = output.headers.find((header) => header.name.toLowerCase() === 'grpc-status')?.value
  const grpc = grpcCode !== undefined && /^\d+$/.test(grpcCode)
    ? { code: Number(grpcCode), codeName: grpcCodeName(Number(grpcCode)), message: output.headers.find((header) => header.name.toLowerCase() === 'grpc-message')?.value ?? '' }
    : null
  // A WebSocket step keeps how it closed in pseudo-headers (spec 0140).
  const closedBy = output.headers.find((header) => header.name.toLowerCase() === 'websocket-closed-by')?.value
  const closeCode = output.headers.find((header) => header.name.toLowerCase() === 'websocket-close-code')?.value
  const websocketMessages =
    output.body === '' ? [] : output.body.startsWith('[\n') && Array.isArray(parsed) ? parsed : [parsed === undefined ? output.body : parsed]
  return [
    ...head,
    ...(closedBy !== undefined
      ? [
          { key: 'closeCode', path: 'closeCode', value: closeCode === undefined ? null : Number(closeCode) },
          { key: 'messages', path: 'messages', value: websocketMessages },
        ]
      : []),
    ...(grpc ? [{ key: 'grpcStatus', path: 'grpcStatus', value: grpc },
      ...(parsed === undefined ? [] : [{ key: 'messages', path: 'messages', value: Array.isArray(parsed) ? parsed : [parsed] }])] : []),
    { key: 'headers', path: null, value: headers },
    { key: 'body', path: 'body', value: parsed === undefined ? output.body : parsed },
  ]
}

/** Header children use headers.<name> even when their root has no reference path. */
export function childrenOfRoot(root: OutputEntry): OutputEntry[] {
  if (root.key !== 'headers') return childEntries(root.value, root.path)
  return childEntries(root.value, 'headers')
}

/** Captured calls from Wait for call blocks use request scope. */
export function referenceFor(nodeId: string, path: string, scope: 'response' | 'request' = 'response'): string {
  return `{{nodes.${nodeId}.${scope}.${path}}}`
}

const PREVIEW_LIMIT = 80

/** Short value preview for a tree row. */
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
