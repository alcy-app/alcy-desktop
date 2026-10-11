import { describe, expect, it } from 'vitest'
import type { LoadSchemaOutput } from '../../bindings/load-schema'
import { internSchema } from './schema-registry'
import { typeIndexOf } from './schema-helpers'

function schema(queryFieldName: string): LoadSchemaOutput {
  return {
    queryType: 'Query',
    mutationType: null,
    subscriptionType: null,
    types: [
      {
        name: 'Query',
        kind: 'OBJECT',
        description: null,
        fields: [{ name: queryFieldName, description: null, typeName: 'String', typeDisplay: 'String', args: [], isDeprecated: false, deprecationReason: null }],
        inputFields: [],
        enumValues: [],
        interfaces: [],
        possibleTypes: [],
      },
    ],
    directives: [],
  } as unknown as LoadSchemaOutput
}

describe('internSchema', () => {
  it('duas cópias iguais (duas abas no mesmo endpoint) passam a ser a mesma instância', () => {
    const first = internSchema(schema('ping'))
    const second = internSchema(schema('ping'))

    expect(second).toBe(first)
  })

  it('schemas diferentes continuam separados', () => {
    const first = internSchema(schema('alpha'))
    const second = internSchema(schema('beta'))

    expect(second).not.toBe(first)
    expect(second.types[0].fields[0].name).toBe('beta')
  })

  it('o índice de tipos é montado uma vez por schema e reaproveitado', () => {
    const shared = internSchema(schema('gamma'))
    const again = internSchema(schema('gamma'))

    expect(typeIndexOf(again.types)).toBe(typeIndexOf(shared.types))
    expect(typeIndexOf(shared.types).get('Query')?.kind).toBe('OBJECT')
  })
})
