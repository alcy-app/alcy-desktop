export type XmlNodeKind = 'open' | 'close' | 'selfclose' | 'comment' | 'cdata' | 'declaration' | 'text'

export interface XmlNode {
  kind: XmlNodeKind
  raw: string
  tagName?: string
}

const NODE_PATTERN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/[^>]*>|<[^>]*>/g
const TAG_NAME_PATTERN = /^<\/?\s*([A-Za-z_][\w:.-]*)/

function classify(raw: string): XmlNode {
  if (raw.startsWith('<!--')) return { kind: 'comment', raw }
  if (raw.startsWith('<![CDATA[')) return { kind: 'cdata', raw }
  if (raw.startsWith('<?')) return { kind: 'declaration', raw }
  const tagName = TAG_NAME_PATTERN.exec(raw)?.[1]
  if (raw.startsWith('</')) return { kind: 'close', raw, tagName }
  if (raw.endsWith('/>')) return { kind: 'selfclose', raw, tagName }
  return { kind: 'open', raw, tagName }
}

/**
 * Quebra o XML em nós de nível estrutural (tags, comentários, CDATA,
 * declaração, texto). Nunca descarta caracteres — a soma de `raw` de todos
 * os nós reconstrói `source` exatamente, mesmo para XML incompleto/malformado
 * (ex.: um `<` solto sem `>` correspondente vira parte de um nó `text`).
 * Usado por `formatXmlBody` (indentação, em `xml-format.ts`).
 */
export function parseXmlNodes(source: string): XmlNode[] {
  if (source.length === 0) return []

  const nodes: XmlNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  NODE_PATTERN.lastIndex = 0
  while ((match = NODE_PATTERN.exec(source))) {
    if (match.index > cursor) nodes.push({ kind: 'text', raw: source.slice(cursor, match.index) })
    nodes.push(classify(match[0]))
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) nodes.push({ kind: 'text', raw: source.slice(cursor) })

  return nodes
}

