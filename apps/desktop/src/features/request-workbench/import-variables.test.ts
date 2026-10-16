import { describe, expect, it } from 'vitest'
import type { PreparedImportDto } from '../../bindings/prepared-import'
import {
  importVariableErrors,
  importVariableSelections,
  importVariablesValid,
  initialImportVariables,
  renameImportVariable,
  updateImportVariable,
} from './import-variables'

function summary(overrides: Partial<PreparedImportDto> = {}): PreparedImportDto {
  return {
    id: 'import-1',
    format: 'postman',
    title: 'Customer API',
    collectionCount: 1,
    folderCount: 0,
    requestCount: 1,
    environmentCount: 2,
    supportsDocumentation: false,
    scriptCount: 0,
    warningCount: 0,
    environmentNames: ['Dev', 'Prod'],
    collectionNames: ['Customer API'],
    variables: [
      { key: 'env:0:host', name: 'host', value: 'dev', valueTruncated: false, sensitive: false, origin: { kind: 'environment', index: 0 }, included: true },
      { key: 'env:1:host', name: 'host', value: 'prod', valueTruncated: false, sensitive: false, origin: { kind: 'environment', index: 1 }, included: true },
      { key: 'collection:0:token', name: 'token', value: 'abc', valueTruncated: false, sensitive: true, origin: { kind: 'collection', index: 0 }, included: true },
      { key: 'ref:apiKey', name: 'apiKey', value: '', valueTruncated: false, sensitive: true, origin: { kind: 'referenced' }, included: false },
      { key: 'env:0:cert', name: 'cert', value: 'cut', valueTruncated: true, sensitive: false, origin: { kind: 'environment', index: 0 }, included: true },
    ],
    ...overrides,
  }
}

describe('import variables review', () => {
  it('starts each variable where the file placed it and referenced ones in the first imported environment', () => {
    const state = initialImportVariables(summary())

    expect(state.newEnvironmentName).toBe('Customer API')
    expect(state.rows.map((row) => [row.key, row.destination, row.include])).toEqual([
      ['env:0:host', 'imported:0', true],
      ['env:1:host', 'imported:1', true],
      ['collection:0:token', 'collection:0', true],
      ['ref:apiKey', 'imported:0', false],
      ['env:0:cert', 'imported:0', true],
    ])
  })

  it('sends referenced variables to a new environment when the file has none', () => {
    const state = initialImportVariables(summary({ environmentNames: [] }))

    expect(state.rows.find((row) => row.key === 'ref:apiKey')?.destination).toBe('new')
  })

  it('renames every row that came with the same name', () => {
    const state = renameImportVariable(initialImportVariables(summary()), 'env:1:host', 'baseUrl')

    expect(state.rows.filter((row) => row.originalName === 'host').map((row) => row.name)).toEqual(['baseUrl', 'baseUrl'])
    expect(state.rows.find((row) => row.key === 'collection:0:token')?.name).toBe('token')
  })

  it('flags empty, braced and repeated names only within the same destination', () => {
    let state = initialImportVariables(summary())
    expect(importVariableErrors(state).size).toBe(0)

    state = renameImportVariable(state, 'env:0:cert', 'host')
    expect(importVariableErrors(state).get('env:0:cert')).toBe('duplicate')
    expect(importVariableErrors(state).get('env:0:host')).toBe('duplicate')
    expect(importVariableErrors(state).has('env:1:host')).toBe(false)

    state = renameImportVariable(state, 'env:0:cert', '{{x}}')
    expect(importVariableErrors(state).get('env:0:cert')).toBe('invalid')

    state = renameImportVariable(state, 'collection:0:token', ' ')
    expect(importVariableErrors(state).get('collection:0:token')).toBe('empty')
    expect(importVariablesValid(state)).toBe(false)

    state = updateImportVariable(state, 'collection:0:token', { include: false })
    state = updateImportVariable(state, 'env:0:cert', { include: false })
    expect(importVariablesValid(state)).toBe(true)
  })

  it('requires a name for the new environment once a variable goes there', () => {
    let state = updateImportVariable(initialImportVariables(summary()), 'ref:apiKey', { include: true, destination: 'new' })
    state = { ...state, newEnvironmentName: '  ' }

    expect(importVariablesValid(state)).toBe(false)
  })

  it('builds selections that keep untouched or truncated values and drop sensitivity in collections', () => {
    let state = initialImportVariables(summary())
    state = updateImportVariable(state, 'ref:apiKey', { include: true, value: 'k', destination: 'existing:env-9' })
    state = updateImportVariable(state, 'env:1:host', { value: 'prod-2', destination: 'new' })

    const selections = importVariableSelections(state)

    expect(selections.find((selection) => selection.key === 'env:0:host')).toMatchObject({ value: null, target: { kind: 'importedEnvironment', index: 0 } })
    expect(selections.find((selection) => selection.key === 'env:1:host')).toMatchObject({ value: 'prod-2', target: { kind: 'newEnvironment', name: 'Customer API' } })
    expect(selections.find((selection) => selection.key === 'collection:0:token')).toMatchObject({ sensitive: false, target: { kind: 'collection', index: 0 } })
    expect(selections.find((selection) => selection.key === 'ref:apiKey')).toMatchObject({ include: true, value: 'k', sensitive: true, target: { kind: 'existingEnvironment', id: 'env-9' } })
    expect(selections.find((selection) => selection.key === 'env:0:cert')?.value).toBeNull()
  })
})
