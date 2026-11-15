import { useSettingDraft } from './settings-actions'
import { useEffect, useState } from 'react'
import { getSecuritySettings, type SecuritySettingsDto } from '../../bindings/get-security-settings'
import { saveSecuritySettings } from '../../bindings/save-security-settings'
import { useLanguage } from '../../shared/i18n/use-language'
import { notifySecuritySettingsChanged } from '../../shared/security/sensitive-sync'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { AlertIcon } from '../../shared/ui/icons'

/** Protect sensitive values during workspace synchronization. The backend
 * enforces this preference, so it is loaded and saved through IPC. */
export function SensitiveSyncSection() {
  const { t } = useLanguage()
  const [settings, setSettings] = useState<SecuritySettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getSecuritySettings().then((result) => {
      if (cancelled) return
      if (result.ok) setSettings(result.value)
      else setLoadError(result.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setProtected = async (protect: boolean) => {
    setBusy(true)
    setSaveError(null)
    const result = await saveSecuritySettings({ syncSensitiveValues: !protect })
    setBusy(false)
    if (!result.ok) {
      setSaveError(t('settings.securitySyncSaveError', { message: result.error.message }))
      return false
    }
    setSettings(result.value)
    notifySecuritySettingsChanged(result.value)
    return true
  }

  const [protect, setProtectDraft] = useSettingDraft(settings === null || !settings.syncSensitiveValues, true, setProtected, settings !== null)

  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('settings.securitySyncLabel')}</p>
      </div>
      <div className="settings-security">
        <label className="settings-checkbox">
          <Checkbox
            checked={protect}
            disabled={settings === null || busy}
            onChange={(event) => setProtectDraft(event.target.checked)}
          />
          <span>{t('settings.securitySyncProtect')}</span>
        </label>
        <p className="settings-proxy-hint">{t('settings.securitySyncProtectHint')}</p>
        {!protect && (
          <p className="settings-security-warning" role="status">
            <AlertIcon size={13} />
            <span>{t('settings.securitySyncRevealWarning')}</span>
          </p>
        )}
        {loadError && <InlineAlert>{t('settings.securitySyncLoadError', { message: loadError })}</InlineAlert>}
        {saveError && <InlineAlert>{saveError}</InlineAlert>}
      </div>
    </section>
  )
}
