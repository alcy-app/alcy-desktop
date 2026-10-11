/**
 * Subconjunto de Markdown (CommonMark/GitLab) usado nos detalhes das
 * notificações, como as notas de uma release. Gera uma árvore simples que a
 * interface transforma em elementos React: nada vira HTML cru, e só URLs
 * http(s) viram links. HTML e tabelas aparecem como texto literal.
 */

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] }
  | { type: 'del'; children: MarkdownInline[] }
  | { type: 'link'; url: string; children: MarkdownInline[] }
  | { type: 'break' }

export type MarkdownBlock =
  | { type: 'heading'; level: number; children: MarkdownInline[] }
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'code'; text: string }
  | { type: 'quote'; children: MarkdownBlock[] }
  | { type: 'list'; ordered: boolean; start: number; tight: boolean; items: MarkdownBlock[][] }
  | { type: 'rule' }

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const SAFE_URL = /^https?:\/\/[^\s<>]+$/i
const BARE_URL = /https?:\/\/[^\s<>]+/gi
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

interface ListMarker {
  indent: number
  ordered: boolean
  start: number
  /** Coluna onde começa o conteúdo do item; linhas de continuação recuam até ela. */
  contentIndent: number
  content: string
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  return parseBlocks(lines)
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function matchListItem(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line)
  if (!match) return null
  const [, spaces, marker, gap, content] = match
  const ordered = /\d/.test(marker)
  // Recuo de 5+ espaços após o marcador é código no CommonMark; aqui só limita a coluna.
  const contentIndent = spaces.length + marker.length + (gap.length === 0 || gap.length > 4 ? 1 : gap.length)
  return { indent: spaces.length, ordered, start: ordered ? Number.parseInt(marker, 10) : 1, contentIndent, content }
}

/** Linha que encerra um parágrafo por começar outro bloco. */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || matchListItem(line) !== null
}

function parseBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      index++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const indent = indentOf(line)
      const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
      const code: string[] = []
      index++
      while (index < lines.length && !closing.test(lines[index])) {
        code.push(lines[index].slice(Math.min(indent, indentOf(lines[index]))))
        index++
      }
      index++
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] ?? '') })
      index++
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      index++
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && !isBlank(lines[index])) {
        const match = QUOTE.exec(lines[index])
        quoted.push(match ? match[1] : lines[index])
        index++
      }
      blocks.push({ type: 'quote', children: parseBlocks(quoted) })
      continue
    }

    const marker = matchListItem(line)
    if (marker) {
      index = parseList(lines, index, marker, blocks)
      continue
    }

    const paragraph: string[] = []
    let level = 0
    while (index < lines.length && !isBlank(lines[index])) {
      if (paragraph.length > 0) {
        const setext = SETEXT.exec(lines[index])
        if (setext) {
          level = setext[1].startsWith('=') ? 1 : 2
          index++
          break
        }
        if (startsBlock(lines[index])) break
      }
      paragraph.push(lines[index].trimStart())
      index++
    }
    const children = parseInline(paragraph.join('\n'))
    blocks.push(level > 0 ? { type: 'heading', level, children } : { type: 'paragraph', children })
  }

  return blocks
}

function parseList(lines: string[], start: number, first: ListMarker, blocks: MarkdownBlock[]): number {
  const items: MarkdownBlock[][] = []
  let tight = true
  let index = start
  let marker: ListMarker | null = first

  while (marker && marker.ordered === first.ordered) {
    const item = [marker.content]
    let lastBlank = false
    index++

    while (index < lines.length) {
      const line = lines[index]
      if (isBlank(line)) {
        lastBlank = true
        item.push('')
        index++
        continue
      }
      const indent = indentOf(line)
      const nested = indent > marker.indent ? matchListItem(line) : null
      if (indent >= marker.contentIndent || nested) {
        item.push(line.slice(Math.min(indent, marker.contentIndent)))
      } else if (!lastBlank && !startsBlock(line)) {
        // Continuação "preguiçosa" do parágrafo do item, sem recuo.
        item.push(line.trimStart())
      } else {
        break
      }
      lastBlank = false
      index++
    }

    while (item.length > 0 && item[item.length - 1] === '') item.pop()
    if (item.includes('')) tight = false
    items.push(parseBlocks(item))

    const next: ListMarker | null = index < lines.length ? matchListItem(lines[index]) : null
    if (next && next.indent <= first.indent + 3 && next.ordered === first.ordered) {
      if (lastBlank) tight = false
      marker = next
    } else {
      marker = null
    }
  }

  blocks.push({ type: 'list', ordered: first.ordered, start: first.start, tight, items })
  return index
}

/**
 * Converte o texto de um bloco em trechos; `\n` vira espaço, ou quebra se a
 * linha terminar em dois espaços ou `\`. `autolink` desliga as URLs soltas
 * dentro do texto de um link, que não pode conter outro link.
 */
export function parseInline(text: string, autolink = true): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let buffer = ''

  const flush = () => {
    if (buffer) pushText(nodes, buffer, autolink)
    buffer = ''
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]

    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1]
      if (next === '\n') {
        flush()
        nodes.push({ type: 'break' })
        index += 2
        continue
      }
      if (ESCAPABLE.test(next)) {
        buffer += next
        index += 2
        continue
      }
    }

    if (char === '\n') {
      const hardBreak = / {2,}$/.test(buffer)
      buffer = buffer.replace(/ +$/, '')
      if (hardBreak) {
        flush()
        nodes.push({ type: 'break' })
      } else {
        buffer += ' '
      }
      index++
      continue
    }

    if (char === '`') {
      const run = backtickRun(text, index)
      const close = findCodeClose(text, index + run.length, run.length)
      if (close !== -1) {
        flush()
        let code = text.slice(index + run.length, close).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        nodes.push({ type: 'code', text: code })
        index = close + run.length
        continue
      }
      buffer += run
      index += run.length
      continue
    }

    const link = parseLink(text, index)
    if (link) {
      flush()
      nodes.push(...link.nodes)
      index = link.end
      continue
    }

    if (char === '<') {
      const close = text.indexOf('>', index)
      const url = close === -1 ? '' : text.slice(index + 1, close)
      if (SAFE_URL.test(url)) {
        flush()
        nodes.push({ type: 'link', url, children: [{ type: 'text', text: url }] })
        index = close + 1
        continue
      }
    }

    const emphasis = parseEmphasis(text, index, autolink)
    if (emphasis) {
      flush()
      nodes.push(emphasis.node)
      index = emphasis.end
      continue
    }

    buffer += char
    index++
  }

  flush()
  return nodes
}

function backtickRun(text: string, index: number): string {
  let end = index
  while (text[end] === '`') end++
  return text.slice(index, end)
}

function findCodeClose(text: string, from: number, length: number): number {
  let index = text.indexOf('`', from)
  while (index !== -1) {
    const run = backtickRun(text, index)
    if (run.length === length) return index
    index = text.indexOf('`', index + run.length)
  }
  return -1
}

/** Posição do `]` que fecha o `[` em `open`, respeitando colchetes aninhados e escapes. */
function findLabelClose(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') index++
    else if (char === '[') depth++
    else if (char === ']' && --depth === 0) return index
  }
  return -1
}

/** `[texto](url "título")` e `![alt](url)`; imagens não são carregadas, viram link para o arquivo. */
function parseLink(text: string, index: number): { nodes: MarkdownInline[]; end: number } | null {
  const image = text[index] === '!' && text[index + 1] === '['
  const open = image ? index + 1 : index
  if (text[open] !== '[') return null
  const close = findLabelClose(text, open)
  if (close === -1 || text[close + 1] !== '(') return null
  const target = /^\(\s*<?([^\s<>()]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(text.slice(close + 1))
  if (!target) return null

  const label = text.slice(open + 1, close)
  const url = target[1]
  const children = image ? [{ type: 'text' as const, text: label || url }] : parseInline(label, false)
  const end = close + 1 + target[0].length
  // Sem esquema http(s) (caminho relativo, mailto:, javascript:…) só o texto aparece.
  return { nodes: SAFE_URL.test(url) ? [{ type: 'link', url, children }] : children, end }
}

function parseEmphasis(text: string, index: number, autolink: boolean): { node: MarkdownInline; end: number } | null {
  const char = text[index]
  if (char !== '*' && char !== '_' && char !== '~') return null

  const double = text[index + 1] === char
  if (char === '~' && !double) return null
  const delimiter = double ? char + char : char
  const contentStart = index + delimiter.length
  if (contentStart >= text.length || /\s/.test(text[contentStart])) return null
  // `_` dentro de palavras (snake_case) é texto.
  if (char === '_' && index > 0 && /\w/.test(text[index - 1])) return null

  let search = contentStart + 1
  while (search < text.length) {
    const close = text.indexOf(delimiter, search)
    if (close === -1) return null
    const after = text[close + delimiter.length]
    const validClose =
      !/\s/.test(text[close - 1]) &&
      (double || (after !== char && text[close - 1] !== char)) &&
      !(char === '_' && after !== undefined && /\w/.test(after))
    if (validClose) {
      const children = parseInline(text.slice(contentStart, close), autolink)
      const type = char === '~' ? 'del' : double ? 'strong' : 'em'
      return { node: { type, children }, end: close + delimiter.length }
    }
    search = close + 1
  }
  return null
}

/** Texto comum, com URLs soltas viradas em link (como o GitLab faz). */
function pushText(nodes: MarkdownInline[], text: string, autolink: boolean) {
  if (!autolink) {
    nodes.push({ type: 'text', text })
    return
  }
  let cursor = 0
  for (const match of text.matchAll(BARE_URL)) {
    // Pontuação no fim pertence à frase, não à URL.
    const url = match[0].replace(/[.,;:!?'")\]]+$/, '')
    if (match.index > cursor) nodes.push({ type: 'text', text: text.slice(cursor, match.index) })
    nodes.push({ type: 'link', url, children: [{ type: 'text', text: url }] })
    cursor = match.index + url.length
  }
  if (cursor < text.length) nodes.push({ type: 'text', text: text.slice(cursor) })
}
