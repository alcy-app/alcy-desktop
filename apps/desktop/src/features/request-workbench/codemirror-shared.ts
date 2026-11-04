import { EditorView, ViewPlugin, keymap, lineNumbers, tooltips, type Command } from '@codemirror/view'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { indentLess, indentMore } from '@codemirror/commands'
import { HighlightStyle, indentUnit } from '@codemirror/language'
import { json as jsonLanguage } from '@codemirror/lang-json'
import { xml as xmlLanguage } from '@codemirror/lang-xml'
import { javascript as javascriptLanguage } from '@codemirror/lang-javascript'
import { tags } from '@lezer/highlight'

export type CodeLanguage = 'json' | 'xml' | 'javascript' | 'html' | 'none'

/** Matches JSON/XML token colors in request-workbench.css. CSS variables injected through EditorView.theme follow theme changes for both request and response editors. */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.propertyName, tags.tagName], color: 'var(--accent-strong)', fontWeight: 600 },
  { tag: [tags.string, tags.attributeValue], color: 'var(--success)' },
  { tag: tags.number, color: 'var(--warning)' },
  { tag: [tags.bool, tags.null, tags.keyword, tags.atom], color: 'var(--accent)' },
  { tag: tags.attributeName, color: 'var(--accent)' },
  { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.angleBracket, tags.meta, tags.processingInstruction], color: 'var(--text-muted)' },
])

export const codeEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-code)',
  },
  '.cm-content': { padding: 0 },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  // Remove the default CodeMirror tooltip box; variable preview cards style themselves through .var-preview (variable-preview.ts and template-highlight.css).
  '.cm-tooltip': { backgroundColor: 'transparent', border: 'none' },
})

/** Shared request/response editor interactions: consistent selection contrast and clickable line gutters. */
export const interactiveCodeEditorTheme = EditorView.theme(
  {
    '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--selection-bg)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      cursor: 'pointer',
    },
    '.cm-lineNumbers .cm-gutterElement:hover': {
      color: 'var(--text-heading)',
      backgroundColor: 'var(--surface-raised)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--accent-soft)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--accent-softer)',
    },
  },
)

/** Line numbers also act as a selection gutter. */
export function selectableLineNumbers() {
  return lineNumbers({
    domEventHandlers: {
      mousedown(editor, block, event) {
        if (!(event instanceof MouseEvent) || event.button !== 0) return false
        event.preventDefault()
        const gutterElement = event.target instanceof Element ? event.target.closest('.cm-gutterElement') : null
        const clickedLineNumber = Number(gutterElement?.textContent)
        const line = Number.isInteger(clickedLineNumber) && clickedLineNumber >= 1 && clickedLineNumber <= editor.state.doc.lines
          ? editor.state.doc.line(clickedLineNumber)
          : editor.state.doc.lineAt(block.from)
        editor.dispatch({
          selection: { anchor: line.from, head: line.to },
          scrollIntoView: true,
        })
        editor.focus()
        return true
      },
    },
  })
}

/** Reserve two digits in the line gutter so text does not shift as the document grows. The 12px matches horizontal gutter padding in codeEditorTheme (border-box). */
export const twoDigitLineNumbersTheme = EditorView.theme({
  '.cm-lineNumbers .cm-gutterElement': { minWidth: 'calc(2ch + 12px)' },
})

/** Editable request editors only. Define the caret in the CodeMirror theme so the injected base theme cannot restore a black border on focus. */
export const editableCodeEditorTheme = EditorView.theme(
  {
    '&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor': {
      borderLeft: '2px solid var(--caret)',
      marginLeft: '-1px',
    },
    '.cm-dropCursor': {
      borderLeft: '2px solid var(--caret)',
      marginLeft: '-1px',
    },
  },
)

/** Tab inserts one indentation unit without a selection, or indents selected lines. */
export const insertIndentOrIndentMore: Command = (view) => {
  if (view.state.selection.ranges.some((range) => !range.empty)) return indentMore(view)
  view.dispatch(view.state.replaceSelection(view.state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input' })
  return true
}

/** Tab/Shift+Tab indent editable code; Escape followed by Tab still leaves the editor (CodeMirror focus mode). */
export const tabIndentKeymap = keymap.of([
  { key: 'Tab', run: insertIndentOrIndentMore, shift: indentLess },
])

export function languageExtensionFor(language: CodeLanguage): Extension {
  if (language === 'json') return jsonLanguage()
  if (language === 'xml') return xmlLanguage()
  if (language === 'javascript') return javascriptLanguage()
  if (language === 'html') return lazyLanguageExtension(loadHtmlLanguage)
  return []
}

// HTML includes embedded CSS and JavaScript support; load its chunk once, only for HTML responses.
let htmlLanguageModule: Promise<typeof import('@codemirror/lang-html')> | null = null
function loadHtmlLanguage(): Promise<Extension> {
  htmlLanguageModule ??= import('@codemirror/lang-html')
  return htmlLanguageModule.then((module) => module.html())
}

/** Load languages on demand. Apply highlighting when ready unless the extension was removed or the editor destroyed. */
function lazyLanguageExtension(load: () => Promise<Extension>): Extension {
  const compartment = new Compartment()
  return [
    compartment.of([]),
    ViewPlugin.define((view) => {
      let active = true
      void load().then((extension) => {
        if (active) view.dispatch({ effects: compartment.reconfigure(extension) })
      })
      return {
        destroy() {
          active = false
        },
      }
    }),
  ]
}

/** Auto-close pairs from the active language data. Backspace removes an empty pair; typing an existing closing character skips it. High precedence overrides defaultKeymap Backspace. */
export function autoCloseBracketsExtension(): Extension {
  return [closeBrackets(), Prec.high(keymap.of(closeBracketsKeymap))]
}

/** GraphQL has no language package here; supply its pairs explicitly, excluding single quotes. */
export function graphqlAutoCloseExtension(): Extension {
  return [
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '"'] } }]),
    autoCloseBracketsExtension(),
  ]
}

/** Attach editor tooltips to document.body so overflow-hidden panels cannot clip completions, descriptions or variable previews. */
export function floatingTooltips(): Extension {
  return tooltips({ parent: document.body })
}

/** CodeMirror completion list for scripts and environment variable suggestions. */
export const completionTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--surface-overlay)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-md)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--selection-bg)',
    color: 'var(--text)',
  },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionInfo': {
    backgroundColor: 'var(--surface-overlay)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-sans)',
    padding: '4px 8px',
    // CodeMirror caps the box at 400px but only wraps at spaces: a long
    // variable name (`name = value`) would run past the border.
    overflowWrap: 'anywhere',
  },
})
