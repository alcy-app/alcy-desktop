import { invoke } from '@tauri-apps/api/core'
import type { FlowDto, FlowsError } from './list-flows'
import type { EnvironmentVariableDto } from './list-environments'
import type { SaveOutcome } from './save-outcome'

export interface FlowExportSource {
  rootPath: string
  flow: FlowDto
  environmentVariables: EnvironmentVariableDto[]
}

export interface FlowExportPreview {
  requestCount: number
  variableCount: number
  emptyVariableCount: number
  canInline: boolean
  hasDependencies: boolean
}

function sourceWithoutSecrets(source: FlowExportSource): FlowExportSource {
  return { ...source, environmentVariables: source.environmentVariables.map((v) => v.sensitive ? { ...v, value: '' } : v) }
}

export async function previewFlowExport(source: FlowExportSource): Promise<FlowExportPreview> {
  return invoke('preview_flow_export', { input: sourceWithoutSecrets(source) })
}

/** Saves the flow where the person chooses in the save dialog the backend opens. */
export async function exportFlow(source: FlowExportSource, suggestedName: string, inline: boolean): Promise<SaveOutcome> {
  return invoke('export_flow', { input: { ...sourceWithoutSecrets(source), suggestedName, inline } })
}

export function flowExportError(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) return (error as FlowsError).message
  return undefined
}
