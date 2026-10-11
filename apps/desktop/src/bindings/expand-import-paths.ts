import { invoke } from '@tauri-apps/api/core'
import type { CollectionsError } from './list-collections'

export type ExpandImportPathsResult = { ok: true; value: string[] } | { ok: false; error: CollectionsError }

/** Troca cada pasta comum pelos arquivos importáveis dentro dela (recursivo,
 * em ordem alfabética). Arquivos e raízes de coleção Bruno/OpenCollection
 * voltam como estão, para serem importados inteiros. */
export async function expandImportPaths(paths: string[]): Promise<ExpandImportPathsResult> {
  try {
    const value = await invoke<string[]>('expand_import_paths', { input: { paths } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
