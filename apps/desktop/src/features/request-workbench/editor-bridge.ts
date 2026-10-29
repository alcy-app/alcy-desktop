import { useSyncExternalStore } from 'react'
import type { EditorState } from '@codemirror/state'

/** Request fields with a code editor. */
export type EditorField = 'body' | 'query' | 'variables' | 'preRequestScript' | 'postResponseScript'
/** Editors the agent can point at: the request fields and the response body. */
export type EditorSlot = EditorField | 'response'

export interface EditorHighlighter {
  /** Highlights every occurrence of `text` in the search bar; returns how many there are. */
  highlight(text: string): number
}

export interface EditorSelection {
  slot: EditorSlot
  text: string
}

/** Selected text kept for the agent; longer selections are cut. */
export const MAX_EDITOR_SELECTION_CHARS = 8000

// Only one editor per slot is mounted at a time (the active tab's), so the
// registry is keyed by slot. It lives outside React: editors register on
// mount and the agent host reads it on demand (ADR 0064).
const highlighters = new Map<EditorSlot, EditorHighlighter>()
const revealers = new Map<EditorSlot, () => void>()
let selection: EditorSelection | null = null
const selectionListeners = new Set<() => void>()

export function registerEditorHighlighter(slot: EditorSlot, highlighter: EditorHighlighter): () => void {
  highlighters.set(slot, highlighter)
  return () => {
    if (highlighters.get(slot) === highlighter) highlighters.delete(slot)
    if (selection?.slot === slot) setSelection(null)
  }
}

export function editorHighlighter(slot: EditorSlot): EditorHighlighter | undefined {
  return highlighters.get(slot)
}

/** Panels that show one of several editors (response tabs, the two scripts)
 * switch to the slot's editor when asked, so it mounts. */
export function registerEditorRevealer(slot: EditorSlot, reveal: () => void): () => void {
  revealers.set(slot, reveal)
  return () => {
    if (revealers.get(slot) === reveal) revealers.delete(slot)
  }
}

export function revealEditor(slot: EditorSlot) {
  revealers.get(slot)?.()
}

function setSelection(next: EditorSelection | null) {
  if (next?.slot === selection?.slot && next?.text === selection?.text) return
  selection = next
  for (const listener of selectionListeners) listener()
}

/** Called by editors when their selection changes; an empty one clears it. */
export function publishEditorSelection(slot: EditorSlot, state: EditorState) {
  const range = state.selection.main
  const text = range.empty ? '' : state.sliceDoc(range.from, range.to).slice(0, MAX_EDITOR_SELECTION_CHARS)
  if (text.trim() !== '') setSelection({ slot, text })
  else if (selection?.slot === slot) setSelection(null)
}

export function currentEditorSelection(): EditorSelection | null {
  return selection
}

function subscribe(listener: () => void) {
  selectionListeners.add(listener)
  return () => {
    selectionListeners.delete(listener)
  }
}

/** The latest non-empty selection in a request or response editor. */
export function useEditorSelection(): EditorSelection | null {
  return useSyncExternalStore(subscribe, currentEditorSelection, currentEditorSelection)
}
