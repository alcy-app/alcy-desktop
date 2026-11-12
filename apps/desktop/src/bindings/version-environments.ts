import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError, VersionStatusDto } from './version-control-types'

export type VersionEnvironmentsResult = CommandResult<VersionStatusDto, VersionControlCommandError>

/** Starts versioning the environments of a workspace already linked to git. */
export function versionEnvironments(rootPath: string, operationId: string): Promise<VersionEnvironmentsResult> {
  return invokeResult('version_environments', { input: { rootPath, operationId } })
}
