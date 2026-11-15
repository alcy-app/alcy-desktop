import { useState } from 'react'
import { useSettingDraft, useSettingsAction } from './settings-actions'
import type { GeneralSettingsState } from './use-general-settings'
import { APP_VERSION } from '../../shared/app-version'
import { useLanguage } from '../../shared/i18n/use-language'
import { useSchemaAutocomplete } from '../../shared/schema-autocomplete/use-schema-autocomplete'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'

/** Mirror `DEFAULT_REQUEST_TIMEOUT_SECONDS` and `MAX_REQUEST_TIMEOUT_SECONDS` (`alcy-domain`). */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 60
export const MAX_REQUEST_TIMEOUT_SECONDS = 3600
/** Mirror `DEFAULT_RESPONSE_SIZE_LIMIT_MB` and `MAX_RESPONSE_SIZE_LIMIT_MB` (`alcy-domain`). */
export const DEFAULT_RESPONSE_SIZE_LIMIT_MB = 50
export const MAX_RESPONSE_SIZE_LIMIT_MB = 4096
/** Mirror `DEFAULT_K6_IMPORT_LIMIT_KB` and `MAX_K6_IMPORT_LIMIT_KB` (`alcy-domain`). */
export const DEFAULT_K6_IMPORT_LIMIT_KB = 512
export const MAX_K6_IMPORT_LIMIT_KB = 2048
/** Mirror `DEFAULT_HISTORY_RETENTION_DAYS` and `MAX_HISTORY_RETENTION_DAYS` (`alcy-domain`). */
export const DEFAULT_HISTORY_RETENTION_DAYS = 7
export const MAX_HISTORY_RETENTION_DAYS = 7

function parseWholeNumber(draft: string, max: number): number | null {
  if (!/^\d+$/.test(draft.trim())) return null
  const value = Number(draft.trim())
  return value >= 1 && value <= max ? value : null
}

type SaveOutcome = { ok: true } | { ok: false; message: string }

export function RequestSettings({ saved, loadError, save }: GeneralSettingsState) {
  const { t } = useLanguage()
  return (
    <>
      <section className="settings-section settings-preference" data-testid="general-settings" data-setting="timeout" tabIndex={-1}>
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
      <section className="settings-section settings-preference" data-testid="response-size-limit-settings" data-setting="response-limit" tabIndex={-1}>
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
          onApply={(responseSizeLimitMb) => save({ responseSizeLimitMb })}
        />
      </section>
      <section className="settings-section settings-preference" data-testid="k6-import-limit-settings" data-setting="k6-import-limit" tabIndex={-1}>
        <div>
          <p className="settings-section-label">{t('settings.k6ImportLimitLabel')}</p>
          <p className="settings-proxy-hint">{t('settings.k6ImportLimitHint')}</p>
        </div>
        <LimitSetting
          savedValue={saved === null ? undefined : saved.k6ImportLimitKb}
          defaultValue={DEFAULT_K6_IMPORT_LIMIT_KB}
          max={MAX_K6_IMPORT_LIMIT_KB}
          inputAriaLabel={t('settings.k6ImportLimitAria')}
          unit={t('settings.k6ImportLimitUnit')}
          invalidMessage={t('settings.k6ImportLimitInvalid', { max: MAX_K6_IMPORT_LIMIT_KB })}
          loadError={loadError && t('settings.k6ImportLimitLoadError', { message: loadError })}
          saveErrorMessage={(message) => t('settings.k6ImportLimitSaveError', { message })}
          onApply={(k6ImportLimitKb) => save({ k6ImportLimitKb: k6ImportLimitKb ?? DEFAULT_K6_IMPORT_LIMIT_KB })}
        />
      </section>
      <SchemaAutocompleteSetting />
    </>
  )
}

export function HistorySettings({ saved, loadError, save, onHistoryRetentionChange }: GeneralSettingsState & { onHistoryRetentionChange?: () => void }) {
  const { t } = useLanguage()
  return (
    <>
      <section className="settings-section settings-preference" data-testid="history-retention-settings" data-setting="history" tabIndex={-1}>
        <div>
          <p className="settings-section-label">{t('settings.historyRetentionLabel')}</p>
          <p className="settings-proxy-hint">{t('settings.historyRetentionHint')}</p>
        </div>
        <LimitSetting
          // Zero days disables history and is represented by the disable option.
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
    </>
  )
}

interface LimitSettingProps {
  /** `undefined` while loading; `null` means disabled. */
  savedValue: number | null | undefined
  defaultValue: number
  max: number
  inputAriaLabel: string
  unit: string
  /** Without it, the limit cannot be disabled and no checkbox is shown. */
  disableLabel?: string
  disabledHint?: string
  invalidMessage: string
  loadError: string | null
  saveErrorMessage: (message: string) => string
  onApply: (value: number | null) => Promise<SaveOutcome>
}

/** A positive integer that can also be disabled (`null`) when `disableLabel` is given. */
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
  onApply,
}: LimitSettingProps) {
  const [draft, setDraft] = useState(String(defaultValue))
  const [disabled, setDisabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Synchronize drafts when saved values change, including initial loading.
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
    return outcome.ok
  }

  useSettingsAction({
    dirty,
    isDefault,
    blocked: locked,
    invalid,
    apply,
    restore: () => { setDisabled(false); setDraft(String(defaultValue)); setSaveError(null) },
  })

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
        />
        <span>{unit}</span>
      </div>
      {disableLabel !== undefined && (
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
      )}
      {disabled && disabledHint && <p className="settings-proxy-hint">{disabledHint}</p>}
      {invalid && <InlineAlert>{invalidMessage}</InlineAlert>}
      {loadError && <InlineAlert>{loadError}</InlineAlert>}
      {saveError && <InlineAlert>{saveError}</InlineAlert>}
    </div>
  )
}

/** Staged with the other preferences on the Privacy page. */
function SaveHistoryResponsesSetting({
  savedValue,
  onApply,
}: {
  /** `undefined` while preferences are loading. */
  savedValue: boolean | undefined
  onApply: (value: boolean) => Promise<SaveOutcome>
}) {
  const { t } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [draft, setDraft] = useSettingDraft(savedValue ?? false, false, async (next) => {
    setBusy(true)
    setSaveError(null)
    const outcome = await onApply(next)
    setBusy(false)
    if (!outcome.ok) setSaveError(t('settings.saveHistoryResponsesSaveError', { message: outcome.message }))
    return outcome.ok
  }, savedValue !== undefined)

  return (
    <section className="settings-section settings-preference" data-testid="save-history-responses-settings" data-setting="history-responses" tabIndex={-1}>
      <div>
        <p className="settings-section-label">{t('settings.saveHistoryResponsesLabel')}</p>
        <p className="settings-proxy-hint">{t('settings.saveHistoryResponsesHint')}</p>
      </div>
      <label className="settings-checkbox">
        <Checkbox
          checked={draft}
          disabled={savedValue === undefined || busy}
          onChange={(event) => { setDraft(event.target.checked); setSaveError(null) }}
        />
        <span>{t('settings.saveHistoryResponsesToggle')}</span>
      </label>
      {saveError && <InlineAlert>{saveError}</InlineAlert>}
    </section>
  )
}

/** Local presentation preference staged with request limits. */
function SchemaAutocompleteSetting() {
  const { t } = useLanguage()
  const { enabled: savedEnabled, setEnabled: applyEnabled } = useSchemaAutocomplete()
  const [enabled, setEnabled] = useSettingDraft(savedEnabled, true, applyEnabled)
  return (
    <section className="settings-section settings-preference" data-setting="autocomplete" tabIndex={-1}>
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

export function ReleaseNotesSetting({ onOpen }: { onOpen?: () => void }) {
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
