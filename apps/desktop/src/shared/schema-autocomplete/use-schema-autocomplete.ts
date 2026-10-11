import { useContext } from 'react'
import { SchemaAutocompleteContext, type SchemaAutocompleteContextValue } from './schema-autocomplete-context'

export function useSchemaAutocomplete(): SchemaAutocompleteContextValue {
  const context = useContext(SchemaAutocompleteContext)
  if (!context) {
    throw new Error('useSchemaAutocomplete precisa ser usado dentro de SchemaAutocompleteProvider')
  }
  return context
}
