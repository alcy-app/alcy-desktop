import { invoke } from '@tauri-apps/api/core'

export type FrontendLogLevel = 'info' | 'warn' | 'error'

export interface FrontendLogEntry {
  level: FrontendLogLevel
  scope: string
  message: string
}

/** Envia um lote de eventos do frontend para o log local do app. Nunca
 * lança: sem Tauri (testes) ou com falha, o lote é descartado em silêncio. */
export async function writeFrontendLogs(entries: FrontendLogEntry[]): Promise<void> {
  try {
    await invoke('write_frontend_logs', { input: { entries } })
  } catch {
    // Logs são best-effort: falhar aqui não pode afetar a interface.
  }
}
