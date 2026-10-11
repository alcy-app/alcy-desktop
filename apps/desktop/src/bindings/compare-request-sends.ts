import { invoke } from '@tauri-apps/api/core'
import type { HistoryError } from './list-history'

export type ComparedOutcomeDto =
  | { type: 'response'; statusCode: number }
  | { type: 'failed'; kind: 'network' | 'timeout'; message: string }

export type ResponseDiffLineKind = 'context' | 'added' | 'removed'

export interface ResponseDiffHunkDto {
  baseStart: number
  targetStart: number
  lines: { kind: ResponseDiffLineKind; text: string }[]
}

export interface ResponseComparisonDto {
  identical: boolean
  base: ComparedOutcomeDto
  target: ComparedOutcomeDto
  body: {
    hunks: ResponseDiffHunkDto[]
    tooLarge: boolean
    binary: boolean
    truncated: boolean
  }
}

export interface CompareRequestSendsInput {
  rootPath: string
  /** Lado antigo ("−"). */
  baseId: string
  /** Lado novo ("+"). */
  targetId: string
}

export type CompareRequestSendsResult = { ok: true; value: ResponseComparisonDto } | { ok: false; error: HistoryError }

/** Diff da resposta de dois envios, já calculado no backend. */
export async function compareRequestSends(input: CompareRequestSendsInput): Promise<CompareRequestSendsResult> {
  try {
    const value = await invoke<ResponseComparisonDto>('compare_request_sends', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
