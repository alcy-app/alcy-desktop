import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete'
import { Compartment, Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  comboFromEvent,
  findShortcutAction,
  isEditorAction,
  isShortcutFor,
  yieldShortcutToWorkbench,
} from '../../shared/shortcuts/shortcuts'
import type { ShortcutBindings } from '../../shared/shortcuts/shortcuts'

export type GetShortcutBindings = () => ShortcutBindings

/** Suggestions while typing: on by default. Closing the list (Esc or
 * `showSuggestions`) pauses them and opening it with `showSuggestions` resumes
 * them, in every editor until the app reloads. */
let automaticSuggestions = true

export function automaticSuggestionsEnabled(): boolean {
  return automaticSuggestions
}

const suggestionsCompartment = new Compartment()

// `defaultKeymap: false` turns CodeMirror's default keymap off for the whole
// editor (the option is combined with "and" across configurations); the keys
// kept from it are in `navigationKeymap`.
const SUGGESTIONS_ON = autocompletion({ activateOnTyping: true, defaultKeymap: false, icons: false })
const SUGGESTIONS_OFF = autocompletion({ activateOnTyping: false, defaultKeymap: false, icons: false })

const suggestionsFor = (enabled: boolean): Extension => (enabled ? SUGGESTIONS_ON : SUGGESTIONS_OFF)

function setAutomaticSuggestions(view: EditorView, enabled: boolean): void {
  automaticSuggestions = enabled
  view.dispatch({ effects: suggestionsCompartment.reconfigure(suggestionsFor(enabled)) })
}

/** Closes the open list and pauses suggestions while typing; false with no open list. */
export function dismissSuggestions(view: EditorView): boolean {
  if (completionStatus(view.state) === null) return false
  closeCompletion(view)
  setAutomaticSuggestions(view, false)
  return true
}

/** Opens the list and resumes suggestions while typing. */
export function showSuggestions(view: EditorView): boolean {
  setAutomaticSuggestions(view, true)
  return startCompletion(view)
}

/** Arrows, PageUp/PageDown and Enter (accepts the selected suggestion; with
 * no open list it breaks the line) in the suggestion list: CodeMirror's
 * default keymap without Ctrl+Space, which comes from the configurable
 * shortcuts, and with Esc pausing suggestions as it closes the list. */
const navigationKeymap = [
  { key: 'Escape', run: dismissSuggestions },
  ...completionKeymap.filter((binding) => binding.run !== startCompletion && binding.run !== closeCompletion),
]

function runCompletionShortcut(view: EditorView, event: KeyboardEvent, bindings: ShortcutBindings): boolean {
  const combo = comboFromEvent(event)
  // Closes the open list or opens it, even after it was closed.
  if (isShortcutFor(bindings, 'showSuggestions', combo)) {
    event.preventDefault()
    if (!dismissSuggestions(view)) showSuggestions(view)
    return true
  }
  // With no open suggestion the key goes on to the editor (Tab indents).
  if (isShortcutFor(bindings, 'acceptSuggestion', combo) && acceptCompletion(view)) {
    event.preventDefault()
    return true
  }
  // With Ctrl/Alt, a shortcut from outside the editors (e.g. Ctrl+Enter to
  // send) beats the editor keymap, which would consume it (Ctrl+Enter inserts
  // a line). Handling the key here stops the keymap; the mark lets the global
  // shortcut run despite the `preventDefault` CodeMirror does.
  const action = combo && (combo.ctrl || combo.alt) ? findShortcutAction(bindings, event) : null
  if (action && !isEditorAction(action)) {
    yieldShortcutToWorkbench(event)
    return true
  }
  return false
}

/**
 * Autocomplete keys of the code editors: the configurable shortcuts
 * `showSuggestions` (Ctrl+Space, opens/closes the list) and `acceptSuggestion`
 * (Tab), plus list navigation. `getBindings` is called on every key, so it
 * follows changes made in the settings without reconfiguring the editor. The suggestion sources (variables, schema,
 * scripts) come from the other extensions.
 */
export function completionShortcutsExtension(getBindings: GetShortcutBindings): Extension {
  return [
    suggestionsCompartment.of(suggestionsFor(automaticSuggestions)),
    // An editor already mounted when the choice changed in another adopts it on focus.
    EditorView.focusChangeEffect.of((state, focusing) => {
      const expected = suggestionsFor(automaticSuggestions)
      return focusing && suggestionsCompartment.get(state) !== expected ? suggestionsCompartment.reconfigure(expected) : null
    }),
    Prec.highest(
      keymap.of([{ any: (view, event) => runCompletionShortcut(view, event, getBindings()) }, ...navigationKeymap]),
    ),
  ]
}
