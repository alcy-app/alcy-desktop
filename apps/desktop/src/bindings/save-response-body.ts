import { invoke } from '@tauri-apps/api/core'
import type { ResponseBodyEncoding } from './execute-graphql-request'
import type { SaveOutcome } from './save-outcome'

/** Where the backend reads the body from: whole (`inline`, it already
 * crossed the IPC) or by the handle of a large body kept in the backend
 * (`windowed`) — the full body never goes back through the IPC. */
export type SaveResponseBodySource = { kind: 'inline'; body: string } | { kind: 'windowed'; handle: string }

export interface SaveResponseBodyInput {
  /** Filled in the save dialog the backend opens. */
  suggestedName: string
  /** Label of the dialog's "all files" filter. */
  allFilesLabel: string
  encoding: ResponseBodyEncoding
  source: SaveResponseBodySource
}

export type SaveResponseBodyError = { kind: 'notFound' } | { kind: 'invalid' | 'storage'; message: string }

export type SaveResponseBodyResult = { ok: true; saved: boolean } | { ok: false; error: SaveResponseBodyError }

/** Saves the response body where the person chooses ("Download response"). */
export async function saveResponseBody(input: SaveResponseBodyInput): Promise<SaveResponseBodyResult> {
  try {
    const outcome = await invoke<SaveOutcome>('save_response_body', { input })
    return { ok: true, saved: outcome === 'saved' }
  } catch (error) {
    return { ok: false, error: error as SaveResponseBodyError }
  }
}
