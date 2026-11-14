import { invoke } from '@tauri-apps/api/core'
import type { SaveOutcome } from './save-outcome'

export interface ExportPngError {
  kind: 'invalid' | 'storage'
  message: string
}

export type ExportPngResult = { ok: true; saved: boolean } | { ok: false; error: ExportPngError }

/** Saves the share image where the person chooses in the save dialog the
 * backend opens. The bytes go as the raw IPC body (not a JSON array) and the
 * suggested name in a header, encoded because headers only take ASCII
 * (ADR 0029). */
export async function exportPng(suggestedName: string, bytes: Uint8Array): Promise<ExportPngResult> {
  try {
    const outcome = await invoke<SaveOutcome>('export_png', bytes, { headers: { 'x-alcy-file-name': encodeURIComponent(suggestedName) } })
    return { ok: true, saved: outcome === 'saved' }
  } catch (error) {
    return { ok: false, error: error as ExportPngError }
  }
}
