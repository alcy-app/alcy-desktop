/**
 * Comments in a JSON request body (spec 0146): `//` to the end of the line and
 * `/* … *\/`, outside strings. The body keeps them; execution removes them
 * before sending (`strip_json_comments` in `alcy-domain`, same rules).
 *
 * A string ends at its closing quote or at the end of the line, so a quote
 * still being typed does not swallow the rest of the document. A `/*` without
 * a closing `*\/` is not a comment.
 */

export interface CommentRange {
  from: number
  to: number
}

/** Comment ranges in document order. A line comment stops before the line break (and before a `\r`). */
export function findJsonComments(text: string): CommentRange[] {
  const ranges: CommentRange[] = []
  let inString = false
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      if (char === '\\' && text[index + 1] !== '\n') index += 2
      else {
        if (char === '"' || char === '\n') inString = false
        index += 1
      }
      continue
    }
    if (char === '"') {
      inString = true
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      let end = text.indexOf('\n', index + 2)
      if (end === -1) end = text.length
      else if (text[end - 1] === '\r') end -= 1
      ranges.push({ from: index, to: end })
      index = end
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      if (close !== -1) {
        ranges.push({ from: index, to: close + 2 })
        index = close + 2
        continue
      }
    }
    index += 1
  }
  return ranges
}

/** The text with every comment character replaced by a space, line breaks kept: same length and positions. */
export function maskJsonComments(text: string, ranges: readonly CommentRange[] = findJsonComments(text)): string {
  if (ranges.length === 0) return text
  let masked = ''
  let last = 0
  for (const { from, to } of ranges) {
    masked += text.slice(last, from) + text.slice(from, to).replace(/[^\r\n]/g, ' ')
    last = to
  }
  return masked + text.slice(last)
}

/**
 * The body without comments, as execution sends it (`strip_json_comments` in
 * `alcy-domain`, same rules and cases): a line left blank goes with its line
 * break, other lines lose the comment and the space before it, and a comma
 * left before `}` or `]` goes too. Without comments the text is returned as is.
 */
export function stripJsonComments(text: string): string {
  const comments = findJsonComments(text)
  if (comments.length === 0) return text
  return removeDanglingCommas(removeComments(text, comments))
}

function removeComments(text: string, comments: readonly CommentRange[]): string {
  let output = ''
  let next = 0
  let lineStart = 0
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline + 1
    let contentEnd = newline === -1 ? text.length : newline
    if (contentEnd > lineStart && text[contentEnd - 1] === '\r') contentEnd -= 1
    const terminator = text.slice(contentEnd, lineEnd)

    while (next < comments.length && comments[next].to <= lineStart) next += 1
    let kept = ''
    let touched = false
    let position = lineStart
    for (let index = next; index < comments.length && comments[index].from < Math.max(contentEnd, lineStart + 1); index++) {
      const comment = comments[index]
      if (comment.to > lineStart) {
        touched = true
        if (comment.from > position) {
          kept += text.slice(position, comment.from)
          // The space before the comment goes with it, not the indentation.
          if (kept.trim() !== '') kept = kept.trimEnd()
        }
        position = Math.max(position, Math.min(comment.to, contentEnd))
      }
      if (comment.to > contentEnd) break
    }

    if (!touched) output += text.slice(lineStart, lineEnd)
    else {
      if (position < contentEnd) kept += text.slice(position, contentEnd)
      if (kept.trim() !== '') output += kept.trimEnd() + terminator
    }
    lineStart = lineEnd
  }
  return output
}

function removeDanglingCommas(text: string): string {
  let output = ''
  let copied = 0
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\' && text[index + 1] !== '\n') index += 1
      else if (char === '"' || char === '\n') inString = false
    } else if (char === '"') inString = true
    else if (char === ',' && closesAfterWhitespace(text, index + 1)) {
      output += text.slice(copied, index)
      copied = index + 1
    }
  }
  return output + text.slice(copied)
}

/** The next character after ASCII whitespace closes an object or a list. */
function closesAfterWhitespace(text: string, from: number): boolean {
  let index = from
  while (index < text.length && ' \t\r\n\f'.includes(text[index])) index += 1
  return text[index] === '}' || text[index] === ']'
}
