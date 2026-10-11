import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import type { Credential, CredentialValues } from '../types'

interface CredentialsPanelProps {
  credentials: Credential[]
  values: CredentialValues
  remember: boolean
  onChange: (id: string, value: string) => void
  onRememberChange: (remember: boolean) => void
  onClear: () => void
  onClose: () => void
}

function credentialLabel(credential: Credential): string {
  const { target } = credential
  switch (target.kind) {
    case 'variable':
      return t('credentials.variable', { name: `{{${target.name}}}` })
    case 'authentication':
      return t(`credentials.auth.${target.field}`)
    case 'header':
      return t('credentials.header', { name: target.name })
    case 'query':
      return t('credentials.query', { name: target.name })
    case 'routeParameter':
      return t('credentials.routeParameter', { name: target.name })
    case 'bodyField':
      return t('credentials.bodyField', { name: target.name })
    case 'bodyText':
      return t(`credentials.bodyText.${target.source}`, { name: target.key })
  }
}

export function CredentialsPanel({ credentials, values, remember, onChange, onRememberChange, onClear, onClose }: CredentialsPanelProps) {
  const [reveal, setReveal] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Foco só ao abrir: o painel re-renderiza a cada tecla digitada.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <aside ref={panelRef} className="wc-credentials" role="dialog" aria-modal="false" aria-labelledby="wc-credentials-title">
      <header className="wc-credentials__header">
        <h2 id="wc-credentials-title" className="wc-credentials__title">
          {t('credentials.title')}
        </h2>
        <button type="button" className="wc-button wc-button--ghost" onClick={onClose}>
          {t('credentials.close')}
        </button>
      </header>
      <p className="wc-muted">{t('credentials.description')}</p>
      {credentials.length === 0 ? (
        <p className="wc-muted">{t('credentials.empty')}</p>
      ) : (
        <form className="wc-stack" autoComplete="off" onSubmit={(event) => event.preventDefault()}>
          {credentials.map((credential) => {
            const value = values[credential.id] ?? ''
            return (
              <label key={credential.id} className="wc-field">
                <span className="wc-field__label">
                  {credentialLabel(credential)}
                  {credential.owner && <span className="wc-muted"> · {credential.owner}</span>}
                </span>
                <input
                  className="wc-input wc-input--mono"
                  type={reveal ? 'text' : 'password'}
                  autoComplete="off"
                  value={value}
                  placeholder={credential.included ? t('credentials.included') : t('credentials.missing')}
                  onChange={(event) => onChange(credential.id, event.target.value)}
                />
              </label>
            )
          })}
          <label className="wc-check">
            <input type="checkbox" checked={reveal} onChange={(event) => setReveal(event.target.checked)} />
            {t('credentials.show')}
          </label>
          <label className="wc-check">
            <input type="checkbox" checked={remember} onChange={(event) => onRememberChange(event.target.checked)} />
            {t('credentials.remember')}
          </label>
          <div>
            <button type="button" className="wc-button wc-button--ghost" onClick={onClear}>
              {t('credentials.clear')}
            </button>
          </div>
        </form>
      )}
    </aside>
  )
}
