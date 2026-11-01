import type { AgentContextOption } from './agent-context'

/** An `@` reference written in the composer text: `text.slice(start, end)` is its token. */
export interface InlineMention {
  option: AgentContextOption
  start: number
  end: number
}

/** A replaced span of text: `[start, oldEnd)` became `insertedLength` new characters. */
export interface TextEdit {
  start: number
  oldEnd: number
  insertedLength: number
}

export type MentionSegment<M> = { type: 'text'; text: string } | { type: 'mention'; text: string; mention: M }

export function mentionToken(option: Pick<AgentContextOption, 'label'>) {
  return `@${option.label}`
}

/** Mentions whose token is still at its place in `text`, in text order. */
export function liveMentions(mentions: InlineMention[], text: string) {
  return mentions
    .filter((mention) => text.slice(mention.start, mention.end) === mentionToken(mention.option))
    .sort((a, b) => a.start - b.start)
}

/**
 * The edit that turned `previous` into `next`, given the caret right after the new text
 * (where typing, pasting and both deletes leave it). Falls back to a plain diff otherwise.
 */
export function textEdit(previous: string, next: string, caret: number): TextEdit {
  let prefix = 0
  const shortest = Math.min(previous.length, next.length)
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix++
  const oldEnd = previous.length - (next.length - caret)
  if (caret >= 0 && caret <= next.length && oldEnd >= 0 && previous.slice(oldEnd) === next.slice(caret)) {
    const start = Math.min(prefix, caret, oldEnd)
    return { start, oldEnd, insertedLength: caret - start }
  }
  let suffix = 0
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  return { start: prefix, oldEnd: previous.length - suffix, insertedLength: next.length - suffix - prefix }
}

/** Mentions after an edit: those before it stay, those after it shift, those it touched are gone. */
export function applyEdit(mentions: InlineMention[], edit: TextEdit): InlineMention[] {
  const delta = edit.insertedLength - (edit.oldEnd - edit.start)
  return mentions.flatMap((mention) => {
    if (mention.end <= edit.start) return [mention]
    if (mention.start >= edit.oldEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    return []
  })
}

/**
 * Writes a mention of `option` at `caret`, spaced from the words around it.
 * An item already mentioned is not repeated: the caret just moves past it.
 */
export function insertMention(text: string, mentions: InlineMention[], caret: number, option: AgentContextOption): { text: string; mentions: InlineMention[]; caret: number } {
  const existing = mentions.find((mention) => mention.option.kind === option.kind && mention.option.id === option.id)
  if (existing) return { text, mentions, caret: existing.end }
  // Never inside another mention.
  const inside = mentionInside(mentions, caret)
  const at = Math.min(Math.max(inside ? inside.end : caret, 0), text.length)
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const trail = /^\s/.test(after) ? '' : ' '
  const token = mentionToken(option)
  const inserted = lead + token + trail
  const start = at + lead.length
  const shifted = applyEdit(mentions, { start: at, oldEnd: at, insertedLength: inserted.length })
  return {
    text: before + inserted + after,
    mentions: [...shifted, { option, start, end: start + token.length }].sort((a, b) => a.start - b.start),
    caret: start + token.length + 1,
  }
}

/** The mention the caret sits strictly inside of, if any. */
export function mentionInside(mentions: InlineMention[], caret: number) {
  return mentions.find((mention) => caret > mention.start && caret < mention.end)
}

/**
 * What a Backspace/Delete removes when mentions are involved: whole mentions only.
 * Returns null when the native behavior already does the right thing.
 */
export function mentionDeletion(mentions: InlineMention[], from: number, to: number, key: 'Backspace' | 'Delete'): { start: number; end: number } | null {
  let start = from
  let end = to
  if (from === to) {
    const hit = mentions.find((mention) => (key === 'Backspace' ? from > mention.start && from <= mention.end : from >= mention.start && from < mention.end))
    if (!hit) return null
    return { start: hit.start, end: hit.end }
  }
  for (const mention of mentions) {
    if (mention.end <= from || mention.start >= to) continue
    start = Math.min(start, mention.start)
    end = Math.max(end, mention.end)
  }
  return start === from && end === to ? null : { start, end }
}

/** `text` cut into plain runs and the mentions it carries. */
export function splitMentions<M extends { start: number; end: number }>(text: string, mentions: M[]): MentionSegment<M>[] {
  const segments: MentionSegment<M>[] = []
  let cursor = 0
  for (const mention of mentions) {
    if (mention.start < cursor) continue
    if (mention.start > cursor) segments.push({ type: 'text', text: text.slice(cursor, mention.start) })
    segments.push({ type: 'mention', text: text.slice(mention.start, mention.end), mention })
    cursor = mention.end
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) })
  return segments
}

/** Mentions of a sent message, found by their tokens: an `@label` at a word start. */
export function findMentions<R extends { label: string }>(text: string, references: R[]): { reference: R; start: number; end: number }[] {
  const candidates = [...references].sort((a, b) => b.label.length - a.label.length)
  const found: { reference: R; start: number; end: number }[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@' || (index > 0 && !/\s/.test(text[index - 1]))) continue
    const reference = candidates.find((candidate) => candidate.label !== '' && text.startsWith(mentionToken(candidate), index))
    if (!reference) continue
    const end = index + mentionToken(reference).length
    found.push({ reference, start: index, end })
    index = end - 1
  }
  return found
}
