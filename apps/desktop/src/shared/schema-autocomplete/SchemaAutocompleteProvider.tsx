import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { readSchemaAutocomplete, writeSchemaAutocomplete } from './schema-autocomplete'
import { SchemaAutocompleteContext, type SchemaAutocompleteContextValue } from './schema-autocomplete-context'

/** Liga/desliga as sugestões vindas da documentação importada (Params,
 * Headers e corpo JSON). Preferência por máquina, como tema e escala. */
export function SchemaAutocompleteProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean>(readSchemaAutocomplete)

  useEffect(() => {
    writeSchemaAutocomplete(enabled)
  }, [enabled])

  const value = useMemo<SchemaAutocompleteContextValue>(() => ({ enabled, setEnabled }), [enabled])

  return <SchemaAutocompleteContext.Provider value={value}>{children}</SchemaAutocompleteContext.Provider>
}
