export type MessageSegment = { type: 'text'; text: string } | { type: 'link'; text: string; url: string }

/** `[texto](https://…)`; só http(s) vira link, o resto fica como texto literal. */
const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g

/** Separa a mensagem em trechos de texto e links, preservando o texto (inclusive `\n`) entre eles. */
export function parseMessage(message: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let cursor = 0

  for (const match of message.matchAll(LINK_PATTERN)) {
    if (match.index > cursor) segments.push({ type: 'text', text: message.slice(cursor, match.index) })
    segments.push({ type: 'link', text: match[1], url: match[2] })
    cursor = match.index + match[0].length
  }

  if (cursor < message.length) segments.push({ type: 'text', text: message.slice(cursor) })
  return segments
}
