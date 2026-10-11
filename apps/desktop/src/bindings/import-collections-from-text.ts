import { invoke } from '@tauri-apps/api/core'
import type { ImportedCollectionDataDto } from './import-collections'
import type { CollectionsError } from './list-collections'

export type ImportCollectionsFromTextResult =
  | { ok: true; value: ImportedCollectionDataDto }
  | { ok: false; error: CollectionsError }

export async function importCollectionsFromText(content: string, rootPath: string): Promise<ImportCollectionsFromTextResult> {
  try {
    const value = await invoke<ImportedCollectionDataDto>('import_collections_from_text', { input: { content, rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
