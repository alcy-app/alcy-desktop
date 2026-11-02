import { indexJsonValues } from './json-value-index'
import type { JsonPathSegment } from './json-value-index'

/** Same limit as the backend (`MAX_MONITOR_CANDIDATES`): above it the evaluation is truncated and the user warned. */
export const MAX_MONITOR_CANDIDATES = 10_000

/** Primitive value (or empty array) of the document that may interest a monitor, with the range it takes in the text. */
export interface MonitorCandidate {
  from: number
  to: number
  path: JsonPathSegment[]
  /** JSON literal as it appears in the text (`"Ana"`, `12.5`, `null`, `[]`). */
  literal: string
}

export interface MonitorCandidates {
  candidates: MonitorCandidate[]
  truncated: boolean
}

/** Last key of a configured field (`items[].name` → `name`), as the backend matches it. */
export function lastFieldKey(field: string): string {
  const segments = field.split('.')
  return segments[segments.length - 1].trim().replace(/\[\]$/, '').trim()
}

/** Last key in a value's path; the indices after it point to items of the array stored there. */
function lastPathKey(path: readonly JsonPathSegment[]): string | undefined {
  for (let index = path.length - 1; index >= 0; index--) {
    const segment = path[index]
    if (typeof segment === 'string') return segment
  }
  return undefined
}

/**
 * Cheap pre-filter before the IPC: only values whose last key is used by
 * some monitored field (the key's own value or items of the array stored in
 * it, empty arrays included). Full matching (path suffix) and the rules stay
 * in the backend. A document that isn't valid JSON has no candidates.
 */
export function monitorCandidates(text: string, lastKeys: readonly string[]): MonitorCandidates {
  const keys = new Set(lastKeys)
  if (keys.size === 0) return { candidates: [], truncated: false }
  const candidates: MonitorCandidate[] = []
  let truncated = false
  for (const value of indexJsonValues(text, { emptyArrays: true })) {
    const last = lastPathKey(value.path)
    if (last === undefined || !keys.has(last)) continue
    if (candidates.length === MAX_MONITOR_CANDIDATES) {
      truncated = true
      break
    }
    candidates.push({ from: value.from, to: value.to, path: value.path, literal: text.slice(value.from, value.to) })
  }
  return { candidates, truncated }
}
