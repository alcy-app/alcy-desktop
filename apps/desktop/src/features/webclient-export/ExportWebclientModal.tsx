import { useId } from 'react'
import type { ExportWebclientError, WebclientCredential, WebclientSummary, WebclientTransportMode } from '../../bindings/export-webclient'
import type { TranslationKey } from '../../shared/i18n/locales/pt-BR'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { Modal } from '../../shared/ui/Modal'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Select } from '../../shared/ui/Select'
import { useToast } from '../../shared/ui/use-toast'
import type { EnvironmentState } from '../environments/environments.types'
import { MIN_PASSWORD_CHARS, useWebclientExport, type WebclientExportSource } from './use-webclient-export'
import './webclient-export.css'

interface ExportWebclientModalProps {
  source: WebclientExportSource
  environments: EnvironmentState[]
  activeEnvironmentId: string | null
  onClose: () => void
}

type Translate = ReturnType<typeof useLanguage>['t']

function credentialLabel(credential: WebclientCredential, t: Translate): string {
  const { target } = credential
  const label =
    target.kind === 'variable'
      ? t('webclientExport.credential.variable', { name: `{{${target.name}}}` })
      : target.kind === 'authentication'
        ? t(`webclientExport.credential.auth.${target.field}`)
        : target.kind === 'bodyText'
          ? t('webclientExport.credential.bodyText', { name: target.key })
          : t(`webclientExport.credential.${target.kind}`, { name: target.name })
  return credential.owner ? t('webclientExport.credential.owner', { label, owner: credential.owner }) : label
}

function errorMessage(error: ExportWebclientError, t: Translate): string {
  switch (error.kind) {
    case 'invalid':
      return t('webclientExport.error.invalid', { message: error.message })
    case 'storage':
      return t('webclientExport.error.storage', { message: error.message })
    case 'passwordTooShort':
      return t('webclientExport.error.passwordTooShort', { minimum: error.minimum })
    case 'folderNotFound':
    case 'noRequests':
    case 'sensitiveNotConfirmed':
      return t(`webclientExport.error.${error.kind}` satisfies TranslationKey)
  }
}

/** Comando para servir o arquivo com o proxy liberado para os hosts usados. */
function serverCommand(title: string, summary: WebclientSummary): string {
  const file = `${title.trim().replace(/[^A-Za-z0-9-_ ]/g, '-') || 'webclient'}.html`
  const hosts = summary.hosts.map((host) => ` --allow-host ${host}`).join('')
  return `alcy-webclient-server --html "${file}"${hosts}`
}

export function ExportWebclientModal({ source, environments, activeEnvironmentId, onClose }: ExportWebclientModalProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const state = useWebclientExport(source, environments, activeEnvironmentId)
  const sensitiveId = useId()
  const confirmId = useId()

  const transportOptions: { value: WebclientTransportMode; label: string }[] = [
    { value: 'auto', label: t('webclientExport.transportAuto') },
    { value: 'direct', label: t('webclientExport.transportDirect') },
    { value: 'server', label: t('webclientExport.transportServer') },
  ]

  const copyServerCommand = async (summary: WebclientSummary) => {
    try {
      await navigator.clipboard.writeText(serverCommand(state.title, summary))
      showToast(t('webclientExport.serverCommandCopied'))
    } catch {
      // Sem permissão de área de transferência: o comando continua visível.
    }
  }

  return (
    <Modal title={t('webclientExport.title')} closeAriaLabel={t('collections.closeModalAria')} onClose={onClose} className="ui-modal--wide webclient-export">
      {(requestClose) => (
        <form
          className="webclient-export__form"
          onSubmit={async (event) => {
            event.preventDefault()
            const outcome = await state.runExport()
            if (outcome.status === 'exported') {
              showToast(t('webclientExport.exported'))
              requestClose()
            } else if (outcome.status === 'failed') {
              showToast(errorMessage(outcome.error, t), 'error')
            }
          }}
        >
          <p className="ui-modal-description">{t('webclientExport.description', { name: source.name })}</p>

          <div className="webclient-export__grid">
            <Field label={t('webclientExport.titleLabel')}>
              {(id) => <Input id={id} value={state.title} onChange={(event) => state.setTitle(event.target.value)} />}
            </Field>
            <Field label={t('webclientExport.environmentLabel')} hint={t('webclientExport.environmentHint')}>
              {(id) => (
                <Select id={id} value={state.environmentId ?? ''} onChange={(event) => state.setEnvironmentId(event.target.value || null)}>
                  <option value="">{t('webclientExport.noEnvironment')}</option>
                  {environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label={t('webclientExport.passwordLabel')}
              hint={state.password === '' ? t('webclientExport.noPasswordWarning') : t('webclientExport.passwordHint')}
              error={state.passwordError === 'tooShort' ? t('webclientExport.passwordTooShort', { minimum: MIN_PASSWORD_CHARS }) : undefined}
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={state.password}
                  onChange={(event) => state.setPassword(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('webclientExport.passwordConfirmationLabel')}
              error={state.passwordError === 'mismatch' ? t('webclientExport.passwordMismatch') : undefined}
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  disabled={state.password === ''}
                  value={state.passwordConfirmation}
                  onChange={(event) => state.setPasswordConfirmation(event.target.value)}
                />
              )}
            </Field>
          </div>

          <div className="webclient-export__section">
            <span className="ui-field-label">{t('webclientExport.transportLabel')}</span>
            <SegmentedControl
              ariaLabel={t('webclientExport.transportLabel')}
              options={transportOptions}
              value={state.transport}
              onChange={state.setTransport}
            />
            <p className="ui-field-hint">{t(`webclientExport.transportHint.${state.transport}`)}</p>
          </div>

          <div className="webclient-export__section webclient-export__summary" aria-live="polite">
            {state.preview.status === 'loading' && <p className="ui-modal-description">{t('webclientExport.loadingPreview')}</p>}
            {state.preview.status === 'error' && <InlineAlert>{errorMessage(state.preview.error, t)}</InlineAlert>}
            {state.preview.status === 'ready' && (
              <>
                <p>
                  {t('webclientExport.summary', {
                    requests: state.preview.summary.requestCount,
                    folders: state.preview.summary.folderCount,
                  })}
                </p>
                {state.preview.summary.credentials.length === 0 ? (
                  <p className="ui-modal-description">{t('webclientExport.noCredentials')}</p>
                ) : (
                  <div>
                    <p>{state.includeSensitive ? t('webclientExport.credentialsIncluded') : t('webclientExport.credentialsOmitted')}</p>
                    <ul className="webclient-export__list">
                      {state.preview.summary.credentials.map((credential) => (
                        <li key={credential.id}>{credentialLabel(credential, t)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {state.preview.summary.unsupported.length > 0 && (
                  <div>
                    <p>{t('webclientExport.unsupported')}</p>
                    <ul className="webclient-export__list">
                      {state.preview.summary.unsupported.map((item) => (
                        <li key={`${item.requestId}:${item.feature}`}>
                          {t(`webclientExport.unsupported.${item.feature}`, { name: item.requestName })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {state.preview.summary.hosts.length > 0 && (
                  <div className="webclient-export__hosts">
                    <span>{t('webclientExport.hostsLabel')}:</span>
                    <code>{state.preview.summary.hosts.join(', ')}</code>
                    <Button variant="ghost" onClick={() => state.preview.status === 'ready' && void copyServerCommand(state.preview.summary)}>
                      {t('webclientExport.copyServerCommand')}
                    </Button>
                  </div>
                )}
                {state.preview.summary.hasUnresolvedHosts && (
                  <p className="ui-field-hint">{t('webclientExport.unresolvedHosts')}</p>
                )}
              </>
            )}
          </div>

          <div className="webclient-export__section">
            <label className="webclient-export__check" htmlFor={sensitiveId}>
              <Checkbox id={sensitiveId} checked={state.includeSensitive} onChange={(event) => state.setIncludeSensitive(event.target.checked)} />
              {t('webclientExport.includeSensitive')}
            </label>
            {state.includeSensitive && (
              <div className="webclient-export__sensitive" role="alert">
                <p>{t('webclientExport.sensitiveWarning')}</p>
                {state.password === '' && <p>{t('webclientExport.sensitiveWithoutPassword')}</p>}
                <label className="webclient-export__check" htmlFor={confirmId}>
                  <Checkbox
                    id={confirmId}
                    checked={state.sensitiveConfirmed}
                    onChange={(event) => state.setSensitiveConfirmed(event.target.checked)}
                  />
                  {t('webclientExport.confirmSensitive')}
                </label>
              </div>
            )}
          </div>

          <div className="ui-modal-actions">
            <Button variant="ghost" onClick={requestClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!state.canExport} isLoading={state.exporting}>
              {t('webclientExport.exportButton')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
