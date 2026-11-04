import { autocompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, closeHoverTooltips, hoverTooltip } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { completionTheme, floatingTooltips } from './codemirror-shared'
import { describeVariable, findOpenTemplateQuery } from './template-highlight'
import type { Translate } from './template-highlight'
import { VariablePreviewCard } from './components/VariablePreviewCard'
import type { VariableEditing } from './variable-editing-context'

/** Troca as variáveis do ambiente ativo conhecidas pelo editor (destaque, tooltip e sugestões). */
export const setEnvironmentVariables = StateEffect.define<EnvironmentVariableDto[]>()

export const variablesField = StateField.define<EnvironmentVariableDto[]>({
  create: () => [],
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setEnvironmentVariables)) return effect.value
    }
    return value
  },
})

export interface VariableRange {
  from: number
  to: number
  name: string
  known: boolean
}

/**
 * Intervalos `{{nome}}` do documento — mesma regra de `parseTemplate` (e do
 * resolvedor real, `alcy_app::resolve_variables`): `{{` sem `}}` correspondente
 * fica literal. Varre com `indexOf` em vez de fatiar o texto, já que roda a
 * cada alteração de corpos que podem ser grandes.
 */
export function variableRangesFor(doc: string, variables: EnvironmentVariableDto[]): VariableRange[] {
  const known = new Set(variables.map((variable) => variable.name))
  const ranges: VariableRange[] = []
  let cursor = 0
  for (;;) {
    const open = doc.indexOf('{{', cursor)
    if (open === -1) break
    const close = doc.indexOf('}}', open + 2)
    if (close === -1) break
    const name = doc.slice(open + 2, close).trim()
    ranges.push({ from: open, to: close + 2, name, known: known.has(name) })
    cursor = close + 2
  }
  return ranges
}

export const variableTokenClassName = (known: boolean) => `var-token ${known ? 'var-token--known' : 'var-token--unknown'}`

/** Token ranges, rescanned only when the text or the variables change — not on
 * every selection change, which only restyles them. */
const variableRangesField = StateField.define<VariableRange[]>({
  create: (state) => variableRangesFor(state.doc.toString(), state.field(variablesField)),
  update: (value, tr) =>
    tr.docChanged || tr.effects.some((effect) => effect.is(setEnvironmentVariables))
      ? variableRangesFor(tr.state.doc.toString(), tr.state.field(variablesField))
      : value,
})

/** Same states as the single-line fields: `active` with the cursor inside the
 * token, `selected` when the selection covers it. The editor draws the
 * selection behind the text, so a selected token drops its fill — otherwise
 * the chip hides the selection. */
function tokenStateClassName(state: EditorState, range: VariableRange): string {
  let active = false
  for (const selection of state.selection.ranges) {
    if (!selection.empty && selection.from < range.to && selection.to > range.from) return ' var-token--selected'
    if (selection.empty && selection.head > range.from && selection.head < range.to) active = true
  }
  return active ? ' var-token--active' : ''
}

const braceMark = Decoration.mark({ class: 'var-token-brace' })

function buildVariableDecorations(state: EditorState): DecorationSet {
  return Decoration.set(
    state.field(variableRangesField).flatMap((range) => [
      Decoration.mark({ class: variableTokenClassName(range.known) + tokenStateClassName(state, range) }).range(range.from, range.to),
      // Muted braces so the name stands out, as in the single-line fields.
      braceMark.range(range.from, range.from + 2),
      braceMark.range(range.to - 2, range.to),
    ]),
    true,
  )
}

const variableDecorationsField = StateField.define<DecorationSet>({
  create: buildVariableDecorations,
  update: (value, tr) => {
    if (tr.docChanged || tr.selection || tr.effects.some((effect) => effect.is(setEnvironmentVariables))) {
      return buildVariableDecorations(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** `{{variable}}` chips (known/undefined, cursor and selection states, muted
 * braces) for an editor that also has `variablesField`. */
export const variableTokenDecorations: Extension = [variableRangesField, variableDecorationsField]

/** Editors with a mouse button held down (drag-selecting): no preview card pops
 * up when the pointer rests over a token mid-drag. */
const pointerDown = new WeakMap<EditorView, boolean>()

const trackPointerButtons = EditorView.domEventHandlers({
  mousedown: (_event, view) => {
    pointerDown.set(view, true)
  },
  // `buttons` comes back to 0 on the first move after a release, even one outside the editor.
  mousemove: (event, view) => {
    pointerDown.set(view, event.buttons !== 0)
  },
  mouseup: (_event, view) => {
    pointerDown.set(view, false)
  },
})

export type GetVariableEditing = () => VariableEditing | null

const noVariableEditing: GetVariableEditing = () => null

/**
 * Pré-visualização de `{{nome}}` no hover — o mesmo `VariablePreviewCard` dos
 * campos de linha única, montado numa raiz React própria dentro do tooltip.
 * `getTranslate` e `getEditing` são chamados a cada hover, não capturados uma
 * vez na criação da extensão — assim acompanham idioma e ambiente ativo sem
 * reconfigurar a extensão via `Compartment`.
 */
export function variableHoverTooltip(getTranslate: () => Translate, getEditing: GetVariableEditing = noVariableEditing) {
  const tooltip = hoverTooltip((view, pos) => {
    if (pointerDown.get(view)) return null
    const variables = view.state.field(variablesField)
    const ranges = view.state.field(variableRangesField, false) ?? variableRangesFor(view.state.doc.toString(), variables)
    const match = ranges.find((range) => pos >= range.from && pos <= range.to)
    if (!match) return null

    return {
      pos: match.from,
      end: match.to,
      above: true,
      create: (tooltipView) => {
        const dom = document.createElement('div')
        const root = createRoot(dom)
        const editing = getEditing()
        // Síncrono: o CodeMirror mede o tooltip logo após `create` para
        // posicioná-lo acima do token — vazio, ficaria sobre o texto.
        flushSync(() => {
          root.render(
            createElement(VariablePreviewCard, {
              name: match.name,
              variables,
              t: getTranslate(),
              onSetValue: editing?.setValue ?? null,
              canCreate: editing?.canCreate ?? false,
              onRequestClose: () => {
                tooltipView.dispatch({ effects: closeHoverTooltips })
                tooltipView.focus()
              },
            }),
          )
        })
        // Adiado: `destroy` pode rodar enquanto o React ainda renderiza.
        return { dom, destroy: () => queueMicrotask(() => root.unmount()) }
      },
    }
  })
  return [trackPointerButtons, tooltip]
}

/**
 * Sugere as variáveis do ambiente ativo enquanto um `{{` ainda aberto antecede
 * o cursor (mesma regra do campo de URL, `findOpenTemplateQuery`, aplicada à
 * linha atual). Aceitar insere `nome}}`, ou só o nome se o `}}` já estiver
 * logo depois do cursor.
 */
export function templateVariableCompletionSource(getTranslate: () => Translate) {
  return (context: CompletionContext): CompletionResult | null => {
    const variables = context.state.field(variablesField, false) ?? []
    if (variables.length === 0) return null

    const line = context.state.doc.lineAt(context.pos)
    const open = findOpenTemplateQuery(line.text, context.pos - line.from)
    if (!open) return null

    const t = getTranslate()
    const alreadyClosed = context.state.sliceDoc(context.pos, context.pos + 2) === '}}'
    const options: Completion[] = variables.map((variable) => ({
      label: variable.name,
      type: 'variable',
      detail: variable.sensitive ? t('environments.sensitiveColumn') : undefined,
      info: describeVariable(t, variable.name, variables),
      apply: alreadyClosed ? variable.name : `${variable.name}}}`,
    }))

    return { from: line.from + open.start, options, validFor: /^[^{}]*$/ }
  }
}

/**
 * Destaque de `{{variável}}` (conhecida/indefinida), pré-visualização no hover
 * (com o valor editável, se `getEditing` fornecer a edição) e sugestões ao digitar `{{` — para os editores CodeMirror
 * cujo texto o backend interpola (corpo raw REST, variables GraphQL). As
 * variáveis chegam via `setEnvironmentVariables`. As teclas para aceitar a
 * sugestão vêm de `completionShortcutsExtension`.
 */
export function environmentVariablesExtension(getTranslate: () => Translate, getEditing: GetVariableEditing = noVariableEditing): Extension {
  // A fonte precisa ser a mesma função em toda consulta: o CodeMirror associa
  // o resultado pendente à fonte por identidade, e uma função nova a cada
  // chamada do provedor faria o resultado ser descartado (lista nunca abre).
  const completionSource = templateVariableCompletionSource(getTranslate)
  const completionLanguageData = [{ autocomplete: completionSource }]
  return [
    variablesField,
    variableTokenDecorations,
    variableHoverTooltip(getTranslate, getEditing),
    autocompletion({ icons: false }),
    EditorState.languageData.of(() => completionLanguageData),
    completionTheme,
    floatingTooltips(),
  ]
}
