import type {
  ScreenshotBlock,
  ScreenshotCodeBlock,
  ScreenshotContent,
  ScreenshotResponse,
  ScreenshotStatus,
  ScreenshotTableBlock,
} from './screenshot-content'
import { highlightLines, type HighlightSpan, type HighlightTone } from './screenshot-highlight'
import { SCREENSHOT_WIDTHS, type ScreenshotOptions } from './screenshot-options'
import type { ColorRole } from './screenshot-palette'

export interface FontSpec {
  family: 'sans' | 'mono'
  size: number
  weight: 400 | 600 | 700
  italic?: boolean
}

/** Drawing operations in logical pixels. `y` is the line box top;
 * the renderer centers text inside its height. */
export type DrawOp =
  | {
      kind: 'rect'
      x: number
      y: number
      width: number
      height: number
      radius: number
      fill: ColorRole | null
      /** Fill opacity for subtle chip and error backgrounds. */
      fillAlpha?: number
      stroke: ColorRole | null
    }
  | { kind: 'text'; x: number; y: number; height: number; text: string; font: FontSpec; color: ColorRole }
  | { kind: 'code'; x: number; y: number; height: number; spans: HighlightSpan[]; font: FontSpec }

export interface ScreenshotLayout {
  width: number
  height: number
  ops: DrawOp[]
  /** The image exceeded the maximum height and was clipped. */
  truncated: boolean
}

export type MeasureText = (text: string, font: FontSpec) => number

export interface ScreenshotLayoutLabels {
  request: string
  response: string
  headers: string
  body: string
  trailers: string
  environment: (name: string) => string
  capturedAt: (date: string) => string
  moreLines: (count: number) => string
  truncated: string
}

const TITLE_FONT: FontSpec = { family: 'sans', size: 20, weight: 600 }
const META_FONT: FontSpec = { family: 'sans', size: 12, weight: 400 }
const BRAND_FONT: FontSpec = { family: 'sans', size: 12, weight: 600 }
const SECTION_FONT: FontSpec = { family: 'sans', size: 11, weight: 700 }
const LABEL_FONT: FontSpec = { family: 'sans', size: 11, weight: 600 }
const URL_FONT: FontSpec = { family: 'mono', size: 14, weight: 400 }
const METHOD_FONT: FontSpec = { family: 'mono', size: 12, weight: 700 }
const CODE_FONT: FontSpec = { family: 'mono', size: 12, weight: 400 }
const CHIP_FONT: FontSpec = { family: 'sans', size: 12, weight: 600 }
const METRIC_FONT: FontSpec = { family: 'sans', size: 12, weight: 400 }
const NOTE_FONT: FontSpec = { family: 'sans', size: 12, weight: 400, italic: true }
const MESSAGE_FONT: FontSpec = { family: 'sans', size: 13, weight: 400 }

const PAGE_PADDING = 32
const HEADER_GAP = 20
const CARD_GAP = 16
const CARD_PADDING = 20
const CARD_RADIUS = 10
const BLOCK_GAP = 16
const WELL_PADDING = 12
const WELL_RADIUS = 6
const CODE_LINE_HEIGHT = 18
const BADGE_HEIGHT = 24
const CHIP_HEIGHT = 22
const MIN_CHARS = 8

/** Maximum logical height (16,000 exported pixels at 2x), below WebView canvas limits. */
export const MAX_SCREENSHOT_HEIGHT = 8_000

const lineHeightOf = (font: FontSpec) => Math.round(font.size * 1.5)

const STATUS_COLORS: Record<ScreenshotStatus['tone'], ColorRole> = {
  success: 'success',
  redirect: 'info',
  warning: 'warning',
  error: 'error',
  neutral: 'textMuted',
}

/** Splits monospaced text into chunks of at most `maxChars` characters. */
function chunkRanges(length: number, maxChars: number): Array<[number, number]> {
  if (length === 0) return [[0, 0]]
  const ranges: Array<[number, number]> = []
  for (let start = 0; start < length; start += maxChars) ranges.push([start, Math.min(start + maxChars, length)])
  return ranges
}

function sliceSpans(spans: HighlightSpan[], start: number, end: number): HighlightSpan[] {
  const result: HighlightSpan[] = []
  let offset = 0
  for (const span of spans) {
    const spanEnd = offset + span.text.length
    if (spanEnd > start && offset < end) {
      result.push({ text: span.text.slice(Math.max(start - offset, 0), Math.min(end, spanEnd) - offset), tone: span.tone })
    }
    offset = spanEnd
    if (offset >= end) break
  }
  return result
}

class LayoutBuilder {
  readonly ops: DrawOp[] = []
  readonly measure: MeasureText
  readonly labels: ScreenshotLayoutLabels
  private readonly codeCharWidth: number

  constructor(measure: MeasureText, labels: ScreenshotLayoutLabels) {
    this.measure = measure
    this.labels = labels
    this.codeCharWidth = measure('0', CODE_FONT)
  }

  charWidth(font: FontSpec): number {
    return font === CODE_FONT ? this.codeCharWidth : this.measure('0', font)
  }

  text(x: number, y: number, text: string, font: FontSpec, color: ColorRole): number {
    const height = lineHeightOf(font)
    this.ops.push({ kind: 'text', x, y, height, text, font, color })
    return height
  }

  code(x: number, y: number, spans: HighlightSpan[], font: FontSpec = CODE_FONT) {
    this.ops.push({ kind: 'code', x, y, height: CODE_LINE_HEIGHT, spans, font })
  }

  plainCode(x: number, y: number, text: string, tone: HighlightTone) {
    this.code(x, y, text ? [{ text, tone }] : [])
  }

  /** Ellipsizes proportional text that does not fit. */
  fit(text: string, font: FontSpec, maxWidth: number): string {
    if (this.measure(text, font) <= maxWidth) return text
    let low = 0
    let high = text.length
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.measure(`${text.slice(0, middle)}…`, font) <= maxWidth) low = middle
      else high = middle - 1
    }
    return `${text.slice(0, low)}…`
  }

  /** Wraps proportional text by words, splitting words longer than a line. */
  wrap(text: string, font: FontSpec, maxWidth: number): string[] {
    const lines: string[] = []
    for (const paragraph of text.split('\n')) {
      let current = ''
      for (const word of paragraph.split(' ')) {
        const candidate = current ? `${current} ${word}` : word
        if (this.measure(candidate, font) <= maxWidth) {
          current = candidate
          continue
        }
        if (current) lines.push(current)
        current = word
        while (current.length > 1 && this.measure(current, font) > maxWidth) {
          const fitted = this.fit(current, font, maxWidth).slice(0, -1)
          const cut = Math.max(fitted.length, 1)
          lines.push(current.slice(0, cut))
          current = current.slice(cut)
        }
      }
      lines.push(current)
    }
    return lines
  }

  /** Lays out content, then inserts its card background at the final height. */
  card(x: number, y: number, width: number, content: (x: number, y: number, width: number) => number) {
    const start = this.ops.length
    const bottom = content(x + CARD_PADDING, y + CARD_PADDING, width - CARD_PADDING * 2)
    const rect: Extract<DrawOp, { kind: 'rect' }> = {
      kind: 'rect',
      x,
      y,
      width,
      height: bottom - y + CARD_PADDING,
      radius: CARD_RADIUS,
      fill: 'surface',
      stroke: 'border',
    }
    this.ops.splice(start, 0, rect)
    return rect
  }

  /** Like `card`, for code and table backgrounds. */
  well(x: number, y: number, width: number, content: (x: number, y: number, width: number) => number): number {
    const start = this.ops.length
    const bottom = content(x + WELL_PADDING, y + WELL_PADDING, width - WELL_PADDING * 2) + WELL_PADDING
    this.ops.splice(start, 0, {
      kind: 'rect',
      x,
      y,
      width,
      height: bottom - y,
      radius: WELL_RADIUS,
      fill: 'surfaceRaised',
      stroke: 'borderSubtle',
    })
    return bottom
  }
}

function layoutHeader(b: LayoutBuilder, header: NonNullable<ScreenshotContent['header']>, x: number, y: number, width: number) {
  const brand = 'Alcy'
  const brandWidth = b.measure(brand, BRAND_FONT)
  b.text(x + width - brandWidth, y + 4, brand, BRAND_FONT, 'textMuted')
  y += b.text(x, y, b.fit(header.title, TITLE_FONT, width - brandWidth - 24), TITLE_FONT, 'textHeading')
  const meta = [header.environment ? b.labels.environment(header.environment) : null, b.labels.capturedAt(header.capturedAt)]
    .filter((part): part is string => part !== null)
    .join('  ·  ')
  y += b.text(x, y + 2, b.fit(meta, META_FONT, width), META_FONT, 'textMuted') + 2
  return y
}

function layoutEndpoint(b: LayoutBuilder, endpoint: NonNullable<ScreenshotContent['endpoint']>, x: number, y: number, width: number) {
  return b.card(x, y, width, (innerX, innerY, innerWidth) => {
    const badgeWidth = b.measure(endpoint.method, METHOD_FONT) + 16
    b.ops.push({ kind: 'rect', x: innerX, y: innerY, width: badgeWidth, height: BADGE_HEIGHT, radius: WELL_RADIUS, fill: 'accent', stroke: null })
    b.ops.push({ kind: 'text', x: innerX + 8, y: innerY, height: BADGE_HEIGHT, text: endpoint.method, font: METHOD_FONT, color: 'onAccent' })

    const urlX = innerX + badgeWidth + 12
    const maxChars = Math.max(MIN_CHARS, Math.floor((innerX + innerWidth - urlX) / b.charWidth(URL_FONT)))
    const url = endpoint.url || '—'
    const lineHeight = lineHeightOf(URL_FONT)
    // Center the first line in the badge and align subsequent lines with it.
    let lineY = innerY + (BADGE_HEIGHT - lineHeight) / 2
    for (const [start, end] of chunkRanges(url.length, maxChars)) {
      b.text(urlX, lineY, url.slice(start, end), URL_FONT, 'text')
      lineY += lineHeight
    }
    let bottom = Math.max(innerY + BADGE_HEIGHT, lineY)
    if (endpoint.rpc) {
      bottom += 8
      const rpcChars = Math.max(MIN_CHARS, Math.floor(innerWidth / b.charWidth(URL_FONT)))
      for (const [start, end] of chunkRanges(endpoint.rpc.length, rpcChars)) {
        bottom += b.text(innerX, bottom, endpoint.rpc.slice(start, end), URL_FONT, 'textHeading')
      }
    }
    return bottom
  })
}

function layoutTable(b: LayoutBuilder, block: ScreenshotTableBlock, x: number, y: number, width: number) {
  return b.well(x, y, width, (innerX, innerY, innerWidth) => {
    const charWidth = b.charWidth(CODE_FONT)
    const longestName = Math.max(...block.rows.map((row) => row.name.length), 1)
    const nameChars = Math.max(MIN_CHARS, Math.min(longestName, Math.floor((innerWidth * 0.35) / charWidth)))
    const valueX = innerX + nameChars * charWidth + 16
    const valueChars = Math.max(MIN_CHARS, Math.floor((innerX + innerWidth - valueX) / charWidth))
    let rowY = innerY
    block.rows.forEach((row, index) => {
      if (index > 0) {
        rowY += 4
        b.ops.push({ kind: 'rect', x: innerX, y: rowY, width: innerWidth, height: 1, radius: 0, fill: 'borderSubtle', stroke: null })
        rowY += 5
      }
      const names = chunkRanges(row.name.length, nameChars)
      const values = chunkRanges(row.value.length, valueChars)
      names.forEach(([start, end], line) => b.plainCode(innerX, rowY + line * CODE_LINE_HEIGHT, row.name.slice(start, end), 'key'))
      values.forEach(([start, end], line) => b.plainCode(valueX, rowY + line * CODE_LINE_HEIGHT, row.value.slice(start, end), 'plain'))
      rowY += Math.max(names.length, values.length) * CODE_LINE_HEIGHT
    })
    return rowY
  })
}

function layoutCode(b: LayoutBuilder, block: ScreenshotCodeBlock, x: number, y: number, width: number) {
  const bottom = b.well(x, y, width, (innerX, innerY, innerWidth) => {
    const charWidth = b.charWidth(CODE_FONT)
    const digits = String(Math.max(block.lines.length, 1)).length
    const codeX = innerX + digits * charWidth + 14
    const maxChars = Math.max(MIN_CHARS, Math.floor((innerX + innerWidth - codeX) / charWidth))
    let lineY = innerY
    highlightLines(block.lines, block.language).forEach((spans, index) => {
      const number = String(index + 1)
      b.plainCode(innerX + (digits - number.length) * charWidth, lineY, number, 'punctuation')
      const length = block.lines[index].length
      for (const [start, end] of chunkRanges(length, maxChars)) {
        b.code(codeX, lineY, sliceSpans(spans, start, end))
        lineY += CODE_LINE_HEIGHT
      }
    })
    if (block.omittedLines > 0) {
      lineY += 4
      lineY += b.text(codeX, lineY, b.labels.moreLines(block.omittedLines), NOTE_FONT, 'textMuted')
    }
    return lineY
  })
  if (!block.note) return bottom
  let noteY = bottom + 6
  for (const line of b.wrap(block.note, NOTE_FONT, width)) noteY += b.text(x, noteY, line, NOTE_FONT, 'textMuted')
  return noteY
}

function layoutBlock(b: LayoutBuilder, block: ScreenshotBlock, x: number, y: number, width: number) {
  if (block.label) y += b.text(x, y, block.label, LABEL_FONT, 'textMuted') + 4
  return block.kind === 'table' ? layoutTable(b, block, x, y, width) : layoutCode(b, block, x, y, width)
}

function sectionTitle(b: LayoutBuilder, title: string, x: number, y: number) {
  return y + b.text(x, y, title.toUpperCase(), SECTION_FONT, 'textMuted') + 8
}

function layoutRequest(b: LayoutBuilder, request: NonNullable<ScreenshotContent['request']>, x: number, y: number, width: number) {
  return b.card(x, y, width, (innerX, innerY, innerWidth) => {
    let blockY = sectionTitle(b, b.labels.request, innerX, innerY)
    const blocks: ScreenshotBlock[] = [
      ...(request.headers ? [{ kind: 'table' as const, label: b.labels.headers, rows: request.headers }] : []),
      ...(request.body ?? []),
    ]
    blocks.forEach((block, index) => {
      if (index > 0) blockY += BLOCK_GAP
      blockY = layoutBlock(b, block, innerX, blockY, innerWidth)
    })
    return blockY
  })
}

/** Places status chips and metrics beside the title when they fit, or below it. */
function layoutStatus(b: LayoutBuilder, status: ScreenshotStatus, titleX: number, titleY: number, titleWidth: number, width: number) {
  const chips: Array<{ text: string; color: ColorRole }> = [{
    text: status.grpc ? `gRPC ${status.statusCode} ${status.grpc.codeName}` : `HTTP ${status.statusCode}`,
    color: STATUS_COLORS[status.tone],
  }]
  if (status.graphql) {
    chips.push({ text: `GraphQL: ${status.graphql === 'error' ? 'Error' : 'Success'}`, color: status.graphql === 'error' ? 'error' : 'success' })
  }
  const metrics = `${status.duration}  ·  ${status.size}`
  const chipWidths = chips.map((chip) => b.measure(chip.text, CHIP_FONT) + 16)
  const metricsWidth = b.measure(metrics, METRIC_FONT)
  const total = chipWidths.reduce((sum, chipWidth) => sum + chipWidth + 8, 0) + 4 + metricsWidth

  const inline = titleWidth + 24 + total <= width
  let chipX = inline ? titleX + width - total : titleX
  const chipY = inline ? titleY + (lineHeightOf(SECTION_FONT) - CHIP_HEIGHT) / 2 : titleY + lineHeightOf(SECTION_FONT) + 8
  chips.forEach((chip, index) => {
    b.ops.push({ kind: 'rect', x: chipX, y: chipY, width: chipWidths[index], height: CHIP_HEIGHT, radius: CHIP_HEIGHT / 2, fill: chip.color, fillAlpha: 0.14, stroke: null })
    b.ops.push({ kind: 'text', x: chipX + 8, y: chipY, height: CHIP_HEIGHT, text: chip.text, font: CHIP_FONT, color: chip.color })
    chipX += chipWidths[index] + 8
  })
  const wrapMetrics = chipX + 4 + metricsWidth > titleX + width
  const metricsY = wrapMetrics ? chipY + CHIP_HEIGHT + 8 : chipY
  b.ops.push({ kind: 'text', x: wrapMetrics ? titleX : chipX + 4, y: metricsY, height: CHIP_HEIGHT, text: metrics, font: METRIC_FONT, color: 'textMuted' })
  return inline ? titleY + lineHeightOf(SECTION_FONT) + 8 : metricsY + CHIP_HEIGHT + 12
}

function layoutResponse(b: LayoutBuilder, response: ScreenshotResponse, x: number, y: number, width: number) {
  return b.card(x, y, width, (innerX, innerY, innerWidth) => {
    const title = b.labels.response.toUpperCase()
    if (response.kind === 'error') {
      let messageY = sectionTitle(b, title, innerX, innerY)
      const lines = b.wrap(response.message, MESSAGE_FONT, innerWidth - WELL_PADDING * 2)
      const height = lines.length * lineHeightOf(MESSAGE_FONT) + WELL_PADDING * 2
      b.ops.push({ kind: 'rect', x: innerX, y: messageY, width: innerWidth, height, radius: WELL_RADIUS, fill: 'error', fillAlpha: 0.1, stroke: null })
      let lineY = messageY + WELL_PADDING
      for (const line of lines) lineY += b.text(innerX + WELL_PADDING, lineY, line, MESSAGE_FONT, 'error')
      messageY += height
      return messageY
    }

    let blockY = response.status
      ? layoutStatus(b, response.status, innerX, innerY, b.measure(title, SECTION_FONT), innerWidth)
      : sectionTitle(b, title, innerX, innerY)
    if (response.status) b.text(innerX, innerY, title, SECTION_FONT, 'textMuted')
    if (response.status?.grpc?.message) {
      for (const line of b.wrap(response.status.grpc.message, MESSAGE_FONT, innerWidth)) {
        blockY += b.text(innerX, blockY, line, MESSAGE_FONT, STATUS_COLORS[response.status.tone])
      }
      blockY += 8
    }
    const blocks: ScreenshotBlock[] = [
      ...(response.headers ? [{ kind: 'table' as const, label: b.labels.headers, rows: response.headers }] : []),
      ...(response.trailers ? [{ kind: 'table' as const, label: b.labels.trailers, rows: response.trailers }] : []),
      ...(response.body ? [{ ...response.body, label: response.body.label ?? b.labels.body }] : []),
    ]
    blocks.forEach((block, index) => {
      if (index > 0) blockY += BLOCK_GAP
      blockY = layoutBlock(b, block, innerX, blockY, innerWidth)
    })
    // Remove the next-block spacing when only the title is present.
    return blocks.length > 0 ? blockY : blockY - 8
  })
}

function opBottom(op: DrawOp): number {
  return op.y + op.height
}

/** Clips content at the maximum height and adds a footer notice. */
function capHeight(b: LayoutBuilder, width: number): ScreenshotLayout {
  const cut = MAX_SCREENSHOT_HEIGHT - PAGE_PADDING - 24
  const ops = b.ops
    .filter((op) => op.y < cut && (op.kind === 'rect' || opBottom(op) <= cut))
    .map((op) => (op.kind === 'rect' && opBottom(op) > cut ? { ...op, height: cut - op.y } : op))
  ops.push({ kind: 'text', x: PAGE_PADDING, y: cut + 8, height: lineHeightOf(NOTE_FONT), text: b.labels.truncated, font: NOTE_FONT, color: 'textMuted' })
  return { width, height: MAX_SCREENSHOT_HEIGHT, ops, truncated: true }
}

/** Positions the header, endpoint, request and response cards vertically or
 * in equal-height columns. Long lines wrap within their column. */
export function layoutScreenshot(
  content: ScreenshotContent,
  options: Pick<ScreenshotOptions, 'layout' | 'width'>,
  measure: MeasureText,
  labels: ScreenshotLayoutLabels,
): ScreenshotLayout {
  const width = SCREENSHOT_WIDTHS[options.width]
  const b = new LayoutBuilder(measure, labels)
  const x = PAGE_PADDING
  const innerWidth = width - PAGE_PADDING * 2
  let bottom = PAGE_PADDING
  let y = PAGE_PADDING

  const place = (nextBottom: number, gap: number) => {
    bottom = nextBottom
    y = nextBottom + gap
  }

  if (content.header) place(layoutHeader(b, content.header, x, y, innerWidth), HEADER_GAP)
  if (content.endpoint) place(opBottom(layoutEndpoint(b, content.endpoint, x, y, innerWidth)), CARD_GAP)

  const { request, response } = content
  if (request && response && options.layout === 'sideBySide') {
    const columnWidth = (innerWidth - CARD_GAP) / 2
    const left = layoutRequest(b, request, x, y, columnWidth)
    const right = layoutResponse(b, response, x + columnWidth + CARD_GAP, y, columnWidth)
    const height = Math.max(left.height, right.height)
    left.height = height
    right.height = height
    place(y + height, CARD_GAP)
  } else {
    if (request) place(opBottom(layoutRequest(b, request, x, y, innerWidth)), CARD_GAP)
    if (response) place(opBottom(layoutResponse(b, response, x, y, innerWidth)), CARD_GAP)
  }

  const height = Math.ceil(bottom + PAGE_PADDING)
  if (height > MAX_SCREENSHOT_HEIGHT) return capHeight(b, width)
  return { width, height, ops: b.ops, truncated: false }
}
