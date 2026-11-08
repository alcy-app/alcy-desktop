import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError, VersionStatusDto } from './version-control-types'

export type GetVersionStatusResult = CommandResult<VersionStatusDto, VersionControlCommandError>

export function getVersionStatus(rootPath: string, operationId: string): Promise<GetVersionStatusResult> {
  return invokeResult('get_version_status', { input: { rootPath, operationId } })
}
