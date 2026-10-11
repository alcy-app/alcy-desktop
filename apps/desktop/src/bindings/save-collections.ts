import { invoke } from '@tauri-apps/api/core'
import type { CollectionDto, CollectionsError } from './list-collections'

export type SaveCollectionsResult = { ok: true } | { ok: false; error: CollectionsError }

export async function saveCollections(rootPath: string, collections: CollectionDto[]): Promise<SaveCollectionsResult> {
  try {
    await invoke('save_collections', { input: { rootPath, collections } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
