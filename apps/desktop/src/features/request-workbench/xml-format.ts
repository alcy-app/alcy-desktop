import { parseXmlNodes } from './xml-syntax-highlight'
import type { XmlNode } from './xml-syntax-highlight'

const INDENT = '  '

function isWhitespaceOnly(text: string): boolean {
  return text.trim().length === 0
}

/**
 * Reindenta um documento XML, um elemento por linha. Nunca lança — entrada
 * malformada ou que não parece XML volta inalterada (mesmo princípio de
 * `formatJsonBody`: nunca esconder o corpo real por causa de um formato
 * inesperado). Um elemento cujo único filho é texto fica em uma linha só
 * (ex.: `<name>ana</name>`), sem indentar o texto separadamente.
 */
export function formatXmlBody(body: string): string {
  if (!body.trim().startsWith('<')) return body

  try {
    const nodes = parseXmlNodes(body).filter((node) => node.kind !== 'text' || !isWhitespaceOnly(node.raw))
    const lines: string[] = []
    let depth = 0

    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]

      if (node.kind === 'close') {
        depth = Math.max(0, depth - 1)
        lines.push(INDENT.repeat(depth) + node.raw)
        continue
      }

      if (node.kind === 'open') {
        const leafText = leafTextPair(nodes, index, node)
        if (leafText !== null) {
          lines.push(INDENT.repeat(depth) + node.raw + leafText.text.trim() + leafText.closeRaw)
          index += 2
          continue
        }
        lines.push(INDENT.repeat(depth) + node.raw)
        depth += 1
        continue
      }

      lines.push(INDENT.repeat(depth) + node.raw.trim())
    }

    return lines.join('\n')
  } catch {
    return body
  }
}

function leafTextPair(
  nodes: XmlNode[],
  index: number,
  open: XmlNode,
): { text: string; closeRaw: string } | null {
  const next = nodes[index + 1]
  const after = nodes[index + 2]
  if (next?.kind === 'text' && after?.kind === 'close' && after.tagName === open.tagName) {
    return { text: next.raw, closeRaw: after.raw }
  }
  return null
}
