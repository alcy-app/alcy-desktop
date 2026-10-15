import type { VariableRow } from './environments.types'

const NO_IDS: ReadonlySet<string> = new Set()

/** Normalized search text: an empty result means "no filter". */
export function normalizeVariableQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * Variables of one environment that match `query`, in their original order. The match is a case-insensitive
 * substring of the name, or of the value for non-sensitive variables only: a secret must never be found (and so
 * revealed) by its value. `keepIds` stay visible regardless of the query, so a row being edited does not vanish
 * mid-typing once it stops matching. Returns the same array when the query is empty.
 */
export function filterVariables<T extends Pick<VariableRow, 'id' | 'name' | 'value' | 'sensitive'>>(
  variables: T[],
  query: string,
  keepIds: ReadonlySet<string> = NO_IDS,
): T[] {
  const needle = normalizeVariableQuery(query)
  if (needle === '') return variables
  return variables.filter(
    (variable) =>
      keepIds.has(variable.id) ||
      variable.name.toLowerCase().includes(needle) ||
      (!variable.sensitive && variable.value.toLowerCase().includes(needle)),
  )
}
