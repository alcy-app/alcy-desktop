import { useEffect, useId, useState } from 'react'
import { listFlowFormOptions } from '../../bindings/flow-forms'
import type { FlowForm, FlowFormField, FlowFormRequest, FormAnswers, FormOptionPage } from '../../bindings/flow-forms'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { fieldError } from './form-model'
import './flow-forms.css'

export function FlowFormView({ form, answers, onChange, onSubmit, request, disabled = false, submitLabel }: { form: FlowForm; answers: FormAnswers; onChange: (answers: FormAnswers) => void; onSubmit: () => Promise<void>; request?: FlowFormRequest; disabled?: boolean; submitLabel?: string }) {
  const { t } = useLanguage()
  const prefix = useId()
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fields = form.sections.flatMap((s) => s.fields)
  const errors = Object.fromEntries(fields.map((field) => [field.id, fieldError(field, answers[field.id])]))
  return <form className="flow-runtime-form" noValidate onSubmit={(event) => {
    event.preventDefault()
    if (busy || disabled) return
    setAttempt((n) => n + 1)
    if (Object.values(errors).some(Boolean)) { setError(t('flows.forms.invalid')); return }
    setError(''); setBusy(true)
    void onSubmit().catch((reason: unknown) => setError(String(reason) === 'staleInteraction' ? t('flows.forms.stale') : String(reason))).finally(() => setBusy(false))
  }}>
    {form.title && <h3>{form.title}</h3>}
    {form.description && <p className="flow-form-description">{form.description}</p>}
    <fieldset disabled={disabled || busy} className="flow-form-fields">
      {form.sections.map((section) => <details className="flow-form-section" key={`${section.id}:${attempt}`} open={!section.collapsed || (attempt > 0 && section.fields.some((field) => errors[field.id]))}>
        <summary>{section.title || t('flows.forms.section')}</summary>
        <div className="flow-form-section-fields">{section.fields.map((field) => {
          const id = `${prefix}-${field.id}`
          const value = answers[field.id]
          const errorKey = attempt > 0 ? errors[field.id] : null
          const props = { id, 'aria-invalid': Boolean(errorKey), 'aria-describedby': `${id}-hint`, required: field.required }
          const change = (value: FormAnswers[string]) => onChange({ ...answers, [field.id]: value })
          return <div className="ui-field" key={field.id}>
            <label className="ui-field-label" htmlFor={id}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>
            {field.kind === 'text' && <Input {...props} maxLength={8192} value={typeof value === 'string' ? value : ''} onChange={(e) => change(e.target.value)} />}
            {field.kind === 'textarea' && <textarea {...props} className="ui-textarea" maxLength={8192} rows={4} value={typeof value === 'string' ? value : ''} onChange={(e) => change(e.target.value)} />}
            {field.kind === 'number' && <Input {...props} type="number" min={field.min ?? undefined} max={field.max ?? undefined} step={field.step ?? 'any'} value={typeof value === 'number' ? value : ''} onChange={(e) => change(e.target.value === '' ? null : Number(e.target.value))} />}
            {field.kind === 'checkbox' && <Checkbox {...props} checked={value === true} onChange={(e) => change(e.target.checked)} />}
            {field.kind === 'select' && <Select {...props} value={typeof value === 'string' ? value : ''} onChange={(e) => change(e.target.value)}><option value="">—</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>}
            {field.kind === 'radio' && <div id={id} role="radiogroup" aria-label={field.label} aria-describedby={`${id}-hint`}>{field.options.map((option) => <label key={option.value} className="flow-form-check"><input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => change(option.value)} />{option.label}</label>)}</div>}
            {field.kind === 'result' && request && <ResultOptions key={request.waitId} field={field} request={request} value={value} onChange={change} />}
            <p id={`${id}-hint`} className={errorKey ? 'ui-field-error' : 'ui-field-hint'}>{errorKey ? t(`flows.forms.${errorKey}`) : field.description}</p>
          </div>
        })}</div>
      </details>)}
    </fieldset>
    {error && <p role="alert" className="ui-field-error">{error}</p>}
    <Button type="submit" variant="primary" disabled={disabled || busy} aria-busy={busy}>{submitLabel ?? t('flows.forms.submit')}</Button>
  </form>
}

function ResultOptions({ field, request, value, onChange }: { field: FlowFormField; request: FlowFormRequest; value: FormAnswers[string]; onChange: (value: FormAnswers[string]) => void }) {
  const { t } = useLanguage()
  const prefix = useId()
  const [offset, setOffset] = useState(0)
  const [previous, setPrevious] = useState<number[]>([])
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ key: string; page?: FormOptionPage; error?: boolean }>()
  const { flowExecutionId, nodeId, waitId } = request
  const key = JSON.stringify([flowExecutionId, nodeId, waitId, field.id, offset, retry])
  const page = state?.key === key ? state.page : undefined
  useEffect(() => {
    let active = true
    void listFlowFormOptions({ flowExecutionId, nodeId, waitId }, field.id, offset).then((page) => { if (active) setState({ key, page }) }).catch(() => { if (active) setState({ key, error: true }) })
    return () => { active = false }
  }, [flowExecutionId, nodeId, waitId, field.id, offset, key])
  const selected = Array.isArray(value) ? value : typeof value === 'number' ? [value] : []
  const selectRow = (index: number) => onChange(field.multiple ? selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index] : index)
  return <div className="flow-form-results">
    {!page ? <p role="status">{state?.key === key && state.error ? <>{t('flows.forms.loadFailed')} <Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>{t('common.retry')}</Button></> : t('flows.studio.loading')}</p> : page.total === 0 ? <p role="status">{t('flows.forms.emptyResults')}</p> : <>
      {field.source?.view === 'list' ? <div className="flow-form-result-list" role="group" aria-label={field.label}><p className="flow-form-description">{t('flows.forms.selected', { count: selected.length })}</p>{page.rows.map((row) => <label className="flow-form-result-item" key={row.index}><input type={field.multiple ? 'checkbox' : 'radio'} name={prefix} checked={selected.includes(row.index)} onChange={() => selectRow(row.index)} /><span>{row.cells.map((cell, index) => index === 0 ? <strong key={index}>{cell}</strong> : <small key={index}>{cell}</small>)}</span></label>)}</div> : <div className="flow-form-table-scroll"><table><caption className="flow-form-description">{t('flows.forms.selected', { count: selected.length })}</caption><thead><tr><th scope="col">{field.label}</th>{field.source?.columns.map((column, index) => <th key={index} scope="col">{column.label}</th>)}</tr></thead><tbody>{page.rows.map((row) => <tr key={row.index} data-selected={selected.includes(row.index)} onClick={() => selectRow(row.index)}><td><input type={field.multiple ? 'checkbox' : 'radio'} name={prefix} aria-label={`${field.label}: ${row.cells.join(', ')}`} checked={selected.includes(row.index)} onChange={() => selectRow(row.index)} onClick={(event) => event.stopPropagation()} /></td>{row.cells.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody></table></div>}
      <div className="flow-form-editor-actions flow-form-pagination"><Button size="sm" variant="ghost" disabled={previous.length === 0} onClick={() => { setOffset(previous.at(-1) ?? 0); setPrevious((items) => items.slice(0, -1)) }}>{t('flows.studio.previousPage')}</Button><span>{previous.length + 1}</span><Button size="sm" variant="ghost" disabled={page.nextOffset === null} onClick={() => { setPrevious((items) => [...items, offset]); setOffset(page.nextOffset ?? offset) }}>{t('flows.studio.nextPage')}</Button></div>
    </>}
  </div>
}
