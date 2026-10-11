import { json } from '@codemirror/lang-json'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { ParameterDocDto, SchemaNodeDto } from '../../bindings/get-request-docs'
import {
  applyJsonKey,
  jsonCursorContext,
  jsonSchemaCompletions,
  parameterNameSuggestions,
  parameterValueSuggestions,
} from './schema-completions'
import { schemaAtPath, schemaTypeLabel } from './schema-docs'
import type { SchemaMap } from './schema-docs'

function node(overrides: Partial<SchemaNodeDto> = {}): SchemaNodeDto {
  return {
    refName: null,
    types: [],
    format: null,
    title: null,
    description: '',
    nullable: false,
    deprecated: false,
    readOnly: false,
    writeOnly: false,
    enumValues: [],
    default: null,
    example: null,
    properties: [],
    required: [],
    items: null,
    additionalProperties: null,
    allOf: [],
    oneOf: [],
    anyOf: [],
    ...overrides,
  }
}

const ref = (name: string) => node({ refName: name })

const schemas: SchemaMap = {
  Pet: node({
    types: ['object'],
    required: ['name'],
    properties: [
      { name: 'name', schema: node({ types: ['string'], description: 'Nome do pet' }) },
      { name: 'status', schema: node({ types: ['string'], enumValues: ['"available"', '"sold"'] }) },
      { name: 'tags', schema: node({ types: ['array'], items: ref('Tag') }) },
      { name: 'vaccinated', schema: node({ types: ['boolean'] }) },
    ],
  }),
  Tag: node({ types: ['object'], properties: [{ name: 'label', schema: node({ types: ['string'] }) }] }),
  Dog: node({
    allOf: [ref('Pet'), node({ types: ['object'], properties: [{ name: 'breed', schema: node({ types: ['string'] }) }] })],
  }),
}

/** `|` marca a posição do cursor. */
function at(source: string): [string, number] {
  const pos = source.indexOf('|')
  return [source.slice(0, pos) + source.slice(pos + 1), pos]
}

describe('jsonCursorContext', () => {
  it('reconhece a posição de chave no objeto raiz, com as chaves já usadas', () => {
    const [text, pos] = at('{"name": "Rex", |}')
    expect(jsonCursorContext(text, pos)).toEqual({
      kind: 'key',
      path: [],
      existingKeys: ['name'],
      from: pos,
      to: pos,
      quoted: false,
    })
  })

  it('reconhece uma chave entre aspas e inclui a aspa de fechamento no trecho substituído', () => {
    const [text, pos] = at('{"na|"}')
    expect(jsonCursorContext(text, pos)).toMatchObject({ kind: 'key', from: 2, to: pos + 1, quoted: true })
  })

  it('reconhece valores em objetos aninhados e itens de lista', () => {
    const [text, pos] = at('{"tags": [{"label": |')
    expect(jsonCursorContext(text, pos)).toMatchObject({
      kind: 'value',
      path: [{ kind: 'property', name: 'tags' }, { kind: 'item' }, { kind: 'property', name: 'label' }],
    })
  })

  it('trata {{variável}} fora de string como um valor, sem abrir objetos', () => {
    const [text, pos] = at('{"id": {{id}}, |')
    expect(jsonCursorContext(text, pos)).toMatchObject({ kind: 'key', path: [], existingKeys: ['id'] })
  })

  it('não sugere nada logo depois de um valor ou antes do dois-pontos', () => {
    const [afterValue, afterValuePos] = at('{"name": "Rex" |')
    expect(jsonCursorContext(afterValue, afterValuePos)).toBeNull()
    const [beforeColon, beforeColonPos] = at('{"name" |')
    expect(jsonCursorContext(beforeColon, beforeColonPos)).toBeNull()
  })

  it('não sugere nada fora de qualquer objeto ou lista', () => {
    expect(jsonCursorContext('', 0)).toBeNull()
  })
})

describe('jsonSchemaCompletions', () => {
  const body = { root: ref('Pet'), schemas }

  it('sugere as chaves ausentes com tipo, obrigatoriedade e descrição', () => {
    const [text, pos] = at('{"status": "sold", |}')
    const result = jsonSchemaCompletions(text, pos, body)
    expect(result?.options.map((option) => option.label)).toEqual(['name', 'tags', 'vaccinated'])
    expect(result?.options[0]).toMatchObject({
      apply: '"name": ',
      detail: 'string *',
      info: 'Nome do pet',
      boost: 1,
    })
  })

  it('completa uma chave já aberta com aspas sem duplicá-las', () => {
    const [text, pos] = at('{"va|"}')
    const result = jsonSchemaCompletions(text, pos, body)
    expect(result?.options.find((option) => option.label === 'vaccinated')?.apply).toBe('vaccinated": ')
    expect(result?.to).toBe(pos + 1)
  })

  it('sugere valores de enum e booleanos na posição de valor', () => {
    const [enumText, enumPos] = at('{"status": |')
    expect(jsonSchemaCompletions(enumText, enumPos, body)?.options.map((option) => option.apply)).toEqual([
      '"available"',
      '"sold"',
    ])
    const [quotedText, quotedPos] = at('{"status": "av|')
    expect(jsonSchemaCompletions(quotedText, quotedPos, body)?.options[0]).toEqual({ label: 'available', apply: 'available"' })
    const [boolText, boolPos] = at('{"vaccinated": |')
    expect(jsonSchemaCompletions(boolText, boolPos, body)?.options.map((option) => option.label)).toEqual(['true', 'false'])
  })

  it('segue referências e itens de lista até o schema certo', () => {
    const [text, pos] = at('{"tags": [{|')
    expect(jsonSchemaCompletions(text, pos, body)?.options.map((option) => option.label)).toEqual(['label'])
  })

  it('combina propriedades de allOf', () => {
    const [text, pos] = at('{|')
    const labels = jsonSchemaCompletions(text, pos, { root: ref('Dog'), schemas })?.options.map((option) => option.label)
    expect(labels).toEqual(['name', 'status', 'tags', 'vaccinated', 'breed'])
  })

  it('não sugere nada fora do schema', () => {
    const [text, pos] = at('{"unknown": {|')
    expect(jsonSchemaCompletions(text, pos, body)).toBeNull()
  })
})

describe('applyJsonKey', () => {
  const body = { root: ref('Pet'), schemas }

  /** Aceita a sugestão `name` no ponto `|` e devolve o documento com `|` no cursor. */
  function acceptKey(source: string, name = 'name'): string {
    const [text, pos] = at(source)
    const result = jsonSchemaCompletions(text, pos, body)
    const option = result?.options.find((candidate) => candidate.label === name)
    if (!result || result.keyStart === undefined || !option) throw new Error(`sem sugestão de chave em ${source}`)
    const view = new EditorView({ state: EditorState.create({ doc: text, selection: { anchor: pos }, extensions: json() }) })
    applyJsonKey(name, result.keyStart)(view, { label: name }, result.from, result.to)
    const cursor = view.state.selection.main.head
    const doc = view.state.doc.toString()
    view.destroy()
    return doc.slice(0, cursor) + '|' + doc.slice(cursor)
  }

  it('leva a chave para a linha seguinte ao abrir o objeto, descendo o fechamento', () => {
    expect(acceptKey('{|}')).toBe('{\n  "name": |\n}')
  })

  it('leva a chave para a linha seguinte depois de uma vírgula', () => {
    expect(acceptKey('{"status": "sold", |}')).toBe('{"status": "sold",\n  "name": |\n}')
    expect(acceptKey('{\n  "status": "sold",|\n}')).toBe('{\n  "status": "sold",\n  "name": |\n}')
  })

  it('substitui a chave já aberta com aspas', () => {
    expect(acceptKey('{"na|"}')).toBe('{\n  "name": |\n}')
  })

  it('numa linha só com indentação, completa ali mesmo', () => {
    expect(acceptKey('{\n  |\n}')).toBe('{\n  "name": |\n}')
    expect(acceptKey('{\n  "na|"\n}')).toBe('{\n  "name": |\n}')
  })

  it('indenta objetos aninhados a partir da linha do pai', () => {
    expect(acceptKey('{\n  "tags": [{|}]\n}', 'label')).toBe('{\n  "tags": [{\n    "label": |\n  }]\n}')
  })
})

describe('schema-docs', () => {
  it('descreve tipos de forma curta', () => {
    expect(schemaTypeLabel(node({ types: ['string'], format: 'date-time' }))).toBe('string (date-time)')
    expect(schemaTypeLabel(node({ types: ['array'], items: ref('Tag') }))).toBe('array<Tag>')
    expect(schemaTypeLabel(node({ types: ['integer'], nullable: true }))).toBe('integer | null')
    expect(schemaTypeLabel(node({ oneOf: [node({ types: ['string'] }), node({ types: ['integer'] })] }))).toBe('string | integer')
    expect(schemaTypeLabel(node())).toBe('any')
  })

  it('não entra em loop com referências cíclicas', () => {
    const cyclic: SchemaMap = { A: ref('B'), B: ref('A') }
    expect(schemaAtPath(ref('A'), [{ kind: 'property', name: 'x' }], cyclic)).toBeNull()
  })
})

describe('sugestões de Params e Headers', () => {
  const parameter = (overrides: Partial<ParameterDocDto>): ParameterDocDto => ({
    name: 'status',
    location: 'query',
    required: false,
    deprecated: false,
    description: '',
    schema: null,
    example: null,
    ...overrides,
  })
  const parameters = [
    parameter({ name: 'page', schema: node({ types: ['integer'], default: '1' }), description: 'Página' }),
    parameter({ name: 'status', required: true, schema: node({ types: ['string'], enumValues: ['"open"', '"closed"'] }) }),
    parameter({ name: 'X-Tenant', location: 'header', example: '"acme"' }),
  ]

  it('sugere nomes ainda não usados, obrigatórios primeiro', () => {
    expect(parameterNameSuggestions(parameters, ['page'])).toEqual([
      { value: 'status', detail: 'string *', description: undefined },
      { value: 'X-Tenant', detail: undefined, description: undefined },
    ])
  })

  it('compara nomes de header sem diferenciar maiúsculas', () => {
    expect(parameterNameSuggestions(parameters, ['x-tenant'], true).map((suggestion) => suggestion.value)).toEqual([
      'status',
      'page',
    ])
  })

  it('sugere valores de enum, default e exemplo como texto simples', () => {
    expect(parameterValueSuggestions(parameters, 'status', {})).toEqual([{ value: 'open' }, { value: 'closed' }])
    expect(parameterValueSuggestions(parameters, 'page', {})).toEqual([{ value: '1' }])
    expect(parameterValueSuggestions(parameters, 'x-tenant', {}, true)).toEqual([{ value: 'acme' }])
    expect(parameterValueSuggestions(parameters, 'missing', {})).toEqual([])
  })
})
