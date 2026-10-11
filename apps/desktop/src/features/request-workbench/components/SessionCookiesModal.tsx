import type { SessionCookieDto } from '../../../bindings/session-cookies'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { IconButton } from '../../../shared/ui/IconButton'
import { Modal } from '../../../shared/ui/Modal'
import { TrashIcon } from '../../../shared/ui/icons'

interface SessionCookiesModalProps {
  cookies: SessionCookieDto[]
  onDelete: (cookie: SessionCookieDto) => void
  onClearAll: () => void
  onClose: () => void
}

/** Cookies guardados pelas respostas nesta sessão do app, que voltam nas próximas requisições. */
export function SessionCookiesModal({ cookies, onDelete, onClearAll, onClose }: SessionCookiesModalProps) {
  const { t } = useLanguage()

  return (
    <Modal
      title={t('sessionCookies.title')}
      closeAriaLabel={t('sessionCookies.closeAria')}
      onClose={onClose}
      className="ui-modal--wide"
    >
      {(requestClose) => (
        <>
          <p className="ui-modal-description">{t('sessionCookies.description')}</p>
          {cookies.length === 0 ? (
            <p className="rw-status-message">{t('sessionCookies.empty')}</p>
          ) : (
            <div className="rw-table-scroll">
              <table className="rw-headers-table rw-headers-table--readonly">
                <caption className="rw-visually-hidden">{t('sessionCookies.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('response.cookieDomainLabel')}</th>
                    <th scope="col">{t('common.name')}</th>
                    <th scope="col">{t('common.value')}</th>
                    <th scope="col">{t('response.cookiePathLabel')}</th>
                    <th scope="col">{t('response.cookieExpiresLabel')}</th>
                    <th scope="col">
                      <span className="rw-visually-hidden">{t('common.remove')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cookies.map((cookie) => (
                    <tr key={`${cookie.domain} ${cookie.path} ${cookie.name}`}>
                      <td>{cookie.hostOnly ? cookie.domain : `.${cookie.domain}`}</td>
                      <td>{cookie.name}</td>
                      <td className="rw-header-value">{cookie.value}</td>
                      <td>{cookie.path}</td>
                      <td>
                        {cookie.expiresAtMs === null
                          ? t('sessionCookies.sessionExpiry')
                          : new Date(cookie.expiresAtMs).toLocaleString()}
                      </td>
                      <td>
                        <IconButton
                          variant="danger"
                          icon={<TrashIcon size={13} />}
                          label={t('sessionCookies.deleteAria', { name: cookie.name })}
                          onClick={() => onDelete(cookie)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="ui-modal-actions">
            <Button variant="ghost" onClick={onClearAll} disabled={cookies.length === 0}>
              {t('sessionCookies.clearAll')}
            </Button>
            <Button variant="primary" onClick={requestClose}>
              {t('sessionCookies.close')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
