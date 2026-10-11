import { invoke } from '@tauri-apps/api/core'
import type { CollectionDto, CollectionsError } from './list-collections'

export type SerializeCollectionsResult = { ok: true; value: string } | { ok: false; error: CollectionsError }

/** Coleções no formato Alcy, como texto — o conteúdo embutido na imagem de
 * compartilhamento para ela poder ser importada (ADR 0032). */
export async function serializeCollections(collections: CollectionDto[]): Promise<SerializeCollectionsResult> {
  try {
    const value = await invoke<string>('serialize_collections', { input: { collections } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
