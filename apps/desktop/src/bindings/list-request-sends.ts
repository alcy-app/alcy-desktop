import { invoke } from '@tauri-apps/api/core'
import type { HttpMethodInput } from './execute-rest-request'
import type { HistoryError, HistoryOutcomeSummary } from './list-history'

/** Um envio de uma requisição, como gravado no histórico. */
export interface RequestSendDto {
  id: string
  executedAtMs: number
  protocol: 'graphql' | 'rest'
  /** URL já resolvida, como foi enviada. */
  endpoint: string
  /** `null` em envios antigos, gravados sem o método no índice. */
  method: HttpMethodInput | null
  outcome: HistoryOutcomeSummary
  baseline: boolean
}

export interface RequestSendsSource {
  rootPath: string
  requestId: string | null
  tabId: string | null
}

export type ListRequestSendsResult = { ok: true; value: RequestSendDto[] } | { ok: false; error: HistoryError }

/** Envios da requisição salva (`requestId`) ou da aba (`tabId`), mais recente primeiro. */
export async function listRequestSends(source: RequestSendsSource): Promise<ListRequestSendsResult> {
  try {
    const value = await invoke<RequestSendDto[]>('list_request_sends', { input: source })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
