import { useEffect, useState } from 'react'
import { getTlsSettings, saveTlsSettings, type TlsSettingsDto } from '../../bindings/tls-settings'
import { useLanguage } from '../../shared/i18n/use-language'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { AlertIcon } from '../../shared/ui/icons'

/** Verificação de certificado das chamadas do usuário (ADR 0058). Ligada por
 * padrão; importação por URL e atualizações sempre verificam. */
export function TlsVerificationSection() {
  const { t } = useLanguage()
  const [settings, setSettings] = useState<TlsSettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getTlsSettings().then((result) => {
      if (cancelled) return
      if (result.ok) setSettings(result.value)
      else setLoadError(result.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setVerify = async (verifyCertificates: boolean) => {
    setBusy(true)
    setSaveError(null)
    const result = await saveTlsSettings({ verifyCertificates })
    setBusy(false)
    if (result.ok) setSettings(result.value)
    else setSaveError(t('settings.tlsVerifySaveError', { message: result.error.message }))
  }

  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('settings.tlsVerifyLabel')}</p>
      </div>
      <div className="settings-security">
        <label className="settings-checkbox">
          <Checkbox
            checked={settings === null || settings.verifyCertificates}
            disabled={settings === null || busy}
            onChange={(event) => void setVerify(event.target.checked)}
          />
          <span>{t('settings.tlsVerifyToggle')}</span>
        </label>
        <p className="settings-proxy-hint">{t('settings.tlsVerifyHint')}</p>
        {settings?.verifyCertificates === false && (
          <p className="settings-security-warning" role="status">
            <AlertIcon size={13} />
            <span>{t('settings.tlsVerifyDisabledWarning')}</span>
          </p>
        )}
        {loadError && <InlineAlert>{t('settings.tlsVerifyLoadError', { message: loadError })}</InlineAlert>}
        {saveError && <InlineAlert>{saveError}</InlineAlert>}
      </div>
    </section>
  )
}
