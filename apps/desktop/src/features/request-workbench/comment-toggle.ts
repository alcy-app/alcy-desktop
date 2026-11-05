import { lineUncomment, toggleBlockCommentByLine, toggleComment } from '@codemirror/commands'
import {
  EditorSelection,
  Prec,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state'
import { keymap, type Command } from '@codemirror/view'
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
 * Comments or uncomments by selection (spec 0146): within one line, a line
 * comment (`//`); across several lines, a block (`/* *\/`) around the whole
 * lines — or, when they are all line comments already, those are removed.
 * Each selection follows its own rule; all changes go in one transaction.
 */
export const toggleCommentBySelection: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false
  const ranges = state.selection.ranges
  const changes = [
    ...changesFor(state, ranges.filter((range) => !spansLines(state, range)), toggleComment),
    ...changesFor(state, ranges.filter((range) => spansLines(state, range)), toggleLinesComment),
  ]
  if (changes.length === 0) return false
  const changeSet = state.changes(changes)
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, 1),
    scrollIntoView: true,
    userEvent: 'input.comment',
  })
  return true
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
