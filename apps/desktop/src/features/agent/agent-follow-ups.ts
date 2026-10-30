const MAX_SUGGESTIONS = 4
const MAX_SUGGESTION_CHARS = 160
const MAX_BLOCK_CHARS = 2048

/** Reads the optional presentation-only trailer from a model reply, including while streaming. */
export function splitAgentReply(source: string): { text: string; suggestions: string[] } {
  const lines = source.split('\n')
  let open: { marker: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '')
    if (open) {
      if (new RegExp(`^ {0,3}${open.marker}{${open.length},}[ \\t]*$`).test(line)) open = null
      continue
    }
    const fence = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line)
    if (!fence) continue
    open = { marker: fence[1][0], length: fence[1].length }
    if (fence[2].trim() !== 'alcy-suggestions') continue

    const closing = new RegExp(`^ {0,3}${open.marker}{${open.length},}[ \\t]*$`)
    const end = lines.findIndex((candidate, position) => position > index && closing.test(candidate.replace(/\r$/, '')))
    // Only a final block is metadata; examples in the middle remain ordinary Markdown.
    if (end >= 0 && lines.slice(end + 1).join('\n').trim()) continue
    const text = lines.slice(0, index).join('\n').trimEnd()
    if (end < 0) return { text, suggestions: [] }
    const block = lines.slice(index + 1, end).join('\n')
    if (block.length > MAX_BLOCK_CHARS) return { text, suggestions: [] }
    try {
      const value: unknown = JSON.parse(block)
      const suggestions = Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && item.length <= MAX_SUGGESTION_CHARS && !/[\r\n]/.test(item)))].slice(0, MAX_SUGGESTIONS)
        : []
      return { text, suggestions }
    } catch {
      return { text, suggestions: [] }
    }
  }
  return { text: source, suggestions: [] }
}
