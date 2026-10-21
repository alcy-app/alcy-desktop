import type { FlowForm, FlowFormField, FlowFormFieldKind } from '../../bindings/flow-forms'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { FlowTemplateTextarea } from './FlowTemplateTextarea'
import './flow-forms.css'

function move<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items]
  const target = index + delta
  if (target >= 0 && target < items.length) [next[index], next[target]] = [next[target], next[index]]
  return next
}

export function FlowFormEditor({ form, onChange, allowResults = false, disabled = false }: { form: FlowForm; onChange: (form: FlowForm) => void; allowResults?: boolean; disabled?: boolean }) {
  const { t } = useLanguage()
  const changeField = (sectionIndex: number, fieldIndex: number, update: Partial<FlowFormField>) => onChange({ ...form, sections: form.sections.map((section, index) => index === sectionIndex ? { ...section, fields: section.fields.map((field, i) => i === fieldIndex ? { ...field, ...update } : field) } : section) })
  return <fieldset className="flow-form-editor" disabled={disabled}>
    <Field label={t('flows.forms.title')}>{(id) => <Input id={id} maxLength={1024} value={form.title} onChange={(e) => onChange({ ...form, title: e.target.value })} />}</Field>
    <Field label={t('flows.forms.description')}>{(id) => <Input id={id} maxLength={4096} value={form.description} onChange={(e) => onChange({ ...form, description: e.target.value })} />}</Field>
    {form.sections.map((section, si) => <details className="flow-form-editor-section" key={section.id} open>
      <summary>{section.title || t('flows.forms.section')} <span>{section.fields.length}</span></summary>
      <div className="flow-form-editor-content">
        <div className="flow-form-editor-row"><Field label={t('flows.forms.section')}>{(id) => <Input id={id} value={section.title} onChange={(e) => onChange({ ...form, sections: form.sections.map((s, i) => i === si ? { ...s, title: e.target.value } : s) })} />}</Field><Button size="sm" variant="ghost" disabled={si === 0} aria-label={t('flows.forms.up')} onClick={() => onChange({ ...form, sections: move(form.sections, si, -1) })}>↑</Button><Button size="sm" variant="ghost" disabled={si === form.sections.length - 1} aria-label={t('flows.forms.down')} onClick={() => onChange({ ...form, sections: move(form.sections, si, 1) })}>↓</Button><Button size="sm" variant="ghost" onClick={() => onChange({ ...form, sections: form.sections.filter((_, i) => i !== si) })}>{t('flows.forms.remove')}</Button></div>
        <label className="flow-form-check"><Checkbox checked={section.collapsed} onChange={(e) => onChange({ ...form, sections: form.sections.map((s, i) => i === si ? { ...s, collapsed: e.target.checked } : s) })} />{t('flows.forms.collapsed')}</label>
        {section.fields.map((field, fi) => <details className="flow-form-editor-field" key={fi} open>
          <summary>{field.label || t('flows.forms.field')}<code>{field.id}</code></summary>
          <div className="flow-form-editor-content">
            <div className="flow-form-editor-grid">
              <Field label={t('flows.forms.id')}>{(id) => <Input id={id} maxLength={128} pattern="[A-Za-z_][A-Za-z0-9_]*" value={field.id} onChange={(e) => changeField(si, fi, { id: e.target.value })} />}</Field>
              <Field label={t('flows.forms.kind')}>{(id) => <Select id={id} value={field.kind} onChange={(e) => changeField(si, fi, { kind: e.target.value as FlowFormFieldKind })}>{(['text', 'textarea', 'number', 'select', 'radio', 'checkbox', ...(allowResults ? ['result'] as const : [])] as FlowFormFieldKind[]).map((kind) => <option key={kind} value={kind}>{t(`flows.forms.type.${kind}`)}</option>)}</Select>}</Field>
            </div>
            <Field label={t('flows.forms.label')}>{(id) => <Input id={id} maxLength={1024} value={field.label} onChange={(e) => changeField(si, fi, { label: e.target.value })} />}</Field>
            <Field label={t('flows.forms.description')}>{(id) => <Input id={id} maxLength={4096} value={field.description} onChange={(e) => changeField(si, fi, { description: e.target.value })} />}</Field>
            <label className="flow-form-check"><Checkbox checked={field.required} onChange={(e) => changeField(si, fi, { required: e.target.checked })} />{t('flows.forms.required')}</label>
            {field.kind !== 'result' && <Field label={t('flows.forms.initialValue')}>{(id) => field.kind === 'checkbox' ? <Select id={id} value={field.initialValue || 'false'} onChange={(e) => changeField(si, fi, { initialValue: e.target.value })}><option value="false">{t('flows.canvas.ifFalseLabel')}</option><option value="true">{t('flows.canvas.ifTrueLabel')}</option></Select> : <Input id={id} value={field.initialValue} onChange={(e) => changeField(si, fi, { initialValue: e.target.value })} />}</Field>}
            {field.kind === 'number' && <div className="flow-form-editor-grid">{(['min', 'max', 'step'] as const).map((key) => <Field key={key} label={t(`flows.forms.${key}`)}>{(id) => <Input id={id} type="number" step="any" value={field[key] ?? ''} onChange={(e) => changeField(si, fi, { [key]: e.target.value === '' ? null : Number(e.target.value) })} />}</Field>)}</div>}
            {(field.kind === 'select' || field.kind === 'radio') && <Field label={t('flows.forms.options')}>{(id) => <textarea key={field.id} id={id} className="ui-textarea" rows={4} defaultValue={field.options.map((o) => `${o.value} | ${o.label}`).join('\n')} onChange={(e) => changeField(si, fi, { options: e.target.value.split('\n').filter((line) => line.trim()).map((line) => { const [value, ...label] = line.split('|'); return { value: value.trim(), label: label.join('|').trim() || value.trim() } }) })} />}</Field>}
            {field.kind === 'result' && <>
              <Field label={t('flows.forms.resultView')}>{(id) => <Select id={id} value={field.source?.view ?? 'table'} onChange={(e) => changeField(si, fi, { source: { reference: field.source?.reference ?? '', columns: field.source?.columns ?? [{ path: '', label: t('flows.forms.field') }], view: e.target.value as 'list' | 'table' } })}><option value="table">{t('flows.forms.table')}</option><option value="list">{t('flows.forms.list')}</option></Select>}</Field>
              <Field label={t('flows.forms.source')}>{(id) => <FlowTemplateTextarea id={id} value={field.source?.reference ?? ''} rows={2} onChange={(e) => changeField(si, fi, { source: { view: field.source?.view ?? 'table', reference: e.target.value, columns: field.source?.columns ?? [{ path: '', label: t('flows.forms.field') }] } })} />}</Field>
              <Field label={t('flows.forms.columns')}>{(id) => <textarea key={field.id} id={id} className="ui-textarea" rows={3} defaultValue={field.source?.columns.map((c) => `${c.path} | ${c.label}`).join('\n') ?? ''} onChange={(e) => changeField(si, fi, { source: { view: field.source?.view ?? 'table', reference: field.source?.reference ?? '', columns: e.target.value.split('\n').filter((line) => line.trim()).map((line) => { const [path, ...label] = line.split('|'); return { path: path.trim(), label: label.join('|').trim() || path.trim() } }) } })} />}</Field>
              <label className="flow-form-check"><Checkbox checked={field.multiple} onChange={(e) => changeField(si, fi, { multiple: e.target.checked })} />{t('flows.forms.multiple')}</label>
            </>}
            <div className="flow-form-editor-actions"><Button size="sm" variant="ghost" disabled={fi === 0} aria-label={t('flows.forms.up')} onClick={() => onChange({ ...form, sections: form.sections.map((s, i) => i === si ? { ...s, fields: move(s.fields, fi, -1) } : s) })}>↑</Button><Button size="sm" variant="ghost" disabled={fi === section.fields.length - 1} aria-label={t('flows.forms.down')} onClick={() => onChange({ ...form, sections: form.sections.map((s, i) => i === si ? { ...s, fields: move(s.fields, fi, 1) } : s) })}>↓</Button><Button size="sm" variant="ghost" onClick={() => onChange({ ...form, sections: form.sections.map((s, i) => i === si ? { ...s, fields: s.fields.filter((_, i) => i !== fi) } : s) })}>{t('flows.forms.remove')}</Button></div>
          </div>
        </details>)}
        <Button size="sm" variant="ghost" disabled={form.sections.reduce((n, s) => n + s.fields.length, 0) >= 200} onClick={() => {
          const used = new Set(form.sections.flatMap((s) => s.fields.map((f) => f.id)))
          let id = 'field'; for (let n = 2; used.has(id); n++) id = `field_${n}`
          const field: FlowFormField = { id, label: t('flows.forms.field'), description: '', kind: 'text', required: false, initialValue: '', min: null, max: null, step: null, options: [], source: null, multiple: false }
          onChange({ ...form, sections: form.sections.map((s, i) => i === si ? { ...s, fields: [...s.fields, field] } : s) })
        }}>{t('flows.forms.addField')}</Button>
      </div>
    </details>)}
    <Button variant="ghost" size="sm" disabled={form.sections.length >= 50} onClick={() => onChange({ ...form, sections: [...form.sections, { id: `section_${crypto.randomUUID().replaceAll('-', '')}`, title: t('flows.forms.section'), collapsed: false, fields: [] }] })}>{t('flows.forms.addSection')}</Button>
  </fieldset>
}
