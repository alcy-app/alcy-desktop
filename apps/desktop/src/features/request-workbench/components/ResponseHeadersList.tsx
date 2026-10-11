import type { ResponseHeader } from '../../../bindings/execute-graphql-request'
import type { TranslationKey } from '../../../shared/i18n/translations'
import { useLanguage } from '../../../shared/i18n/use-language'

interface ResponseHeadersListProps {
  headers: ResponseHeader[]
  emptyMessageKey?: TranslationKey
  captionKey?: TranslationKey
}

export function ResponseHeadersList({
  headers,
  emptyMessageKey = 'response.noHeaders',
  captionKey = 'response.headersCaption',
}: ResponseHeadersListProps) {
  const { t } = useLanguage()

  if (headers.length === 0) {
    return <p className="rw-status-message">{t(emptyMessageKey)}</p>
  }

  return (
    <table className="rw-headers-table rw-headers-table--readonly">
      <caption className="rw-visually-hidden">{t(captionKey)}</caption>
      <thead>
        <tr>
          <th scope="col">{t('common.name')}</th>
          <th scope="col">{t('common.value')}</th>
        </tr>
      </thead>
      <tbody>
        {headers.map((header, index) => (
          <tr key={`${header.name}-${index}`}>
            <td>{header.name}</td>
            <td className="rw-header-value">{header.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
