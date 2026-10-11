import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, ResolutionInput } from './gitlab-types'

export interface ResolveConflictResultDto {
  localFileChanged: boolean
}

export type ResolveConflictResult = CommandResult<ResolveConflictResultDto, GitlabCommandError>

export function resolveConflict(
  rootPath: string,
  operationId: string,
  fileName: string,
  resolution: ResolutionInput,
): Promise<ResolveConflictResult> {
  return invokeResult('resolve_conflict', { input: { rootPath, operationId, fileName, resolution } })
}
