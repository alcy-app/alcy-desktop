import { invoke } from '@tauri-apps/api/core'
import type { ExecuteCollectionRunError } from './execute-collection-run'

/** Resumo do arquivo de dados de iteração; o conteúdo inteiro fica no backend. */
export interface IterationDataPreviewDto {
  fileName: string
  columns: string[]
  rowCount: number
  /** Primeiras linhas, na ordem das colunas. */
  sample: string[][]
}

export type PreviewIterationDataResult =
  | { ok: true; value: IterationDataPreviewDto }
  | { ok: false; error: ExecuteCollectionRunError }

export async function previewIterationData(path: string): Promise<PreviewIterationDataResult> {
  try {
    const value = await invoke<IterationDataPreviewDto>('preview_iteration_data', { input: { path } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as ExecuteCollectionRunError }
  }
}
