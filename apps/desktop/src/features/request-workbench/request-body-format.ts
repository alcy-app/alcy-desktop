import type { RawBodyLanguage } from '../../bindings/execute-rest-request'
import { formatXmlBody } from './xml-format'

const INDENT = '  '

type TokenKind = 'punct' | 'string' | 'literal' | 'template' | 'lineComment' | 'blockComment'

interface Token {
  kind: TokenKind
  text: string
  /** A line break separated this token from the previous one in the source. */
  newlineBefore: boolean
}

const PUNCTUATION = '{}[],:'
const isWhitespace = (char: string) => char === ' ' || char === '\n' || char === '\r' || char === '\t'

/** Splits a JSON body that may hold comments and `{{variable}}` templates;
 * `null` when a string or block comment never closes. */
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = []
  let newlineBefore = false
  let index = 0
  const push = (kind: TokenKind, end: number) => {
    tokens.push({ kind, text: source.slice(index, end), newlineBefore })
    newlineBefore = false
    index = end
  }

  while (index < source.length) {
    const char = source[index]
    if (isWhitespace(char)) {
      if (char === '\n') newlineBefore = true
      index++
    } else if (char === '"') {
      let end = index + 1
      while (end < source.length && source[end] !== '"' && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1
      if (source[end] !== '"') return null
      push('string', end + 1)
    } else if (char === '/' && source[index + 1] === '/') {
      let end = source.indexOf('\n', index)
      if (end === -1) end = source.length
      else if (source[end - 1] === '\r') end -= 1
      push('lineComment', end)
    } else if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      if (close === -1) return null
      push('blockComment', close + 2)
    } else if (char === '{' && source[index + 1] === '{' && source.indexOf('}}', index + 2) !== -1) {
      // Same rule as the variable resolver: `{{` up to the next `}}`.
      push('template', source.indexOf('}}', index + 2) + 2)
    } else if (PUNCTUATION.includes(char)) {
      push('punct', index + 1)
    } else {
      let end = index + 1
      while (end < source.length && !isWhitespace(source[end]) && !PUNCTUATION.includes(source[end]) && source[end] !== '"' && source[end] !== '/') end++
      push('literal', end)
    }
  }
  return tokens
}

/** Valid JSON once comments are dropped and each template outside a string
 * stands for a value. */
function isValidJson(tokens: readonly Token[]): boolean {
  const parts: string[] = []
  for (const token of tokens) {
    if (token.kind === 'lineComment' || token.kind === 'blockComment') continue
    parts.push(token.kind === 'template' ? '0' : token.text)
  }
  try {
    JSON.parse(parts.join(' '))
    return true
  } catch {
    return false
  }
}

function print(tokens: readonly Token[]): string {
  let out = ''
  let depth = 0
  let breakPending = false
  let spacePending = false

  const write = (text: string) => {
    if (breakPending && out) out += '\n' + INDENT.repeat(depth)
    else if (spacePending && out) out += ' '
    breakPending = false
    spacePending = false
    out += text
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const next = tokens[index + 1]
    switch (token.kind) {
      case 'lineComment':
        // A comment that shared a line with the previous token stays there (`"a": 1, // note`).
        if (!token.newlineBefore) {
          breakPending = false
          spacePending = true
        } else breakPending = true
        write(token.text)
        breakPending = true
        break
      case 'blockComment':
        if (token.newlineBefore) breakPending = true
        else if (!breakPending) spacePending = true
        write(token.text)
        if (next?.newlineBefore) breakPending = true
        else spacePending = true
        break
      case 'punct':
        if (token.text === '{' || token.text === '[') {
          const closer = token.text === '{' ? '}' : ']'
          if (next?.kind === 'punct' && next.text === closer) {
            write(token.text + closer)
            index++
          } else {
            write(token.text)
            depth++
            breakPending = true
          }
        } else if (token.text === '}' || token.text === ']') {
          depth = Math.max(0, depth - 1)
          breakPending = true
          write(token.text)
        } else if (token.text === ',') {
          write(',')
          breakPending = true
        } else {
          write(':')
          spacePending = true
        }
        break
      default:
        write(token.text)
    }
  }
  return out
}

/**
 * Reindents a raw JSON request body with 2 spaces. Unlike `formatJsonBody`,
 * it only moves whitespace: comments (spec 0146), `{{variable}}` templates and
 * every literal (large numbers, escapes) are kept exactly as written. `null`
 * when the body is not valid JSON, so the user's text is never replaced by a
 * guess.
 */
export function formatJsoncBody(source: string): string | null {
  const tokens = tokenize(source)
  if (!tokens || tokens.length === 0 || !isValidJson(tokens)) return null
  return print(tokens)
}

/** Reindents an XML body; `null` when it does not look like XML. */
function formatXmlRequestBody(source: string): string | null {
  return source.trimStart().startsWith('<') ? formatXmlBody(source) : null
}

/** The formatter of a raw body language, or `undefined` when there is none (text, JavaScript, HTML). */
export function rawBodyFormatter(language: RawBodyLanguage): ((source: string) => string | null) | undefined {
  if (language === 'json') return formatJsoncBody
  if (language === 'xml') return formatXmlRequestBody
  return undefined
}
