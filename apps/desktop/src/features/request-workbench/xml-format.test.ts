import { describe, expect, it } from 'vitest'
import { formatXmlBody } from './xml-format'

describe('formatXmlBody', () => {
  it('reindenta um documento com 2 espaços, um elemento por linha', () => {
    expect(formatXmlBody('<root><a>1</a><b>2</b></root>')).toBe(
      '<root>\n  <a>1</a>\n  <b>2</b>\n</root>',
    )
  })

  it('mantém um elemento cujo único filho é texto em uma linha só', () => {
    expect(formatXmlBody('<root><name>ana</name></root>')).toBe('<root>\n  <name>ana</name>\n</root>')
  })

  it('lida com tags de autofechamento sem alterar a profundidade', () => {
    expect(formatXmlBody('<root><br/></root>')).toBe('<root>\n  <br/>\n</root>')
  })

  it('preserva comentários exatamente como estão', () => {
    expect(formatXmlBody('<root><!-- c --><a>x</a></root>')).toBe(
      '<root>\n  <!-- c -->\n  <a>x</a>\n</root>',
    )
  })

  it('preserva CDATA exatamente como está', () => {
    expect(formatXmlBody('<root><![CDATA[<raw>]]></root>')).toBe('<root>\n  <![CDATA[<raw>]]>\n</root>')
  })

  it('devolve o texto original quando não parece XML', () => {
    expect(formatXmlBody('não é xml')).toBe('não é xml')
  })

  it('devolve o texto original para corpo vazio', () => {
    expect(formatXmlBody('')).toBe('')
  })
})
