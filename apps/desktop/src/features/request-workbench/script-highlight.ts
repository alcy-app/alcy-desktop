import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'

/** Identificadores globais injetados nos scripts, destacados como palavras
 * reservadas. */
const RESERVED_IDENTIFIERS = new Set(['al'])

const reservedMark = Decoration.mark({ class: 'cm-script-reserved' })

/** Só `VariableName` — `obj.al` (propriedade), strings e comentários não são
 * o objeto global e ficam com a cor normal. */
export function reservedIdentifierDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'VariableName') return
        if (RESERVED_IDENTIFIERS.has(view.state.sliceDoc(node.from, node.to))) {
          builder.add(node.from, node.to, reservedMark)
        }
      },
    })
  }
  return builder.finish()
}

const reservedIdentifierPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = reservedIdentifierDecorations(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = reservedIdentifierDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** Mesma cor de `tags.keyword` em `codeHighlightStyle`. */
const reservedIdentifierTheme = EditorView.theme({
  '.cm-script-reserved': { color: 'var(--accent)' },
})

export function scriptReservedHighlight(): Extension {
  return [reservedIdentifierPlugin, reservedIdentifierTheme]
}
