import { invoke } from '@tauri-apps/api/core'
import type { HistoryError } from './list-history'

export interface LoadRunSummaryDto {
  cancelled: boolean
  completedIterations: number
  droppedIterations: number
  requests: number
  failedRequests: number
  checksPassed: number
  checksFailed: number
}

export interface LoadMetricDto {
  name: string
  tags: [string, string][]
  kind: string
  count: number
  value: number
  average: number | null
  minimum: number | null
  maximum: number | null
  p90: number | null
  p95: number | null
  p99: number | null
}

export interface LoadThresholdDto {
  metric: string
  tags: [string, string][]
  statistic: string
  comparison: string
  target: number
  actual: number | null
  passed: boolean
}

export interface LoadRunSampleDto {
  scenarioId: string
  vuId: number
  nodeId: string
  method: string
  status: number | null
  failed: boolean
  durationMs: number
}

export interface LoadRunDetailDto {
  id: string
  flowId: string
  flowName: string
  startedAtMs: number
  finishedAtMs: number
  passed: boolean
  summary: LoadRunSummaryDto
  metrics: LoadMetricDto[]
  thresholds: LoadThresholdDto[]
  sampleCount: number
  omittedSamples: number
}

export interface LoadRunSamplesPageDto {
  samples: LoadRunSampleDto[]
  offset: number
  total: number
  nextOffset: number | null
}

export type GetLoadRunHistoryResult = { ok: true; value: LoadRunDetailDto } | { ok: false; error: HistoryError }
export type GetLoadRunSamplesResult = { ok: true; value: LoadRunSamplesPageDto } | { ok: false; error: HistoryError }

export async function getLoadRunHistory(rootPath: string, id: string): Promise<GetLoadRunHistoryResult> {
  try {
    return { ok: true, value: await invoke<LoadRunDetailDto>('get_load_run_history', { input: { rootPath, id } }) }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}

export async function getLoadRunSamples(rootPath: string, id: string, offset = 0): Promise<GetLoadRunSamplesResult> {
  try {
    return { ok: true, value: await invoke<LoadRunSamplesPageDto>('get_load_run_samples', { input: { rootPath, id, offset } }) }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
