import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, VersionStatusDto } from './gitlab-types'

export type GetVersionStatusResult = CommandResult<VersionStatusDto, GitlabCommandError>

export function getVersionStatus(rootPath: string, operationId: string): Promise<GetVersionStatusResult> {
  return invokeResult('get_version_status', { input: { rootPath, operationId } })
}
