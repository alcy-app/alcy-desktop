import type { CollectionLabelDto, LabelColor } from '../../bindings/list-collections'
import type { TreeNode } from './collection-tree'

/** Paleta fixa, na ordem em que aparece no seletor de cor (ADR 0060). */
export const LABEL_COLORS: readonly LabelColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']

/** Tamanho máximo do nome de um rótulo, para caber nos chips e no menu de filtro. */
export const LABEL_NAME_MAX_LENGTH = 40

/** Chave de comparação: nomes de rótulo não diferenciam maiúsculas de minúsculas. */
export function labelKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Catálogo do workspace: a união dos rótulos de todas as collections, sem repetição, com a cor da
 * primeira ocorrência e em ordem alfabética. */
export function labelCatalog(collections: TreeNode[]): CollectionLabelDto[] {
  const byKey = new Map<string, CollectionLabelDto>()
  for (const collection of collections) {
    for (const label of collection.labels ?? []) {
      const key = labelKey(label.name)
      if (!byKey.has(key)) byKey.set(key, label)
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
}

function withLabels(node: TreeNode, labels: CollectionLabelDto[]): TreeNode {
  const next = { ...node }
  if (labels.length > 0) next.labels = labels
  else delete next.labels
  return next
}

/** Liga (`assigned`) ou desliga um rótulo nas collections `ids` — uma só pela linha, ou a seleção
 * múltipla. Collections que já estão no estado pedido não mudam. */
export function assignCollectionLabel(
  collections: TreeNode[],
  ids: readonly string[],
  label: CollectionLabelDto,
  assigned: boolean,
): TreeNode[] {
  const targets = new Set(ids)
  const key = labelKey(label.name)
  return collections.map((collection) => {
    if (!targets.has(collection.id)) return collection
    const labels = collection.labels ?? []
    const has = labels.some((current) => labelKey(current.name) === key)
    if (has === assigned) return collection
    return withLabels(
      collection,
      assigned ? [...labels, { name: label.name.trim(), color: label.color }] : labels.filter((current) => labelKey(current.name) !== key),
    )
  })
}

/** Renomeia um rótulo em todas as collections. Renomear para um rótulo que já existe mescla os dois,
 * mantendo a cor do rótulo de destino. */
export function renameLabelEverywhere(collections: TreeNode[], oldName: string, newName: string): TreeNode[] {
  const oldKey = labelKey(oldName)
  const newKey = labelKey(newName)
  const trimmed = newName.trim()
  if (!trimmed) return collections

  const catalog = labelCatalog(collections)
  const target = newKey === oldKey ? undefined : catalog.find((label) => labelKey(label.name) === newKey)
  const source = catalog.find((label) => labelKey(label.name) === oldKey)
  if (!source) return collections
  const renamed: CollectionLabelDto = { name: trimmed, color: target?.color ?? source.color }

  return collections.map((collection) => {
    const labels = collection.labels ?? []
    const index = labels.findIndex((label) => {
      const key = labelKey(label.name)
      return key === oldKey || key === newKey
    })
    if (index === -1) return collection
    const rest = labels.filter((label) => {
      const key = labelKey(label.name)
      return key !== oldKey && key !== newKey
    })
    return withLabels(collection, [...rest.slice(0, index), renamed, ...rest.slice(index)])
  })
}

/** Troca a cor de um rótulo em todas as collections que o usam. */
export function recolorLabelEverywhere(collections: TreeNode[], name: string, color: LabelColor): TreeNode[] {
  const key = labelKey(name)
  return collections.map((collection) =>
    collection.labels?.some((label) => labelKey(label.name) === key)
      ? withLabels(
          collection,
          collection.labels.map((label) => (labelKey(label.name) === key ? { ...label, color } : label)),
        )
      : collection,
  )
}

/** Exclui um rótulo de todas as collections. */
export function removeLabelEverywhere(collections: TreeNode[], name: string): TreeNode[] {
  const key = labelKey(name)
  return collections.map((collection) =>
    collection.labels?.some((label) => labelKey(label.name) === key)
      ? withLabels(
          collection,
          collection.labels.filter((label) => labelKey(label.name) !== key),
        )
      : collection,
  )
}

export interface CollectionFilters {
  favoritesOnly: boolean
  /** Chaves (`labelKey`) dos rótulos escolhidos; vazio não filtra por rótulo. */
  labelKeys: ReadonlySet<string>
}

export const NO_COLLECTION_FILTERS: CollectionFilters = { favoritesOnly: false, labelKeys: new Set() }

export function hasCollectionFilters(filters: CollectionFilters): boolean {
  return filters.favoritesOnly || filters.labelKeys.size > 0
}

/** Mantém as collections que atendem aos filtros: rótulos se combinam por "ou" entre si e por "e" com
 * "somente favoritas". */
export function filterCollections(
  collections: TreeNode[],
  filters: CollectionFilters,
  favoriteIds: ReadonlySet<string>,
): TreeNode[] {
  if (!hasCollectionFilters(filters)) return collections
  return collections.filter((collection) => {
    if (filters.favoritesOnly && !favoriteIds.has(collection.id)) return false
    if (filters.labelKeys.size === 0) return true
    return (collection.labels ?? []).some((label) => filters.labelKeys.has(labelKey(label.name)))
  })
}

/** Favoritas primeiro, preservando a ordem manual dentro de cada grupo. */
export function sortFavoritesFirst(collections: TreeNode[], favoriteIds: ReadonlySet<string>): TreeNode[] {
  if (favoriteIds.size === 0) return collections
  const favorites = collections.filter((collection) => favoriteIds.has(collection.id))
  if (favorites.length === 0) return collections
  return [...favorites, ...collections.filter((collection) => !favoriteIds.has(collection.id))]
}
