import { describe, expect, it } from 'vitest'
import { parseQuery } from './graphql-query-tree'
import { validateQuery } from './graphql-query-validation'
import type { SchemaType } from '../../bindings/load-schema'

const scalarField = (name: string, typeName: string | null = null) => ({
  name,
  description: null,
  args: [],
  typeDisplay: typeName ?? 'String',
  typeName,
  isDeprecated: false,
  deprecationReason: null,
})

const types: SchemaType[] = [
  {
    name: 'Query',
    kind: 'OBJECT',
    description: null,
    fields: [scalarField('ping'), scalarField('currentCustomer', 'Customer')],
    inputFields: [],
    enumValues: [],
    interfaces: [],
    possibleTypes: [],
  },
  {
    name: 'Customer',
    kind: 'OBJECT',
    description: null,
    fields: [scalarField('id'), scalarField('name')],
    inputFields: [],
    enumValues: [],
    interfaces: [],
    possibleTypes: [],
  },
]

describe('validateQuery', () => {
  it('não reporta nada para uma query só com campos existentes', () => {
    const parsed = parseQuery('{ ping currentCustomer { id name } }')!

    expect(validateQuery(parsed, types, 'Query')).toEqual([])
  })

  it('reporta um campo inexistente na raiz', () => {
    const parsed = parseQuery('{ doesNotExist }')!

    expect(validateQuery(parsed, types, 'Query')).toEqual([
      { path: ['doesNotExist'], kind: 'unknownField', fieldName: 'doesNotExist', typeName: 'Query' },
    ])
  })

  it('reporta um campo inexistente aninhado, com o caminho completo', () => {
    const parsed = parseQuery('{ currentCustomer { id nickname } }')!

    expect(validateQuery(parsed, types, 'Query')).toEqual([
      { path: ['currentCustomer', 'nickname'], kind: 'unknownField', fieldName: 'nickname', typeName: 'Customer' },
    ])
  })

  it('ignora fragment spreads (opacos) em vez de reportá-los como campo inexistente', () => {
    const parsed = parseQuery('{ currentCustomer { ...CustomerFields } }')!

    expect(validateQuery(parsed, types, 'Query')).toEqual([])
  })

  it('não reporta nada quando o tipo raiz não é encontrado no schema', () => {
    const parsed = parseQuery('{ ping }')!

    expect(validateQuery(parsed, types, 'Mutation')).toEqual([])
    expect(validateQuery(parsed, types, null)).toEqual([])
  })
})
