import { describe, expect, it } from 'vitest'
import { accessorFor, captureStatement, captureVariableName, findValueAt, indexJsonValues } from './json-value-index'

const doc = JSON.stringify({ data: { token: 'abc', items: [{ id: 7 }, true], 'a-b': null } }, null, 2)

describe('indexJsonValues', () => {
  it('indexa só os valores primitivos, com a faixa e o caminho de cada um', () => {
    const values = indexJsonValues(doc)

    expect(values.map((value) => value.path)).toEqual([
      ['data', 'token'],
      ['data', 'items', 0, 'id'],
      ['data', 'items', 1],
      ['data', 'a-b'],
    ])
    const token = values[0]
    expect(doc.slice(token.from, token.to)).toBe('"abc"')
    expect(doc.slice(values[1].from, values[1].to)).toBe('7')
  })

  it('trata escapes em strings e chaves', () => {
    const text = '{"a\\"b": "x\\"y"}'
    const [value] = indexJsonValues(text)

    expect(value.path).toEqual(['a"b'])
    expect(text.slice(value.from, value.to)).toBe('"x\\"y"')
  })

  it('devolve vazio para JSON inválido ou com lixo depois do valor', () => {
    expect(indexJsonValues('{"a": ')).toEqual([])
    expect(indexJsonValues('{"a": 1} extra')).toEqual([])
    expect(indexJsonValues('not json')).toEqual([])
  })

  it('aceita um valor primitivo na raiz e containers vazios', () => {
    expect(indexJsonValues('42')).toEqual([{ from: 0, to: 2, path: [] }])
    expect(indexJsonValues('{"a": {}, "b": []}')).toEqual([])
  })

  it('inclui arrays vazios só quando pedido', () => {
    const text = '{"a": {}, "b": [ ], "c": [[]]}'
    const values = indexJsonValues(text, { emptyArrays: true })

    expect(values.map((value) => [value.path, text.slice(value.from, value.to)])).toEqual([
      [['b'], '[ ]'],
      [['c', 0], '[]'],
    ])
  })
})

describe('findValueAt', () => {
  it('encontra o valor que contém a posição e ignora chaves e pontuação', () => {
    const values = indexJsonValues(doc)
    const start = doc.indexOf('"abc"')

    expect(findValueAt(values, start + 2)?.path).toEqual(['data', 'token'])
    expect(findValueAt(values, doc.indexOf('"token"') + 2)).toBeNull()
    expect(findValueAt(values, 0)).toBeNull()
  })
})

describe('captura', () => {
  it('monta o acessor com pontos, colchetes e índices', () => {
    expect(accessorFor(['data', 'items', 0, 'id'])).toBe('.data.items[0].id')
    expect(accessorFor(['a-b', 'x'])).toBe('["a-b"].x')
  })

  it('sugere o nome da variável pela última chave', () => {
    expect(captureVariableName(['data', 'token'])).toBe('token')
    expect(captureVariableName(['items', 0])).toBe('items')
    expect(captureVariableName(['a-b'])).toBe('a_b')
    expect(captureVariableName([])).toBe('value')
  })

  it('gera a linha de script', () => {
    expect(captureStatement(['data', 'token'])).toBe("al.environment.set('token', al.response.json().data.token);")
  })
})
