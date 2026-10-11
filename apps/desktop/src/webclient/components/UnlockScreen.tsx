import { useState, type FormEvent } from 'react'
import { t } from '../i18n'
import { openEnvelope, WrongPasswordError } from '../seal'
import type { SealedEnvelope } from '../types'

interface UnlockScreenProps {
  envelope: SealedEnvelope
  onUnlocked: (snapshotJson: string) => void
}

export function UnlockScreen({ envelope, onUnlocked }: UnlockScreenProps) {
  const [password, setPassword] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password || opening) return
    setOpening(true)
    setError(null)
    try {
      onUnlocked(await openEnvelope(envelope, password))
    } catch (caught) {
      setError(caught instanceof WrongPasswordError ? t('unlock.wrongPassword') : t('app.loadingFailed'))
      setOpening(false)
    }
  }

  return (
    <main className="wc-unlock">
      <form className="wc-unlock__card" onSubmit={submit}>
        <h1 className="wc-unlock__title">{t('unlock.title')}</h1>
        <p className="wc-muted">{t('unlock.description')}</p>
        <label className="wc-field">
          <span className="wc-field__label">{t('unlock.password')}</span>
          <input
            className="wc-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error !== null}
          />
        </label>
        {error && (
          <p className="wc-alert wc-alert--error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="wc-button wc-button--primary" disabled={!password || opening}>
          {opening ? t('unlock.opening') : t('unlock.submit')}
        </button>
      </form>
    </main>
  )
}
