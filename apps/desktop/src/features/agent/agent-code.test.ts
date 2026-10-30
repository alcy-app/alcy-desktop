import { describe, expect, it } from 'vitest'
import { codeBlockLanguage, pasteJsonAsBlock, splitUserMessage } from './agent-code'

describe('codeBlockLanguage', () => {
  it('maps fence languages to a highlighter and recognizes untagged JSON', () => {
    expect(codeBlockLanguage('gql', '{ me }')).toEqual({ label: 'gql', highlight: 'graphql' })
    expect(codeBlockLanguage('ts', 'const a = 1')).toEqual({ label: 'ts', highlight: 'javascript' })
    expect(codeBlockLanguage('bash', 'echo ok')).toEqual({ label: 'bash', highlight: 'text' })
    expect(codeBlockLanguage('constructor', 'x')).toEqual({ label: 'constructor', highlight: 'text' })
    expect(codeBlockLanguage(undefined, '{"ok": true}')).toEqual({ label: 'json', highlight: 'json' })
    expect(codeBlockLanguage(undefined, 'GET /users')).toEqual({ label: null, highlight: 'text' })
  })
})

describe('splitUserMessage', () => {
  it('keeps text literal and separates fenced blocks', () => {
    expect(splitUserMessage('Veja *isto*:\n\n```json\n{"a": 1}\n```\nE agora?')).toEqual([
      { type: 'text', text: 'Veja *isto*:' },
      { type: 'code', text: '{"a": 1}', lang: 'json' },
      { type: 'text', text: 'E agora?' },
    ])
    expect(splitUserMessage('```\nsem fim')).toEqual([{ type: 'code', text: 'sem fim' }])
    expect(splitUserMessage('olá')).toEqual([{ type: 'text', text: 'olá' }])
  })

  it('shows a message that is only JSON as a JSON block', () => {
    expect(splitUserMessage('  [1, 2]\n')).toEqual([{ type: 'code', text: '[1, 2]', lang: 'json' }])
    expect(splitUserMessage('{ não é json')).toEqual([{ type: 'text', text: '{ não é json' }])
  })
})

describe('pasteJsonAsBlock', () => {
  it('fences a pasted JSON document on its own lines and puts the caret after it', () => {
    expect(pasteJsonAsBlock('Explique:', 9, 9, ' {"a": 1} ')).toEqual({
      value: 'Explique:\n```json\n{"a": 1}\n```\n',
      caret: 31,
    })
    expect(pasteJsonAsBlock('antes\n\ndepois', 6, 6, '[1]')).toEqual({ value: 'antes\n```json\n[1]\n```\ndepois', caret: 22 })
  })

  it('replaces the selection and uses a fence longer than backticks in the JSON', () => {
    expect(pasteJsonAsBlock('troque ISTO', 7, 11, '{"md": "```x```"}')?.value).toBe('troque \n````json\n{"md": "```x```"}\n````\n')
  })

  it('leaves plain text, scalars and pastes inside an open fence alone', () => {
    expect(pasteJsonAsBlock('', 0, 0, 'GET /users')).toBeNull()
    expect(pasteJsonAsBlock('', 0, 0, '42')).toBeNull()
    expect(pasteJsonAsBlock('```json\n', 8, 8, '{"a": 1}')).toBeNull()
    expect(pasteJsonAsBlock('```\nx\n```\n', 10, 10, '{"a": 1}')).not.toBeNull()
  })
})
