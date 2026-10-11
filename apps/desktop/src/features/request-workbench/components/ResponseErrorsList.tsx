import type { GraphqlErrorOutput } from '../../../bindings/execute-graphql-request'
import { useLanguage } from '../../../shared/i18n/use-language'

interface ResponseErrorsListProps {
  errors: GraphqlErrorOutput[]
}

export function ResponseErrorsList({ errors }: ResponseErrorsListProps) {
  const { t } = useLanguage()

  if (errors.length === 0) {
    return <p className="rw-status-message">{t('response.noGraphqlErrors')}</p>
  }

  return (
    <ul className="rw-graphql-errors">
      {errors.map((error, index) => (
        <li key={index} className="rw-graphql-error">
          <p className="rw-graphql-error-message">{error.message}</p>
          {error.path.length > 0 && (
            <p className="rw-graphql-error-path">{t('response.errorPath', { path: error.path.join(' › ') })}</p>
          )}
        </li>
      ))}
    </ul>
  )
}
