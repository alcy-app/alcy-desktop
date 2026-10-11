import { Channel, invoke } from '@tauri-apps/api/core'

export type LoadRunEventDto =
  | {
      type: 'progress'
      activeVus: number
      plannedVus: number
      completedIterations: number
      droppedIterations: number
      requests: number
      failedRequests: number
      checksPassed: number
      checksFailed: number
      elapsedMs: number
    }
  | {
      type: 'scenarioFinished'
      scenarioId: string
      cancelled: boolean
      completedIterations: number
      droppedIterations: number
      requests: number
      failedRequests: number
      checksPassed: number
      checksFailed: number
    }
  | {
      type: 'runFinished'
      cancelled: boolean
      passed: boolean
      completedIterations: number
      droppedIterations: number
      requests: number
      failedRequests: number
      checksPassed: number
      checksFailed: number
    }

export type ExecuteLoadFlowError = { kind: 'notFound' } | { kind: 'invalid'; message: string } | { kind: 'storage'; message: string }
export type ExecuteLoadFlowResult = { ok: true } | { ok: false; error: ExecuteLoadFlowError }

/** O backend relê o flow salvo pelo ID: o channel leva apenas snapshots agregados. */
export async function executeLoadFlow(
  input: { loadRunId: string; rootPath: string; flowId: string },
  onEvent: (event: LoadRunEventDto) => void,
): Promise<ExecuteLoadFlowResult> {
  const channel = new Channel<LoadRunEventDto>()
  channel.onmessage = onEvent
  try {
    await invoke('execute_load_flow', { input, onEvent: channel })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as ExecuteLoadFlowError }
  }
}
