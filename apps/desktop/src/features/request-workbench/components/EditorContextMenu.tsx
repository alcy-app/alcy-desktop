import { useEffect, useLayoutEffect, useRef } from 'react'
import type { FocusEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@codemirror/view'
import { useLanguage } from '../../../shared/i18n/use-language'
import type { TranslationKey } from '../../../shared/i18n/translations'
import { MenuItem, MenuSeparator } from '../../../shared/ui/Menu'
import '../../../shared/ui/menu.css'
import { toggleCommentAll, toggleCommentBySelection } from '../comment-toggle'
import type { CommentScope } from '../comment-toggle'
import type { EditorMenuState } from '../editor-context-menu'

const COMMENT_LABELS: Record<CommentScope, { comment: TranslationKey; uncomment: TranslationKey }> = {
  line: { comment: 'requestBody.commentLine', uncomment: 'requestBody.uncommentLine' },
  lines: { comment: 'requestBody.commentLines', uncomment: 'requestBody.uncommentLines' },
  selection: { comment: 'requestBody.commentSelection', uncomment: 'requestBody.uncommentSelection' },
  all: { comment: 'requestBody.commentAll', uncomment: 'requestBody.uncommentAll' },
}

interface EditorContextMenuProps {
  viewRef: RefObject<EditorView | null>
  menu: EditorMenuState
  onClose: () => void
}

const VIEWPORT_MARGIN = 8

/** Copy, Paste and, when offered, comment actions for an editable CodeMirror editor, at the right-click point. */
export function EditorContextMenu({ viewRef, menu, onClose }: EditorContextMenuProps) {
  const { t } = useLanguage()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const { x, y, hasSelection, canPaste, comment } = menu

  // Kept inside the window, measured once rendered.
  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return
    const maxLeft = window.innerWidth - element.offsetWidth - VIEWPORT_MARGIN
    const maxTop = window.innerHeight - element.offsetHeight - VIEWPORT_MARGIN
    element.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(x, maxLeft))}px`
    element.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(y, maxTop))}px`
  }, [x, y])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node | null)) onClose()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  const closeAndFocusEditor = () => {
    onClose()
    viewRef.current?.focus()
  }

  const copy = async () => {
    const current = viewRef.current
    const range = current?.state.selection.main
    try {
      if (current && range && !range.empty && navigator.clipboard) {
        await navigator.clipboard.writeText(current.state.sliceDoc(range.from, range.to))
      }
    } catch {
      // Clipboard unavailable or denied: the menu just closes.
    } finally {
      closeAndFocusEditor()
    }
  }

  const paste = async () => {
    try {
      const text = navigator.clipboard ? await navigator.clipboard.readText() : ''
      // Looked up after the await: the editor may have unmounted meanwhile.
      const current = viewRef.current
      if (current && text) {
        current.dispatch(current.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true })
      }
    } catch {
      // Clipboard unavailable or denied: the menu just closes.
    } finally {
      closeAndFocusEditor()
    }
  }

  const toggleComment = () => {
    const current = viewRef.current
    if (current && comment) {
      if (comment.scope === 'all') toggleCommentAll(current)
      else toggleCommentBySelection(current)
    }
    closeAndFocusEditor()
  }

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="ui-menu ui-menu--portal rw-editor-context-menu"
      role="menu"
      aria-label={t('requestBody.contextMenuLabel')}
      style={{ left: x, top: y }}
      onBlur={closeOnBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closeAndFocusEditor()
      }}
    >
      <MenuItem label={t('requestBody.copy')} disabled={!hasSelection} autoFocus={hasSelection} onSelect={() => void copy()} />
      <MenuItem label={t('requestBody.paste')} disabled={!canPaste} autoFocus={!hasSelection && canPaste} onSelect={() => void paste()} />
      {comment && (
        <>
          <MenuSeparator />
          <MenuItem
            label={t(COMMENT_LABELS[comment.scope][comment.uncomment ? 'uncomment' : 'comment'])}
            // With nothing selected the shortcut acts on the cursor's line, not on everything.
            shortcutAction={comment.scope === 'all' ? undefined : 'toggleComment'}
            onSelect={toggleComment}
          />
        </>
      )}
    </div>,
    document.body,
  )
}
