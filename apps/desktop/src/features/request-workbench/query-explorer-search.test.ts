import { describe, expect, it } from 'vitest'
import type { SchemaField, SchemaType } from '../../bindings/load-schema'
import { rankQueryExplorerFields, searchQueryExplorerFields } from './query-explorer-search'

function field(name: string, typeName: string): SchemaField {
  return {
    name,
    description: null,
    args: [],
    typeDisplay: typeName,
    typeName,
    isDeprecated: false,
    deprecationReason: null,
  }
}

function objectType(name: string, fields: SchemaField[], kind = 'OBJECT'): SchemaType {
  return { name, kind, description: null, fields, inputFields: [], enumValues: [], interfaces: [], possibleTypes: [] }
}

const TYPES: SchemaType[] = [
  objectType('Query', [field('currentCustomer', 'Customer'), field('orders', 'Order'), field('ping', 'String')]),
  objectType('Customer', [field('id', 'ID'), field('email', 'String'), field('orders', 'Order')]),
  objectType('Order', [field('id', 'ID'), field('customer', 'Customer'), field('billingEmail', 'String')]),
  objectType('String', [], 'SCALAR'),
  objectType('ID', [], 'SCALAR'),
]
const ROOT = TYPES[0]

describe('searchQueryExplorerFields', () => {
  it('não filtra sem termo', () => {
    expect(searchQueryExplorerFields(ROOT, TYPES, '   ')).toBeNull()
  })

  it('encontra campos aninhados, ignorando maiúsculas, e abre seus ancestrais', () => {
    const result = searchQueryExplorerFields(ROOT, TYPES, 'EMAIL')

    expect(result?.term).toBe('email')
    expect(result?.matchCount).toBe(2)
    expect([...(result?.visible ?? [])].sort()).toEqual(
      ['currentCustomer', 'currentCustomer email', 'orders', 'orders billingEmail'].sort(),
    )
    expect([...(result?.expanded ?? [])].sort()).toEqual(['currentCustomer', 'orders'])
  })

  it('percorre cada tipo uma só vez, no caminho mais curto, mesmo com tipos recursivos', () => {
    const result = searchQueryExplorerFields(ROOT, TYPES, 'customer')

    // Root `currentCustomer` and `orders > customer`; Customer is not revisited.
    expect(result?.matchCount).toBe(2)
    expect(result?.visible.has('orders customer')).toBe(true)
    expect([...(result?.visible ?? [])].some((key) => key.split(' ').length > 2)).toBe(false)
  })

  it('limits displayed matches and indicates more results are available', () => {
    const result = searchQueryExplorerFields(ROOT, TYPES, 'i', 2)

    expect(result?.matchCount).toBe(2)
    expect(result?.truncated).toBe(true)
  })

  it('retains exact names encountered after longer matches when applying the limit', () => {
    const root = objectType('Query', [field('emailAddress', 'String'), field('profile', 'Profile'), field('emailAlias', 'String')])
    const profile = objectType('Profile', [field('email', 'String')])
    const result = searchQueryExplorerFields(root, [root, profile], 'email', 1)

    expect(result?.matchCount).toBe(1)
    expect(result?.truncated).toBe(true)
    expect([...(result?.visible ?? [])]).toEqual(['profile', 'profile email'])
    expect([...(result?.expanded ?? [])]).toEqual(['profile'])
  })

  it('ranks siblings by closest name length, preserving the schema array', () => {
    const fields = [field('emailAddress', 'String'), field('emailAlias', 'String'), field('xemail', 'String'), field('email', 'String')]
    const original = [...fields]
    const root = objectType('Query', fields)
    const result = searchQueryExplorerFields(root, [root], ' EMAIL ')

    expect(rankQueryExplorerFields(fields, [], result).map((field) => field.name))
      .toEqual(['email', 'xemail', 'emailAlias', 'emailAddress'])
    expect(fields).toEqual(original)
    expect(rankQueryExplorerFields(fields, [], null)).toBe(fields)
  })

  it('keeps the 200-result limit while retaining an exact name after hundreds of partial matches', () => {
    const root = objectType('Query', [
      ...Array.from({ length: 300 }, (_, index) => field(`emailAddress${index}`, 'String')),
      field('email', 'String'),
    ])
    const result = searchQueryExplorerFields(root, [root], 'email')

    expect(result?.matchCount).toBe(200)
    expect(result?.visible.size).toBe(200)
    expect(result?.truncated).toBe(true)
    expect(rankQueryExplorerFields(root.fields, [], result)[0].name).toBe('email')
  })

  it('ranks a branch by its exact descendant even when the branch name also matches', () => {
    const root = objectType('Query', [field('emailAlias', 'String'), field('emailProfile', 'Profile')])
    const profile = objectType('Profile', [field('email', 'String')])
    const result = searchQueryExplorerFields(root, [root, profile], 'email')

    expect(rankQueryExplorerFields(root.fields, [], result).map((field) => field.name))
      .toEqual(['emailProfile', 'emailAlias'])
    expect(result?.expanded.has('emailProfile')).toBe(true)
  })

  it('não encontra nada quando nenhum campo casa', () => {
    const result = searchQueryExplorerFields(ROOT, TYPES, 'inexistente')

    expect(result?.matchCount).toBe(0)
    expect(result?.visible.size).toBe(0)
    expect(result?.truncated).toBe(false)
  })
})
