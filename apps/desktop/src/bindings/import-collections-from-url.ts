import { invoke } from '@tauri-apps/api/core'
import type { ImportedCollectionDataDto } from './import-collections'
import type { CollectionsError } from './list-collections'

export type ImportCollectionsFromUrlResult =
  | { ok: true; value: ImportedCollectionDataDto }
  | { ok: false; error: CollectionsError }

export async function importCollectionsFromUrl(url: string, rootPath: string): Promise<ImportCollectionsFromUrlResult> {
  try {
    const value = await invoke<ImportedCollectionDataDto>('import_collections_from_url', { input: { url, rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
