import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

export interface EditorSearchRange {
  from: number
  to: number
}

export interface EditorSearchOptions {
  matchCase: boolean
  wholeWord: boolean
  regularExpression: boolean
}

export interface EditorSearchResult {
  matches: EditorSearchRange[]
  invalidRegularExpression: boolean
  limited: boolean
}

const MAX_SEARCH_MATCHES = 10_000

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value)
}

/** Localiza ocorrências com offsets UTF-16, o mesmo sistema usado pelo CodeMirror. */
export function findEditorSearchMatches(text: string, query: string, options: EditorSearchOptions): EditorSearchResult {
  if (!query) return { matches: [], invalidRegularExpression: false, limited: false }

  let expression: RegExp
  try {
    expression = new RegExp(options.regularExpression ? query : escapeRegularExpression(query), options.matchCase ? 'gu' : 'giu')
  } catch {
    return { matches: [], invalidRegularExpression: true, limited: false }
  }

  const matches: EditorSearchRange[] = []
  let limited = false
  let match: RegExpExecArray | null
  while ((match = expression.exec(text)) !== null) {
    if (match[0].length === 0) {
      expression.lastIndex += 1
      continue
    }

    const from = match.index
    const to = from + match[0].length
    const isWholeWord =
      !options.wholeWord ||
      (!isWordCharacter(text[from - 1]) && !isWordCharacter(text[to]))
    if (isWholeWord) matches.push({ from, to })

    if (matches.length === MAX_SEARCH_MATCHES) {
      limited = expression.exec(text) !== null
      break
    }
  }

  return { matches, invalidRegularExpression: false, limited }
}

interface SearchHighlights {
  matches: EditorSearchRange[]
  activeIndex: number
}

const setSearchHighlights = StateEffect.define<SearchHighlights>()

export const editorSearchHighlightExtension: Extension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setSearchHighlights)) continue
      next = Decoration.set(
        effect.value.matches.map((match, index) =>
          Decoration.mark({ class: index === effect.value.activeIndex ? 'cm-editor-search-match--active' : 'cm-editor-search-match' }).range(
            match.from,
            match.to,
          ),
        ),
        true,
      )
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function updateEditorSearchHighlights(view: EditorView, matches: EditorSearchRange[], activeIndex: number): void {
  view.dispatch({ effects: setSearchHighlights.of({ matches, activeIndex }) })
}
