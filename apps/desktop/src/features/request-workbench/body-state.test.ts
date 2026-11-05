import { describe, expect, it } from 'vitest'
import type { RestBodyInput } from '../../bindings/execute-rest-request'
import {
  bodyFilePaths,
  bodyPreviewText,
  contentTypeFor,
  emptyBodyState,
  fileNameOf,
  isAbsolutePath,
  restBodyFromDto,
  syncContentTypeHeader,
  toBodyState,
  toRestBodyInput,
  toWorkspaceRelativePath,
} from './body-state'
import type { HeaderEntry } from './request-workbench.types'

let id = 0
const newId = () => `new-${++id}`
const header = (name: string, value: string): HeaderEntry => ({ id: `h-${name}-${value}`, name, value, enabled: true })

describe('toRestBodyInput / toBodyState', () => {
  const inputs: RestBodyInput[] = [
    { type: 'none' },
    { type: 'raw', content: '<a/>', rawLanguage: 'xml' },
    { type: 'urlencoded', fields: [{ name: 'a', value: '1', enabled: false }] },
    {
      type: 'formData',
      fields: [
        { kind: 'text', name: 'title', enabled: true, value: 'photo' },
        { kind: 'file', name: 'file', enabled: true, filePath: '/tmp/photo.png' },
      ],
    },
    { type: 'binary', filePath: 'C:\\files\\archive.zip' },
  ]

  it.each(inputs)('round-trips $type', (input) => {
    expect(toRestBodyInput(toBodyState(input))).toEqual(input)
  })

  it('only sends the active type, even when other types keep data', () => {
    const body = { ...toBodyState({ type: 'raw', content: '{}', rawLanguage: 'json' }), binaryFilePath: '/tmp/x' }
    expect(toRestBodyInput(body)).toEqual({ type: 'raw', content: '{}', rawLanguage: 'json' })
  })

  it('treats a legacy DTO without a structured body as raw JSON', () => {
    expect(restBodyFromDto(undefined, '{"a":1}')).toEqual({ type: 'raw', content: '{"a":1}', rawLanguage: 'json' })
  })
})

describe('contentTypeFor', () => {
  it('maps each body type to the header the request needs', () => {
    expect(contentTypeFor('raw', 'json')).toBe('application/json')
    expect(contentTypeFor('raw', 'text')).toBe('text/plain')
    expect(contentTypeFor('raw', 'html')).toBe('text/html')
    expect(contentTypeFor('urlencoded', 'json')).toBe('application/x-www-form-urlencoded')
    expect(contentTypeFor('binary', 'json')).toBe('application/octet-stream')
    expect(contentTypeFor('formData', 'json')).toBeNull()
    expect(contentTypeFor('none', 'json')).toBeNull()
  })
})

describe('syncContentTypeHeader', () => {
  it('adds the header when there is none', () => {
    const headers = syncContentTypeHeader([header('Accept', '*/*')], 'application/json', newId)
    expect(headers.map(({ name, value }) => [name, value])).toEqual([
      ['Accept', '*/*'],
      ['Content-Type', 'application/json'],
    ])
  })

  it('replaces an automatic value, matching the header name case-insensitively', () => {
    const headers = syncContentTypeHeader([header('content-type', 'application/json')], 'application/xml', newId)
    expect(headers).toEqual([{ ...header('content-type', 'application/json'), value: 'application/xml' }])
  })

  it('removes an automatic header when the body type needs none', () => {
    expect(syncContentTypeHeader([header('Content-Type', 'text/plain')], null, newId)).toEqual([])
  })

  it('never touches a value the user typed', () => {
    const custom = [header('Content-Type', 'application/vnd.api+json')]
    expect(syncContentTypeHeader(custom, 'application/xml', newId)).toBe(custom)
    expect(syncContentTypeHeader(custom, null, newId)).toBe(custom)
  })
})

describe('bodyPreviewText', () => {
  it('shows a JSON body without its comments, as sent, and other raw bodies as they are', () => {
    const raw = '{\n  "a": 1,\n  // "b": 2\n}'
    expect(bodyPreviewText({ ...emptyBodyState, type: 'raw', rawLanguage: 'json', raw })).toBe('{\n  "a": 1\n}')
    expect(bodyPreviewText({ ...emptyBodyState, type: 'raw', rawLanguage: 'text', raw })).toBe(raw)
  })

  it('describes every body type as text for the console', () => {
    expect(bodyPreviewText({ ...emptyBodyState, type: 'none', raw: 'ignored' })).toBe('')
    expect(bodyPreviewText({ ...emptyBodyState, raw: '{}' })).toBe('{}')
    expect(
      bodyPreviewText(
        toBodyState({
          type: 'urlencoded',
          fields: [
            { name: 'q', value: 'a b', enabled: true },
            { name: 'off', value: 'x', enabled: false },
          ],
        }),
      ),
    ).toBe('q=a+b')
    expect(
      bodyPreviewText(toBodyState({ type: 'formData', fields: [{ kind: 'file', name: 'f', enabled: true, filePath: '/a.png' }] })),
    ).toBe('f=@/a.png')
    expect(bodyPreviewText(toBodyState({ type: 'binary', filePath: '/a.bin' }))).toBe('@/a.bin')
  })
})

describe('fileNameOf', () => {
  it('handles Windows and Unix paths', () => {
    expect(fileNameOf('C:\\Users\\ana\\photo.png')).toBe('photo.png')
    expect(fileNameOf('/home/ana/photo.png')).toBe('photo.png')
  })
})

describe('toWorkspaceRelativePath', () => {
  it('turns files inside the workspace into relative paths with forward slashes', () => {
    expect(toWorkspaceRelativePath('/home/ana/api/files/photo.png', '/home/ana/api')).toBe('files/photo.png')
    expect(toWorkspaceRelativePath('C:\\Users\\Ana\\api\\files\\a.bin', 'c:\\users\\ana\\api\\')).toBe('files/a.bin')
  })

  it('keeps files outside the workspace absolute', () => {
    expect(toWorkspaceRelativePath('/home/ana/other/photo.png', '/home/ana/api')).toBe('/home/ana/other/photo.png')
    expect(toWorkspaceRelativePath('/home/ana/api-old/photo.png', '/home/ana/api')).toBe('/home/ana/api-old/photo.png')
    expect(toWorkspaceRelativePath('/home/Ana/api/photo.png', '/home/ana/api')).toBe('/home/Ana/api/photo.png')
  })

  it('recognizes absolute paths on every platform', () => {
    expect(isAbsolutePath('/tmp/a')).toBe(true)
    expect(isAbsolutePath('C:\\a')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a')).toBe(true)
    expect(isAbsolutePath('files/a')).toBe(false)
  })
})

describe('bodyFilePaths', () => {
  it('lists only the files the active body reads', () => {
    expect(bodyFilePaths({ ...emptyBodyState, type: 'binary', binaryFilePath: 'a.bin' })).toEqual(['a.bin'])
    expect(bodyFilePaths({ ...emptyBodyState, binaryFilePath: 'a.bin' })).toEqual([])
    expect(
      bodyFilePaths(
        toBodyState({
          type: 'formData',
          fields: [
            { kind: 'file', name: 'f', enabled: true, filePath: 'x.png' },
            { kind: 'file', name: 'g', enabled: true, filePath: '' },
            { kind: 'text', name: 't', enabled: true, value: 'v' },
          ],
        }),
      ),
    ).toEqual(['x.png'])
  })
})
