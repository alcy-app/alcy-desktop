import type { Extension } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import type { Text } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { findValueAt, indexJsonValues } from './json-value-index'
import type { JsonValueRange } from './json-value-index'

const setHoveredValue = StateEffect.define<{ from: number; to: number } | null>()

const hoverMark = Decoration.mark({ class: 'cm-value-capture-hover' })

interface HoveredRange {
  from: number
  to: number
}

const hoveredValueField = StateField.define<HoveredRange | null>({
  create: () => null,
  update(hovered, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHoveredValue)) return effect.value
    }
    return transaction.docChanged ? null : hovered
  },
  provide: (field) =>
    EditorView.decorations.from(field, (hovered) =>
      hovered ? Decoration.set([hoverMark.range(hovered.from, hovered.to)]) : Decoration.none,
    ),
})

/** Retângulo discreto em volta do valor sob o mouse. */
const hoverTheme = EditorView.theme({
  '.cm-value-capture-hover': {
    outline: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)',
    borderRadius: 'var(--radius-sm)',
  },
})

/** Índice dos valores por documento (o `Text` é imutável, então serve de chave de cache). */
const indexCache = new WeakMap<Text, JsonValueRange[]>()

/**
 * Acima deste tamanho, o destaque/captura por hover fica desligado. Indexar
 * cria um caminho por valor primitivo, na thread principal, no primeiro
 * movimento do mouse: num corpo de dezenas de MB, isso são centenas de MB e
 * segundos de travamento.
 */
export const VALUE_CAPTURE_MAX_DOC_LENGTH = 2_000_000

function valuesOf(doc: Text): JsonValueRange[] {
  if (doc.length > VALUE_CAPTURE_MAX_DOC_LENGTH) return []
  let values = indexCache.get(doc)
  if (!values) {
    values = indexJsonValues(doc.toString())
    indexCache.set(doc, values)
  }
  return values
}

/** Valor JSON sob as coordenadas da tela, ou `null` se o ponteiro não está sobre um valor primitivo. */
export function jsonValueAtCoords(view: EditorView, x: number, y: number): JsonValueRange | null {
  const pos = view.posAtCoords({ x, y })
  if (pos === null) return null
  return findValueAt(valuesOf(view.state.doc), pos)
}

/**
 * Destaca o valor JSON sob o mouse. `isActive` é consultada a cada
 * movimento: o visualizador fica montado ao trocar de formato, e o destaque
 * só faz sentido enquanto o corpo é JSON e há para onde capturar.
 */
export function valueCaptureExtension(isActive: () => boolean): Extension {
  const show = (view: EditorView, value: JsonValueRange | null) => {
    const current = view.state.field(hoveredValueField)
    if (current?.from === value?.from && current?.to === value?.to) return
    view.dispatch({ effects: setHoveredValue.of(value ? { from: value.from, to: value.to } : null) })
  }

  return [
    hoveredValueField,
    hoverTheme,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        show(view, isActive() ? jsonValueAtCoords(view, event.clientX, event.clientY) : null)
      },
      mouseleave(_event, view) {
        show(view, null)
      },
    }),
  ]
}
