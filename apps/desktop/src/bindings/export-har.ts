import { invoke } from '@tauri-apps/api/core'

export interface ExportHarError {
  kind: 'invalid' | 'storage'
  message: string
}

export type ExportHarResult = { ok: true } | { ok: false; error: ExportHarError }

export async function exportHar(path: string, content: string): Promise<ExportHarResult> {
  try {
    await invoke('export_har', { input: { path, content } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as ExportHarError }
  }
}
