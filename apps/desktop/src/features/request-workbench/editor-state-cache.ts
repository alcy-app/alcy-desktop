import { EditorState, StateEffect } from '@codemirror/state'
import type { Extension } from '@codemirror/state'

/** Editors kept at once; the oldest is dropped first. */
const MAX_SAVED_EDITORS = 24

const savedStates = new Map<string, EditorState>()

/**
 * The editor state for a mount: the one saved under `key` by
 * `saveEditorState`, reconfigured with this mount's `extensions`, when its
 * text is still `doc`; a new state otherwise. Switching between a request's
 * sections or tabs unmounts its editors, and a new state would lose their
 * undo history. The history field is shared by every `history()` extension,
 * so reconfiguring keeps it, along with the selection.
 *
 * A different text means the content changed while the editor was unmounted
 * (another request opened in the tab, an import): its history would undo into
 * text that never was in this editor, so it starts over.
 */
export function restoreEditorState(key: string | undefined, doc: string, extensions: Extension): EditorState {
  const saved = key === undefined ? undefined : savedStates.get(key)
  if (saved && saved.doc.length === doc.length && saved.doc.toString() === doc) {
    return saved.update({ effects: StateEffect.reconfigure.of(extensions) }).state
  }
  return EditorState.create({ doc, extensions })
}

/** Keeps `state` for the next mount under `key` (see `restoreEditorState`). */
export function saveEditorState(key: string | undefined, state: EditorState): void {
  if (key === undefined) return
  savedStates.delete(key)
  savedStates.set(key, state)
  while (savedStates.size > MAX_SAVED_EDITORS) {
    const oldest = savedStates.keys().next().value
    if (oldest === undefined) break
    savedStates.delete(oldest)
  }
}

/** Test helper: forgets every saved editor. */
export function clearSavedEditorStates(): void {
  savedStates.clear()
}
