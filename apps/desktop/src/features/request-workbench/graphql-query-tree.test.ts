import { describe, expect, it } from 'vitest'
import {
  createEmptyQuery,
  ensureFieldPath,
  getArgValue,
  isFieldSelected,
  parseArgPairs,
  parseQuery,
  setFieldArgument,
  toggleField,
} from './graphql-query-tree'

describe('parseQuery', () => {
  it('interpreta uma operação anônima com campos aninhados', () => {
    const parsed = parseQuery('{ currentCustomer { id name } }')!

    expect(parsed.operationType).toBe('query')
    expect(parsed.operationName).toBe('')
    expect(isFieldSelected(parsed, [], 'currentCustomer')).toBe(true)
    expect(isFieldSelected(parsed, ['currentCustomer'], 'id')).toBe(true)
    expect(isFieldSelected(parsed, ['currentCustomer'], 'name')).toBe(true)
  })

  it('interpreta query nomeada, mutation e subscription', () => {
    expect(parseQuery('query GetOrder { order { total } }')?.operationName).toBe('GetOrder')
    expect(parseQuery('mutation { ping }')?.operationType).toBe('mutation')
    expect(parseQuery('subscription { ping }')?.operationType).toBe('subscription')
  })

  it('preserva argumentos e não se confunde com chaves dentro de uma string', () => {
    const parsed = parseQuery('{ search(filter: "{ not a brace }") { id } }')!

    expect(isFieldSelected(parsed, [], 'search')).toBe(true)
    expect(isFieldSelected(parsed, ['search'], 'id')).toBe(true)
  })

  it('tolera comentários de linha', () => {
    const parsed = parseQuery('{\n  # comentário\n  ping\n}')!

    expect(isFieldSelected(parsed, [], 'ping')).toBe(true)
  })

  it('tolera variáveis de operação sem interpretá-las', () => {
    const parsed = parseQuery('query GetOrder($id: ID!) { order(id: $id) { total } }')!

    expect(parsed.operationName).toBe('GetOrder')
    expect(isFieldSelected(parsed, [], 'order')).toBe(true)
  })

  it('tolera fragment spreads e definições de fragmento', () => {
    const parsed = parseQuery(
      '{ currentCustomer { ...CustomerFields } }\nfragment CustomerFields on Customer { id name }',
    )!

    expect(isFieldSelected(parsed, [], 'currentCustomer')).toBe(true)
  })

  it('rejeita fragmentos inline (não suportados)', () => {
    expect(parseQuery('{ pet { ... on Dog { bark } } }')).toBeNull()
  })

  it('retorna null para uma query vazia, só espaços, ou texto inválido', () => {
    expect(parseQuery('')).toBeNull()
    expect(parseQuery('   ')).toBeNull()
    expect(parseQuery('isso não é graphql')).toBeNull()
    expect(parseQuery('{ currentCustomer { id ')).toBeNull()
  })
})

describe('toggleField', () => {
  it('cria uma operação anônima mínima ao adicionar o primeiro campo escalar', () => {
    const result = toggleField(createEmptyQuery(), [], 'ping', false)

    expect(result).toBe('{\n  ping\n}')
  })

  it('adiciona um campo com subcampos com chaves compactas vazias', () => {
    const result = toggleField(createEmptyQuery(), [], 'currentCustomer', true)

    expect(result).toBe('{\n  currentCustomer {}\n}')
  })

  it('nunca duplica: clicar de novo no mesmo campo remove em vez de duplicar', () => {
    const first = toggleField(createEmptyQuery(), [], 'ping', false)
    const second = toggleField(parseQuery(first)!, [], 'ping', false)

    expect(second).toBe('{}')
  })

  it('aninha um campo filho respeitando a indentação existente do bloco pai', () => {
    const source = '{\n    currentCustomer {}\n}'
    const parsed = parseQuery(source)!

    const result = toggleField(parsed, ['currentCustomer'], 'id', false)

    expect(result).toBe('{\n    currentCustomer {\n      id\n    }\n}')
  })

  it('encadeia duas adições mantendo a indentação consistente entre irmãos', () => {
    const first = toggleField(createEmptyQuery(), [], 'currentCustomer', true)
    const second = toggleField(parseQuery(first)!, ['currentCustomer'], 'id', false)
    const third = toggleField(parseQuery(second)!, ['currentCustomer'], 'name', false)

    expect(third).toBe('{\n  currentCustomer {\n    id\n    name\n  }\n}')
  })

  it('remove um campo do meio preservando os irmãos e a formatação ao redor', () => {
    const nested = '{\n  currentCustomer {\n    id\n    name\n  }\n}'
    const parsed = parseQuery(nested)!

    const result = toggleField(parsed, ['currentCustomer'], 'id', false)

    expect(result).toBe('{\n  currentCustomer {\n    name\n  }\n}')
  })

  it('remove um campo com subcampos junto com toda a sua subárvore', () => {
    const source = '{\n  currentCustomer {\n    id\n  }\n  ping\n}'
    const parsed = parseQuery(source)!

    const result = toggleField(parsed, [], 'currentCustomer', true)

    expect(result).toBe('{\n  ping\n}')
    expect(parseQuery(result)).not.toBeNull()
    expect(isFieldSelected(parseQuery(result)!, [], 'currentCustomer')).toBe(false)
  })

  it('colapsa de volta a chaves vazias ao remover o único campo restante', () => {
    const source = '{\n  currentCustomer {\n    id\n  }\n}'
    const parsed = parseQuery(source)!

    const afterRemovingId = toggleField(parsed, ['currentCustomer'], 'id', false)
    expect(afterRemovingId).toBe('{\n  currentCustomer {}\n}')

    const afterRemovingParent = toggleField(parseQuery(afterRemovingId)!, [], 'currentCustomer', true)
    expect(afterRemovingParent).toBe('{}')
  })

  it('preserva comentários fora do campo editado', () => {
    const source = '{\n  # note\n  id\n  name\n}'
    const parsed = parseQuery(source)!

    const result = toggleField(parsed, [], 'name', false)

    expect(result).toBe('{\n  # note\n  id\n}')
  })

  it('preserva variáveis de operação e fragment spreads ao editar um campo irmão', () => {
    const source = 'query GetOrder($id: ID!) {\n  order(id: $id) {\n    ...OrderFields\n  }\n  ping\n}'
    const parsed = parseQuery(source)!

    const result = toggleField(parsed, [], 'ping', false)

    expect(result).toContain('query GetOrder($id: ID!)')
    expect(result).toContain('...OrderFields')
    expect(result).not.toMatch(/\bping\b/)
  })

  it('ignora um caminho que não existe mais na seleção, devolvendo a query inalterada', () => {
    const source = '{\n  ping\n}'
    const parsed = parseQuery(source)!

    const result = toggleField(parsed, ['nonExistentParent'], 'id', false)

    expect(result).toBe(source)
  })
})

describe('ensureFieldPath', () => {
  it('não muda nada quando o caminho já está selecionado', () => {
    const source = '{\n  currentCustomer {\n    id\n  }\n}'
    const parsed = parseQuery(source)!

    const result = ensureFieldPath(parsed, ['currentCustomer'])

    expect(result.source).toBe(source)
  })

  it('adiciona o ancestral que falta a partir de uma query vazia', () => {
    const result = ensureFieldPath(createEmptyQuery(), ['currentCustomer'])

    expect(result.source).toBe('{\n  currentCustomer {}\n}')
  })

  it('constrói uma cadeia inteira de ancestrais que faltam, dois níveis de uma vez', () => {
    const result = ensureFieldPath(createEmptyQuery(), ['order', 'customer'])

    expect(result.source).toBe('{\n  order {\n    customer {}\n  }\n}')
  })
})

describe('parseArgPairs', () => {
  it('interpreta pares simples, ignorando vírgulas dentro de strings e listas', () => {
    expect(parseArgPairs('(id: "1", tags: ["a, b", "c"])')).toEqual([
      { name: 'id', value: '"1"' },
      { name: 'tags', value: '["a, b", "c"]' },
    ])
  })

  it('devolve lista vazia para texto sem argumentos', () => {
    expect(parseArgPairs('')).toEqual([])
    expect(parseArgPairs('()')).toEqual([])
  })
})

describe('getArgValue e setFieldArgument', () => {
  it('lê o valor bruto de um argumento existente', () => {
    const parsed = parseQuery('{ continent(code: "1A") { name } }')!

    expect(getArgValue(parsed, [], 'continent', 'code')).toBe('"1A"')
    expect(getArgValue(parsed, [], 'continent', 'missing')).toBeUndefined()
  })

  it('adiciona os parênteses de argumento quando o campo ainda não tinha nenhum', () => {
    const parsed = parseQuery('{ continent { name } }')!

    const result = setFieldArgument(parsed, [], 'continent', true, 'code', '"1A"')

    expect(result).toBe('{ continent(code: "1A") { name } }')
  })

  it('atualiza o valor de um argumento já presente sem duplicar', () => {
    const parsed = parseQuery('{ continent(code: "1A") { name } }')!

    const result = setFieldArgument(parsed, [], 'continent', true, 'code', '"EU"')

    expect(result).toBe('{ continent(code: "EU") { name } }')
  })

  it('remove o argumento e os parênteses quando era o único', () => {
    const parsed = parseQuery('{ continent(code: "1A") { name } }')!

    const result = setFieldArgument(parsed, [], 'continent', true, 'code', null)

    expect(result).toBe('{ continent { name } }')
  })

  it('preserva os demais argumentos ao remover só um deles', () => {
    const parsed = parseQuery('{ search(query: "a", limit: 10) { id } }')!

    const result = setFieldArgument(parsed, [], 'search', false, 'limit', null)

    expect(result).toBe('{ search(query: "a") { id } }')
  })

  it('cascateia a seleção dos ancestrais e do próprio campo ao definir um argumento numa query vazia', () => {
    const result = setFieldArgument(createEmptyQuery(), [], 'continent', true, 'code', '"1A"')

    expect(result).toBe('{\n  continent(code: "1A") {}\n}')
  })

  it('remover argumento de um campo não selecionado é um no-op', () => {
    const parsed = parseQuery('{ ping }')!

    const result = setFieldArgument(parsed, [], 'continent', true, 'code', null)

    expect(result).toBe('{ ping }')
  })
})
