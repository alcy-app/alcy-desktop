import { lineUncomment, toggleBlockComment, toggleBlockCommentByLine, toggleComment } from '@codemirror/commands'
import {
  EditorSelection,
  Prec,
  type ChangeSet,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state'
import { keymap, type Command, type EditorView } from '@codemirror/view'
import { comboFromEvent, isShortcutFor } from '../../shared/shortcuts/shortcuts'
import type { GetShortcutBindings } from './completion-shortcuts'

/** Where the selection's last line is: a selection ending at the start of a
 * line does not count that line (CodeMirror's convention). */
function lastLineEnd(state: EditorState, range: SelectionRange): number {
  return range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to
}

/** The selection reaches more than one line. */
function spansLines(state: EditorState, range: SelectionRange): boolean {
  return state.doc.lineAt(lastLineEnd(state, range)).number > state.doc.lineAt(range.from).number
}

/** Every non-blank line the ranges cover starts with the line comment token. */
function allLinesCommented(state: EditorState, ranges: readonly SelectionRange[]): boolean {
  for (const range of ranges) {
    const token = state.languageDataAt<{ line?: string }>('commentTokens', range.from)[0]?.line
    if (!token) return false
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(lastLineEnd(state, range)).number
    for (let number = first; number <= last; number++) {
      const text = state.doc.line(number).text.trimStart()
      if (text !== '' && !text.startsWith(token)) return false
    }
  }
  return true
}

/** The selection covers its lines whole: only indentation before it and only
 * spaces after it, on the lines it reaches. */
function coversWholeLines(state: EditorState, range: SelectionRange): boolean {
  if (range.empty) return false
  const end = lastLineEnd(state, range)
  return state.sliceDoc(state.doc.lineAt(range.from).from, range.from).trim() === '' && state.sliceDoc(end, state.doc.lineAt(end).to).trim() === ''
}

/** Several lines: unwrap lines already commented one by one, otherwise toggle a block around them. */
const toggleLinesComment: StateCommand = (target) =>
  allLinesCommented(target.state, target.state.selection.ranges) ? lineUncomment(target) : toggleBlockCommentByLine(target)

/** The changes `command` would make with only `ranges` selected. */
function changesFor(state: EditorState, ranges: readonly SelectionRange[], command: StateCommand): ChangeSpec[] {
  if (ranges.length === 0) return []
  const specs: ChangeSpec[] = []
  const scoped = state.update({ selection: EditorSelection.create(ranges) }).state
  command({
    state: scoped,
    dispatch: (tr) => tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => specs.push({ from, to, insert: inserted })),
  })
  return specs
}

/**
 * The changes that comment or uncomment `ranges` (spec 0146), each by its own
 * rule: the cursor's line, or one whole line, gets a line comment (`//`);
 * several whole lines get a block (`/* *\/`) around them — or, when they are
 * all line comments already, those are removed; part of the text gets a block
 * around exactly the selected text.
 */
function commentChanges(state: EditorState, ranges: readonly SelectionRange[]): ChangeSet | null {
  if (state.readOnly) return null
  const wholeLines = ranges.filter((range) => coversWholeLines(state, range))
  const changes = [
    ...changesFor(state, ranges.filter((range) => range.empty), toggleComment),
    ...changesFor(state, wholeLines.filter((range) => !spansLines(state, range)), toggleComment),
    ...changesFor(state, wholeLines.filter((range) => spansLines(state, range)), toggleLinesComment),
    ...changesFor(state, ranges.filter((range) => !range.empty && !coversWholeLines(state, range)), toggleBlockComment),
  ]
  return changes.length === 0 ? null : state.changes(changes)
}

/** The whole document, as one selection of all its lines. */
function wholeDocument(state: EditorState): SelectionRange[] {
  return state.doc.length === 0 ? [] : [EditorSelection.range(0, state.doc.length)]
}

function applyComment(view: EditorView, ranges: readonly SelectionRange[]): boolean {
  const { state } = view
  const changeSet = commentChanges(state, ranges)
  if (!changeSet) return false
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, 1),
    scrollIntoView: true,
    userEvent: 'input.comment',
  })
  return true
}

/** Comments or uncomments each selection by its rule; all changes go in one transaction. */
export const toggleCommentBySelection: Command = (view) => applyComment(view, view.state.selection.ranges)

/** Comments or uncomments the whole document, as if all its lines were selected. */
export const toggleCommentAll: Command = (view) => applyComment(view, wholeDocument(view.state))

/** What commenting covers: the selected lines, the selected text, or everything when nothing is selected. */
export type CommentScope = 'line' | 'lines' | 'selection' | 'all'

export interface CommentAction {
  scope: CommentScope
  /** Running it removes comments instead of adding them. */
  uncomment: boolean
}

/**
 * The comment action the context menu offers for the current selection, or
 * `null` when there is none (read-only editor, language without comments,
 * empty document). With nothing selected it covers the whole document.
 */
export function commentActionAt(state: EditorState): CommentAction | null {
  const ranges = state.selection.ranges
  const nothingSelected = ranges.every((range) => range.empty)
  const changeSet = commentChanges(state, nothingSelected ? wholeDocument(state) : ranges)
  if (!changeSet) return null
  let inserts = false
  changeSet.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.length > 0) inserts = true
  })
  const selected = ranges.filter((range) => !range.empty)
  const scope: CommentScope = nothingSelected
    ? 'all'
    : selected.some((range) => !coversWholeLines(state, range))
      ? 'selection'
      : selected.some((range) => spansLines(state, range))
        ? 'lines'
        : 'line'
  return { scope, uncomment: !inserts }
}

/** The configurable `toggleComment` shortcut (Ctrl+/ and Ctrl+; by default).
 * `getBindings` is read on every key, so changes in the settings apply at once. */
export function commentShortcutExtension(getBindings: GetShortcutBindings): Extension {
  return Prec.high(
    keymap.of([
      {
        any: (view, event) => {
          if (!isShortcutFor(getBindings(), 'toggleComment', comboFromEvent(event))) return false
          event.preventDefault()
          toggleCommentBySelection(view)
          return true
        },
      },
    ]),
  )
}
