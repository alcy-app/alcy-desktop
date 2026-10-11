import { invoke } from '@tauri-apps/api/core'
import type { FlowDto } from './list-flows'

export interface LoadImportDiagnosticDto {
  line: number
  column: number
  message: string
}

export interface LoadTestImportAnalysisDto {
  format: 'k6' | 'jmeter'
  analysisHash: string
  flow: FlowDto
  destinations: string[]
  blocks: number
  assets: string[]
}

export type LoadTestImportError =
  | { kind: 'invalidSource'; message: string }
  | { kind: 'incompatible'; diagnostics: LoadImportDiagnosticDto[] }
  | { kind: 'staleAnalysis' }
  | { kind: 'storage'; message: string }

export type AnalyzeLoadTestImportResult =
  | { ok: true; value: LoadTestImportAnalysisDto }
  | { ok: false; error: LoadTestImportError }

export type CommitLoadTestImportResult = { ok: true; value: FlowDto } | { ok: false; error: LoadTestImportError }

/** Analisa localmente a fonte sem gravar flow ou asset. */
export async function analyzeLoadTestImport(sourcePath: string): Promise<AnalyzeLoadTestImportResult> {
  try {
    const value = await invoke<LoadTestImportAnalysisDto>('analyze_load_test_import', { input: { sourcePath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as LoadTestImportError }
  }
}

/** Confirma exatamente a análise exibida; o backend rejeita uma fonte que tenha mudado. */
export async function commitLoadTestImport(
  rootPath: string,
  sourcePath: string,
  analysisHash: string,
): Promise<CommitLoadTestImportResult> {
  try {
    const value = await invoke<FlowDto>('commit_load_test_import', { input: { rootPath, sourcePath, analysisHash } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as LoadTestImportError }
  }
}
