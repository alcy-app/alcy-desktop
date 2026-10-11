import { invoke } from '@tauri-apps/api/core'
import type { HistoryError } from './list-history'
import type { RequestSendsSource } from './list-request-sends'

export type SetSendBaselineResult = { ok: true } | { ok: false; error: HistoryError }

/** Marca `id` como baseline dos envios da requisição; `null` desmarca. */
export async function setSendBaseline(source: RequestSendsSource, id: string | null): Promise<SetSendBaselineResult> {
  try {
    await invoke('set_send_baseline', { input: { ...source, id } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
