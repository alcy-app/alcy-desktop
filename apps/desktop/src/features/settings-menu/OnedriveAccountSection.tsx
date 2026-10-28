import { useId, useState } from 'react'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { useOnedrive } from '../../shared/onedrive/use-onedrive'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { ChevronDownIcon, Spinner } from '../../shared/ui/icons'

const CLIENT_ID_STORAGE_KEY = 'alcy:onedrive:client-id'
const TENANT_STORAGE_KEY = 'alcy:onedrive:tenant'
const CALLBACK_URL = 'http://127.0.0.1:53682/callback'

function bundledClientId(): string {
  return import.meta.env.VITE_ONEDRIVE_CLIENT_ID?.trim() ?? ''
}

function bundledTenant(): string {
  return import.meta.env.VITE_ONEDRIVE_TENANT?.trim() ?? ''
}

function readRemembered(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Prefilling is optional.
  }
}

/** Microsoft login in the browser. Only the refresh token is kept, in the system keyring. */
export function OnedriveAccountSection() {
  const { t } = useLanguage()
  const { accounts, loaded, loggingIn, login, cancelLogin, logout } = useOnedrive()
  const bundled = bundledClientId()
  const [clientId, setClientId] = useState(() => readRemembered(CLIENT_ID_STORAGE_KEY, ''))
  const [tenant, setTenant] = useState(() => readRemembered(TENANT_STORAGE_KEY, ''))
  const [error, setError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const id = useId()
  const custom = bundled === ''
  const canLogin = !loggingIn && (!custom || clientId.trim() !== '')

  const runLogin = async () => {
    if (!canLogin) return
    setError(null)
    const resolvedClientId = custom ? clientId.trim() : bundled
    const resolvedTenant = custom ? tenant.trim() : bundledTenant()
    if (custom) {
      remember(CLIENT_ID_STORAGE_KEY, resolvedClientId)
      remember(TENANT_STORAGE_KEY, resolvedTenant)
    }
    const result = await login(resolvedClientId, resolvedTenant)
    if (!result.ok && result.error.kind !== 'cancelled') setError(gitlabErrorMessage(result.error, t))
  }

  const runLogout = async (accountId: string) => {
    setError(null)
    setDisconnecting(accountId)
    const result = await logout(accountId)
    setDisconnecting(null)
    if (!result.ok) setError(gitlabErrorMessage(result.error, t))
  }

  return (
    <section className="settings-gitlab" data-testid="onedrive-settings">
      <div className="settings-gitlab-status-row">
        <span>{t('gitlab.statusLabel')}</span>
        <span className={`settings-connection-status${accounts.length ? ' settings-connection-status--connected' : ''}`}>
          {!loaded ? t('gitlab.loading') : loggingIn ? t('gitlab.connecting') : accounts.length ? t('gitlab.connected') : t('gitlab.disconnected')}
        </span>
      </div>

      {!loaded && <p className="settings-gitlab-waiting" role="status"><Spinner />{t('gitlab.loadingAccounts')}</p>}

      {loaded && accounts.length > 0 && (
        <div className="settings-section">
          {accounts.map((account) => (
            <div key={account.id} className="settings-gitlab-account">
              <div className="settings-gitlab-account-text">
                <strong>{account.name}</strong>
                <span>{account.username}</span>
              </div>
              <Button variant="ghost" disabled={disconnecting !== null} isLoading={disconnecting === account.id} onClick={() => void runLogout(account.id)}>
                {t('gitlab.logout')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {loaded && (
        <form className="settings-gitlab-form" onSubmit={(event) => { event.preventDefault(); void runLogin() }}>
          {custom && (
            <>
              <p className="settings-gitlab-permission" role="note">{t('onedrive.customAppNotice')}</p>
              <Field label={t('onedrive.clientIdLabel')}>
                {(fieldId) => (
                  <Input id={fieldId} mono required value={clientId} placeholder={t('onedrive.clientIdPlaceholder')}
                    spellCheck={false} autoComplete="off" disabled={loggingIn}
                    onChange={(event) => { setClientId(event.target.value); setError(null) }} />
                )}
              </Field>
              <Field label={t('onedrive.tenantLabel')}>
                {(fieldId) => (
                  <Input id={fieldId} mono value={tenant} placeholder={t('onedrive.tenantPlaceholder')}
                    spellCheck={false} autoComplete="off" disabled={loggingIn}
                    onChange={(event) => { setTenant(event.target.value); setError(null) }} />
                )}
              </Field>

              <div className="settings-gitlab-help">
                <button type="button" className="settings-help-toggle" aria-expanded={helpOpen} aria-controls={`${id}-help`} onClick={() => setHelpOpen(!helpOpen)}>
                  <span>{t('onedrive.setupHelp')}</span><ChevronDownIcon size={16} />
                </button>
                <div id={`${id}-help`} hidden={!helpOpen} className="settings-help-content">
                  <ol>
                    <li>{t('onedrive.setupCreate')}</li>
                    <li>{t('onedrive.setupPlatform')}</li>
                    <li>{t('onedrive.setupPermissions')}</li>
                  </ol>
                  <label htmlFor={`${id}-callbacks`}>{t('gitlab.callbackUrls')}</label>
                  <Input id={`${id}-callbacks`} mono readOnly value={CALLBACK_URL} onFocus={(event) => event.target.select()} />
                  <p>{t('onedrive.setupFinish')}</p>
                </div>
              </div>
            </>
          )}

          <p className="settings-gitlab-permission" role="note">{t('onedrive.permissionNotice')}</p>
          <div className="settings-gitlab-authorize">
            {loggingIn ? (
              <div className="settings-gitlab-progress">
                <p className="settings-gitlab-waiting" role="status"><Spinner />{t('gitlab.loginWaiting')}</p>
                <Button variant="ghost" onClick={cancelLogin}>{t('gitlab.cancel')}</Button>
              </div>
            ) : (
              <Button type="submit" disabled={!canLogin}>{accounts.length > 0 ? t('onedrive.addAccount') : t('onedrive.login')}</Button>
            )}
          </div>
        </form>
      )}
      {error && <InlineAlert className="settings-gitlab-alert">{error}</InlineAlert>}
    </section>
  )
}
