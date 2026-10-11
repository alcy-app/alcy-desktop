import { useEffect, useState } from 'react'
import {
  addCustomCaCertificate,
  listCustomCaCertificates,
  removeCustomCaCertificate,
  type CustomCaCertificateDto,
} from '../../bindings/custom-ca-certificates'
import { pickCustomCaCertificate } from '../../bindings/pick-custom-ca-certificate'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { InlineAlert } from '../../shared/ui/InlineAlert'

/** CAs privadas ampliam as raízes confiáveis sem desativar TLS ou hostname. */
export function CustomCaCertificatesSection() {
  const { t } = useLanguage()
  const [certificates, setCertificates] = useState<CustomCaCertificateDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void listCustomCaCertificates().then((result) => {
      if (cancelled) return
      if (result.ok) setCertificates(result.value)
      else setError(t('settings.customCaLoadError', { message: result.error.message }))
    })
    return () => { cancelled = true }
  }, [t])

  const add = async () => {
    const path = await pickCustomCaCertificate()
    if (path === null) return
    setBusy(true)
    setError(null)
    const result = await addCustomCaCertificate(path)
    setBusy(false)
    if (result.ok) setCertificates(result.value)
    else setError(t('settings.customCaSaveError', { message: result.error.message }))
  }

  const remove = async (id: string) => {
    setBusy(true)
    setError(null)
    const result = await removeCustomCaCertificate(id)
    setBusy(false)
    if (result.ok) setCertificates(result.value)
    else setError(t('settings.customCaSaveError', { message: result.error.message }))
  }

  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('settings.customCaLabel')}</p>
      </div>
      <div className="settings-custom-ca">
        <p className="settings-proxy-hint">{t('settings.customCaHint')}</p>
        {certificates?.length === 0 && <p className="settings-proxy-hint">{t('settings.customCaEmpty')}</p>}
        {certificates && certificates.length > 0 && (
          <ul className="settings-custom-ca-list" aria-label={t('settings.customCaListAria')}>
            {certificates.map((certificate) => (
              <li key={certificate.id}>
                <span>{certificate.name}</span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(certificate.id)}>
                  {t('common.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
        <div className="settings-proxy-actions">
          <Button disabled={certificates === null || busy} isLoading={busy} onClick={() => void add()}>
            {t('settings.customCaAdd')}
          </Button>
        </div>
      </div>
    </section>
  )
}
