import { invoke } from '@tauri-apps/api/core'

export interface LoadScenarioPreviewDto {
  nodeId: string
  label: string
  peakVus: number
  durationMs: number | null
  peakArrivalRatePerSecond: number | null
  requestCount: number
}

export interface LoadFlowPreviewDto {
  scenarios: LoadScenarioPreviewDto[]
  destinations: string[]
  peakVus: number
  durationMs: number | null
  peakArrivalRatePerSecond: number | null
}

export type PreviewLoadFlowError =
  | { kind: 'notFound' }
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string }

export type PreviewLoadFlowResult =
  | { ok: true; value: LoadFlowPreviewDto }
  | { ok: false; error: PreviewLoadFlowError }

/** Obtém a prévia validada antes de iniciar um flow de carga salvo. */
export async function previewLoadFlow(rootPath: string, flowId: string): Promise<PreviewLoadFlowResult> {
  try {
    const value = await invoke<LoadFlowPreviewDto>('preview_load_flow', { input: { rootPath, flowId } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as PreviewLoadFlowError }
  }
}
