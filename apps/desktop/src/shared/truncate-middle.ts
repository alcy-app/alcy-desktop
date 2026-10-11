/** Encurta `text` com reticências no meio, preservando início e fim. */
export function truncateMiddle(text: string, maxLength = 40): string {
  const chars = Array.from(text)
  if (chars.length <= maxLength) return text
  const keep = maxLength - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}
