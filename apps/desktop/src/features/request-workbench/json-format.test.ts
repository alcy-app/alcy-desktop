import { describe, expect, it } from 'vitest'
import { formatJsonBody, formatPartialJsonBody } from './json-format'

describe('formatJsonBody', () => {
  it('reformata um corpo compacto com indentação de 2 espaços', () => {
    expect(formatJsonBody('{"data":{"id":1}}')).toBe('{\n  "data": {\n    "id": 1\n  }\n}')
  })

  it('devolve o texto original quando não é JSON válido', () => {
    expect(formatJsonBody('not json')).toBe('not json')
  })

  it('devolve o texto original para corpo vazio', () => {
    expect(formatJsonBody('')).toBe('')
  })
})

describe('formatPartialJsonBody', () => {
  const stringify = (text: string) => JSON.stringify(JSON.parse(text), null, 2)

  it('produz a mesma saída de formatJsonBody para JSON válido compacto', () => {
    const samples = [
      '{"data":{"countries":[{"code":"AD","states":[],"meta":{},"phones":["376"],"ok":true,"n":null,"x":-1.5}]}}',
      '[1,[2,[3,[]]],{"a":{"b":{}}}]',
      '{"tricky":"vírgula, chave { colchete ] dois-pontos: e \\"aspas\\"","barra":"\\\\"}',
      '{}',
      '[]',
    ]
    for (const sample of samples) {
      expect(formatPartialJsonBody(sample)).toBe(stringify(sample))
    }
  })

  it('normaliza JSON já indentado', () => {
    const indented = '{\n    "a" : [ 1 , 2 ],\n\t"b": { }\n}'
    expect(formatPartialJsonBody(indented)).toBe(stringify(indented))
  })

  it('indenta prefixos truncados sem lançar', () => {
    expect(formatPartialJsonBody('{"data":{"items":[{"id":1},{"na')).toBe(
      '{\n  "data": {\n    "items": [\n      {\n        "id": 1\n      },\n      {\n        "na',
    )
    expect(formatPartialJsonBody('{"a":"texto com \\"')).toBe('{\n  "a": "texto com \\"')
    expect(formatPartialJsonBody('{"a":12')).toBe('{\n  "a": 12')
    expect(formatPartialJsonBody('{"a":1,')).toBe('{\n  "a": 1,\n  ')
    expect(formatPartialJsonBody('{"a":')).toBe('{\n  "a": ')
    expect(formatPartialJsonBody('[')).toBe('[')
  })

  it('nunca produz indentação negativa com fechamentos sobrando', () => {
    expect(() => formatPartialJsonBody('{}]]}')).not.toThrow()
  })

  it('devolve intacto o texto que não começa como objeto ou array JSON', () => {
    expect(formatPartialJsonBody('<html>a, b: c</html>')).toBe('<html>a, b: c</html>')
    expect(formatPartialJsonBody('')).toBe('')
  })
})
