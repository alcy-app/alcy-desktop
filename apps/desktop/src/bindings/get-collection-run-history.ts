import { invoke } from '@tauri-apps/api/core'
import type { CollectionRunOptionsDto, RunStepDto } from './execute-collection-run'
import type { FlowNodeOutputDto } from './get-flow-node-output'
import type { HistoryError } from './list-history'

export interface CollectionRunPlanItemDto {
  requestId: string
  name: string
  protocol: string
  method: string
}

export type CollectionRunOutputDto = FlowNodeOutputDto & { iteration: number; position: number }

/** Um run do runner gravado no histórico. */
export interface CollectionRunDetailDto {
  id: string
  scopeName: string
  environmentName: string | null
  startedAtMs: number
  finishedAtMs: number
  cancelled: boolean
  stoppedOnError: boolean
  iterations: number
  options: Omit<CollectionRunOptionsDto, 'saveToHistory'> & { dataFileName: string | null }
  plan: CollectionRunPlanItemDto[]
  steps: RunStepDto[]
  outputs: CollectionRunOutputDto[]
}

export type GetCollectionRunHistoryResult =
  | { ok: true; value: CollectionRunDetailDto }
  | { ok: false; error: HistoryError }

export async function getCollectionRunHistory(rootPath: string, id: string): Promise<GetCollectionRunHistoryResult> {
  try {
    const value = await invoke<CollectionRunDetailDto>('get_collection_run_history', { input: { rootPath, id } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
