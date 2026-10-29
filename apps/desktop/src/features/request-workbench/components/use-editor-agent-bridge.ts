import { useEffect, useState, type RefObject } from 'react'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { publishEditorSelection, registerEditorHighlighter, type EditorSlot } from '../editor-bridge'
import { findEditorSearchMatches } from '../editor-search'

export interface RequestedSearch {
  text: string
  /** Changes on every request, so asking for the same text again re-runs it. */
  nonce: number
}

/** Keeps the agent informed of the editor's selection; read only at mount. */
export function editorSelectionExtension(slot: EditorSlot | undefined): Extension {
  if (!slot) return []
  return EditorView.updateListener.of((update) => {
    if (update.selectionSet || update.docChanged) publishEditorSelection(slot, update.state)
  })
}

/** Lets the agent highlight text in this editor through its search bar. */
export function useEditorAgentBridge(slot: EditorSlot | undefined, viewRef: RefObject<EditorView | null>, openSearch: () => void) {
  const [requestedSearch, setRequestedSearch] = useState<RequestedSearch | null>(null)

  useEffect(() => {
    if (!slot) return
    return registerEditorHighlighter(slot, {
      highlight(text) {
        setRequestedSearch((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }))
        openSearch()
        const view = viewRef.current
        if (!view) return 0
        return findEditorSearchMatches(view.state.doc.toString(), text, { matchCase: false, wholeWord: false, regularExpression: false }).matches.length
      },
    })
  }, [openSearch, slot, viewRef])

  return requestedSearch
}
