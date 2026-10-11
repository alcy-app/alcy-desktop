import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_AUTOCOMPLETE_STORAGE_KEY } from './schema-autocomplete'
import { SchemaAutocompleteProvider } from './SchemaAutocompleteProvider'
import { useSchemaAutocomplete } from './use-schema-autocomplete'

function Probe() {
  const { enabled, setEnabled } = useSchemaAutocomplete()
  return <button onClick={() => setEnabled(!enabled)}>{String(enabled)}</button>
}

describe('SchemaAutocompleteProvider', () => {
  beforeEach(() => window.localStorage.clear())

  it('vem habilitado por padrão', () => {
    render(<SchemaAutocompleteProvider><Probe /></SchemaAutocompleteProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('true')
  })

  it('ignora valor salvo inválido', () => {
    window.localStorage.setItem(SCHEMA_AUTOCOMPLETE_STORAGE_KEY, 'talvez')
    render(<SchemaAutocompleteProvider><Probe /></SchemaAutocompleteProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('true')
  })

  it('desliga e persiste a escolha', () => {
    const { unmount } = render(<SchemaAutocompleteProvider><Probe /></SchemaAutocompleteProvider>)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveTextContent('false')
    expect(window.localStorage.getItem(SCHEMA_AUTOCOMPLETE_STORAGE_KEY)).toBe('false')
    unmount()

    render(<SchemaAutocompleteProvider><Probe /></SchemaAutocompleteProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('false')
  })
})
