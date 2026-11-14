import { invoke } from '@tauri-apps/api/core'
import type { SaveOutcome } from './save-outcome'

export type RunReportFormat = 'html' | 'json' | 'junit'

export type ExportCollectionRunReportError = { kind: 'notFound' } | { kind: 'storage'; message: string }

export type ExportCollectionRunReportResult = { ok: true; saved: boolean } | { ok: false; error: ExportCollectionRunReportError }

/** Builds the report of a run (the last one, in memory, or one from the
 * history) and saves it where the person chooses in the save dialog the
 * backend opens. The backend builds the file: responses do not cross the IPC. */
export async function exportCollectionRunReport(input: {
  rootPath: string
  runId: string
  suggestedName: string
  format: RunReportFormat
  language: string
}): Promise<ExportCollectionRunReportResult> {
  try {
    const outcome = await invoke<SaveOutcome>('export_collection_run_report', { input })
    return { ok: true, saved: outcome === 'saved' }
  } catch (error) {
    return { ok: false, error: error as ExportCollectionRunReportError }
  }
}
