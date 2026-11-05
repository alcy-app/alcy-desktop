import { useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Field } from '../../shared/ui/Field'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { isTemplateSetting, literalNumber, numberSettingIssue } from './number-setting'
import type { NumberSettingRules } from './number-setting'

/** Longest wait the engine accepts (`MAX_SLEEP_MS` in `execute_flow.rs`). */
export const MAX_WAIT_MS = 10 * 60 * 1000

type Translate = ReturnType<typeof useLanguage>['t']

function issueMessage(value: string, rules: NumberSettingRules, t: Translate): string | undefined {
  const issue = numberSettingIssue(value, rules)
  if (issue === 'notANumber') return t(rules.integer ? 'flows.canvas.numberSettingNotAnInteger' : 'flows.canvas.numberSettingNotANumber')
  if (issue === 'outOfRange') {
    return rules.max === undefined
      ? t('flows.canvas.numberSettingAtLeast', { min: String(rules.min) })
      : t('flows.canvas.numberSettingBetween', { min: String(rules.min ?? 0), max: String(rules.max) })
  }
  return undefined
}

interface NumberSettingFieldProps {
  label: string
  hint?: string
  value: string
  rules: NumberSettingRules
  onChange: (value: string) => void
}

/** A numeric block setting typed as a number or a `{{variable}}`; out-of-range numbers show an error but are kept. */
export function NumberSettingField({ label, hint, value, rules, onChange }: NumberSettingFieldProps) {
  const { t } = useLanguage()
  return (
    <Field label={label} hint={hint} error={issueMessage(value, rules, t)}>
      {(id) => (
        <Input
          id={id}
          mono
          inputMode="decimal"
          value={value}
          placeholder={t('flows.canvas.numberSettingPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

type DurationUnit = 'ms' | 's'

interface DurationSettingFieldsProps {
  label: string
  hint?: string
  /** Milliseconds, or a template read in milliseconds. */
  value: string
  min: number
  onChange: (value: string) => void
}

/**
 * A duration stored in milliseconds and typed in ms or s. A `{{variable}}` is
 * stored as typed and read in milliseconds, so the unit is fixed to ms for it.
 */
export function DurationSettingFields({ label, hint, value, min, onChange }: DurationSettingFieldsProps) {
  const { t } = useLanguage()
  const [unit, setUnit] = useState<DurationUnit>(() => {
    const ms = literalNumber(value)
    return ms !== null && ms >= 1000 && ms % 1000 === 0 ? 's' : 'ms'
  })
  const factorOf = (next: DurationUnit) => (next === 's' ? 1000 : 1)
  const [draft, setDraft] = useState(() => {
    const ms = literalNumber(value)
    return ms === null ? value : String(ms / factorOf(unit))
  })
  const template = isTemplateSetting(draft)
  const factor = template ? 1 : factorOf(unit)

  const changeDraft = (text: string) => {
    setDraft(text)
    const number = isTemplateSetting(text) ? null : literalNumber(text)
    onChange(number === null ? text : String(Math.round(number * factorOf(unit))))
  }

  const changeUnit = (next: DurationUnit) => {
    setUnit(next)
    const ms = literalNumber(value)
    if (ms !== null) setDraft(String(ms / factorOf(next)))
  }

  return (
    <div className="flow-inspector-condition">
      <Field
        label={label}
        hint={template ? t('flows.canvas.durationVariableHint') : hint}
        error={issueMessage(draft, { min: min / factor, max: MAX_WAIT_MS / factor }, t)}
      >
        {(id) => (
          <Input
            id={id}
            mono
            inputMode="decimal"
            value={draft}
            placeholder={t('flows.canvas.numberSettingPlaceholder')}
            onChange={(event) => changeDraft(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('flows.canvas.sleepUnitLabel')}>
        {(id) => (
          <Select id={id} value={template ? 'ms' : unit} disabled={template} onChange={(event) => changeUnit(event.target.value as DurationUnit)}>
            <option value="ms">{t('flows.canvas.sleepUnitMilliseconds')}</option>
            <option value="s">{t('flows.canvas.sleepUnitSeconds')}</option>
          </Select>
        )}
      </Field>
    </div>
  )
}
