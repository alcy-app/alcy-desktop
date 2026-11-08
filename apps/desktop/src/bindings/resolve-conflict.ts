import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError, ResolutionInput } from './version-control-types'

export interface ResolveConflictResultDto {
  localFileChanged: boolean
}

export type ResolveConflictResult = CommandResult<ResolveConflictResultDto, VersionControlCommandError>

export function resolveConflict(
  rootPath: string,
  operationId: string,
  fileName: string,
  resolution: ResolutionInput,
): Promise<ResolveConflictResult> {
  return invokeResult('resolve_conflict', { input: { rootPath, operationId, fileName, resolution } })
}
