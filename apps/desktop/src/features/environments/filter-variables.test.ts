import { describe, expect, it } from 'vitest'
import { filterVariables, normalizeVariableQuery } from './filter-variables'

const variables = [
  { id: 'v1', name: 'baseUrl', value: 'https://API.example.com', sensitive: false },
  { id: 'v2', name: 'apiToken', value: 'secret-value', sensitive: true },
  { id: 'v3', name: 'timeout', value: '30', sensitive: false },
  { id: 'v4', name: 'password', value: 'hunter2', sensitive: true },
]
const ids = (list: { id: string }[]) => list.map((variable) => variable.id)

describe('normalizeVariableQuery', () => {
  it('trims and lowercases the query', () => {
    expect(normalizeVariableQuery('  BaseURL ')).toBe('baseurl')
    expect(normalizeVariableQuery('   ')).toBe('')
  })
})

describe('filterVariables', () => {
  it('returns the same array for an empty or blank query', () => {
    expect(filterVariables(variables, '')).toBe(variables)
    expect(filterVariables(variables, '   ')).toBe(variables)
  })

  it('matches the name case-insensitively as a substring', () => {
    expect(ids(filterVariables(variables, 'API'))).toEqual(['v1', 'v2'])
    expect(ids(filterVariables(variables, 'out'))).toEqual(['v3'])
  })

  it('matches the value of non-sensitive variables', () => {
    expect(ids(filterVariables(variables, 'example'))).toEqual(['v1'])
    expect(ids(filterVariables(variables, '30'))).toEqual(['v3'])
  })

  it('never matches the value of sensitive variables', () => {
    expect(filterVariables(variables, 'secret')).toEqual([])
    expect(filterVariables(variables, 'hunter2')).toEqual([])
  })

  it('keeps the given ids visible even when they do not match, in the original order', () => {
    expect(ids(filterVariables(variables, 'timeout', new Set(['v1'])))).toEqual(['v1', 'v3'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterVariables(variables, 'nothing-here')).toEqual([])
  })
})
