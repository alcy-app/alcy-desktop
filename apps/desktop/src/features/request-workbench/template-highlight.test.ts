import { describe, expect, it } from 'vitest'
import { findOpenTemplateQuery, parseTemplate } from './template-highlight'

describe('parseTemplate', () => {
  it('retorna um único segmento de texto quando não há placeholder', () => {
    expect(parseTemplate('https://static.example.com/graphql')).toEqual([
      { type: 'text', value: 'https://static.example.com/graphql' },
    ])
  })

  it('reconhece um placeholder simples', () => {
    expect(parseTemplate('{{baseUrl}}/graphql')).toEqual([
      { type: 'variable', raw: '{{baseUrl}}', name: 'baseUrl' },
      { type: 'text', value: '/graphql' },
    ])
  })

  it('reconhece múltiplos placeholders com texto entre eles', () => {
    expect(parseTemplate('Bearer {{token}} for {{baseUrl}}')).toEqual([
      { type: 'text', value: 'Bearer ' },
      { type: 'variable', raw: '{{token}}', name: 'token' },
      { type: 'text', value: ' for ' },
      { type: 'variable', raw: '{{baseUrl}}', name: 'baseUrl' },
    ])
  })

  it('preserva espaços dentro das chaves no raw, mas normaliza o nome', () => {
    expect(parseTemplate('{{ baseUrl }}')).toEqual([{ type: 'variable', raw: '{{ baseUrl }}', name: 'baseUrl' }])
  })

  it('mantém um "{{" sem fechamento como texto literal', () => {
    // dois segmentos de texto adjacentes: visualmente idênticos a um só,
    // já que ambos renderizam sem estilo de placeholder.
    expect(parseTemplate('prefix {{unclosed')).toEqual([
      { type: 'text', value: 'prefix ' },
      { type: 'text', value: '{{unclosed' },
    ])
  })

  it('retorna uma lista vazia para uma string vazia', () => {
    expect(parseTemplate('')).toEqual([])
  })
})

describe('findOpenTemplateQuery', () => {
  it('retorna null quando não há "{{" antes do cursor', () => {
    expect(findOpenTemplateQuery('https://example.com', 5)).toBeNull()
  })

  it('reconhece um placeholder aberto e devolve o texto digitado depois do "{{"', () => {
    const value = '{{base'
    expect(findOpenTemplateQuery(value, value.length)).toEqual({ start: 2, query: 'base' })
  })

  it('retorna null quando o placeholder já foi fechado antes do cursor', () => {
    const value = '{{baseUrl}}/graphql'
    expect(findOpenTemplateQuery(value, value.length)).toBeNull()
  })

  it('considera só o "{{" mais próximo do cursor quando há mais de um', () => {
    const value = '{{token}} and {{ba'
    expect(findOpenTemplateQuery(value, value.length)).toEqual({ start: 16, query: 'ba' })
  })

  it('ignora texto depois do cursor', () => {
    const value = '{{base}} unrelated'
    // cursor no meio de "base", antes do "}}" — o placeholder ainda está "aberto" até aqui.
    expect(findOpenTemplateQuery(value, 5)).toEqual({ start: 2, query: 'bas' })
  })
})
