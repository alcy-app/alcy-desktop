import type { SchemaType } from '../../bindings/load-schema'

/** Limite de campos encontrados exibidos: termos curtos (ex.: `id`) casam com boa parte do schema. */
export const QUERY_EXPLORER_SEARCH_LIMIT = 200

/**
 * Resultado da busca no explorador de query. As chaves são o caminho do
 * campo unido por espaço — o mesmo formato usado pela árvore para expandir.
 */
export interface QueryExplorerSearchResult {
  /** Termo normalizado (minúsculo, sem espaços nas pontas). */
  term: string
  /** Campos exibidos: os que casam com o termo e seus ancestrais. */
  visible: Set<string>
  /** Ancestrais dos campos encontrados, abertos automaticamente. */
  expanded: Set<string>
  matchCount: number
  /** A busca parou em `QUERY_EXPLORER_SEARCH_LIMIT` campos encontrados. */
  truncated: boolean
}

export function fieldKey(path: string[]): string {
  return path.join(' ')
}

function hasSelectableFields(type: SchemaType): boolean {
  return type.kind === 'OBJECT' || type.kind === 'INTERFACE'
}

/**
 * Procura campos pelo nome a partir do tipo raiz, em largura. Cada tipo é
 * percorrido uma única vez, no caminho mais curto até ele: o custo fica
 * proporcional ao tamanho do schema (sem explodir em tipos recursivos) e
 * cada campo encontrado aparece num caminho só.
 */
export function searchQueryExplorerFields(
  rootType: SchemaType,
  types: SchemaType[],
  rawTerm: string,
  limit = QUERY_EXPLORER_SEARCH_LIMIT,
): QueryExplorerSearchResult | null {
  const term = rawTerm.trim().toLowerCase()
  if (!term) return null

  const typesByName = new Map(types.map((type) => [type.name, type]))
  const visited = new Set<string>([rootType.name])
  const queue: { type: SchemaType; path: string[] }[] = [{ type: rootType, path: [] }]
  const visible = new Set<string>()
  const expanded = new Set<string>()
  let matchCount = 0

  for (let index = 0; index < queue.length; index++) {
    const { type, path } = queue[index]
    for (const field of type.fields) {
      const fieldPath = [...path, field.name]
      if (field.name.toLowerCase().includes(term)) {
        if (matchCount === limit) {
          return { term, visible, expanded, matchCount, truncated: true }
        }
        matchCount++
        visible.add(fieldKey(fieldPath))
        for (let depth = 1; depth < fieldPath.length; depth++) {
          const ancestorKey = fieldKey(fieldPath.slice(0, depth))
          visible.add(ancestorKey)
          expanded.add(ancestorKey)
        }
      }
      const childType = field.typeName ? typesByName.get(field.typeName) : undefined
      if (childType && hasSelectableFields(childType) && !visited.has(childType.name)) {
        visited.add(childType.name)
        queue.push({ type: childType, path: fieldPath })
      }
    }
  }

  return { term, visible, expanded, matchCount, truncated: false }
}
