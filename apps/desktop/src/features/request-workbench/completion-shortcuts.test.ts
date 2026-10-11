import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import { defaultKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SHORTCUTS, isShortcutEventConsumed, type ShortcutBindings } from '../../shared/shortcuts/shortcuts'
import {
  automaticSuggestionsEnabled,
  completionShortcutsExtension,
  toggleAutomaticSuggestions,
} from './completion-shortcuts'
import { scriptCompletionExtension } from './script-completions'

function scriptEditor(doc: string, bindings: ShortcutBindings = DEFAULT_SHORTCUTS) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        completionShortcutsExtension(() => bindings),
        keymap.of(defaultKeymap),
        javascript(),
        scriptCompletionExtension('pre'),
      ],
    }),
  })
}

async function openSuggestions(view: EditorView) {
  startCompletion(view)
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  // O CodeMirror ignora a aceitação logo após abrir a lista (interactionDelay).
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const press = (view: EditorView, key: string, init: KeyboardEventInit = {}) =>
  runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...init }), 'editor')

describe('teclas do autocompletar', () => {
  it('Tab aceita a sugestão selecionada', async () => {
    const view = scriptEditor('al.envi')
    await openSuggestions(view)

    expect(press(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('al.environment')
    view.destroy()
  })

  it('Enter quebra a linha em vez de aceitar a sugestão', async () => {
    const view = scriptEditor('al.envi')
    await openSuggestions(view)

    press(view, 'Enter')
    expect(view.state.doc.toString()).toBe('al.envi\n')
    view.destroy()
  })

  it('segue o atalho configurado para aceitar', async () => {
    const view = scriptEditor('al.envi', { ...DEFAULT_SHORTCUTS, acceptSuggestion: [{ ctrl: false, alt: false, shift: false, key: 'F4' }] })
    await openSuggestions(view)

    expect(press(view, 'Tab')).toBe(false)
    expect(press(view, 'F4')).toBe(true)
    expect(view.state.doc.toString()).toBe('al.environment')
    view.destroy()
  })

  it('Ctrl+Espaço desliga e religa as sugestões automáticas, fechando a lista aberta', async () => {
    const view = scriptEditor('al.envi')
    await openSuggestions(view)

    expect(automaticSuggestionsEnabled()).toBe(true)
    expect(press(view, ' ', { ctrlKey: true })).toBe(true)
    expect(automaticSuggestionsEnabled()).toBe(false)
    expect(completionStatus(view.state)).toBeNull()

    expect(press(view, ' ', { ctrlKey: true })).toBe(true)
    expect(automaticSuggestionsEnabled()).toBe(true)
    view.destroy()
  })

  it('um editor já montado adota a escolha feita em outro ao ganhar foco', () => {
    const first = scriptEditor('')
    const second = scriptEditor('')
    const focusEffects = () =>
      second.state.facet(EditorView.focusChangeEffect).flatMap((effect) => effect(second.state, true) ?? [])

    toggleAutomaticSuggestions(first)
    expect(focusEffects()).toHaveLength(1)
    second.dispatch({ effects: focusEffects() })
    expect(focusEffects()).toHaveLength(0)

    toggleAutomaticSuggestions(second)
    expect(automaticSuggestionsEnabled()).toBe(true)
    first.destroy()
    second.destroy()
  })

  it('cede Ctrl+Enter ao atalho de enviar em vez de inserir uma linha', () => {
    const view = scriptEditor('a')
    const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true })

    expect(runScopeHandlers(view, event, 'editor')).toBe(true)
    event.preventDefault()
    expect(view.state.doc.toString()).toBe('a')
    expect(isShortcutEventConsumed(event)).toBe(false)
    view.destroy()
  })

  it('sem o atalho global, Ctrl+Enter segue para o editor', () => {
    const view = scriptEditor('a', { ...DEFAULT_SHORTCUTS, sendRequest: [{ ctrl: false, alt: false, shift: false, key: 'Enter' }] })
    const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true })

    runScopeHandlers(view, event, 'editor')
    expect(view.state.doc.toString()).toBe('a\n')
    view.destroy()
  })
})
