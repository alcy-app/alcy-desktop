import type { Cookie } from '../../../bindings/execute-graphql-request'
import { useLanguage } from '../../../shared/i18n/use-language'

interface CookiesListProps {
  cookies: Cookie[]
}

function flagsOf(cookie: Cookie): string {
  const flags: string[] = []
  if (cookie.secure) flags.push('Secure')
  if (cookie.httpOnly) flags.push('HttpOnly')
  if (cookie.sameSite) flags.push(`SameSite=${cookie.sameSite}`)
  return flags.length > 0 ? flags.join(', ') : '—'
}

export function CookiesList({ cookies }: CookiesListProps) {
  const { t } = useLanguage()

  if (cookies.length === 0) {
    return <p className="rw-status-message">{t('response.noCookies')}</p>
  }

  return (
    <div className="rw-table-scroll">
      <table className="rw-headers-table rw-headers-table--readonly">
        <caption className="rw-visually-hidden">{t('response.cookiesCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('common.name')}</th>
            <th scope="col">{t('common.value')}</th>
            <th scope="col">{t('response.cookieDomainLabel')}</th>
            <th scope="col">{t('response.cookiePathLabel')}</th>
            <th scope="col">{t('response.cookieExpiresLabel')}</th>
            <th scope="col">{t('response.cookieFlagsLabel')}</th>
          </tr>
        </thead>
        <tbody>
          {cookies.map((cookie, index) => (
            <tr key={`${cookie.name}-${index}`}>
              <td>{cookie.name}</td>
              <td className="rw-header-value">{cookie.value}</td>
              <td>{cookie.domain ?? '—'}</td>
              <td>{cookie.path ?? '—'}</td>
              <td>{cookie.expires ?? '—'}</td>
              <td>{flagsOf(cookie)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
