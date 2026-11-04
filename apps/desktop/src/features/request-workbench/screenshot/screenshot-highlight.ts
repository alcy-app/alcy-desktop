import type { LRLanguage } from '@codemirror/language'
import { htmlLanguage } from '@codemirror/lang-html'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { jsonLanguage } from '@codemirror/lang-json'
import { xmlLanguage } from '@codemirror/lang-xml'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { tokenizeGraphql, type GraphqlTokenType } from '../graphql-syntax-highlight'

export type HighlightLanguage = 'json' | 'graphql' | 'xml' | 'html' | 'javascript' | 'text'

/** Papel de um trecho de código; a paleta da imagem decide a cor. */
export type HighlightTone = 'plain' | 'key' | 'string' | 'number' | 'keyword' | 'punctuation' | 'comment'

export interface HighlightSpan {
  text: string
  tone: HighlightTone
}

/** Mesmos agrupamentos de `codeHighlightStyle` (`codemirror-shared.ts`), para
 * a imagem ter as cores do editor. */
const toneHighlighter = tagHighlighter([
  { tag: [tags.propertyName, tags.tagName], class: 'key' },
  { tag: [tags.string, tags.attributeValue], class: 'string' },
  { tag: tags.number, class: 'number' },
  { tag: [tags.bool, tags.null, tags.keyword, tags.atom, tags.attributeName], class: 'keyword' },
  { tag: tags.comment, class: 'comment' },
  {
    tag: [tags.punctuation, tags.separator, tags.bracket, tags.angleBracket, tags.meta, tags.processingInstruction],
    class: 'punctuation',
  },
])

const LEZER_LANGUAGES: Partial<Record<HighlightLanguage, LRLanguage>> = {
  json: jsonLanguage,
  xml: xmlLanguage,
  html: htmlLanguage,
  javascript: javascriptLanguage,
}

const GRAPHQL_TONES: Record<GraphqlTokenType, HighlightTone> = {
  keyword: 'key',
  name: 'plain',
  punctuation: 'punctuation',
  string: 'string',
  number: 'number',
  variable: 'keyword',
  comment: 'comment',
  plain: 'plain',
}

function lezerSpans(text: string, language: LRLanguage): HighlightSpan[] {
  const spans: HighlightSpan[] = []
  let cursor = 0
  highlightTree(language.parser.parse(text), toneHighlighter, (from, to, classes) => {
    if (from > cursor) spans.push({ text: text.slice(cursor, from), tone: 'plain' })
    spans.push({ text: text.slice(from, to), tone: classes.split(' ')[0] as HighlightTone })
    cursor = to
  })
  if (cursor < text.length) spans.push({ text: text.slice(cursor), tone: 'plain' })
  return spans
}

/**
 * Colored spans of `text`, the document slice from `from`, using a tree
 * already parsed for the whole document: a fragment keeps the colors it has
 * in context (a selected `"name": 1` is still a key, not a string).
 */
export function highlightTreeRange(tree: Parameters<typeof highlightTree>[0], text: string, from: number): HighlightSpan[] {
  const spans: HighlightSpan[] = []
  let cursor = 0
  highlightTree(tree, toneHighlighter, (start, end, classes) => {
    const spanFrom = start - from
    if (spanFrom > cursor) spans.push({ text: text.slice(cursor, spanFrom), tone: 'plain' })
    spans.push({ text: text.slice(spanFrom, end - from), tone: classes.split(' ')[0] as HighlightTone })
    cursor = end - from
  }, from, from + text.length)
  if (cursor < text.length) spans.push({ text: text.slice(cursor), tone: 'plain' })
  return spans
}

/** Colored spans of a whole text; joined, they rebuild it. Also used by the agent chat code blocks. */
export function highlightSpans(text: string, language: HighlightLanguage): HighlightSpan[] {
  if (language === 'graphql') return tokenizeGraphql(text).map((token) => ({ text: token.text, tone: GRAPHQL_TONES[token.type] }))
  const lezer = LEZER_LANGUAGES[language]
  return lezer ? lezerSpans(text, lezer) : [{ text, tone: 'plain' }]
}

/**
 * Colore as linhas de um bloco de código, devolvendo os trechos de cada
 * linha na mesma ordem. O texto é analisado inteiro (strings e comentários
 * de várias linhas ficam certos) e depois repartido nas quebras de linha;
 * a soma dos trechos de cada linha reconstrói a linha original.
 */
export function highlightLines(lines: string[], language: HighlightLanguage): HighlightSpan[][] {
  const result: HighlightSpan[][] = [[]]
  for (const span of highlightSpans(lines.join('\n'), language)) {
    const parts = span.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) result.push([])
      if (part) result[result.length - 1].push({ text: part, tone: span.tone })
    })
  }
  while (result.length < lines.length) result.push([])
  return result.slice(0, Math.max(lines.length, 0))
}
