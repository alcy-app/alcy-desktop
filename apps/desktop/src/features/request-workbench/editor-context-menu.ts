import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { commentActionAt } from './comment-toggle'
import type { CommentAction } from './comment-toggle'

/** Where the menu opens and what the editor allowed at that moment. */
export interface EditorMenuState {
  x: number
  y: number
  hasSelection: boolean
  canPaste: boolean
  /** Comment action for the selection, when the editor accepts comments. */
  comment: CommentAction | null
}

/** Opens the editor's own context menu on right click instead of the webview's.
 * With `comments`, the menu also offers commenting what is selected. */
export function editorContextMenuExtension(open: (menu: EditorMenuState) => void, comments = false): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      event.preventDefault()
      open({
        x: event.clientX,
        y: event.clientY,
        hasSelection: !view.state.selection.main.empty,
        canPaste: !view.state.readOnly,
        comment: comments ? commentActionAt(view.state) : null,
      })
      return true
    },
  })
}
