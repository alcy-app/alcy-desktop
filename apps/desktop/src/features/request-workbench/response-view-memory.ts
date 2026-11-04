import type { StateEffect } from '@codemirror/state'
import type { EditorSearchRange, EditorSearchState } from './editor-search'

/**
 * Where the user was in a response view. Positions belong to the document
 * they were taken on, so they only apply again to a document of the same
 * length (the same formatted body).
 */
export interface ResponseViewMemory {
  docLength: number
  /** `EditorView.scrollSnapshot()`: top visible position and its offset, independent of pixel estimates. */
  scroll: StateEffect<unknown> | null
  selection: { anchor: number; head: number }
  folds: EditorSearchRange[]
  search: EditorSearchState
}

/**
 * Response views unmount on every tab switch. This in-memory cache — never
 * persisted — lets the view of a tab pick up where it was. Keys carry the
 * tab and the send, so a new send starts fresh; the oldest entries are
 * dropped past the limit, which covers closed tabs.
 */
const MAX_ENTRIES = 64
const entries = new Map<string, ResponseViewMemory>()

export function rememberResponseView(key: string, memory: ResponseViewMemory): void {
  entries.delete(key)
  entries.set(key, memory)
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function recallResponseView(key: string): ResponseViewMemory | null {
  return entries.get(key) ?? null
}

export function resetResponseViewMemoryForTests(): void {
  entries.clear()
}
