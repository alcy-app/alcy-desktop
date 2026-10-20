import { invoke } from '@tauri-apps/api/core'
import type { FlowNodeOutputDto } from './get-flow-node-output'

export interface FlowOutputFieldDto {
  key: string
  pointer: string
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  preview: string
}

export interface FlowOutputInspectionDto {
  output: FlowNodeOutputDto
  availability: 'pending' | 'available' | 'preview' | 'binary' | 'limit' | 'busy' | 'unavailable'
  revision: string
  page: { kind: string; preview: string; entries: FlowOutputFieldDto[]; total: number } | null
  text: string | null
  nextCursor: string | null
}

export interface InspectFlowOutputInput {
  rootPath: string
  flowExecutionId: string
  nodeId: string
  queryId: string
  revision?: string
  pointer?: string
  cursor?: string | null
  query?: string
  text?: boolean
}

export function inspectFlowOutput(input: InspectFlowOutputInput): Promise<FlowOutputInspectionDto> {
  return invoke('inspect_flow_node_output', { input })
}

export function cancelFlowOutputQuery(queryId: string): Promise<void> {
  return invoke('cancel_flow_output_query', { queryId })
}
