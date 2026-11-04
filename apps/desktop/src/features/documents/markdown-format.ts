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

export interface ImagePlacement {
  /** Percent of the text column. */
  width?: number
  align?: 'left' | 'center' | 'right'
}

/** Markdown reference for an attached image; brackets and line breaks would end the alt text early. */
export function imageReference(assetId: string, caption: string, placement: ImagePlacement = {}): string {
  const alt = caption.replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim()
  const attributes = [placement.width ? `width=${placement.width}%` : '', placement.align ? `align=${placement.align}` : ''].filter(Boolean).join(' ')
  return `![${alt}](assets/${assetId}.png)${attributes ? `{${attributes}}` : ''}`
}

export type DocumentInsert = 'note' | 'tip' | 'warning' | 'danger' | 'columns2' | 'columns3' | 'center' | 'pagebreak' | 'toc' | 'tableCaption'

/** Words the inserted blocks start with, so they can be typed over. */
export interface InsertPlaceholders {
  title: string
  text: string
  column: string
  caption: string
}

/** Wraps the selection (or a placeholder) in a `:::name` container; selects its title or content. */
function insertContainer(text: string, start: number, end: number, opening: string, body: string, select: 'title' | 'body', title = ''): TextEdit {
  const head = `:::${opening}${title ? ` ${title}` : ''}`
  const block = `${head}\n${body}\n:::`
  const range: [number, number] = select === 'title' && title ? [head.length - title.length, head.length] : [head.length + 1, head.length + 1 + body.length]
  return insertBlock(text, start, end, block, range)
}

/** Adds a `Table:` caption line right after the table around the cursor. */
function insertTableCaption(text: string, start: number, caption: string): TextEdit {
  const lines = text.split('\n')
  let offset = 0
  let line = 0
  while (line < lines.length - 1 && offset + lines[line].length < start) {
    offset += lines[line].length + 1
    line++
  }
  const isRow = (value: string | undefined) => value !== undefined && /^\s*\|.*\|\s*$/.test(value)
  if (!isRow(lines[line])) return insertBlock(text, start, start, `Table: ${caption}`, [7, 7 + caption.length])
  while (isRow(lines[line + 1])) {
    offset += lines[line].length + 1
    line++
  }
  const at = offset + lines[line].length
  const inserted = `\nTable: ${caption}`
  return { text: text.slice(0, at) + inserted + text.slice(at), selectionStart: at + 8, selectionEnd: at + 8 + caption.length }
}

export function applyDocumentInsert(text: string, start: number, end: number, insert: DocumentInsert, placeholders: InsertPlaceholders): TextEdit {
  const selected = text.slice(start, end).replace(/\n+$/, '')
  switch (insert) {
    case 'note':
    case 'tip':
    case 'warning':
    case 'danger':
      return insertContainer(text, start, end, insert, selected || placeholders.text, selected ? 'title' : 'body', placeholders.title)
    case 'columns2':
    case 'columns3': {
      const count = insert === 'columns2' ? 2 : 3
      const first = selected || `${placeholders.column} 1`
      const rest = Array.from({ length: count - 1 }, (_, index) => `${placeholders.column} ${index + 2}`)
      return insertContainer(text, start, end, 'columns', [first, ...rest].join('\n+++\n'), 'body')
    }
    case 'center':
      return insertContainer(text, start, end, 'center', selected || placeholders.text, 'body')
    case 'pagebreak':
      return insertBlock(text, start, end, '\\pagebreak')
    case 'toc':
      return insertBlock(text, start, end, '[[toc]]')
    case 'tableCaption':
      return insertTableCaption(text, start, placeholders.caption)
  }
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
