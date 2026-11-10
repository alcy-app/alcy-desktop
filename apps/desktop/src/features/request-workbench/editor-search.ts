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

export interface EditorReplaceOptions {
  replacement: string
  preserveCase: boolean
}

export interface EditorSearchReplacement extends EditorSearchRange {
  insert: string
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

function compileSearchExpression(query: string, options: EditorSearchOptions): RegExp | null {
  try {
    return new RegExp(options.regularExpression ? query : escapeRegularExpression(query), options.matchCase ? 'gmu' : 'gimu')
  } catch {
    return null
  }
}

function* iterateSearchMatches(
  text: string,
  expression: RegExp,
  wholeWord: boolean,
  scope: EditorSearchRange | null,
): Generator<RegExpExecArray> {
  const end = scope?.to ?? text.length
  expression.lastIndex = scope?.from ?? 0
  let match: RegExpExecArray | null
  while ((match = expression.exec(text)) !== null && match.index < end) {
    if (match[0].length === 0) {
      expression.lastIndex += 1
      continue
    }

    const from = match.index
    const to = from + match[0].length
    const isWholeWord = !wholeWord || (!isWordCharacter(text[from - 1]) && !isWordCharacter(text[to]))
    if (to <= end && isWholeWord) yield match
  }
}

/** Finds occurrences with UTF-16 offsets, the same system CodeMirror uses; `scope` keeps only those fully inside it. */
export function findEditorSearchMatches(
  text: string,
  query: string,
  options: EditorSearchOptions,
  scope: EditorSearchRange | null = null,
): EditorSearchResult {
  if (!query) return { matches: [], invalidRegularExpression: false, limited: false }

  const expression = compileSearchExpression(query, options)
  if (!expression) return { matches: [], invalidRegularExpression: true, limited: false }

  const matches: EditorSearchRange[] = []
  let limited = false
  for (const match of iterateSearchMatches(text, expression, options.wholeWord, scope)) {
    if (matches.length === MAX_SEARCH_MATCHES) {
      limited = true
      break
    }
    matches.push({ from: match.index, to: match.index + match[0].length })
  }

  return { matches, invalidRegularExpression: false, limited }
}

const REPLACEMENT_TOKEN = /\$\$|\$&|\$(\d{1,2})|\$<([^>]+)>|\\n|\\t|\\\\/g

function captureGroupText(digits: string, match: RegExpExecArray, token: string): string {
  const index = Number(digits)
  if (index < match.length) return match[index] ?? ''
  // `$12` with a single group is group 1 followed by a literal 2.
  const firstDigit = Number(digits[0])
  return digits.length === 2 && firstDigit < match.length ? `${match[firstDigit] ?? ''}${digits[1]}` : token
}

/** Expands `$1`, `$&`, `$<name>`, `$$`, `\n`, `\t` and `\\`; a reference to a group that does not exist stays as typed. */
function expandRegularExpressionReplacement(template: string, match: RegExpExecArray): string {
  return template.replace(REPLACEMENT_TOKEN, (token: string, digits: string | undefined, name: string | undefined) => {
    if (digits !== undefined) return captureGroupText(digits, match, token)
    if (name !== undefined) return match.groups && name in match.groups ? (match.groups[name] ?? '') : token
    if (token === '$$') return '$'
    if (token === '$&') return match[0]
    if (token === '\\n') return '\n'
    if (token === '\\t') return '\t'
    return '\\'
  })
}

function applyMatchedCase(matched: string, replacement: string): string {
  const upper = matched.toUpperCase()
  const lower = matched.toLowerCase()
  if (!replacement || upper === lower) return replacement
  if (matched === upper && matched.length > 1) return replacement.toUpperCase()
  if (matched === lower) return replacement.toLowerCase()
  const firstIsUpper = matched[0] === upper[0] && matched[0] !== lower[0]
  return `${firstIsUpper ? replacement[0].toUpperCase() : replacement[0].toLowerCase()}${replacement.slice(1)}`
}

/**
 * Text changes that replace the occurrences, in document order. Unlike the
 * search itself this has no cap: "replace all" must not stop halfway. The
 * replacement is literal unless the search is a regular expression.
 */
export function buildEditorSearchReplacements(
  text: string,
  query: string,
  options: EditorSearchOptions,
  { replacement, preserveCase }: EditorReplaceOptions,
  scope: EditorSearchRange | null = null,
): EditorSearchReplacement[] {
  const expression = query ? compileSearchExpression(query, options) : null
  if (!expression) return []

  return Array.from(iterateSearchMatches(text, expression, options.wholeWord, scope), (match) => {
    const expanded = options.regularExpression ? expandRegularExpressionReplacement(replacement, match) : replacement
    return {
      from: match.index,
      to: match.index + match[0].length,
      insert: preserveCase ? applyMatchedCase(match[0], expanded) : expanded,
    }
  })
}

/**
 * Moves a range across an edit known only by the text before and after it
 * (the editor's content arrives as a value). Returns null when the edit
 * crosses a boundary of the range or leaves it empty.
 */
export function mapRangeThroughTextChange(range: EditorSearchRange, before: string, after: string): EditorSearchRange | null {
  const shortest = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1

  const changeTo = before.length - suffix
  const delta = after.length - before.length
  if (changeTo <= range.from) return { from: range.from + delta, to: range.to + delta }
  if (prefix >= range.to) return range
  const staysInside = prefix >= range.from && changeTo <= range.to && range.to + delta > range.from
  return staysInside ? { from: range.from, to: range.to + delta } : null
}

interface SearchHighlights {
  matches: EditorSearchRange[]
  activeIndex: number
  scope: EditorSearchRange | null
}

const setSearchHighlights = StateEffect.define<SearchHighlights>()

export const editorSearchHighlightExtension: Extension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setSearchHighlights)) continue
      const { matches, activeIndex, scope } = effect.value
      next = Decoration.set(
        [
          ...(scope ? [Decoration.mark({ class: 'cm-editor-search-scope' }).range(scope.from, scope.to)] : []),
          ...matches.map((match, index) =>
            Decoration.mark({ class: index === activeIndex ? 'cm-editor-search-match--active' : 'cm-editor-search-match' }).range(
              match.from,
              match.to,
            ),
          ),
        ],
        true,
      )
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function updateEditorSearchHighlights(
  view: EditorView,
  matches: EditorSearchRange[],
  activeIndex: number,
  scope: EditorSearchRange | null = null,
): void {
  view.dispatch({ effects: setSearchHighlights.of({ matches, activeIndex, scope }) })
}
