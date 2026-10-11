import type { FileStatusDto } from '../../bindings/gitlab-types'

export type VersionSummary = 'unlinked' | 'loading' | 'busy' | 'error' | 'clean' | 'changes' | 'remoteAhead' | 'conflict'

export interface VersionCounts {
  local: number
  remote: number
  conflicts: number
}

export function countChanges(files: FileStatusDto[]): VersionCounts {
  const counts: VersionCounts = { local: 0, remote: 0, conflicts: 0 }
  for (const file of files) {
    if (file.state === 'localAdded' || file.state === 'localModified' || file.state === 'localDeleted') counts.local += 1
    else if (file.state === 'remoteChanged') counts.remote += 1
    else if (file.state === 'conflict') counts.conflicts += 1
  }
  return counts
}

interface SummaryInput {
  linked: boolean
  loaded: boolean
  statusKnown: boolean
  remoteStatusKnown: boolean
  busy: boolean
  failed: boolean
  counts: VersionCounts
}

/** Estado exibido pelo ícone da barra de status; conflito tem prioridade sobre alterações locais e estas sobre o remoto à frente. */
export function summarize({ linked, loaded, statusKnown, remoteStatusKnown, busy, failed, counts }: SummaryInput): VersionSummary {
  if (!loaded) return 'loading'
  if (!linked) return 'unlinked'
  if (busy) return 'busy'
  if (failed && !statusKnown) return 'error'
  if (!statusKnown) return 'loading'
  if (counts.conflicts > 0) return 'conflict'
  if (counts.local > 0) return 'changes'
  if (counts.remote > 0) return 'remoteAhead'
  if (!remoteStatusKnown) return failed ? 'error' : 'loading'
  return 'clean'
}

/** Arquivos versionados por padrão (a lista autoritativa vive em `alcy-domain`). */
export const TRACKED_FILES = ['alcy-workspace.json', 'alcy-collections.json', 'alcy-flows.json', 'alcy-api-docs.json', 'alcy-value-monitors.json'] as const
/** Monitores de valores do workspace. */
export const VALUE_MONITORS_FILE = 'alcy-value-monitors.json'
export const ENVIRONMENTS_FILE = 'alcy-environments.json'
/** Documentação importada das APIs (ADR 0035). */
export const API_DOCS_FILE = 'alcy-api-docs.json'

/**
 * Mescla um status local (hash local × base salva, sem tocar o remoto —
 * `get_local_version_status`) sobre o último status conhecido (que pode vir
 * de uma consulta que checou o remoto de verdade). O local é otimista: nunca
 * sabe sobre o remoto, então nunca deveria "apagar" um `remoteChanged`/
 * `conflict` já detectado — só o poll periódico/manual corrige isso.
 */
export function mergeLocalStatus(previous: FileStatusDto[], local: FileStatusDto[]): FileStatusDto[] {
  const previousByName = new Map(previous.map((file) => [file.name, file]))
  return local.map((file) => {
    const previousFile = previousByName.get(file.name)
    if (previousFile?.state === 'conflict') return { ...file, state: 'conflict', remoteRevision: previousFile.remoteRevision }
    if (previousFile?.state === 'remoteChanged') {
      return {
        ...file,
        state: file.state === 'clean' ? 'remoteChanged' : 'conflict',
        remoteRevision: previousFile.remoteRevision,
      }
    }
    return file
  })
}
