import { describe, expect, it } from 'vitest'
import { tokenizeGraphql } from './graphql-syntax-highlight'

function reconstruct(source: string): string {
  return tokenizeGraphql(source)
    .map((token) => token.text)
    .join('')
}

describe('tokenizeGraphql', () => {
  it('classifica palavras-chave, nomes, pontuação, argumentos e strings', () => {
    const tokens = tokenizeGraphql('query Foo { user(name: "ana") { id } }')
    expect(tokens.map((token) => token.type)).toEqual([
      'keyword',
      'plain',
      'name',
      'plain',
      'punctuation',
      'plain',
      'name',
      'punctuation',
      'name',
      'punctuation',
      'plain',
      'string',
      'punctuation',
      'plain',
      'punctuation',
      'plain',
      'name',
      'plain',
      'punctuation',
      'plain',
      'punctuation',
    ])
  })

  it('marca o nome logo após "$" como variável', () => {
    const tokens = tokenizeGraphql('query($id: ID!) { user(id: $id) { name } }')
    const variableTokens = tokens.filter((token) => token.type === 'variable')
    expect(variableTokens.map((token) => token.text)).toEqual(['id', 'id'])
  })

  it('reconhece comentários de linha', () => {
    const tokens = tokenizeGraphql('# comentário\nquery { id }')
    expect(tokens.some((token) => token.type === 'comment' && token.text === '# comentário')).toBe(true)
  })

  it('reconstrói o texto original exatamente, incluindo espaços e vírgulas', () => {
    const source = 'query Foo($id: ID!) {\n  user(id: $id, active: true) {\n    id, name\n  }\n}\n'
    expect(reconstruct(source)).toBe(source)
  })

  it('não quebra com texto inválido/incompleto — devolve o restante como texto simples', () => {
    const source = 'query { user(name: "unterminated'
    expect(reconstruct(source)).toBe(source)
    expect(() => tokenizeGraphql(source)).not.toThrow()
  })

  it('devolve lista vazia para texto vazio', () => {
    expect(tokenizeGraphql('')).toEqual([])
  })
})
