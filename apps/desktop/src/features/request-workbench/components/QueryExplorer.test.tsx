import { describe, expect, it, vi } from 'vitest'
import type { SchemaField, SchemaType } from '../../../bindings/load-schema'
import { fireEvent, render, screen } from '../../../test-utils'
import type { SchemaLoadState } from '../request-workbench.types'
import { QueryExplorer } from './QueryExplorer'

function field(name: string, typeName: string): SchemaField {
  return {
    name,
    description: null,
    args: [],
    typeDisplay: typeName,
    typeName,
    isDeprecated: false,
    deprecationReason: null,
  }
}

function objectType(name: string, fields: SchemaField[], kind = 'OBJECT'): SchemaType {
  return { name, kind, description: null, fields, inputFields: [], enumValues: [], interfaces: [], possibleTypes: [] }
}

const SCHEMA: SchemaLoadState = {
  status: 'success',
  schema: {
    queryType: 'Query',
    mutationType: null,
    subscriptionType: null,
    directives: [],
    types: [
      objectType('Query', [field('currentCustomer', 'Customer'), field('ping', 'String')]),
      objectType('Customer', [field('id', 'ID'), field('email', 'String')]),
      objectType('String', [], 'SCALAR'),
      objectType('ID', [], 'SCALAR'),
    ],
  },
}

function renderExplorer(onToggleField = vi.fn()) {
  render(
    <QueryExplorer
      query=""
      schema={SCHEMA}
      onToggleField={onToggleField}
      onSetArgument={vi.fn()}
      onLoad={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  return onToggleField
}

describe('QueryExplorer', () => {
  it('busca um campo aninhado, mostra só o caminho até ele e permite selecioná-lo', async () => {
    const onToggleField = renderExplorer()

    fireEvent.click(screen.getByRole('button', { name: 'Buscar campos' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar campos' }), { target: { value: 'mail' } })

    const emailCheckbox = await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer > email à query' })
    expect(screen.queryByRole('checkbox', { name: 'Adicionar campo ping à query' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Adicionar campo currentCustomer > id à query' })).not.toBeInTheDocument()

    fireEvent.click(emailCheckbox)
    expect(onToggleField).toHaveBeenCalledWith(['currentCustomer'], 'email', false)
  })

  it('fecha a busca pelo botão e limpa o termo', async () => {
    renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Buscar campos' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar campos' }), { target: { value: 'mail' } })

    fireEvent.click(screen.getByRole('button', { name: 'Fechar busca' }))
    expect(await screen.findByRole('checkbox', { name: 'Adicionar campo ping à query' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Buscar campos' }))
    expect(screen.getByRole('textbox', { name: 'Buscar campos' })).toHaveValue('')
  })

  it('avisa quando nenhum campo casa e volta à árvore completa ao fechar a busca com Esc', async () => {
    renderExplorer()
    fireEvent.click(screen.getByRole('button', { name: 'Buscar campos' }))
    const search = screen.getByRole('textbox', { name: 'Buscar campos' })
    expect(search).toHaveFocus()

    fireEvent.change(search, { target: { value: 'inexistente' } })
    expect(await screen.findByText('Nenhum campo encontrado para "inexistente".')).toBeInTheDocument()

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Buscar campos' })).not.toBeInTheDocument()
    expect(await screen.findByRole('checkbox', { name: 'Adicionar campo ping à query' })).toBeInTheDocument()
  })
})
