import { describe, expect, it } from 'vitest'
import type { LoadSchemaOutput, SchemaField, SchemaInputValue, SchemaType } from '../../bindings/load-schema'
import { graphqlCompletions } from './graphql-completions'

function arg(name: string, typeName: string, typeDisplay = typeName): SchemaInputValue {
  return { name, description: null, typeDisplay, typeName, defaultValue: null }
}

function field(name: string, typeName: string, args: SchemaInputValue[] = [], isDeprecated = false): SchemaField {
  return { name, description: null, args, typeDisplay: typeName, typeName, isDeprecated, deprecationReason: null }
}

function type(name: string, kind: string, overrides: Partial<SchemaType> = {}): SchemaType {
  return {
    name,
    kind,
    description: null,
    fields: [],
    inputFields: [],
    enumValues: [],
    interfaces: [],
    possibleTypes: [],
    ...overrides,
  }
}

const SCHEMA: LoadSchemaOutput = {
  queryType: 'Query',
  mutationType: 'Mutation',
  subscriptionType: null,
  directives: [],
  types: [
    type('Query', 'OBJECT', {
      fields: [
        field('user', 'User', [arg('id', 'ID', 'ID!'), arg('active', 'Boolean')]),
        field('users', 'User', [arg('order', 'Order')]),
        field('search', 'SearchResult'),
        field('legacy', 'String', [], true),
      ],
    }),
    type('Mutation', 'OBJECT', { fields: [field('createUser', 'User')] }),
    type('User', 'OBJECT', { fields: [field('id', 'ID'), field('name', 'String'), field('friends', 'User')] }),
    type('Post', 'OBJECT', { fields: [field('title', 'String')] }),
    type('SearchResult', 'UNION', { possibleTypes: ['User', 'Post'] }),
    type('Order', 'ENUM', {
      enumValues: [
        { name: 'ASC', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'DESC', description: null, isDeprecated: false, deprecationReason: null },
      ],
    }),
    type('ID', 'SCALAR'),
    type('String', 'SCALAR'),
    type('Boolean', 'SCALAR'),
  ],
}

/** `|` marca o cursor. */
function complete(source: string, explicit = false) {
  const pos = source.indexOf('|')
  const text = source.slice(0, pos) + source.slice(pos + 1)
  return graphqlCompletions(text, pos, SCHEMA, explicit)
}

function labels(source: string, explicit = false) {
  return complete(source, explicit)?.options.map((option) => option.label) ?? null
}

describe('graphqlCompletions', () => {
  it('sugere os campos do tipo raiz, com o tipo e depreciados por último', () => {
    const result = complete('query { us| }')

    expect(result?.from).toBe('query { '.length)
    expect(result?.options.map((option) => option.label)).toEqual(['user', 'users', 'search', 'legacy', '__typename'])
    expect(result?.options.find((option) => option.label === 'legacy')?.boost).toBe(-1)
    expect(result?.options.find((option) => option.label === 'user')?.detail).toBe('User')
  })

  it('segue o caminho dos campos, inclusive com argumentos, alias e query anônima', () => {
    expect(labels('{ user(id: "1") { friends { | } } }')).toEqual(['id', 'name', 'friends', '__typename'])
    expect(labels('{ me: user(id: "1") { n| } }')).toEqual(['id', 'name', 'friends', '__typename'])
  })

  it('usa o tipo raiz da operação e o tipo do fragmento', () => {
    expect(labels('mutation Criar { c| }')).toEqual(['createUser', '__typename'])
    expect(labels('fragment F on Post { t| }')).toEqual(['title', '__typename'])
  })

  it('não repete campos já selecionados no mesmo nível', () => {
    expect(labels('{ user(id: "1") { id n| } }')).toEqual(['name', 'friends', '__typename'])
  })

  it('sugere fragmentos inline em unions e as condições de tipo depois de `... on`', () => {
    expect(labels('{ search { | } }')).toEqual(['__typename', '... on User', '... on Post'])
    expect(labels('{ search { ... on | } }')).toEqual(['User', 'Post'])
    expect(labels('{ search { ... on Post { | } } }')).toEqual(['title', '__typename'])
  })

  it('sugere argumentos ainda não usados, obrigatórios primeiro', () => {
    const result = complete('{ user(| ) }')
    expect(result?.options.map((option) => option.label)).toEqual(['id', 'active'])
    expect(result?.options[0]).toMatchObject({ apply: 'id: ', detail: 'ID!', boost: 1 })
    expect(labels('{ user(id: "1", a|) }')).toEqual(['active'])
  })

  it('sugere valores de enum e booleanos para argumentos', () => {
    expect(labels('{ users(order: |) }')).toEqual(['ASC', 'DESC'])
    expect(labels('{ user(active: t|) }')).toEqual(['true', 'false'])
    expect(complete('{ user(id: |) }')).toBeNull()
  })

  it('sugere as palavras-chave fora das operações', () => {
    expect(labels('qu|')).toEqual(['query', 'mutation', 'subscription', 'fragment'])
  })

  it('sem texto digitado, só abre depois de `{`, `(` ou `:`, ou quando pedido', () => {
    expect(labels('{ user(id: "1") { id |')).toBeNull()
    expect(labels('{ user(id: "1") { id |', true)).toEqual(['name', 'friends', '__typename'])
    expect(labels('{ |')).not.toBeNull()
  })

  it('não sugere dentro de strings, comentários, variáveis, diretivas e `{{variável}}`', () => {
    expect(complete('{ user(id: "us|') ).toBeNull()
    expect(complete('{ # us|')).toBeNull()
    expect(complete('query Q($i|')).toBeNull()
    expect(complete('{ user @inc|')).toBeNull()
    expect(complete('{ user(id: {{us|')).toBeNull()
  })

  it('ignora os parênteses de diretivas ao seguir o caminho', () => {
    expect(labels('{ user(id: "1") @include(if: true) { n| } }')).toEqual(['id', 'name', 'friends', '__typename'])
  })

  it('não sugere nada sem tipo conhecido', () => {
    expect(complete('{ naoExiste { a| } }')).toBeNull()
  })
})
