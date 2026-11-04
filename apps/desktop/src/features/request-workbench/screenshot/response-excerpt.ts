import { highlightSpans, type HighlightLanguage, type HighlightSpan } from './screenshot-highlight'

/** Part of the response body the user selected to share as an image. */
export interface ResponseExcerpt {
  /** Selected lines, without the indentation they share. */
  lines: string[]
  /** Colored spans of each line, as the response view colors them. */
  spans: HighlightSpan[][]
  /** Line number of `lines[0]` in the response view. */
  firstLine: number
  language: HighlightLanguage
}

export interface ExcerptSelection {
  /** Selected text, exactly as it appears in the view. */
  text: string
  /** Colored spans of `text`; without them the excerpt is highlighted on its own. */
  spans?: HighlightSpan[]
  /** Line number where the selection starts. */
  startLine: number
  /** Characters between the start of that line and the selection. */
  startColumn: number
  language: HighlightLanguage
}

type SpanLine = HighlightSpan[]

const lineText = (line: SpanLine) => line.map((span) => span.text).join('')

/** Splits spans at line breaks; tabs become the editor's two spaces. */
function splitLines(spans: HighlightSpan[]): SpanLine[] {
  const lines: SpanLine[] = [[]]
  for (const span of spans) {
    span.text
      .replace(/\r/g, '')
      .replace(/\t/g, '  ')
      .split('\n')
      .forEach((part, index) => {
        if (index > 0) lines.push([])
        if (part) lines[lines.length - 1].push({ text: part, tone: span.tone })
      })
  }
  return lines
}

/** Drops the first `count` characters of a line. */
function dropStart(line: SpanLine, count: number): SpanLine {
  const result: SpanLine = []
  let remaining = count
  for (const span of line) {
    if (remaining >= span.text.length) {
      remaining -= span.text.length
      continue
    }
    result.push(remaining > 0 ? { text: span.text.slice(remaining), tone: span.tone } : span)
    remaining = 0
  }
  return result
}

function trimEnd(line: SpanLine): SpanLine {
  const result = [...line]
  while (result.length > 0) {
    const last = result[result.length - 1]
    const trimmed = last.text.trimEnd()
    if (trimmed) {
      result[result.length - 1] = { text: trimmed, tone: last.tone }
      break
    }
    result.pop()
  }
  return result
}

const leadingSpaces = (text: string) => text.length - text.trimStart().length

/**
 * Turns a selection into image lines. A selection starting mid-line keeps its
 * column, so nested JSON stays aligned with the lines below it; then the
 * indentation every line shares is removed, and blank lines at either end are
 * dropped (a selection ending right after a newline does not add an empty line).
 * Returns `null` when nothing but whitespace was selected.
 */
export function excerptFromSelection({ text, spans, startLine, startColumn, language }: ExcerptSelection): ResponseExcerpt | null {
  const lines = splitLines(spans ?? highlightSpans(text, language)).map(trimEnd)
  if (startColumn > 0) lines[0] = [{ text: ' '.repeat(startColumn), tone: 'plain' }, ...lines[0]]

  const blank = (line: SpanLine) => lineText(line).trim() === ''
  let first = 0
  while (first < lines.length && blank(lines[first])) first += 1
  if (first === lines.length) return null
  let last = lines.length - 1
  while (blank(lines[last])) last -= 1

  const kept = lines.slice(first, last + 1)
  const indent = Math.min(...kept.filter((line) => !blank(line)).map((line) => leadingSpaces(lineText(line))))
  const dedented = kept.map((line) => (blank(line) ? [] : dropStart(line, indent)))
  return {
    lines: dedented.map(lineText),
    spans: dedented,
    firstLine: startLine + first,
    language,
  }
}

export function excerptLastLine(excerpt: ResponseExcerpt): number {
  return excerpt.firstLine + excerpt.lines.length - 1
}
