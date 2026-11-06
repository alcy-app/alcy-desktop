import { useEffect, useState } from 'react'
import { getGitIdentity, saveGitIdentity, type GitIdentityDto } from '../../bindings/local-git'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'

/**
 * Author of the commits written to git folders. Starts from the system's git
 * config (`user.name`/`user.email`); values set here replace it for Alcy only,
 * without touching the git config files.
 */
export function GitIdentitySection() {
  const { t } = useLanguage()
  const [identity, setIdentity] = useState<GitIdentityDto | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const apply = (value: GitIdentityDto) => {
    setIdentity(value)
    setName(value.overrides.name ?? '')
    setEmail(value.overrides.email ?? '')
  }

  useEffect(() => {
    let cancelled = false
    void getGitIdentity().then((result) => {
      if (cancelled) return
      if (result.ok) apply(result.value)
      else setLoadError(gitlabErrorMessage(result.error, t))
    })
    return () => {
      cancelled = true
    }
  }, [t])

  const save = async (fields: { name: string; email: string }) => {
    setBusy(true)
    setSaveError(null)
    setSaved(false)
    const result = await saveGitIdentity({ name: fields.name.trim() || null, email: fields.email.trim() || null })
    setBusy(false)
    if (result.ok) {
      apply(result.value)
      setSaved(true)
    } else {
      setSaveError(gitlabErrorMessage(result.error, t))
    }
  }

  const system = identity?.system
  const unchanged = identity !== null && name.trim() === (identity.overrides.name ?? '') && email.trim() === (identity.overrides.email ?? '')
  const hasOverrides = identity !== null && (identity.overrides.name !== null || identity.overrides.email !== null)
  const effective = identity?.effective

  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('settings.git.authorLabel')}</p>
      </div>
      <form
        className="settings-git-identity"
        // The backend validates both fields and its message shows below.
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!unchanged) void save({ name, email })
        }}
      >
        <p className="settings-proxy-hint">{t('settings.git.authorHint')}</p>
        <Field label={t('settings.git.name')}>
          {(id) => <Input id={id} value={name} placeholder={system?.name ?? t('settings.git.notConfigured')} autoComplete="off" disabled={identity === null || busy} onChange={(event) => { setName(event.target.value); setSaved(false) }} />}
        </Field>
        <Field label={t('settings.git.email')}>
          {(id) => <Input id={id} type="email" value={email} placeholder={system?.email ?? t('settings.git.notConfigured')} autoComplete="off" disabled={identity === null || busy} onChange={(event) => { setEmail(event.target.value); setSaved(false) }} />}
        </Field>
        <p className="settings-proxy-hint" role="status">
          {identity === null
            ? t('settings.git.loading')
            : effective
              ? t('settings.git.effective', { name: effective.name ?? '', email: effective.email ?? '' })
              : t('settings.git.missing')}
        </p>
        <div className="settings-git-identity-actions">
          <Button variant="ghost" disabled={!hasOverrides || busy} onClick={() => void save({ name: '', email: '' })}>{t('settings.git.useSystem')}</Button>
          <Button type="submit" disabled={identity === null || unchanged || busy} isLoading={busy}>{t('settings.git.save')}</Button>
        </div>
        {saved && <p className="settings-proxy-hint" role="status">{t('settings.git.saved')}</p>}
        {loadError && <InlineAlert>{loadError}</InlineAlert>}
        {saveError && <InlineAlert>{saveError}</InlineAlert>}
      </form>
    </section>
  )
}
