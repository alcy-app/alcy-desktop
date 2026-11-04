/**
 * The document dialect (ADR 0069) for the live preview: Markdown plus a
 * metadata block, `:::` containers, page control and table captions. The PDF
 * export parses the same syntax natively (`alcy-app` documentation_markdown);
 * the test cases on both sides mirror each other.
 */
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from '../notifications/markdown'

export const METADATA_KEYS = ['subtitle', 'author', 'version', 'date', 'status', 'theme', 'lang', 'cover', 'toc', 'numbering'] as const
export type MetadataKey = (typeof METADATA_KEYS)[number]
export type BlockAlign = 'left' | 'center' | 'right'
export type CalloutKind = 'note' | 'tip' | 'warning' | 'danger'

export interface DocumentMeta {
  subtitle?: string
  author?: string
  version?: string
  date?: string
  status?: string
  theme?: string
  lang?: string
  cover: boolean
  toc: boolean
  numbering: boolean
}

export type DocBlock =
  | { type: 'markdown'; block: MarkdownBlock; align: BlockAlign; caption?: string }
  | { type: 'callout'; kind: CalloutKind; title?: string; children: DocBlock[] }
  | { type: 'columns'; columns: DocBlock[][] }
  | { type: 'pagebreak' }
  | { type: 'toc' }

export interface OutlineEntry { level: number; text: string; number?: string; block: MarkdownBlock }

export interface DocumentDialect {
  meta: DocumentMeta
  blocks: DocBlock[]
  outline: OutlineEntry[]
  /** Automatic numbers by node: heading blocks, captioned tables and captioned images. */
  headingNumbers: Map<MarkdownBlock, string>
  tableNumbers: Map<MarkdownBlock, number>
  figureNumbers: Map<MarkdownInline, number>
}

const MAX_COLUMNS = 3

/** The leading `---` block when every line in it is `key: value`. */
export function splitFrontMatter(markdown: string): { pairs: [string, string][]; bodyStart: number } | null {
  const lines = markdown.split(/(?<=\n)/)
  if (lines.length === 0 || lines[0].trimEnd() !== '---') return null
  let offset = lines[0].length
  const pairs: [string, string][] = []
  for (const line of lines.slice(1)) {
    offset += line.length
    const text = line.trimEnd()
    if (text === '---') return { pairs, bodyStart: offset }
    if (text.trim() === '') continue
    const match = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(text)
    if (!match) return null
    pairs.push([match[1].toLowerCase(), unquote(match[2].trim())])
  }
  return null
}

function unquote(value: string): string {
  for (const quote of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) return value.slice(1, -1)
  }
  return value
}

const truthy = (value: string) => ['true', 'yes', 'sim', 'on', '1'].includes(value.toLowerCase())

export function parseMeta(pairs: [string, string][]): DocumentMeta {
  const meta: DocumentMeta = { cover: false, toc: false, numbering: false }
  for (const [key, value] of pairs) {
    if (key === 'cover' || key === 'toc' || key === 'numbering') meta[key] = truthy(value)
    else if ((METADATA_KEYS as readonly string[]).includes(key) && value) meta[key as Exclude<MetadataKey, 'cover' | 'toc' | 'numbering'>] = value
  }
  return meta
}

/** Sets or removes (`null`) metadata keys, keeping unknown keys and the body. */
export function setFrontMatter(markdown: string, patch: Partial<Record<MetadataKey, string | null>>): string {
  const found = splitFrontMatter(markdown)
  const pairs = found ? [...found.pairs] : []
  for (const [key, raw] of Object.entries(patch) as [MetadataKey, string | null | undefined][]) {
    if (raw === undefined) continue
    const value = raw?.replace(/[\r\n]+/g, ' ').trim() ?? ''
    const index = pairs.findIndex(([existing]) => existing === key)
    if (!value) {
      if (index >= 0) pairs.splice(index, 1)
    } else if (index >= 0) {
      pairs[index] = [key, value]
    } else {
      const order = (name: string) => { const at = (METADATA_KEYS as readonly string[]).indexOf(name); return at < 0 ? Number.MAX_SAFE_INTEGER : at }
      const at = pairs.findIndex(([existing]) => order(existing) > order(key))
      pairs.splice(at < 0 ? pairs.length : at, 0, [key, value])
    }
  }
  const body = markdown.slice(found?.bodyStart ?? 0).replace(/^[\r\n]+/, '')
  if (pairs.length === 0) return body
  return `---\n${pairs.map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n${body}`
}

const CONTAINERS: Record<string, { kind: 'callout'; callout: CalloutKind } | { kind: 'columns' } | { kind: 'align'; align: BlockAlign }> = {
  note: { kind: 'callout', callout: 'note' }, info: { kind: 'callout', callout: 'note' },
  tip: { kind: 'callout', callout: 'tip' }, success: { kind: 'callout', callout: 'tip' },
  warning: { kind: 'callout', callout: 'warning' }, important: { kind: 'callout', callout: 'warning' }, caution: { kind: 'callout', callout: 'warning' },
  danger: { kind: 'callout', callout: 'danger' }, error: { kind: 'callout', callout: 'danger' },
  columns: { kind: 'columns' },
  center: { kind: 'align', align: 'center' },
  right: { kind: 'align', align: 'right' },
}

type Segment =
  | { type: 'markdown'; text: string }
  | { type: 'container'; name: string; title?: string; columns: Segment[][] }
  | { type: 'pagebreak' }
  | { type: 'toc' }
  | { type: 'caption'; text: string }

interface OpenContainer { name: string; title?: string; columns: Segment[][]; current: Segment[] }

function fenceOpen(line: string): [string, number] | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
  return match ? [match[1][0], match[1].length] : null
}

function scan(body: string): Segment[] {
  const root: Segment[] = []
  const stack: OpenContainer[] = []
  let buffer = ''
  let fence: [string, number] | null = null
  let lastLineWasTable = false
  const target = () => stack.length > 0 ? stack[stack.length - 1].current : root
  const flush = () => {
    if (buffer.trim()) target().push({ type: 'markdown', text: buffer })
    buffer = ''
  }
  const close = (open: OpenContainer): Segment => ({ type: 'container', name: open.name, title: open.title, columns: [...open.columns, open.current] })

  for (const line of body.split(/(?<=\n)/)) {
    const text = line.replace(/\r?\n$/, '')
    if (fence) {
      const trimmed = text.trim()
      if (trimmed.length >= fence[1] && [...trimmed].every((c) => c === fence?.[0])) fence = null
      buffer += line
      continue
    }
    const opened = fenceOpen(text)
    if (opened) {
      fence = opened
      buffer += line
      lastLineWasTable = false
      continue
    }
    const trimmed = text.trim()
    if (trimmed.startsWith(':::')) {
      const rest = trimmed.slice(3).trim()
      if (!rest && stack.length > 0) {
        flush()
        const open = stack.pop()
        if (open) target().push(close(open))
        lastLineWasTable = false
        continue
      }
      const [name, ...title] = rest.split(/\s+/)
      if (rest && CONTAINERS[name.toLowerCase()]) {
        flush()
        stack.push({ name: name.toLowerCase(), title: title.join(' ') || undefined, columns: [], current: [] })
        lastLineWasTable = false
        continue
      }
    }
    const top = stack[stack.length - 1]
    if (trimmed === '+++' && top && CONTAINERS[top.name].kind === 'columns' && top.columns.length + 1 < MAX_COLUMNS) {
      flush()
      top.columns.push(top.current)
      top.current = []
      continue
    }
    if (trimmed === '\\pagebreak' || trimmed.toLowerCase() === '[[toc]]') {
      flush()
      target().push({ type: trimmed === '\\pagebreak' ? 'pagebreak' : 'toc' })
      lastLineWasTable = false
      continue
    }
    if (lastLineWasTable && trimmed.startsWith('Table:')) {
      flush()
      target().push({ type: 'caption', text: trimmed.slice(6).trim() })
      lastLineWasTable = false
      continue
    }
    if (trimmed) lastLineWasTable = trimmed.startsWith('|') || trimmed.endsWith('|')
    buffer += line
  }
  flush()
  while (stack.length > 0) {
    const open = stack.pop()
    if (open) target().push(close(open))
  }
  return root
}

function convert(segments: Segment[], align: BlockAlign, inColumns: boolean, out: DocBlock[]) {
  for (const segment of segments) {
    if (segment.type === 'markdown') {
      for (const block of parseMarkdown(segment.text)) out.push({ type: 'markdown', block, align })
    } else if (segment.type === 'pagebreak' || segment.type === 'toc') {
      out.push({ type: segment.type })
    } else if (segment.type === 'caption') {
      const last = out[out.length - 1]
      if (last?.type === 'markdown' && last.block.type === 'table' && last.caption === undefined) last.caption = segment.text
      else out.push({ type: 'markdown', block: { type: 'paragraph', children: [{ type: 'text', text: `Table: ${segment.text}` }] }, align })
    } else {
      const container = CONTAINERS[segment.name]
      if (container.kind === 'callout') {
        const children: DocBlock[] = []
        for (const column of segment.columns) convert(column, 'left', inColumns, children)
        out.push({ type: 'callout', kind: container.callout, title: segment.title, children })
      } else if (container.kind === 'align') {
        for (const column of segment.columns) convert(column, container.align, inColumns, out)
      } else if (inColumns) {
        // Columns inside columns stack their content.
        for (const column of segment.columns) convert(column, align, true, out)
      } else {
        const columns = segment.columns.map((column) => { const blocks: DocBlock[] = []; convert(column, align, true, blocks); return blocks }).filter((blocks) => blocks.length > 0)
        if (columns.length === 1) out.push(...columns[0])
        else if (columns.length > 1) out.push({ type: 'columns', columns })
      }
    }
  }
}

export function inlineText(nodes: MarkdownInline[]): string {
  return nodes.map((node) => node.type === 'text' || node.type === 'code' ? node.text : node.type === 'image' ? node.caption : node.type === 'break' ? ' ' : inlineText(node.children)).join('')
}

/** Numbers headings (when enabled), captioned tables and captioned images in document order. */
function numberBlocks(blocks: DocBlock[], dialect: DocumentDialect) {
  const headings = [0, 0, 0]
  let figures = 0
  let tables = 0
  const visitInline = (nodes: MarkdownInline[]) => {
    for (const node of nodes) {
      if (node.type === 'image' && node.caption.trim()) dialect.figureNumbers.set(node, ++figures)
      else if ('children' in node) visitInline(node.children)
    }
  }
  const visitMarkdown = (block: MarkdownBlock, caption?: string) => {
    switch (block.type) {
      case 'heading': {
        let number: string | undefined
        if (dialect.meta.numbering && block.level <= 3) {
          const index = block.level - 1
          headings[index] += 1
          for (let deeper = index + 1; deeper < headings.length; deeper++) headings[deeper] = 0
          number = headings.slice(0, index + 1).map((n) => Math.max(n, 1)).join('.')
          dialect.headingNumbers.set(block, number)
        }
        dialect.outline.push({ level: block.level, text: inlineText(block.children), number, block })
        visitInline(block.children)
        break
      }
      case 'paragraph': visitInline(block.children); break
      case 'table':
        if (caption !== undefined) dialect.tableNumbers.set(block, ++tables)
        break
      case 'quote': block.children.forEach((child) => visitMarkdown(child)); break
      case 'list': block.items.forEach((item) => item.forEach((child) => visitMarkdown(child))); break
      default: break
    }
  }
  const visit = (list: DocBlock[]) => {
    for (const block of list) {
      if (block.type === 'markdown') visitMarkdown(block.block, block.caption)
      else if (block.type === 'callout') visit(block.children)
      else if (block.type === 'columns') block.columns.forEach(visit)
    }
  }
  visit(blocks)
}

export function parseDocument(markdown: string): DocumentDialect {
  const found = splitFrontMatter(markdown)
  const meta = parseMeta(found?.pairs ?? [])
  const blocks: DocBlock[] = []
  convert(scan(markdown.slice(found?.bodyStart ?? 0)), 'left', false, blocks)
  const dialect: DocumentDialect = { meta, blocks, outline: [], headingNumbers: new Map(), tableNumbers: new Map(), figureNumbers: new Map() }
  numberBlocks(blocks, dialect)
  return dialect
}
