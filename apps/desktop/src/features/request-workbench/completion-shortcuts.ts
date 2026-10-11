import { acceptCompletion, autocompletion, closeCompletion, completionKeymap, startCompletion } from '@codemirror/autocomplete'
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

/** Sugestões automáticas ao digitar: ligadas por padrão; o atalho
 * `toggleSuggestions` alterna. A escolha vale para todos os editores até
 * recarregar o app. */
let automaticSuggestions = true

export function automaticSuggestionsEnabled(): boolean {
  return automaticSuggestions
}

const suggestionsCompartment = new Compartment()

// `defaultKeymap: false` desliga o keymap padrão do CodeMirror em todo o
// editor (a opção é combinada com "e" entre as configurações), inclusive o
// Enter que aceitaria a sugestão: aqui Enter sempre quebra a linha.
const SUGGESTIONS_ON = autocompletion({ activateOnTyping: true, defaultKeymap: false, icons: false })
const SUGGESTIONS_OFF = autocompletion({ activateOnTyping: false, defaultKeymap: false, icons: false })

const suggestionsFor = (enabled: boolean): Extension => (enabled ? SUGGESTIONS_ON : SUGGESTIONS_OFF)

/** Liga/desliga as sugestões automáticas neste editor (e nos próximos). */
export function toggleAutomaticSuggestions(view: EditorView): boolean {
  automaticSuggestions = !automaticSuggestions
  if (!automaticSuggestions) closeCompletion(view)
  view.dispatch({ effects: suggestionsCompartment.reconfigure(suggestionsFor(automaticSuggestions)) })
  return true
}

/** Setas, PageUp/PageDown e Esc da lista de sugestões: o keymap padrão do
 * CodeMirror sem Enter (aceitaria a sugestão) e sem Ctrl+Espaço (abriria a
 * lista; aqui os dois vêm dos atalhos configuráveis). */
const navigationKeymap = completionKeymap.filter((binding) => binding.key !== 'Enter' && binding.run !== startCompletion)

function runCompletionShortcut(view: EditorView, event: KeyboardEvent, bindings: ShortcutBindings): boolean {
  const combo = comboFromEvent(event)
  if (isShortcutFor(bindings, 'toggleSuggestions', combo)) {
    event.preventDefault()
    return toggleAutomaticSuggestions(view)
  }
  // Sem sugestão aberta a tecla segue para o editor (Tab indenta).
  if (isShortcutFor(bindings, 'acceptSuggestion', combo) && acceptCompletion(view)) {
    event.preventDefault()
    return true
  }
  // Com Ctrl/Alt, um atalho de fora dos editores (ex.: Ctrl+Enter para
  // enviar) vence o keymap do editor, que o consumiria (Ctrl+Enter insere
  // linha). Tratar a tecla aqui impede o keymap; a marca deixa o atalho
  // global agir mesmo com o `preventDefault` que o CodeMirror faz.
  const action = combo && (combo.ctrl || combo.alt) ? findShortcutAction(bindings, event) : null
  if (action && !isEditorAction(action)) {
    yieldShortcutToWorkbench(event)
    return true
  }
  return false
}

/**
 * Teclas do autocompletar dos editores de código: os atalhos configuráveis
 * `acceptSuggestion` (Tab) e `toggleSuggestions` (Ctrl+Espaço), mais a
 * navegação da lista. `getBindings` é chamado a cada tecla, então acompanha
 * as mudanças feitas nas configurações sem reconfigurar o editor. As fontes
 * de sugestão (variáveis, schema, scripts) vêm das outras extensões.
 */
export function completionShortcutsExtension(getBindings: GetShortcutBindings): Extension {
  return [
    suggestionsCompartment.of(suggestionsFor(automaticSuggestions)),
    // Um editor já montado quando a escolha mudou em outro a adota ao ganhar foco.
    EditorView.focusChangeEffect.of((state, focusing) => {
      const expected = suggestionsFor(automaticSuggestions)
      return focusing && suggestionsCompartment.get(state) !== expected ? suggestionsCompartment.reconfigure(expected) : null
    }),
    Prec.highest(
      keymap.of([{ any: (view, event) => runCompletionShortcut(view, event, getBindings()) }, ...navigationKeymap]),
    ),
  ]
}
