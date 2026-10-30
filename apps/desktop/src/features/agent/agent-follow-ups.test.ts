import { describe, expect, it } from 'vitest'
import { splitAgentReply } from './agent-follow-ups'

describe('splitAgentReply', () => {
  it('extracts only a final suggestions block and preserves the reply Markdown', () => {
    expect(splitAgentReply('Done **here**.\n\n```alcy-suggestions\n["Show details", "Add tests"]\n```')).toEqual({
      text: 'Done **here**.', suggestions: ['Show details', 'Add tests'],
    })
    const example = '```alcy-suggestions\n["Example"]\n```\nThis is an example.'
    expect(splitAgentReply(example)).toEqual({ text: example, suggestions: [] })
    const nested = '````markdown\n```alcy-suggestions\n["Example"]\n```\n````'
    expect(splitAgentReply(nested)).toEqual({ text: nested, suggestions: [] })
  })

  it('hides unfinished, malformed and oversized trailers without offering actions', () => {
    for (const block of ['["Partial', 'invalid\n```', '{"message":"Wrong shape"}\n```', ' '.repeat(2048) + '[]\n```']) {
      expect(splitAgentReply('Reply\n\n```alcy-suggestions\n' + block)).toEqual({ text: 'Reply', suggestions: [] })
    }
  })

  it('bounds, validates and deduplicates suggested messages', () => {
    const values = [null, 1, {}, '', ' ', 'Too\nlong', 'x'.repeat(161), ' A ', 'A', 'B', 'C', 'D', 'E']
    expect(splitAgentReply('Reply\n\n```alcy-suggestions\n' + JSON.stringify(values) + '\n```').suggestions).toEqual(['A', 'B', 'C', 'D'])
  })

  it('accepts CRLF and leaves ordinary replies and code blocks unchanged', () => {
    expect(splitAgentReply('Reply\r\n\r\n~~~alcy-suggestions\r\n["Next"]\r\n~~~\r\n')).toEqual({ text: 'Reply', suggestions: ['Next'] })
    const source = 'Reply\n\n```json\n["Keep this"]\n```'
    expect(splitAgentReply(source)).toEqual({ text: source, suggestions: [] })
  })
})
