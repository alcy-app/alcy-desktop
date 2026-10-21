import type { FlowForm, FlowFormField, FormAnswers } from '../../bindings/flow-forms'

export function emptyFlowForm(): FlowForm {
  return { title: '', description: '', sections: [] }
}

export function initialFormAnswers(form: FlowForm): FormAnswers {
  return Object.fromEntries(form.sections.flatMap((section) => section.fields.map((field) => [field.id,
    field.kind === 'checkbox' ? field.initialValue === 'true' : field.kind === 'number' ? field.initialValue.trim() && Number.isFinite(Number(field.initialValue)) ? Number(field.initialValue) : null : field.kind === 'result' ? field.multiple ? [] : null : field.initialValue,
  ])))
}

export function fieldError(field: FlowFormField, value: FormAnswers[string]): 'requiredError' | 'numberError' | 'invalidOption' | null {
  const missing = value == null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0) || (field.kind === 'checkbox' && value !== true)
  if (missing) return field.required ? 'requiredError' : null
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (field.min !== null && value < field.min) || (field.max !== null && value > field.max)) return 'numberError'
    if (field.step !== null) {
      const n = (value - (field.min ?? 0)) / field.step
      if (Math.abs(n - Math.round(n)) > 1e-8) return 'numberError'
    }
  }
  if ((field.kind === 'select' || field.kind === 'radio') && !field.options.some((option) => option.value === value)) return 'invalidOption'
  return null
}
