import { useId, useState } from 'react'
import { useGitlab } from '../../shared/gitlab/use-gitlab'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { ChevronDownIcon, Spinner } from '../../shared/ui/icons'

const INSTANCE_STORAGE_KEY = 'alcy:gitlab:instance-url'
const CLIENT_ID_STORAGE_KEY = 'alcy:gitlab:client-id'
const DEFAULT_INSTANCE_URL = 'https://gitlab.example.com'
const GITLAB_COM_URL = 'https://gitlab.com'
const CALLBACK_URL = 'http://127.0.0.1:53682/callback'

type ConnectionTarget = 'gitlabCom' | 'selfManaged'

function gitlabComClientId(): string {
  return import.meta.env.VITE_GITLAB_COM_CLIENT_ID?.trim() ?? ''
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
    // O preenchimento automático é opcional.
  }
}

/** Login OAuth no navegador. Tokens permanecem no chaveiro do sistema. */
export function GitlabAccountSection() {
  const { t } = useLanguage()
  const { accounts, loaded, loggingIn, login, cancelLogin, logout } = useGitlab()
  const bundledClientId = gitlabComClientId()
  const [target, setTarget] = useState<ConnectionTarget>(bundledClientId ? 'gitlabCom' : 'selfManaged')
  const [instanceUrl, setInstanceUrl] = useState(() => readRemembered(INSTANCE_STORAGE_KEY, DEFAULT_INSTANCE_URL))
  const [clientId, setClientId] = useState(() => readRemembered(CLIENT_ID_STORAGE_KEY, ''))
  const [error, setError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const id = useId()
  const selfManaged = target === 'selfManaged'
  const canLogin = !loggingIn && (selfManaged ? instanceUrl.trim() !== '' && clientId.trim() !== '' : bundledClientId !== '')

  const runLogin = async () => {
    if (!canLogin) return
    setError(null)
    const resolvedUrl = selfManaged ? instanceUrl.trim() : GITLAB_COM_URL
    const resolvedClientId = selfManaged ? clientId.trim() : bundledClientId
    if (selfManaged) {
      remember(INSTANCE_STORAGE_KEY, resolvedUrl)
      remember(CLIENT_ID_STORAGE_KEY, resolvedClientId)
    }
    const result = await login(resolvedUrl, resolvedClientId)
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
    <section className="settings-gitlab" data-testid="gitlab-settings">
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
                <span>@{account.username} · {account.baseUrl}</span>
              </div>
              <Button variant="ghost" disabled={disconnecting !== null} isLoading={disconnecting === account.id} onClick={() => void runLogout(account.id)}>
                {t('gitlab.logout')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {loaded && accounts.length === 0 && (
        <form className="settings-gitlab-form" onSubmit={(event) => { event.preventDefault(); void runLogin() }}>
          {bundledClientId && (
            <div className="settings-gitlab-target">
              <SegmentedControl<ConnectionTarget>
                ariaLabel={t('gitlab.targetLabel')}
                value={target}
                onChange={(value) => { setTarget(value); setError(null) }}
                options={[
                  { value: 'gitlabCom', label: 'GitLab.com', disabled: loggingIn },
                  { value: 'selfManaged', label: t('gitlab.selfManaged'), disabled: loggingIn },
                ]}
              />
            </div>
          )}

          {selfManaged && (
            <>
              <Field label={t('gitlab.instanceLabel')}>
                {(fieldId) => (
                  <Input id={fieldId} mono type="url" required value={instanceUrl} placeholder={t('gitlab.instancePlaceholder')}
                    spellCheck={false} autoComplete="url" disabled={loggingIn}
                    onChange={(event) => { setInstanceUrl(event.target.value); setError(null) }} />
                )}
              </Field>
              <Field label={t('gitlab.clientIdLabel')}>
                {(fieldId) => (
                  <Input id={fieldId} mono required value={clientId} placeholder={t('gitlab.clientIdPlaceholder')}
                    spellCheck={false} autoComplete="off" disabled={loggingIn}
                    onChange={(event) => { setClientId(event.target.value); setError(null) }} />
                )}
              </Field>

              <div className="settings-gitlab-help">
                <button type="button" className="settings-help-toggle" aria-expanded={helpOpen} aria-controls={`${id}-help`} onClick={() => setHelpOpen(!helpOpen)}>
                  <span>{t('gitlab.setupHelp')}</span><ChevronDownIcon size={16} />
                </button>
                <div id={`${id}-help`} hidden={!helpOpen} className="settings-help-content">
                  <ol>
                    <li>{t('gitlab.setupCreate')}</li>
                    <li>{t('gitlab.setupPermissions')}</li>
                    <li>{t('gitlab.setupCallbacks')}</li>
                  </ol>
                  <label htmlFor={`${id}-callbacks`}>{t('gitlab.callbackUrls')}</label>
                  <Input id={`${id}-callbacks`} mono readOnly value={CALLBACK_URL} onFocus={(event) => event.target.select()} />
                  <p>{t('gitlab.setupFinish')}</p>
                </div>
              </div>
            </>
          )}

          <p className="settings-gitlab-permission" role="note">{t('gitlab.permissionNotice')}</p>
          <div className="settings-gitlab-authorize">
            {loggingIn ? (
              <div className="settings-gitlab-progress">
                <p className="settings-gitlab-waiting" role="status"><Spinner />{t('gitlab.loginWaiting')}</p>
                <Button variant="ghost" onClick={cancelLogin}>{t('gitlab.cancel')}</Button>
              </div>
            ) : (
              <Button type="submit" disabled={!canLogin}>{t('gitlab.login')}</Button>
            )}
          </div>
        </form>
      )}
      {error && <InlineAlert className="settings-gitlab-alert">{error}</InlineAlert>}
    </section>
  )
}
