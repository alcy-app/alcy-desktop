import { describe, expect, it, vi } from 'vitest'
import type { LoadSchemaOutput, SchemaType } from '../../../bindings/load-schema'
import { fireEvent, render, screen, within } from '../../../test-utils'
import { SchemaPanel } from './SchemaPanel'

function type(name: string, fieldNames: string[] = []): SchemaType {
  return {
    name,
    kind: 'OBJECT',
    description: null,
    fields: fieldNames.map((name) => ({
      name,
      typeName: 'String',
      typeDisplay: 'String',
      args: [],
      description: null,
      isDeprecated: false,
      deprecationReason: null,
    })),
    inputFields: [],
    enumValues: [],
    interfaces: [],
    possibleTypes: [],
  }
}

const SCHEMA: LoadSchemaOutput = {
  queryType: 'Query',
  mutationType: null,
  subscriptionType: null,
  types: [
    type('AUserProfile'),
    type('User'),
    type('Users'),
    type('UserProfile'),
    type('XUser'),
    type('Account', ['userProfile']),
    type('Query', ['user']),
    type('Unrelated'),
  ],
  directives: [
    { name: 'userInfo', description: null, locations: [], args: [] },
    { name: 'user', description: null, locations: [], args: [] },
  ],
}

function renderPanel() {
  render(<SchemaPanel schema={{ status: 'success', schema: SCHEMA }} onLoad={vi.fn()} onCancel={vi.fn()} />)
}

function results() {
  return within(screen.getByRole('list', { name: 'Tipos e diretivas do schema' }))
    .getAllByRole('button')
    .map((button) => Array.from(button.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('')
      .trim())
}

describe('SchemaPanel search', () => {
  it('ranks exact names and closest lengths before longer and indirect matches', () => {
    renderPanel()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  USER  ' } })

    expect(results()).toEqual(['@user', 'User', 'Users', 'XUser', '@userInfo', 'UserProfile', 'AUserProfile', 'Query', 'Account'])
  })

  it('restores alphabetical ordering when the search is cleared', () => {
    renderPanel()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'user' } })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })

    expect(results()).toEqual(['@user', '@userInfo', 'Account', 'AUserProfile', 'Query', 'Unrelated', 'User', 'UserProfile', 'Users', 'XUser'])
  })

  it('keeps the empty state for a search without matches', () => {
    renderPanel()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })

    expect(screen.queryByRole('list', { name: 'Tipos e diretivas do schema' })).not.toBeInTheDocument()
    expect(screen.getByText('Nenhum tipo ou diretiva encontrado.')).toBeInTheDocument()
  })
})
