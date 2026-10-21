import { invoke } from '@tauri-apps/api/core'

export type FlowFormFieldKind = 'text' | 'textarea' | 'number' | 'select' | 'radio' | 'checkbox' | 'result'
export interface FlowFormColumn { path: string; label: string }
export interface FlowFormField {
  id: string
  label: string
  description: string
  kind: FlowFormFieldKind
  required: boolean
  initialValue: string
  min: number | null
  max: number | null
  step: number | null
  options: { value: string; label: string }[]
  source: { reference: string; columns: FlowFormColumn[]; view?: 'list' | 'table' } | null
  multiple: boolean
}
export interface FlowFormSection { id: string; title: string; collapsed: boolean; fields: FlowFormField[] }
export interface FlowForm { title: string; description: string; sections: FlowFormSection[] }
export interface FlowPanel { nodeId: string; title: string; x: number; y: number; width: number; height: number }
export interface FlowPresentation { panels: FlowPanel[] }
export type FormAnswers = Record<string, string | number | boolean | number[] | null>
export interface FlowFormRequest { flowExecutionId: string; nodeId: string; waitId: string }
export interface FormOptionPage { rows: { index: number; cells: string[] }[]; total: number; nextOffset: number | null }

export function submitFlowForm(input: FlowFormRequest, answers: FormAnswers): Promise<void> {
  return invoke('submit_flow_form', { input, answers })
}
export function listFlowFormOptions(input: FlowFormRequest, fieldId: string, offset: number): Promise<FormOptionPage> {
  return invoke('list_flow_form_options', { input, fieldId, offset })
}
export function releaseFlowRun(flowExecutionId: string): Promise<void> {
  return invoke('release_flow_run', { flowExecutionId })
}
