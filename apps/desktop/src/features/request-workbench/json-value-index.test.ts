import { describe, expect, it } from 'vitest'
import { accessorFor, captureStatement, captureVariableName, findValueAt, indexJsonValues } from './json-value-index'

const doc = JSON.stringify({ data: { token: 'abc', items: [{ id: 7 }, true], 'a-b': null } }, null, 2)

describe('indexJsonValues', () => {
  it('indexes only primitive values, with the range and path of each', () => {
    const values = indexJsonValues(doc)

    expect(values.map((value) => value.path)).toEqual([
      ['data', 'token'],
      ['data', 'items', 0, 'id'],
      ['data', 'items', 1],
      ['data', 'a-b'],
    ])
    const token = values[0]
    expect(doc.slice(token.from, token.to)).toBe('"abc"')
    expect(doc.slice(values[1].from, values[1].to)).toBe('7')
  })

  it('handles escapes in strings and keys', () => {
    const text = '{"a\\"b": "x\\"y"}'
    const [value] = indexJsonValues(text)

    expect(value.path).toEqual(['a"b'])
    expect(text.slice(value.from, value.to)).toBe('"x\\"y"')
  })

  it('returns nothing for invalid JSON or trailing garbage', () => {
    expect(indexJsonValues('{"a": ')).toEqual([])
    expect(indexJsonValues('{"a": 1} extra')).toEqual([])
    expect(indexJsonValues('not json')).toEqual([])
  })

  it('accepts a primitive at the root and empty containers', () => {
    expect(indexJsonValues('42')).toEqual([{ from: 0, to: 2, path: [] }])
    expect(indexJsonValues('{"a": {}, "b": []}')).toEqual([])
  })

  it('includes empty arrays only when asked', () => {
    const text = '{"a": {}, "b": [ ], "c": [[]]}'
    const values = indexJsonValues(text, { emptyArrays: true })

    expect(values.map((value) => [value.path, text.slice(value.from, value.to)])).toEqual([
      [['b'], '[ ]'],
      [['c', 0], '[]'],
    ])
  })
})

describe('findValueAt', () => {
  it('finds the value containing the position and ignores keys and punctuation', () => {
    const values = indexJsonValues(doc)
    const start = doc.indexOf('"abc"')

    expect(findValueAt(values, start + 2)?.path).toEqual(['data', 'token'])
    expect(findValueAt(values, doc.indexOf('"token"') + 2)).toBeNull()
    expect(findValueAt(values, 0)).toBeNull()
  })
})

describe('capture', () => {
  it('builds the accessor with dots, brackets and indices', () => {
    expect(accessorFor(['data', 'items', 0, 'id'])).toBe('.data.items[0].id')
    expect(accessorFor(['a-b', 'x'])).toBe('["a-b"].x')
  })

  it('suggests the variable name from the last key', () => {
    expect(captureVariableName(['data', 'token'])).toBe('token')
    expect(captureVariableName(['items', 0])).toBe('items')
    expect(captureVariableName(['a-b'])).toBe('a_b')
    expect(captureVariableName([])).toBe('value')
  })

  it('generates the script line', () => {
    expect(captureStatement(['data', 'token'])).toBe("al.environment.set('token', al.response.json().data.token);")
  })
})
