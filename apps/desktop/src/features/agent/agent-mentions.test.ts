import { describe, expect, it } from 'vitest'
import type { AgentContextOption } from './agent-context'
import { applyEdit, findMentions, liveMentions, mentionDeletion, splitMentions, textEdit, type InlineMention } from './agent-mentions'

const users: AgentContextOption = { kind: 'tab', id: 't1', label: 'Users', summary: '' }
const dev: AgentContextOption = { kind: 'environment', id: 'dev', label: 'Dev env', summary: '' }
// "@Users e @Dev env x"
const text = '@Users e @Dev env x'
const mentions: InlineMention[] = [
  { option: users, start: 0, end: 6 },
  { option: dev, start: 9, end: 17 },
]

describe('textEdit', () => {
  it('locates typing, pasting and deletions from the caret', () => {
    expect(textEdit('ab', 'aXb', 2)).toEqual({ start: 1, oldEnd: 1, insertedLength: 1 })
    expect(textEdit('abcd', 'abd', 2)).toEqual({ start: 2, oldEnd: 3, insertedLength: 0 })
    expect(textEdit('ab cd', 'ab XYZ cd', 6)).toEqual({ start: 2, oldEnd: 2, insertedLength: 4 })
  })

  it('places a repeated character where the caret says, not where a diff guesses', () => {
    // An `@` typed right before `@Users`.
    expect(textEdit('a @Users', 'a @@Users', 3)).toEqual({ start: 2, oldEnd: 2, insertedLength: 1 })
  })
})

describe('applyEdit', () => {
  it('keeps mentions before the edit, shifts those after it and drops the touched ones', () => {
    expect(applyEdit(mentions, { start: 7, oldEnd: 7, insertedLength: 3 })).toEqual([
      mentions[0],
      { option: dev, start: 12, end: 20 },
    ])
    expect(applyEdit(mentions, { start: 3, oldEnd: 4, insertedLength: 0 })).toEqual([{ option: dev, start: 8, end: 16 }])
  })

  it('keeps a mention typed right against', () => {
    expect(applyEdit(mentions, { start: 6, oldEnd: 6, insertedLength: 1 })[0]).toEqual(mentions[0])
    expect(applyEdit(mentions, { start: 9, oldEnd: 9, insertedLength: 1 })[1]).toEqual({ option: dev, start: 10, end: 18 })
  })
})

describe('liveMentions', () => {
  it('forgets mentions whose token is no longer in place', () => {
    expect(liveMentions(mentions, text)).toEqual(mentions)
    expect(liveMentions(mentions, '')).toEqual([])
    expect(liveMentions(mentions, '@Users e @Dev')).toEqual([mentions[0]])
  })
})

describe('mentionDeletion', () => {
  it('removes a whole mention from either side of the caret', () => {
    expect(mentionDeletion(mentions, 6, 6, 'Backspace')).toEqual({ start: 0, end: 6 })
    expect(mentionDeletion(mentions, 9, 9, 'Delete')).toEqual({ start: 9, end: 17 })
    expect(mentionDeletion(mentions, 9, 9, 'Backspace')).toBeNull()
    expect(mentionDeletion(mentions, 17, 17, 'Delete')).toBeNull()
  })

  it('widens a selection that cuts through a mention', () => {
    expect(mentionDeletion(mentions, 3, 8, 'Backspace')).toEqual({ start: 0, end: 8 })
    expect(mentionDeletion(mentions, 6, 9, 'Delete')).toBeNull()
  })
})

describe('splitMentions and findMentions', () => {
  it('cuts the text around its mentions', () => {
    expect(splitMentions(text, mentions).map((segment) => segment.type === 'text' ? segment.text : `[${segment.text}]`)).toEqual(['[@Users]', ' e ', '[@Dev env]', ' x'])
  })

  it('finds mentions of a sent message by their labels, longest first, at word starts', () => {
    const devTools = { ...dev, id: 'other', label: 'Dev' }
    expect(findMentions(text, [users, devTools, dev]).map(({ reference, start }) => [reference.id, start])).toEqual([['t1', 0], ['dev', 9]])
    expect(findMentions('mail@Users', [users])).toEqual([])
  })
})
