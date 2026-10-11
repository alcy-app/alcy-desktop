import { invoke } from '@tauri-apps/api/core'

export type HistoryOutcomeSummary =
  | { type: 'success'; statusCode: number; durationMs: number; sizeBytes: number }
  | { type: 'failed'; kind: 'network' | 'timeout' }

export interface RequestHistorySummaryDto {
  origin: 'collection'
  id: string
  protocol: string
  endpoint: string
  executedAtMs: number
  outcome: HistoryOutcomeSummary
}

export type FlowRunStatus = 'completed' | 'failed' | 'cancelled'

/** Um run de flow inteiro, como um único evento. */
export interface FlowRunHistorySummaryDto {
  origin: 'flow'
  id: string
  flowName: string
  executedAtMs: number
  durationMs: number
  status: FlowRunStatus
}

/** Um run do runner de coleções, como um único evento. */
export interface CollectionRunHistorySummaryDto {
  origin: 'runner'
  id: string
  scopeName: string
  executedAtMs: number
  durationMs: number
  status: FlowRunStatus
  passed: number
  total: number
}

/** Execução de carga: detalhes agregados e amostras são buscados sob demanda. */
export interface LoadRunHistorySummaryDto {
  origin: 'load'
  id: string
  flowId: string
  flowName: string
  executedAtMs: number
  durationMs: number
  status: FlowRunStatus
  passed: boolean
  requests: number
  failedRequests: number
}

export type HistoryOrigin = HistoryEntrySummaryDto['origin']

export type HistoryEntrySummaryDto = RequestHistorySummaryDto | FlowRunHistorySummaryDto | CollectionRunHistorySummaryDto | LoadRunHistorySummaryDto

export type HistoryError =
  | { kind: 'storage'; message: string }
  | { kind: 'notFound' }
  /** Comparação pedida para um envio cuja resposta não foi guardada. */
  | { kind: 'responseNotStored' }

export type ListHistoryResult = { ok: true; value: HistoryEntrySummaryDto[] } | { ok: false; error: HistoryError }

export async function listHistory(rootPath: string): Promise<ListHistoryResult> {
  try {
    const value = await invoke<HistoryEntrySummaryDto[]>('list_history', { input: { rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
