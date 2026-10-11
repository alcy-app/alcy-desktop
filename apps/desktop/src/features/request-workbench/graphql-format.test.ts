import { describe, expect, it } from 'vitest'
import { formatGraphqlQuery } from './graphql-format'

describe('formatGraphqlQuery', () => {
  it('reformata uma query compacta com indentação padrão', () => {
    const result = formatGraphqlQuery('{currentCustomer{id name}}')
    expect(result).toBe('{\n  currentCustomer {\n    id\n    name\n  }\n}')
  })

  it('preserva o nome e o tipo da operação', () => {
    const result = formatGraphqlQuery('query GetCustomer($id:ID!){customer(id:$id){name}}')
    expect(result).toBe('query GetCustomer($id: ID!) {\n  customer(id: $id) {\n    name\n  }\n}')
  })

  it('devolve null para uma query sintaticamente inválida', () => {
    expect(formatGraphqlQuery('{ currentCustomer {')).toBeNull()
  })

  it('devolve null para texto vazio', () => {
    expect(formatGraphqlQuery('')).toBeNull()
  })
})
