import type { HighlightLanguage } from '../request-workbench/screenshot/screenshot-highlight'

/** Larger texts skip JSON detection and coloring to keep the chat responsive. */
const MAX_DETECT_CHARS = 512 * 1024
const MAX_HIGHLIGHT_CHARS = 100_000
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/

const LANGUAGE_ALIASES = new Map<string, HighlightLanguage>([
  ['json', 'json'], ['jsonc', 'json'], ['json5', 'json'],
  ['graphql', 'graphql'], ['gql', 'graphql'],
  ['xml', 'xml'], ['svg', 'xml'],
  ['html', 'html'],
  // TypeScript colors well enough with the JavaScript grammar.
  ...['js', 'javascript', 'jsx', 'mjs', 'cjs', 'ts', 'typescript', 'tsx'].map((name): [string, HighlightLanguage] => [name, 'javascript']),
])

export type MessageSegment = { type: 'text'; text: string } | { type: 'code'; text: string; lang?: string }

/** A JSON object or array, the shapes worth showing as a block. */
export function isJsonDocument(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length > MAX_DETECT_CHARS || !/^[[{]/.test(trimmed)) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/** Language shown on a code block and used to color it; untagged JSON is recognized by its content. */
export function codeBlockLanguage(lang: string | undefined, text: string): { label: string | null; highlight: HighlightLanguage } {
  const large = text.length > MAX_HIGHLIGHT_CHARS
  if (lang) return { label: lang, highlight: (!large && LANGUAGE_ALIASES.get(lang)) || 'text' }
  if (isJsonDocument(text)) return { label: 'json', highlight: large ? 'text' : 'json' }
  return { label: null, highlight: 'text' }
}

/**
 * Splits a user message into plain text and fenced code blocks; the text
 * stays literal (no Markdown). A message that is only a JSON document shows
 * as a JSON block, as when it was pasted before the composer fenced it.
 */
export function splitUserMessage(text: string): MessageSegment[] {
  if (isJsonDocument(text)) return [{ type: 'code', text: text.trim(), lang: 'json' }]
  const segments: MessageSegment[] = []
  const lines = text.split('\n')
  let prose: string[] = []
  const flushProse = () => {
    const joined = prose.join('\n').replace(/^\n+|\n+$/g, '')
    if (joined.trim()) segments.push({ type: 'text', text: joined })
    prose = []
  }

  for (let index = 0; index < lines.length; index++) {
    const fence = FENCE.exec(lines[index])
    if (!fence) {
      prose.push(lines[index])
      continue
    }
    flushProse()
    const marker = fence[1]
    const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
    const code: string[] = []
    index++
    while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++])
    const lang = fence[2].toLowerCase()
    segments.push({ type: 'code', text: code.join('\n'), ...(lang && { lang }) })
  }
  flushProse()
  return segments
}

/** Whether `offset` falls inside a fenced block of `text` that is still open there. */
function insideFence(text: string, offset: number): boolean {
  let open: RegExp | null = null
  for (const line of text.slice(0, offset).split('\n').slice(0, -1)) {
    if (open) {
      if (open.test(line)) open = null
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) open = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*$`)
  }
  return open !== null
}

/**
 * Pasting a JSON object or array into the composer wraps it in a ```json
 * fence, on its own lines, so the model and the chat read it as a block.
 * Returns null when the paste should go through untouched.
 */
export function pasteJsonAsBlock(value: string, start: number, end: number, pasted: string): { value: string; caret: number } | null {
  if (!isJsonDocument(pasted) || insideFence(value, start)) return null
  const json = pasted.trim()
  // A fence longer than any backtick run inside the JSON strings.
  const longestRun = Math.max(2, ...Array.from(json.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longestRun + 1)
  const before = value.slice(0, start)
  const after = value.slice(end)
  const block = `${before && !before.endsWith('\n') ? '\n' : ''}${fence}json\n${json}\n${fence}\n`
  const rest = after.startsWith('\n') ? after.slice(1) : after
  return { value: before + block + rest, caret: before.length + block.length }
}
