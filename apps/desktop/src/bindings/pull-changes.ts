import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError } from './version-control-types'

export interface PullResultDto {
  /** Arquivos locais reescritos ou removidos (a interface precisa recarregá-los). */
  updated: string[]
  conflicts: string[]
  skipped: string[]
}

export type PullChangesResult = CommandResult<PullResultDto, VersionControlCommandError>

export function pullChanges(rootPath: string, operationId: string): Promise<PullChangesResult> {
  return invokeResult('pull_changes', { input: { rootPath, operationId } })
}
