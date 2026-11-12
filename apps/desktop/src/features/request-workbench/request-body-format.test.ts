import { describe, expect, it } from 'vitest'
import { formatJsoncBody, rawBodyFormatter } from './request-body-format'

describe('formatJsoncBody', () => {
  it('reindents compact JSON with 2 spaces', () => {
    expect(formatJsoncBody('{"a":1,"b":[true,null],"c":{}}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ],\n  "c": {}\n}',
    )
  })

  it('keeps literals exactly as written, including large numbers and escapes', () => {
    expect(formatJsoncBody('{"id":12345678901234567890,"n":1.0,"s":"\\u00e9\\""}')).toBe(
      '{\n  "id": 12345678901234567890,\n  "n": 1.0,\n  "s": "\\u00e9\\""\n}',
    )
  })

  it('keeps {{variable}} templates, inside and outside strings', () => {
    expect(formatJsoncBody('{"id":{{userId}},"name":"{{name}}","tags":[{{tag}}]}')).toBe(
      '{\n  "id": {{userId}},\n  "name": "{{name}}",\n  "tags": [\n    {{tag}}\n  ]\n}',
    )
  })

  it('keeps line comments on their line and own-line comments on their own line', () => {
    const source = '// header\n{"a":1, // first\n// about b\n"b":2}'
    expect(formatJsoncBody(source)).toBe('// header\n{\n  "a": 1, // first\n  // about b\n  "b": 2\n}')
  })

  it('keeps block comments', () => {
    expect(formatJsoncBody('{"a":/* one */1,\n/* b */\n"b":2}')).toBe('{\n  "a": /* one */ 1,\n  /* b */\n  "b": 2\n}')
  })

  it('formats a top-level scalar or empty containers', () => {
    expect(formatJsoncBody('  42 ')).toBe('42')
    expect(formatJsoncBody('[ ]')).toBe('[]')
  })

  it('returns null for invalid JSON instead of guessing', () => {
    expect(formatJsoncBody('{"a":1,}')).toBeNull()
    expect(formatJsoncBody('{"a":')).toBeNull()
    expect(formatJsoncBody('{"a":"open')).toBeNull()
    expect(formatJsoncBody('{"a":1 /* open')).toBeNull()
    expect(formatJsoncBody('not json')).toBeNull()
    expect(formatJsoncBody('')).toBeNull()
  })
})

describe('rawBodyFormatter', () => {
  it('formats JSON and XML only', () => {
    expect(rawBodyFormatter('json')?.('[1,2]')).toBe('[\n  1,\n  2\n]')
    expect(rawBodyFormatter('xml')?.('<a><b>1</b></a>')).toBe('<a>\n  <b>1</b>\n</a>')
    expect(rawBodyFormatter('xml')?.('plain')).toBeNull()
    expect(rawBodyFormatter('text')).toBeUndefined()
    expect(rawBodyFormatter('javascript')).toBeUndefined()
    expect(rawBodyFormatter('html')).toBeUndefined()
  })
})
