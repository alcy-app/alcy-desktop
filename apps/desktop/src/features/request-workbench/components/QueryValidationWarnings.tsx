import { useDeferredValue, useMemo } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { parseQuery } from '../graphql-query-tree'
import { validateQuery } from '../graphql-query-validation'
import { rootTypeNameFor } from '../schema-helpers'
import type { SchemaLoadState } from '../request-workbench.types'

interface QueryValidationWarningsProps {
  query: string
  schema: SchemaLoadState
}

export function QueryValidationWarnings({ query, schema }: QueryValidationWarningsProps) {
  const { t } = useLanguage()
  // A validação (parse + checagem contra o schema) não precisa ser síncrona
  // por tecla — adia para depois que a digitação está quieta.
  const deferredQuery = useDeferredValue(query)

  const warnings = useMemo(() => {
    if (schema.status !== 'success') return []
    const parsed = parseQuery(deferredQuery)
    if (!parsed) return []
    const rootTypeName = rootTypeNameFor(parsed.operationType, schema.schema)
    return validateQuery(parsed, schema.schema.types, rootTypeName)
  }, [deferredQuery, schema])

  if (warnings.length === 0) return null

  return (
    <ul className="rw-query-warnings" aria-label={t('query.warningsLabel')}>
      {warnings.map((warning) => (
        <li key={warning.path.join('.')} className="rw-query-warning">
          {t('query.unknownField', { field: warning.fieldName, type: warning.typeName })}
        </li>
      ))}
    </ul>
  )
}
