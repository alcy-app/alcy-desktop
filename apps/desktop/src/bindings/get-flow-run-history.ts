import { invoke } from '@tauri-apps/api/core'
import type { FlowNodeOutputDto } from './get-flow-node-output'
import type { FlowRunEventDto } from './execute-flow'
import type { FlowEdgeDto, FlowNodeDto } from './list-flows'
import type { HistoryError } from './list-history'

export interface TimedFlowRunEventDto {
  atMs: number
  event: FlowRunEventDto
}

export type FlowRunNodeOutputDto = FlowNodeOutputDto & { nodeId: string }

/** Historical run snapshot: executed graph, timestamped events replayed by the live reducers, and optional node output previews. */
export interface FlowRunDetailDto {
  id: string
  flowName: string
  startedAtMs: number
  finishedAtMs: number
  cancelled: boolean
  nodes: FlowNodeDto[]
  edges: FlowEdgeDto[]
  events: TimedFlowRunEventDto[]
  outputs: FlowRunNodeOutputDto[]
}

export type GetFlowRunHistoryResult = { ok: true; value: FlowRunDetailDto } | { ok: false; error: HistoryError }

export async function getFlowRunHistory(rootPath: string, id: string): Promise<GetFlowRunHistoryResult> {
  try {
    const value = await invoke<FlowRunDetailDto>('get_flow_run_history', { input: { rootPath, id, includeOutputs: false } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
