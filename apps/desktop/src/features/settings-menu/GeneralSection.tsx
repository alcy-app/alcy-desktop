import { useEffect, useState } from 'react'
import { getGeneralSettings, type GeneralSettingsDto } from '../../bindings/get-general-settings'
import { saveGeneralSettings } from '../../bindings/save-general-settings'
import { APP_VERSION } from '../../shared/app-version'
import { useLanguage } from '../../shared/i18n/use-language'
import { useSchemaAutocomplete } from '../../shared/schema-autocomplete/use-schema-autocomplete'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'

/** Espelham `DEFAULT_REQUEST_TIMEOUT_SECONDS` e `MAX_REQUEST_TIMEOUT_SECONDS` (`alcy-domain`). */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 60
export const MAX_REQUEST_TIMEOUT_SECONDS = 3600
/** Espelham `DEFAULT_RESPONSE_SIZE_LIMIT_MB` e `MAX_RESPONSE_SIZE_LIMIT_MB` (`alcy-domain`). */
export const DEFAULT_RESPONSE_SIZE_LIMIT_MB = 50
export const MAX_RESPONSE_SIZE_LIMIT_MB = 4096
/** Espelham `DEFAULT_HISTORY_RETENTION_DAYS` e `MAX_HISTORY_RETENTION_DAYS` (`alcy-domain`). */
export const DEFAULT_HISTORY_RETENTION_DAYS = 7
export const MAX_HISTORY_RETENTION_DAYS = 7

function parseWholeNumber(draft: string, max: number): number | null {
  if (!/^\d+$/.test(draft.trim())) return null
  const value = Number(draft.trim())
  return value >= 1 && value <= max ? value : null
}

interface GeneralSectionProps {
  /** Ausente quando o changelog embutido não tem a seção da versão atual. */
  onOpenReleaseNotes?: () => void
  /** Chamado depois de aplicar uma nova retenção, que já pode ter podado o histórico. */
  onHistoryRetentionChange?: () => void
}

type SaveOutcome = { ok: true } | { ok: false; message: string }

export function GeneralSection({ onOpenReleaseNotes, onHistoryRetentionChange }: GeneralSectionProps) {
  const { t } = useLanguage()
  const [saved, setSaved] = useState<GeneralSettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getGeneralSettings().then((result) => {
      if (cancelled) return
      if (result.ok) setSaved(result.value)
      else setLoadError(result.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** As preferências são gravadas juntas: aplicar um campo reenvia os outros como estão salvos. */
  const save = async (patch: Partial<GeneralSettingsDto>): Promise<SaveOutcome> => {
    if (saved === null) return { ok: false, message: '' }
    const result = await saveGeneralSettings({ ...saved, ...patch })
    if (!result.ok) return { ok: false, message: result.error.message }
    setSaved(result.value)
    return { ok: true }
  }

  return (
    <>
      <section className="settings-section settings-preference" data-testid="general-settings">
        <div>
          <p className="settings-section-label">{t('settings.timeoutLabel')}</p>
          <p className="settings-proxy-hint">{t('settings.timeoutHint')}</p>
        </div>
        <LimitSetting
          savedValue={saved === null ? undefined : saved.requestTimeoutSeconds}
          defaultValue={DEFAULT_REQUEST_TIMEOUT_SECONDS}
          max={MAX_REQUEST_TIMEOUT_SECONDS}
          inputAriaLabel={t('settings.timeoutSecondsAria')}
          unit={t('settings.timeoutSecondsUnit')}
          disableLabel={t('settings.timeoutDisable')}
          disabledHint={t('settings.timeoutDisabledHint')}
          invalidMessage={t('settings.timeoutInvalid', { max: MAX_REQUEST_TIMEOUT_SECONDS })}
          loadError={loadError && t('settings.timeoutLoadError', { message: loadError })}
          saveErrorMessage={(message) => t('settings.timeoutSaveError', { message })}
          onApply={(requestTimeoutSeconds) => save({ requestTimeoutSeconds })}
        />
      </section>
      <section className="settings-section settings-preference" data-testid="response-size-limit-settings">
        <div>
          <p className="settings-section-label">{t('settings.responseLimitLabel')}</p>
          <p className="settings-proxy-hint">{t('settings.responseLimitHint')}</p>
        </div>
        <LimitSetting
          savedValue={saved === null ? undefined : saved.responseSizeLimitMb}
          defaultValue={DEFAULT_RESPONSE_SIZE_LIMIT_MB}
          max={MAX_RESPONSE_SIZE_LIMIT_MB}
          inputAriaLabel={t('settings.responseLimitAria')}
          unit={t('settings.responseLimitUnit')}
          disableLabel={t('settings.responseLimitDisable')}
          disabledHint={t('settings.responseLimitDisabledHint')}
          invalidMessage={t('settings.responseLimitInvalid', { max: MAX_RESPONSE_SIZE_LIMIT_MB })}
          loadError={loadError && t('settings.responseLimitLoadError', { message: loadError })}
          saveErrorMessage={(message) => t('settings.responseLimitSaveError', { message })}
          applyAriaLabel={t('settings.responseLimitApplyAria')}
          restoreAriaLabel={t('settings.responseLimitRestoreAria')}
          onApply={(responseSizeLimitMb) => save({ responseSizeLimitMb })}
        />
      </section>
      <section className="settings-section settings-preference" data-testid="history-retention-settings">
        <div>
          <p className="settings-section-label">{t('settings.historyRetentionLabel')}</p>
          <p className="settings-proxy-hint">{t('settings.historyRetentionHint')}</p>
        </div>
        <LimitSetting
          // Zero dias desativa o histórico: aparece como a opção "Desativar histórico".
          savedValue={saved === null ? undefined : saved.historyRetentionDays || null}
          defaultValue={DEFAULT_HISTORY_RETENTION_DAYS}
          max={MAX_HISTORY_RETENTION_DAYS}
          inputAriaLabel={t('settings.historyRetentionAria')}
          unit={t('settings.historyRetentionUnit')}
          disableLabel={t('settings.historyRetentionDisable')}
          disabledHint={t('settings.historyRetentionDisabledHint')}
          invalidMessage={t('settings.historyRetentionInvalid', { max: MAX_HISTORY_RETENTION_DAYS })}
          loadError={loadError && t('settings.historyRetentionLoadError', { message: loadError })}
          saveErrorMessage={(message) => t('settings.historyRetentionSaveError', { message })}
          applyAriaLabel={t('settings.historyRetentionApplyAria')}
          restoreAriaLabel={t('settings.historyRetentionRestoreAria')}
          onApply={async (days) => {
            const outcome = await save({ historyRetentionDays: days ?? 0 })
            if (outcome.ok) onHistoryRetentionChange?.()
            return outcome
          }}
        />
      </section>
      <SaveHistoryResponsesSetting
        savedValue={saved === null ? undefined : saved.saveHistoryResponses}
        onApply={(saveHistoryResponses) => save({ saveHistoryResponses })}
      />
      <SchemaAutocompleteSetting />
      <ReleaseNotesSetting onOpen={onOpenReleaseNotes} />
    </>
  )
}

interface LimitSettingProps {
  /** `undefined` enquanto as preferências não carregaram; `null` = desabilitado. */
  savedValue: number | null | undefined
  defaultValue: number
  max: number
  inputAriaLabel: string
  unit: string
  disableLabel: string
  disabledHint: string
  invalidMessage: string
  loadError: string | null
  saveErrorMessage: (message: string) => string
  /** Nomes acessíveis dos botões quando há mais de um limite na mesma tela. */
  applyAriaLabel?: string
  restoreAriaLabel?: string
  onApply: (value: number | null) => Promise<SaveOutcome>
}

/** Um valor inteiro com mínimo de 1, que também pode ser desabilitado (`null`). */
function LimitSetting({
  savedValue,
  defaultValue,
  max,
  inputAriaLabel,
  unit,
  disableLabel,
  disabledHint,
  invalidMessage,
  loadError,
  saveErrorMessage,
  applyAriaLabel,
  restoreAriaLabel,
  onApply,
}: LimitSettingProps) {
  const { t } = useLanguage()
  const [draft, setDraft] = useState(String(defaultValue))
  const [disabled, setDisabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // O rascunho acompanha o valor salvo sempre que ele muda (carregamento e
  // cada "Aplicar"), sem efeito: ajuste de estado durante a renderização.
  const [syncedValue, setSyncedValue] = useState<number | null | undefined>(undefined)
  if (savedValue !== syncedValue) {
    setSyncedValue(savedValue)
    if (savedValue !== undefined) {
      setDisabled(savedValue === null)
      setDraft(String(savedValue ?? defaultValue))
    }
  }

  const value = parseWholeNumber(draft, max)
  const invalid = !disabled && value === null
  const next = disabled ? null : value
  const dirty = savedValue !== undefined && next !== savedValue
  const isDefault = !disabled && value === defaultValue
  const locked = savedValue === undefined || busy

  const apply = async () => {
    setBusy(true)
    setSaveError(null)
    const outcome = await onApply(next)
    setBusy(false)
    if (!outcome.ok) setSaveError(saveErrorMessage(outcome.message))
  }

  return (
    <div className="settings-timeout">
      <div className="settings-timeout-field">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={max}
          step={1}
          mono
          aria-label={inputAriaLabel}
          aria-invalid={invalid || undefined}
          disabled={locked || disabled}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setSaveError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && dirty && !invalid && !locked) void apply()
          }}
        />
        <span>{unit}</span>
      </div>
      <label className="settings-checkbox">
        <Checkbox
          checked={disabled}
          disabled={locked}
          onChange={(event) => {
            setDisabled(event.target.checked)
            setSaveError(null)
          }}
        />
        <span>{disableLabel}</span>
      </label>
      {disabled && <p className="settings-proxy-hint">{disabledHint}</p>}
      {invalid && <InlineAlert>{invalidMessage}</InlineAlert>}
      {loadError && <InlineAlert>{loadError}</InlineAlert>}
      {saveError && <InlineAlert>{saveError}</InlineAlert>}
      <div className="settings-proxy-actions">
        <Button
          variant="ghost"
          aria-label={restoreAriaLabel}
          disabled={locked || isDefault}
          onClick={() => {
            setDisabled(false)
            setDraft(String(defaultValue))
            setSaveError(null)
          }}
        >
          {t('settings.timeoutRestoreDefault')}
        </Button>
        <Button aria-label={applyAriaLabel} disabled={locked || !dirty || invalid} isLoading={busy} onClick={() => void apply()}>
          {t('settings.timeoutApply')}
        </Button>
      </div>
    </div>
  )
}

/** Aplica na hora, sem "Aplicar": vale para os próximos envios. */
function SaveHistoryResponsesSetting({
  savedValue,
  onApply,
}: {
  /** `undefined` enquanto as preferências não carregaram. */
  savedValue: boolean | undefined
  onApply: (value: boolean) => Promise<SaveOutcome>
}) {
  const { t } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  return (
    <section className="settings-section settings-preference" data-testid="save-history-responses-settings">
      <div>
        <p className="settings-section-label">{t('settings.saveHistoryResponsesLabel')}</p>
        <p className="settings-proxy-hint">{t('settings.saveHistoryResponsesHint')}</p>
      </div>
      <label className="settings-checkbox">
        <Checkbox
          checked={savedValue ?? false}
          disabled={savedValue === undefined || busy}
          onChange={(event) => {
            const next = event.target.checked
            setBusy(true)
            setSaveError(null)
            void onApply(next).then((outcome) => {
              setBusy(false)
              if (!outcome.ok) setSaveError(t('settings.saveHistoryResponsesSaveError', { message: outcome.message }))
            })
          }}
        />
        <span>{t('settings.saveHistoryResponsesToggle')}</span>
      </label>
      {saveError && <InlineAlert>{saveError}</InlineAlert>}
    </section>
  )
}

/** Preferência local (não passa pelo backend): aplica na hora, sem "Aplicar". */
function SchemaAutocompleteSetting() {
  const { t } = useLanguage()
  const { enabled, setEnabled } = useSchemaAutocomplete()
  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('settings.schemaAutocompleteLabel')}</p>
        <p className="settings-proxy-hint">{t('settings.schemaAutocompleteHint')}</p>
      </div>
      <label className="settings-checkbox">
        <Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>{t('settings.schemaAutocompleteToggle')}</span>
      </label>
    </section>
  )
}

function ReleaseNotesSetting({ onOpen }: { onOpen?: () => void }) {
  const { t } = useLanguage()
  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('settings.releaseNotesLabel')}</p>
        <p className="settings-proxy-hint">
          {onOpen
            ? t('settings.releaseNotesHint', { version: APP_VERSION })
            : t('settings.releaseNotesUnavailable', { version: APP_VERSION })}
        </p>
      </div>
      <div className="settings-proxy-actions">
        <Button variant="ghost" disabled={!onOpen} onClick={onOpen}>
          {t('settings.releaseNotesOpen')}
        </Button>
      </div>
    </section>
  )
}
