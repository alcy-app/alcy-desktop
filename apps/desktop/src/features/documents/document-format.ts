import type { Language } from '../../shared/i18n/translations'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 minutes ago", "yesterday"…; dates older than a week show the date itself. */
export function formatRelativeTime(atMs: number, language: Language, nowMs = Date.now()): string {
  const elapsed = nowMs - atMs
  const relative = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (elapsed < MINUTE) return relative.format(0, 'second')
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), 'hour')
  if (elapsed < 7 * DAY) return relative.format(-Math.floor(elapsed / DAY), 'day')
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric' }).format(atMs)
}

export function formatDateTime(atMs: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(atMs)
}

/** Words in the Markdown source, ignoring syntax-only tokens such as `#`, `-` or `|`. */
export function countWords(markdown: string): number {
  return markdown.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length
}
