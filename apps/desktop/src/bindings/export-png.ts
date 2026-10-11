import { invoke } from '@tauri-apps/api/core'

export interface ExportPngError {
  kind: 'invalid' | 'storage'
  message: string
}

export type ExportPngResult = { ok: true } | { ok: false; error: ExportPngError }

/** Grava a imagem de compartilhamento no caminho escolhido. Os bytes vão
 * como corpo binário cru da IPC (sem virar array JSON) e o caminho num
 * header, codificado porque headers só aceitam ASCII (ADR 0029). */
export async function exportPng(path: string, bytes: Uint8Array): Promise<ExportPngResult> {
  try {
    await invoke('export_png', bytes, { headers: { 'x-alcy-path': encodeURIComponent(path) } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as ExportPngError }
  }
}
