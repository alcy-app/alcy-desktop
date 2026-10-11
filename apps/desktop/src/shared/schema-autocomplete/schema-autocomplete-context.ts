import { createContext } from 'react'

export interface SchemaAutocompleteContextValue {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const SchemaAutocompleteContext = createContext<SchemaAutocompleteContextValue | null>(null)
