import { useSettingDraft } from './settings-actions'
import { useEffect, useState } from 'react'
import { getSecuritySettings, type SecuritySettingsDto } from '../../bindings/get-security-settings'
import { clearBodyFileGrants, countBodyFileGrants } from '../../bindings/pick-body-file'
import { saveSecuritySettings } from '../../bindings/save-security-settings'
import { useLanguage } from '../../shared/i18n/use-language'
import { notifySecuritySettingsChanged } from '../../shared/security/sensitive-sync'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { AlertIcon } from '../../shared/ui/icons'

interface BodyFilesSectionProps {
  /** Workspace whose picked files can be forgotten; absent without one. */
  rootPath?: string
}

/** Which body files a send may read (spec 0163). The setting lives in the
 * backend, which enforces it on every send, so it loads and saves by IPC. */
export function BodyFilesSection({ rootPath }: BodyFilesSectionProps) {
  const { t } = useLanguage()
  const [settings, setSettings] = useState<SecuritySettingsDto | null>(null)
  const [grantCount, setGrantCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getSecuritySettings().then((result) => {
      if (cancelled) return
      if (result.ok) setSettings(result.value)
      else setError(t('settings.securitySyncLoadError', { message: result.error.message }))
    })
    if (rootPath) {
      void countBodyFileGrants(rootPath).then((result) => {
        if (!cancelled && result.ok) setGrantCount(result.value)
      })
    }
    return () => {
      cancelled = true
    }
  }, [rootPath, t])

  const setAllowOutside = async (allow: boolean) => {
    setBusy(true)
    setError(null)
    const result = await saveSecuritySettings({ allowBodyFilesOutsideWorkspace: allow })
    setBusy(false)
    if (!result.ok) {
      setError(t('settings.securitySyncSaveError', { message: result.error.message }))
      return false
    }
    setSettings(result.value)
    notifySecuritySettingsChanged(result.value)
    return true
  }

  const clearGrants = async () => {
    if (!rootPath) return
    setBusy(true)
    setError(null)
    const result = await clearBodyFileGrants(rootPath)
    setBusy(false)
    if (!result.ok) {
      setError(t('settings.securitySyncSaveError', { message: 'message' in result.error ? result.error.message : '' }))
      return
    }
    setGrantCount(0)
    // Open Body tabs check their files again.
    if (settings) notifySecuritySettingsChanged(settings)
  }

  const [allowOutside, setAllowOutsideDraft] = useSettingDraft(settings?.allowBodyFilesOutsideWorkspace ?? false, false, setAllowOutside, settings !== null)

  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('settings.securityBodyFilesLabel')}</p>
      </div>
      <div className="settings-security">
        <label className="settings-checkbox">
          <Checkbox
            checked={allowOutside}
            disabled={settings === null || busy}
            onChange={(event) => setAllowOutsideDraft(event.target.checked)}
          />
          <span>{t('settings.securityBodyFilesAllow')}</span>
        </label>
        <p className="settings-proxy-hint">{t('settings.securityBodyFilesHint')}</p>
        {allowOutside && (
          <p className="settings-security-warning" role="status">
            <AlertIcon size={13} />
            <span>{t('settings.securityBodyFilesWarning')}</span>
          </p>
        )}
        {rootPath && grantCount !== null && grantCount > 0 && (
          <div className="settings-body-file-grants">
            <span className="settings-proxy-hint">{t('settings.securityBodyFilesGranted', { count: grantCount })}</span>
            <Button variant="ghost" disabled={busy} onClick={() => void clearGrants()}>
              {t('settings.securityBodyFilesClear')}
            </Button>
          </div>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
      </div>
    </section>
  )
}
