import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'

export type UnlinkWorkspaceResult = CommandResult<null, GitlabCommandError>

export function unlinkWorkspace(rootPath: string): Promise<UnlinkWorkspaceResult> {
  return invokeResult('unlink_workspace', { input: { rootPath } })
}
