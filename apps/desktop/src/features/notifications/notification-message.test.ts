import { describe, expect, it } from 'vitest'
import { parseMessage } from './notification-message'

describe('parseMessage', () => {
  it('mantém mensagens sem links como um único trecho de texto', () => {
    expect(parseMessage('Linha 1\nLinha 2')).toEqual([{ type: 'text', text: 'Linha 1\nLinha 2' }])
  })

  it('separa links do texto ao redor', () => {
    expect(parseMessage('Veja [as novidades](https://alcy.dev/v2) e [o guia](http://a.b/c?x=1).')).toEqual([
      { type: 'text', text: 'Veja ' },
      { type: 'link', text: 'as novidades', url: 'https://alcy.dev/v2' },
      { type: 'text', text: ' e ' },
      { type: 'link', text: 'o guia', url: 'http://a.b/c?x=1' },
      { type: 'text', text: '.' },
    ])
  })

  it('aceita link no início e no fim da mensagem', () => {
    expect(parseMessage('[a](https://a.b)')).toEqual([{ type: 'link', text: 'a', url: 'https://a.b' }])
  })

  it('deixa como texto links com esquema não http(s) ou malformados', () => {
    for (const message of ['[x](file:///etc/passwd)', '[x](javascript:alert(1))', '[x] (https://a.b)', '[](https://a.b)']) {
      expect(parseMessage(message)).toEqual([{ type: 'text', text: message }])
    }
  })

  it('devolve lista vazia para mensagem vazia', () => {
    expect(parseMessage('')).toEqual([])
  })
})
