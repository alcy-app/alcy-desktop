import { invoke } from '@tauri-apps/api/core'
import type { SaveOutcome } from './save-outcome'

export interface ExportHarError {
  kind: 'invalid' | 'storage'
  message: string
}

export type ExportHarResult = { ok: true; saved: boolean } | { ok: false; error: ExportHarError }

/** Saves the HAR where the person chooses in the save dialog the backend opens. */
export async function exportHar(suggestedName: string, content: string): Promise<ExportHarResult> {
  try {
    const outcome = await invoke<SaveOutcome>('export_har', { input: { suggestedName, content } })
    return { ok: true, saved: outcome === 'saved' }
  } catch (error) {
    return { ok: false, error: error as ExportHarError }
  }
}
