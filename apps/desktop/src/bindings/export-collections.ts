import { invoke } from '@tauri-apps/api/core'
import type { CollectionDto, CollectionsError } from './list-collections'

export type ExportCollectionsResult = { ok: true } | { ok: false; error: CollectionsError }

export async function exportCollections(path: string, collections: CollectionDto[]): Promise<ExportCollectionsResult> {
  try {
    await invoke('export_collections', { input: { path, collections } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
