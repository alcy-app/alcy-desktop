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

/** What the search bar shows; a view that remounts can start from it again. */
export interface EditorSearchState {
  isOpen: boolean
  query: string
  matchCase: boolean
  wholeWord: boolean
  regularExpression: boolean
  activeIndex: number
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

const MAX_SEARCH_SEED_LENGTH = 1_000

/**
 * Query for a search started over a selection (Ctrl+F with text selected):
 * single-line selections up to a sane length, escaped when the search is a
 * regular expression so it still finds the selected text literally.
 */
export function searchSeedFromSelection(selected: string, regularExpression: boolean): string | null {
  if (!selected || selected.length > MAX_SEARCH_SEED_LENGTH || /[\r\n]/.test(selected)) return null
  return regularExpression ? escapeRegularExpression(selected) : selected
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
