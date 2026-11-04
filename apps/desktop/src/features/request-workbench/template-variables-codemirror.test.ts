import { CompletionContext, completionStatus, startCompletion } from '@codemirror/autocomplete'
import type { CompletionResult } from '@codemirror/autocomplete'
import { json } from '@codemirror/lang-json'
import { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { translate } from '../../shared/i18n/translations'
import { DEFAULT_SHORTCUTS } from '../../shared/shortcuts/shortcuts'
import { completionShortcutsExtension } from './completion-shortcuts'
import {
  environmentVariablesExtension,
  setEnvironmentVariables,
  templateVariableCompletionSource,
  variableRangesFor,
  variablesField,
} from './template-variables-codemirror'

const VARIABLES: EnvironmentVariableDto[] = [
  { name: 'token', value: 'abc123', sensitive: false },
  { name: 'secret', value: 's3cr3t', sensitive: true },
]

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('pt-BR', key, params)

function complete(doc: string, pos = doc.length, variables = VARIABLES): CompletionResult | null {
  const state = EditorState.create({ doc, extensions: [variablesField] }).update({
    effects: setEnvironmentVariables.of(variables),
  }).state
  return templateVariableCompletionSource(() => t)(new CompletionContext(state, pos, false)) as CompletionResult | null
}

describe('variableRangesFor', () => {
  it('encontra os placeholders fechados, com nome aparado, e ignora {{ sem fechamento', () => {
    expect(variableRangesFor('a {{ token }} b {{nope', VARIABLES)).toEqual([{ from: 2, to: 13, name: 'token', known: true }])
  })

  it('marca como desconhecida uma variável fora do ambiente', () => {
    expect(variableRangesFor('{{x}}', VARIABLES)).toEqual([{ from: 0, to: 5, name: 'x', known: false }])
  })
})

describe('templateVariableCompletionSource', () => {
  it('sugere as variáveis logo depois de {{', () => {
    const result = complete('Bearer {{')
    expect(result?.from).toBe(9)
    expect(result?.options.map((option) => option.label)).toEqual(['token', 'secret'])
  })

  it('continua sugerindo enquanto o nome é digitado', () => {
    const result = complete('{"auth": "{{to')
    expect(result?.from).toBe(12)
    expect(result?.validFor instanceof RegExp && result.validFor.test('to')).toBe(true)
  })

  it('não sugere fora de um {{ aberto', () => {
    expect(complete('{{token}} x')).toBeNull()
    expect(complete('texto')).toBeNull()
  })

  it('não sugere sem variáveis no ambiente', () => {
    expect(complete('{{', 2, [])).toBeNull()
  })

  it('insere o fechamento }} só quando ele ainda não existe', () => {
    expect(complete('{{')?.options[0].apply).toBe('token}}')
    expect(complete('{{}}', 2)?.options[0].apply).toBe('token')
  })

  it('marca variáveis sensíveis e mascara o valor na descrição', () => {
    const secret = complete('{{')?.options.find((option) => option.label === 'secret')
    expect(secret?.detail).toBe('Sens.')
    expect(secret?.info).toBe('secret = ••••••••')
  })
})

describe('aceitar sugestão no editor', () => {
  async function openCompletion(doc: string) {
    const view = new EditorView({
      state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [completionShortcutsExtension(() => DEFAULT_SHORTCUTS), environmentVariablesExtension(() => t)] }),
    })
    view.dispatch({ effects: setEnvironmentVariables.of(VARIABLES) })
    startCompletion(view)
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
    return view
  }

  it('Tab insere a variável selecionada', async () => {
    const view = await openCompletion('{"auth": "{{to')
    // O CodeMirror ignora a aceitação logo após abrir a lista (interactionDelay).
    await vi.waitFor(() => {
      expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Tab' }), 'editor')).toBe(true)
    })

    expect(view.state.doc.toString()).toBe('{"auth": "{{token}}')
    view.destroy()
  })

  it('clicar numa sugestão a insere', async () => {
    const view = await openCompletion('{{se')
    const option = await vi.waitFor(() => {
      const item = Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li')).find((li) => li.textContent?.includes('secret'))
      expect(item).toBeDefined()
      return item as HTMLElement
    })
    await vi.waitFor(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      expect(view.state.doc.toString()).toBe('{{secret}}')
    })
    view.destroy()
  })
})

describe('environmentVariablesExtension', () => {
  it('destaca {{variável}} conhecida e indefinida no editor', () => {
    const view = new EditorView({
      doc: '{"a": "{{token}}", "b": "{{missing}}"}',
      extensions: [json(), environmentVariablesExtension(() => t)],
    })
    view.dispatch({ effects: setEnvironmentVariables.of(VARIABLES) })

    expect(view.dom.querySelector('.var-token--known')).toHaveTextContent('{{token}}')
    expect(view.dom.querySelector('.var-token--unknown')).toHaveTextContent('{{missing}}')
    view.destroy()
  })

  it('mutes the braces inside the token, keeping the token in one piece', () => {
    const view = new EditorView({ doc: '{"a": "{{token}}"}', extensions: [json(), environmentVariablesExtension(() => t)] })
    view.dispatch({ effects: setEnvironmentVariables.of(VARIABLES) })

    const token = view.dom.querySelector('.var-token--known') as HTMLElement
    expect(token).toHaveTextContent('{{token}}')
    expect([...token.querySelectorAll('.var-token-brace')].map((brace) => brace.textContent)).toEqual(['{{', '}}'])
    view.destroy()
  })

  it('marks the token holding the cursor and the one covered by the selection', () => {
    // `{{token}}` spans 7..16, `{{missing}}` 24..35.
    const view = new EditorView({
      doc: '{"a": "{{token}}", "b": "{{missing}}"}',
      extensions: [json(), environmentVariablesExtension(() => t)],
    })
    view.dispatch({ effects: setEnvironmentVariables.of(VARIABLES) })
    const known = () => view.dom.querySelector('.var-token--known') as HTMLElement
    const unknown = () => view.dom.querySelector('.var-token--unknown') as HTMLElement

    view.dispatch({ selection: { anchor: 10 } })
    expect(known()).toHaveClass('var-token--active')
    expect(unknown()).not.toHaveClass('var-token--active')

    // Right after `}}` the cursor is no longer editing the variable.
    view.dispatch({ selection: { anchor: 16 } })
    expect(known()).not.toHaveClass('var-token--active')

    view.dispatch({ selection: { anchor: 3, head: 12 } })
    expect(known()).toHaveClass('var-token--selected')
    expect(unknown()).not.toHaveClass('var-token--selected')
    view.destroy()
  })
})
