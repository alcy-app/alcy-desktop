import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUTS, parseCombo, type ShortcutBindings } from '../../shared/shortcuts/shortcuts'
import { commentActionAt, commentShortcutExtension, toggleCommentAll, toggleCommentBySelection } from './comment-toggle'
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
/** End of the line holding `text` in BODY. */
const lineEnd = (text: string) => BODY.indexOf('\n', at(text))

describe('toggleCommentBySelection', () => {
  it('comments and uncomments a single line with //', () => {
    const view = editor(BODY, EditorSelection.single(at('"age"')))
    expect(toggleCommentBySelection(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('{\n  "name": "Ana",\n  // "age": 30,\n  "city": "Rio"\n}')
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('uses a line comment for a selection covering one whole line', () => {
    const view = editor(BODY, EditorSelection.single(at('"age"'), lineEnd('"age"')))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toContain('  // "age": 30,')
    view.destroy()
  })

  it('wraps only the selected text in a block and unwraps it', () => {
    const view = editor(BODY, EditorSelection.single(at('30'), at('30') + 2))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toContain('  "age": /* 30 */,')
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('wraps a partial selection across lines around the selected text only', () => {
    const view = editor(BODY, EditorSelection.single(at('"Ana"'), at('30') + 2))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe('{\n  "name": /* "Ana",\n  "age": 30 */,\n  "city": "Rio"\n}')
    view.destroy()
  })

  it('wraps whole lines across a selection in a block and unwraps it', () => {
    const view = editor(BODY, EditorSelection.single(at('"name"'), lineEnd('"age"')))
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
    const view = editor(commented, EditorSelection.single(commented.indexOf('//'), commented.indexOf('30,') + 3))
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('applies each selection its own rule in one undoable change', () => {
    const view = editor(
      BODY,
      EditorSelection.create([EditorSelection.cursor(at('"city"')), EditorSelection.range(at('"name"'), lineEnd('"age"'))]),
    )
    toggleCommentBySelection(view)
    expect(view.state.doc.toString()).toBe('{\n  /* "name": "Ana",\n  "age": 30, */\n  // "city": "Rio"\n}')
    view.destroy()
  })
})

describe('toggleCommentAll', () => {
  it('wraps every line in a block and unwraps it', () => {
    const view = editor(BODY, EditorSelection.single(at('"age"')))
    expect(toggleCommentAll(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(`/* ${BODY} */`)
    toggleCommentAll(view)
    expect(view.state.doc.toString()).toBe(BODY)
    view.destroy()
  })

  it('does nothing in an empty document', () => {
    const view = editor('', EditorSelection.single(0))
    expect(toggleCommentAll(view)).toBe(false)
    view.destroy()
  })
})

describe('commentActionAt', () => {
  const actionAt = (doc: string, selection: EditorSelection) => {
    const view = editor(doc, selection)
    const action = commentActionAt(view.state)
    view.destroy()
    return action
  }

  it('offers everything when nothing is selected', () => {
    expect(actionAt(BODY, EditorSelection.single(at('"age"')))).toEqual({ scope: 'all', uncomment: false })
    expect(actionAt(`/* ${BODY} */`, EditorSelection.single(0))).toEqual({ scope: 'all', uncomment: true })
  })

  it('offers the line when one whole line is selected', () => {
    expect(actionAt(BODY, EditorSelection.single(at('"age"'), lineEnd('"age"')))).toEqual({ scope: 'line', uncomment: false })
    const commented = '{\n  // "age": 30\n}'
    const line = EditorSelection.single(commented.indexOf('//'), commented.indexOf('\n}'))
    expect(actionAt(commented, line)).toEqual({ scope: 'line', uncomment: true })
  })

  it('offers the lines when several whole lines are selected', () => {
    expect(actionAt(BODY, EditorSelection.single(at('"name"'), lineEnd('"age"')))).toEqual({ scope: 'lines', uncomment: false })
  })

  it('offers the selected text for part of a line', () => {
    expect(actionAt(BODY, EditorSelection.single(at('30'), at('30') + 2))).toEqual({ scope: 'selection', uncomment: false })
    const commented = BODY.replace('30', '/* 30 */')
    const inside = commented.indexOf('30')
    expect(actionAt(commented, EditorSelection.single(inside, inside + 2))).toEqual({ scope: 'selection', uncomment: true })
  })

  it('offers nothing in a read-only editor', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: BODY, extensions: [jsoncLanguageSupport(), EditorState.readOnly.of(true)] }),
    })
    expect(commentActionAt(view.state)).toBeNull()
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
