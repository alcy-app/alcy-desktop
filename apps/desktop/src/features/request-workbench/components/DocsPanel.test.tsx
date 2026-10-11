import { describe, expect, it } from 'vitest'
import type { RequestDocsDto, SchemaNodeDto } from '../../../bindings/get-request-docs'
import { fireEvent, render, screen, within } from '../../../test-utils'
import { DocsPanel } from './DocsPanel'

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

const DOCS: RequestDocsDto = {
  sourceTitle: 'Pet Store',
  sourceKind: 'openapi',
  summary: 'Cria um pet',
  description: 'Grava um pet novo.\nNomes repetidos são aceitos.',
  deprecated: true,
  parameters: [
    {
      name: 'petId',
      location: 'path',
      required: true,
      deprecated: false,
      description: 'Id do pet',
      schema: node({ types: ['integer'], format: 'int64' }),
      example: null,
    },
    {
      name: 'status',
      location: 'query',
      required: false,
      deprecated: false,
      description: '',
      schema: node({ types: ['string'], enumValues: ['"available"', '"sold"'], default: '"available"' }),
      example: null,
    },
  ],
  requestBody: {
    description: 'Pet a gravar',
    required: true,
    content: [{ mediaType: 'application/json', schema: node({ refName: 'Pet' }), example: '{\n  "name": "Rex"\n}' }],
  },
  responses: [{ status: '201', description: 'Criado', content: [] }],
  schemas: {
    Pet: node({
      types: ['object'],
      description: 'Um pet',
      required: ['name'],
      properties: [
        { name: 'name', schema: node({ types: ['string'], description: 'Nome do pet' }) },
        { name: 'parent', schema: node({ refName: 'Pet' }) },
      ],
    }),
  },
}

describe('DocsPanel', () => {
  it('mostra um estado vazio quando a requisição não tem documentação', () => {
    render(<DocsPanel state={{ status: 'none' }} />)
    expect(screen.getByText('Sem documentação')).toBeInTheDocument()
  })

  it('mostra carregamento, documentação ausente e erro', () => {
    const { rerender } = render(<DocsPanel state={{ status: 'loading' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Carregando documentação…')

    rerender(<DocsPanel state={{ status: 'missing' }} />)
    expect(screen.getByText('Documentação não encontrada')).toBeInTheDocument()

    rerender(<DocsPanel state={{ status: 'error', message: 'arquivo corrompido' }} />)
    expect(screen.getByText('Não foi possível carregar a documentação: arquivo corrompido')).toBeInTheDocument()
  })

  it('mostra resumo, origem, descrição, parâmetros por local, corpo e respostas', () => {
    render(<DocsPanel state={{ status: 'ready', docs: DOCS }} />)

    expect(screen.getByRole('heading', { name: 'Cria um pet' })).toBeInTheDocument()
    expect(screen.getByText('Importado de Pet Store (OpenAPI)')).toBeInTheDocument()
    expect(screen.getByText(/Nomes repetidos são aceitos/)).toBeInTheDocument()

    const path = screen.getByRole('region', { name: 'Parâmetros de path' })
    expect(within(path).getByText('petId')).toBeInTheDocument()
    expect(within(path).getByText('integer (int64)')).toBeInTheDocument()
    expect(within(path).getByText('Id do pet')).toBeInTheDocument()

    const query = screen.getByRole('region', { name: 'Parâmetros de query' })
    expect(within(query).getByText('Valores: "available", "sold"')).toBeInTheDocument()
    expect(within(query).getByText('Padrão: "available"')).toBeInTheDocument()

    const body = screen.getByRole('region', { name: 'Corpo da requisição' })
    expect(within(body).getByText('Pet a gravar')).toBeInTheDocument()
    expect(within(body).getByText('application/json')).toBeInTheDocument()

    const responses = screen.getByRole('region', { name: 'Respostas' })
    expect(within(responses).getByText('201')).toBeInTheDocument()
    expect(within(responses).getByText('Criado')).toBeInTheDocument()
  })

  it('marca a referência a um ancestral como recursiva, sem expandi-la', () => {
    render(<DocsPanel state={{ status: 'ready', docs: DOCS }} />)
    const body = screen.getByRole('region', { name: 'Corpo da requisição' })

    // A raiz do corpo já vem aberta, com as propriedades do schema referenciado.
    expect(within(body).getByText('Nome do pet')).toBeInTheDocument()
    const parentRow = within(body).getByText('parent').closest('li')!
    expect(within(parentRow).getByText('(recursivo)')).toBeInTheDocument()
    expect(within(parentRow).queryByRole('button', { name: 'Expandir' })).not.toBeInTheDocument()
  })

  it('lista os schemas nomeados recolhidos e os expande sob demanda', () => {
    render(<DocsPanel state={{ status: 'ready', docs: DOCS }} />)
    const schemas = screen.getByRole('region', { name: 'Schemas' })
    expect(within(schemas).getByText('Pet')).toBeInTheDocument()
    expect(within(schemas).queryByText('Nome do pet')).not.toBeInTheDocument()

    fireEvent.click(within(schemas).getByRole('button', { name: 'Expandir' }))

    expect(within(schemas).getByText('Nome do pet')).toBeInTheDocument()
  })

  it('mostra o exemplo do corpo só quando pedido', () => {
    render(<DocsPanel state={{ status: 'ready', docs: DOCS }} />)
    expect(screen.queryByText(/"name": "Rex"/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Exemplo' }))

    expect(screen.getByText(/"name": "Rex"/)).toBeInTheDocument()
  })
})
