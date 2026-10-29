import { describe, expect, it } from 'vitest'
import { mentionAt } from './agent-context'

describe('mentionAt', () => {
  it('finds the @query right before the caret', () => {
    expect(mentionAt('explain @us', 11)).toEqual({ start: 8, query: 'us' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('ignores e-mail addresses, finished mentions and text after the caret', () => {
    expect(mentionAt('ana@example.com', 15)).toBeNull()
    expect(mentionAt('@users and more', 15)).toBeNull()
    expect(mentionAt('hello @world', 3)).toBeNull()
  })
})
