import type {
  ImportVariableSelectionDto,
  ImportVariableTargetDto,
  PreparedImportDto,
} from '../../bindings/prepared-import'

/** Encoded `<select>` value: `imported:<index>`, `new`, `existing:<id>` or `collection:<index>`. */
export type ImportVariableDestination = string

export const NEW_ENVIRONMENT_DESTINATION = 'new'

export interface ImportVariableRow {
  key: string
  /** Name in the imported file; rows sharing it are renamed together so references stay consistent. */
  originalName: string
  name: string
  originalValue: string
  value: string
  valueTruncated: boolean
  referenced: boolean
  include: boolean
  /** The person's choice; a collection destination never stores it (ADR 0031). */
  sensitive: boolean
  destination: ImportVariableDestination
}

export interface ImportVariablesState {
  rows: ImportVariableRow[]
  newEnvironmentName: string
}

export type ImportVariableError = 'empty' | 'invalid' | 'duplicate'

export interface ExistingEnvironmentTarget {
  id: string
  name: string
  variableNames: string[]
}

export function isCollectionDestination(destination: ImportVariableDestination): boolean {
  return destination.startsWith('collection:')
}

export function initialImportVariables(summary: PreparedImportDto): ImportVariablesState {
  const referencedDestination = (summary.environmentNames ?? []).length > 0 ? 'imported:0' : NEW_ENVIRONMENT_DESTINATION
  return {
    newEnvironmentName: summary.title,
    rows: (summary.variables ?? []).map((candidate) => ({
      key: candidate.key,
      originalName: candidate.name,
      name: candidate.name,
      originalValue: candidate.value,
      value: candidate.value,
      valueTruncated: candidate.valueTruncated,
      referenced: candidate.origin.kind === 'referenced',
      include: candidate.included,
      sensitive: candidate.sensitive,
      destination:
        candidate.origin.kind === 'environment'
          ? `imported:${candidate.origin.index}`
          : candidate.origin.kind === 'collection'
            ? `collection:${candidate.origin.index}`
            : referencedDestination,
    })),
  }
}

export function updateImportVariable(
  state: ImportVariablesState,
  key: string,
  patch: Partial<Pick<ImportVariableRow, 'include' | 'value' | 'sensitive' | 'destination'>>,
): ImportVariablesState {
  return { ...state, rows: state.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) }
}

/** Renames every row that came with the same name, since the commit rewrites `{{old}}` references once per name. */
export function renameImportVariable(state: ImportVariablesState, key: string, name: string): ImportVariablesState {
  const originalName = state.rows.find((row) => row.key === key)?.originalName
  if (originalName === undefined) return state
  return { ...state, rows: state.rows.map((row) => (row.originalName === originalName ? { ...row, name } : row)) }
}

export function importVariableErrors(state: ImportVariablesState): Map<string, ImportVariableError> {
  const errors = new Map<string, ImportVariableError>()
  const byDestination = new Map<string, ImportVariableRow[]>()
  for (const row of state.rows) {
    if (!row.include) continue
    const name = row.name.trim()
    if (name === '') errors.set(row.key, 'empty')
    else if (name.includes('{') || name.includes('}')) errors.set(row.key, 'invalid')
    const group = `${row.destination}\u0000${name}`
    byDestination.set(group, [...(byDestination.get(group) ?? []), row])
  }
  for (const rows of byDestination.values()) {
    if (rows.length < 2) continue
    for (const row of rows) if (!errors.has(row.key)) errors.set(row.key, 'duplicate')
  }
  return errors
}

export function needsNewEnvironment(state: ImportVariablesState): boolean {
  return state.rows.some((row) => row.include && row.destination === NEW_ENVIRONMENT_DESTINATION)
}

export function importVariablesValid(state: ImportVariablesState): boolean {
  if (needsNewEnvironment(state) && state.newEnvironmentName.trim() === '') return false
  return importVariableErrors(state).size === 0
}

function target(destination: ImportVariableDestination, newEnvironmentName: string): ImportVariableTargetDto {
  if (destination === NEW_ENVIRONMENT_DESTINATION) return { kind: 'newEnvironment', name: newEnvironmentName.trim() }
  const separator = destination.indexOf(':')
  const kind = destination.slice(0, separator)
  const rest = destination.slice(separator + 1)
  if (kind === 'existing') return { kind: 'existingEnvironment', id: rest }
  if (kind === 'collection') return { kind: 'collection', index: Number(rest) }
  return { kind: 'importedEnvironment', index: Number(rest) }
}

export function importVariableSelections(state: ImportVariablesState): ImportVariableSelectionDto[] {
  return state.rows.map((row) => ({
    key: row.key,
    include: row.include,
    name: row.name.trim(),
    value: row.valueTruncated || row.value === row.originalValue ? null : row.value,
    sensitive: row.sensitive && !isCollectionDestination(row.destination),
    target: target(row.destination, state.newEnvironmentName),
  }))
}
