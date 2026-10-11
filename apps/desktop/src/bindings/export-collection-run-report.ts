import { invoke } from '@tauri-apps/api/core'

export type RunReportFormat = 'html' | 'json' | 'junit'

export type ExportCollectionRunReportError = { kind: 'notFound' } | { kind: 'storage'; message: string }

export type ExportCollectionRunReportResult = { ok: true } | { ok: false; error: ExportCollectionRunReportError }

/** Gera o relatório de um run (o último, em memória, ou um do histórico) e
 * grava em `path`. O backend monta o arquivo: as respostas não atravessam o IPC. */
export async function exportCollectionRunReport(input: {
  rootPath: string
  runId: string
  path: string
  format: RunReportFormat
  language: string
}): Promise<ExportCollectionRunReportResult> {
  try {
    await invoke('export_collection_run_report', { input })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as ExportCollectionRunReportError }
  }
}
