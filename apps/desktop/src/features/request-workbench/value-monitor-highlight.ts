import type { Extension } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { Decoration, EditorView, hoverTooltip } from '@codemirror/view'
import type { MonitorHighlight } from './use-value-monitor-findings'

/** Substitui os destaques do monitor (lista vazia limpa). */
export const setMonitorHighlights = StateEffect.define<MonitorHighlight[]>()

const passMark = Decoration.mark({ class: 'cm-monitor-pass' })
const failMark = Decoration.mark({ class: 'cm-monitor-fail' })

interface MonitorHighlightState {
  highlights: MonitorHighlight[]
  decorations: DecorationSet
}

const EMPTY: MonitorHighlightState = { highlights: [], decorations: Decoration.none }

function build(highlights: MonitorHighlight[], docLength: number): MonitorHighlightState {
  const valid = highlights.filter((highlight) => highlight.from < highlight.to && highlight.to <= docLength)
  return {
    highlights: valid,
    decorations: Decoration.set(
      valid.map((highlight) => (highlight.failed ? failMark : passMark).range(highlight.from, highlight.to)),
      true,
    ),
  }
}

const monitorHighlightField = StateField.define<MonitorHighlightState>({
  create: () => EMPTY,
  update(state, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMonitorHighlights)) return build(effect.value, transaction.newDoc.length)
    }
    // As faixas valem para um texto exato; o próximo resultado chega por efeito.
    return transaction.docChanged ? EMPTY : state
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.decorations),
})

/** Destaque cujo trecho contém `pos` (busca binária — as faixas estão em ordem de documento). */
export function highlightAt(highlights: MonitorHighlight[], pos: number): MonitorHighlight | null {
  let low = 0
  let high = highlights.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const highlight = highlights[mid]
    if (pos < highlight.from) high = mid - 1
    else if (pos > highlight.to) low = mid + 1
    else return highlight
  }
  return null
}

/** Reprovado: fundo suave e sublinhado; aprovado: só um sublinhado fino, para não poluir a leitura. */
const monitorTheme = EditorView.theme({
  '.cm-monitor-pass': {
    textDecoration: 'underline',
    textDecorationColor: 'color-mix(in srgb, var(--success) 70%, transparent)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
  },
  '.cm-monitor-fail': {
    backgroundColor: 'color-mix(in srgb, var(--error) 14%, transparent)',
    textDecoration: 'underline',
    textDecorationColor: 'var(--error)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
    borderRadius: 'var(--radius-sm)',
  },
})

/**
 * Destaques do monitor de valores e o tooltip que explica cada um.
 * `describe` é chamada a cada hover (monta o conteúdo do cartão), então
 * acompanha idioma e monitores sem reconfigurar a extensão.
 */
export function valueMonitorHighlightExtension(describe: (highlight: MonitorHighlight) => HTMLElement): Extension {
  return [
    monitorHighlightField,
    monitorTheme,
    hoverTooltip((view, pos) => {
      const highlight = highlightAt(view.state.field(monitorHighlightField).highlights, pos)
      if (!highlight) return null
      return { pos: highlight.from, end: highlight.to, above: true, create: () => ({ dom: describe(highlight) }) }
    }),
  ]
}
