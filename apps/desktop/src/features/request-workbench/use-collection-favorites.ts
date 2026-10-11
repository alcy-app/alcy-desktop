import { useCallback, useState } from 'react'

/** Favoritas são pessoais (ADR 0060): ficam nesta máquina, por workspace, e não vão para o arquivo
 * de collections — favoritar não gera alteração para commitar. */
export function collectionFavoritesStorageKey(workspaceRootPath: string): string {
  return `alcy:collections:favorites:${workspaceRootPath}`
}

export function loadCollectionFavorites(workspaceRootPath: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(collectionFavoritesStorageKey(workspaceRootPath))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    // localStorage indisponível ou conteúdo inválido: começa sem favoritas.
    return new Set()
  }
}

function persistCollectionFavorites(workspaceRootPath: string, favoriteIds: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(collectionFavoritesStorageKey(workspaceRootPath), JSON.stringify([...favoriteIds]))
  } catch {
    // localStorage indisponível: a escolha continua valendo nesta sessão.
  }
}

/** Ids das collections favoritas do workspace. O workbench é remontado ao trocar de workspace
 * (`key` em `App.tsx`), então a leitura inicial basta. */
export function useCollectionFavorites(workspaceRootPath: string) {
  const [favoriteIds, setFavoriteIds] = useState(() => loadCollectionFavorites(workspaceRootPath))

  /** Marca (`favorite`) ou desmarca as collections `ids` — uma só pela linha, ou a seleção múltipla.
   * `existingIds` descarta, na mesma gravação, favoritas de collections que não existem mais. */
  const setFavorites = useCallback(
    (ids: string[], favorite: boolean, existingIds: Iterable<string>) => {
      const existing = new Set(existingIds)
      const next = new Set([...favoriteIds].filter((favoriteId) => existing.has(favoriteId)))
      for (const id of ids) {
        if (favorite) next.add(id)
        else next.delete(id)
      }
      persistCollectionFavorites(workspaceRootPath, next)
      setFavoriteIds(next)
    },
    [favoriteIds, workspaceRootPath],
  )

  return { favoriteIds, setFavorites }
}
