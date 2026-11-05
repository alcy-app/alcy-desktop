import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUTS, parseCombo, type ShortcutBindings } from '../../shared/shortcuts/shortcuts'
import { commentShortcutExtension, toggleCommentBySelection } from './comment-toggle'
import { jsoncLanguageSupport } from './jsonc-language'

function editor(doc: string, selection: EditorSelection, bindings: ShortcutBindings = DEFAULT_SHORTCUTS) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [EditorState.allowMultipleSelections.of(true), jsoncLanguageSupport(), commentShortcutExtension(() => bindings)],
    }),
  })
}

const BODY = '{\n  "name": "Ana",\n  "age": 30,\n  "city": "Rio"\n}'
/** Position of `text` in BODY. */
const at = (text: string) => BODY.indexOf(text)

describe('toggleCommentBySelection', () => {
  it('comments and uncomments a single line with //', () => {
    const view = editor(BODY, EditorSelection.single(at('"age"')))
    expect(toggleCommentBySelection(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('{\n  "name": "Ana",\n  // "age": 30,\n  "city": "Rio"\n}')
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('uses a line comment for a selection inside one line', () => {
    const view = editor(BODY, EditorSelection.single(at('"age"'), at('30')))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toContain('  // "age": 30,')
    view.destroy()
  })

  it('wraps a selection across lines in a block and unwraps it', () => {
    const view = editor(BODY, EditorSelection.single(at('"name"'), at('30')))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe('{\n  /* "name": "Ana",\n  "age": 30, */\n  "city": "Rio"\n}')
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('does not count the line where the selection ends at column 0', () => {
    const view = editor(BODY, EditorSelection.single(at('  "name"'), at('  "city"')))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe('{\n  /* "name": "Ana",\n  "age": 30, */\n  "city": "Rio"\n}')
    view.destroy()
  })

  it('uncomments lines already commented one by one instead of adding a block', () => {
    const commented = '{\n  // "name": "Ana",\n  // "age": 30,\n  "city": "Rio"\n}'
    const view = editor(commented, EditorSelection.single(commented.indexOf('//'), commented.indexOf('30')))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('applies each selection its own rule in one undoable change', () => {
    const view = editor(
      BODY,
      EditorSelection.create([EditorSelection.cursor(at('"city"')), EditorSelection.range(at('"name"'), at('30'))]),
    )
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe('{\n  /* "name": "Ana",\n  "age": 30, */\n  // "city": "Rio"\n}')
    view.destroy()
  })
})

describe('commentShortcutExtension', () => {
  function press(view: EditorView, key: string) {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }))
  }

  it('comments with Ctrl+/ and Ctrl+;', () => {
    const view = editor(BODY, EditorSelection.single(at('"age"')))
    press(view, ';')
    expect(view.state.doc.toString()).toContain('// "age"')
    press(view, '/')
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('follows a reconfigured shortcut', () => {
    const combo = parseCombo('Ctrl+K')!
    const view = editor(BODY, EditorSelection.single(at('"age"')), { ...DEFAULT_SHORTCUTS, toggleComment: [combo] })
    press(view, '/')
    expect(view.state.doc.toString()).toBe(BODY)
    press(view, 'k')
    expect(view.state.doc.toString()).toContain('// "age"')
    view.destroy()
  })
})
