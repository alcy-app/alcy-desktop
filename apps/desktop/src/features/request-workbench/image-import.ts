import { importCollections } from '../../bindings/import-collections'
import type { CollectionDto, FolderDto, SavedRequestDto } from '../../bindings/list-collections'
import type { RequestSummary } from './collection-tree'
import { requestFromDto } from './use-collections-state'

/** Imagem do "Compartilhar como imagem": importar abre a requisição como
 * rascunho, em vez de criar uma collection (ADR 0032). */
export const isPngPath = (path: string) => /\.png$/i.test(path)

export type ImageRequestResult = { ok: true; request: RequestSummary } | { ok: false; message: string | null }

export function firstRequest(nodes: (CollectionDto | FolderDto)[]): SavedRequestDto | null {
  for (const node of nodes) {
    const found = node.requests[0] ?? firstRequest(node.folders)
    if (found) return found
  }
  return null
}

/** Lê a requisição embutida no PNG. `message: null` quando a imagem tem
 * dados do Alcy, mas nenhuma requisição neles. */
export async function readImageRequest(path: string, rootPath: string): Promise<ImageRequestResult> {
  const result = await importCollections(path, rootPath)
  if (!result.ok) return { ok: false, message: result.error.message }
  const dto = firstRequest(result.value.collections)
  return dto ? { ok: true, request: requestFromDto(dto) } : { ok: false, message: null }
}
