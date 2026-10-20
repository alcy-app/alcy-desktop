import type { SchemaField, SchemaType } from '../../bindings/load-schema'

/** Display limit: short terms such as `id` can match much of the schema. */
export const QUERY_EXPLORER_SEARCH_LIMIT = 200

/**
 * Query explorer search results. Keys are space-separated field paths,
 * matching the format used by the tree to expand nodes.
 */
export interface QueryExplorerSearchResult {
  /** Lowercase search term without surrounding whitespace. */
  term: string
  /** Matching fields and their ancestors. */
  visible: Set<string>
  /** Ancestors of matching fields, expanded automatically. */
  expanded: Set<string>
  /** Sibling order, using the best match in each branch. */
  rank: Map<string, number>
  matchCount: number
  /** More matches exist than the display limit allows. */
  truncated: boolean
}

export function fieldKey(path: string[]): string {
  return path.join(' ')
}

function hasSelectableFields(type: SchemaType): boolean {
  return type.kind === 'OBJECT' || type.kind === 'INTERFACE'
}

/**
 * Search field names breadth-first, visiting each type once through its
 * shortest path to avoid recursive expansion. Rank matches before applying
 * the limit so exact names are retained even when encountered late.
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
  const matches: { name: string; path: string[] }[] = []
  const compare = (a: (typeof matches)[number], b: (typeof matches)[number]) =>
    a.name.length - b.name.length || a.name.indexOf(term) - b.name.indexOf(term)
  const recordMatch = (match: (typeof matches)[number]) => {
    // Retain only the best results and one extra to detect truncation.
    // Insert after equal scores so ties keep their original schema order.
    const capacity = limit + 1
    if (matches.length === capacity && compare(matches[capacity - 1], match) <= 0) return
    let low = 0
    let high = matches.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (compare(matches[middle], match) <= 0) low = middle + 1
      else high = middle
    }
    matches.splice(low, 0, match)
    if (matches.length > capacity) matches.pop()
  }

  for (let index = 0; index < queue.length; index++) {
    const { type, path } = queue[index]
    for (const field of type.fields) {
      const fieldPath = [...path, field.name]
      const name = field.name.toLowerCase()
      if (name.includes(term)) recordMatch({ name, path: fieldPath })
      const childType = field.typeName ? typesByName.get(field.typeName) : undefined
      if (childType && hasSelectableFields(childType) && !visited.has(childType.name)) {
        visited.add(childType.name)
        queue.push({ type: childType, path: fieldPath })
      }
    }
  }

  const selected = matches.slice(0, limit)
  const visible = new Set<string>()
  const expanded = new Set<string>()
  const rank = new Map<string, number>()
  selected.forEach(({ path }, index) => {
    for (let depth = 1; depth <= path.length; depth++) {
      const key = fieldKey(path.slice(0, depth))
      visible.add(key)
      if (!rank.has(key)) rank.set(key, index)
      if (depth < path.length) expanded.add(key)
    }
  })

  return { term, visible, expanded, rank, matchCount: selected.length, truncated: matches.length > limit }
}

/** Keep hierarchy intact while ordering siblings by their best search match. */
export function rankQueryExplorerFields(
  fields: SchemaField[],
  path: string[],
  search: QueryExplorerSearchResult | null,
): SchemaField[] {
  if (!search) return fields
  const rank = (field: SchemaField) => search.rank.get(fieldKey([...path, field.name])) ?? Number.MAX_SAFE_INTEGER
  return [...fields].sort((a, b) => rank(a) - rank(b))
}
