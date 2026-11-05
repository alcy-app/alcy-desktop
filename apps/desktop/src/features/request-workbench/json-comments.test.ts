import { describe, expect, it } from 'vitest'
import { findJsonComments, maskJsonComments, stripJsonComments } from './json-comments'

const comments = (text: string) => findJsonComments(text).map(({ from, to }) => text.slice(from, to))

describe('findJsonComments', () => {
  it('finds line and block comments outside strings', () => {
    expect(comments('{\n  "a": 1, // first\n  /* b\n  c */ "d": 2\n}')).toEqual(['// first', '/* b\n  c */'])
  })

  it('ignores comment markers inside strings, escapes included', () => {
    expect(comments('{"url": "http://x/*y*/", "q": "a\\"//b"} // end')).toEqual(['// end'])
  })

  it('stops a line comment before a CRLF break', () => {
    expect(comments('// x\r\n{}')).toEqual(['// x'])
  })

  it('ends an unterminated string at the line break', () => {
    expect(comments('{"a": "open\n// x\n}')).toEqual(['// x'])
  })

  it('does not treat an unclosed /* as a comment', () => {
    expect(comments('{} /* open\n// x')).toEqual(['// x'])
  })
})

describe('maskJsonComments', () => {
  it('blanks comments keeping positions and line breaks', () => {
    const text = '{ /* a\nb */ "x": 1 } // é'
    const masked = maskJsonComments(text)
    expect(masked).toHaveLength(text.length)
    expect(masked).toBe(`{${' '.repeat(5)}\n${' '.repeat(5)}"x": 1 }${' '.repeat(5)}`)
  })

  it('returns the same text without comments', () => {
    expect(maskJsonComments('{"a": "//"}')).toBe('{"a": "//"}')
  })
})

/** Same cases as the tests of `crates/alcy-domain/src/json_comments.rs`. */
describe('stripJsonComments', () => {
  it('returns a body without comments untouched', () => {
    expect(stripJsonComments('{\n  "a": 1,\n}\n')).toBe('{\n  "a": 1,\n}\n')
    expect(stripJsonComments('{"url": "http://example.test/*x*/"}')).toBe('{"url": "http://example.test/*x*/"}')
  })

  it('removes a line holding only a comment', () => {
    expect(stripJsonComments('{\n  "name": "Ana",\n  // "age": 30,\n  "city": "Rio"\n}')).toBe('{\n  "name": "Ana",\n  "city": "Rio"\n}')
  })

  it('removes a comment at the end of a line and the space before it', () => {
    expect(stripJsonComments('{\n  "a": 1, // first\n  "b": 2\n}')).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  it('removes the comma left by commenting out the last property', () => {
    expect(stripJsonComments('{\n  "name": "Ana",\n  // "age": 30\n}')).toBe('{\n  "name": "Ana"\n}')
    expect(stripJsonComments('[\n  1,\n  // 2\n]')).toBe('[\n  1\n]')
  })

  it('removes a block comment across lines', () => {
    expect(stripJsonComments('{\n  "a": 1,\n  /* "b": 2,\n  "c": 3, */\n  "d": 4\n}')).toBe('{\n  "a": 1,\n  "d": 4\n}')
    expect(stripJsonComments('{"a": 1, /* start\nmiddle\nend */ "b": 2}')).toBe('{"a": 1,\n "b": 2}')
  })

  it('keeps comment markers inside strings', () => {
    expect(stripJsonComments('{\n  "url": "http://x/*y*/", // note\n  "q": "a\\"//b"\n}')).toBe('{\n  "url": "http://x/*y*/",\n  "q": "a\\"//b"\n}')
  })

  it('leaves templates for variable resolution', () => {
    expect(stripJsonComments('{\n  "id": {{id}},\n  // "token": "{{missing}}"\n}')).toBe('{\n  "id": {{id}}\n}')
  })

  it('treats an unclosed block as text', () => {
    expect(stripJsonComments('{"a": 1} /* open')).toBe('{"a": 1} /* open')
    expect(stripJsonComments('{"a": 1} /* open\n// x')).toBe('{"a": 1} /* open\n')
  })

  it('ends an unterminated string at the line break', () => {
    expect(stripJsonComments('{"a": "open\n// x\n}')).toBe('{"a": "open\n}')
  })

  it('keeps CRLF line breaks', () => {
    expect(stripJsonComments('{\r\n  "a": 1, // x\r\n  // "b": 2\r\n}\r\n')).toBe('{\r\n  "a": 1\r\n}\r\n')
  })

  it('keeps non-ASCII text around comments', () => {
    expect(stripJsonComments('{"nome": "João ✓" /* olá */}')).toBe('{"nome": "João ✓"}')
  })
})
