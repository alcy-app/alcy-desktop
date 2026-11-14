import { invoke } from '@tauri-apps/api/core'
import type { CollectionDto, CollectionsError } from './list-collections'
import type { SaveOutcome } from './save-outcome'

export type ExportCollectionsResult = { ok: true; saved: boolean } | { ok: false; error: CollectionsError }

/** Saves the collections in the Alcy format where the person chooses in the
 * save dialog the backend opens. */
export async function exportCollections(suggestedName: string, collections: CollectionDto[]): Promise<ExportCollectionsResult> {
  try {
    const outcome = await invoke<SaveOutcome>('export_collections', { input: { suggestedName, collections } })
    return { ok: true, saved: outcome === 'saved' }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
