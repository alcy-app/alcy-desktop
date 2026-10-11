import { describe, expect, it } from 'vitest'
import type { SchemaField, SchemaType } from '../../bindings/load-schema'
import { searchQueryExplorerFields } from './query-explorer-search'

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

    // `currentCustomer` (raiz) e `orders > customer`; `Customer` não é revisitado por `orders > customer`.
    expect(result?.matchCount).toBe(2)
    expect(result?.visible.has('orders customer')).toBe(true)
    expect([...(result?.visible ?? [])].some((key) => key.split(' ').length > 2)).toBe(false)
  })

  it('para no limite e indica que há mais resultados', () => {
    const result = searchQueryExplorerFields(ROOT, TYPES, 'i', 2)

    expect(result?.matchCount).toBe(2)
    expect(result?.truncated).toBe(true)
  })

  it('não encontra nada quando nenhum campo casa', () => {
    const result = searchQueryExplorerFields(ROOT, TYPES, 'inexistente')

    expect(result?.matchCount).toBe(0)
    expect(result?.visible.size).toBe(0)
    expect(result?.truncated).toBe(false)
  })
})
