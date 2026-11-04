/**
 * Pure Markdown editing helpers for the document editor's format bar. Each one
 * takes the text and the textarea selection and returns the new text with the
 * selection to restore, so the editor stays a controlled textarea.
 */

export interface TextEdit {
  text: string
  selectionStart: number
  selectionEnd: number
}

export type MarkdownFormat =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'bullet'
  | 'ordered'
  | 'quote'
  | 'table'
  | 'rule'

/** Words inserted when there is no selection to format. */
export interface FormatPlaceholders {
  text: string
  column: string
  cell: string
}

const URL_PLACEHOLDER = 'https://'

/** Wraps the selection in `before`/`after`, or removes the markers when it is already wrapped. */
export function wrapSelection(text: string, start: number, end: number, before: string, after: string, placeholder: string): TextEdit {
  const selected = text.slice(start, end)
  if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after && selected) {
    const unwrapped = text.slice(0, start - before.length) + selected + text.slice(end + after.length)
    return { text: unwrapped, selectionStart: start - before.length, selectionEnd: end - before.length }
  }
  if (selected.length > before.length + after.length && selected.startsWith(before) && selected.endsWith(after)) {
    const inner = selected.slice(before.length, selected.length - after.length)
    return { text: text.slice(0, start) + inner + text.slice(end), selectionStart: start, selectionEnd: start + inner.length }
  }
  const inner = selected || placeholder
  return {
    text: text.slice(0, start) + before + inner + after + text.slice(end),
    selectionStart: start + before.length,
    selectionEnd: start + before.length + inner.length,
  }
}

function lineRange(text: string, start: number, end: number) {
  const from = text.lastIndexOf('\n', start - 1) + 1
  // A selection ending right after a line break does not include the next line.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end
  const newline = text.indexOf('\n', last)
  return { from, to: newline === -1 ? text.length : newline }
}

const LINE_PREFIXES: Record<'heading' | 'bullet' | 'ordered' | 'quote', { match: RegExp; add: (index: number) => string }> = {
  heading: { match: /^#{1,6}[ \t]+/, add: () => '## ' },
  bullet: { match: /^[-*+][ \t]+/, add: () => '- ' },
  ordered: { match: /^\d{1,9}[.)][ \t]+/, add: (index) => `${index + 1}. ` },
  quote: { match: /^>[ \t]?/, add: () => '> ' },
}

/** Toggles a block prefix on every selected line: removed when all non-blank lines have it. */
export function toggleLinePrefix(text: string, start: number, end: number, kind: keyof typeof LINE_PREFIXES): TextEdit {
  const { match, add } = LINE_PREFIXES[kind]
  const { from, to } = lineRange(text, start, end)
  const lines = text.slice(from, to).split('\n')
  const filled = lines.filter((line) => line.trim() !== '')
  const remove = filled.length > 0 && filled.every((line) => match.test(line))
  let index = 0
  const next = lines.map((line) => {
    if (remove) return line.replace(match, '')
    if (line.trim() === '' && lines.length > 1) return line
    // Replace another block prefix (a list becoming a quote, a heading level…).
    const stripped = Object.values(LINE_PREFIXES).reduce((value, prefix) => value.replace(prefix.match, ''), line)
    return add(index++) + stripped
  }).join('\n')
  const updated = text.slice(0, from) + next + text.slice(to)
  if (start === end && lines.length === 1) {
    const caret = Math.max(from, start + (next.length - (to - from)))
    return { text: updated, selectionStart: caret, selectionEnd: caret }
  }
  return { text: updated, selectionStart: from, selectionEnd: from + next.length }
}

/** Inserts a block on its own paragraph, replacing the selection; `select` is relative to the block. */
export function insertBlock(text: string, start: number, end: number, block: string, select: [number, number] = [block.length, block.length]): TextEdit {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const offset = start + lead.length
  return { text: before + lead + block + trail + after, selectionStart: offset + select[0], selectionEnd: offset + select[1] }
}

/** Markdown reference for an attached image; brackets and line breaks would end the alt text early. */
export function imageReference(assetId: string, caption: string): string {
  const alt = caption.replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim()
  return `![${alt}](assets/${assetId}.png)`
}

export function applyMarkdownFormat(text: string, start: number, end: number, format: MarkdownFormat, placeholders: FormatPlaceholders): TextEdit {
  switch (format) {
    case 'bold': return wrapSelection(text, start, end, '**', '**', placeholders.text)
    case 'italic': return wrapSelection(text, start, end, '_', '_', placeholders.text)
    case 'strike': return wrapSelection(text, start, end, '~~', '~~', placeholders.text)
    case 'code': {
      const selected = text.slice(start, end)
      if (!selected.includes('\n')) return wrapSelection(text, start, end, '`', '`', placeholders.text)
      const body = selected.replace(/\n$/, '')
      return insertBlock(text, start, end, `\`\`\`\n${body}\n\`\`\``, [4, 4 + body.length])
    }
    case 'link': {
      const label = text.slice(start, end).replace(/\n/g, ' ')
      if (!label) {
        const inserted = `[${placeholders.text}](${URL_PLACEHOLDER})`
        return { text: text.slice(0, start) + inserted + text.slice(end), selectionStart: start + 1, selectionEnd: start + 1 + placeholders.text.length }
      }
      const inserted = `[${label}](${URL_PLACEHOLDER})`
      const urlStart = start + label.length + 3
      return { text: text.slice(0, start) + inserted + text.slice(end), selectionStart: urlStart, selectionEnd: urlStart + URL_PLACEHOLDER.length }
    }
    case 'heading':
    case 'bullet':
    case 'ordered':
    case 'quote':
      return toggleLinePrefix(text, start, end, format)
    case 'table': {
      const { column, cell } = placeholders
      const table = `| ${column} | ${column} |\n| --- | --- |\n| ${cell} | ${cell} |`
      return insertBlock(text, start, end, table, [2, 2 + column.length])
    }
    case 'rule':
      return insertBlock(text, start, end, '---')
  }
}
