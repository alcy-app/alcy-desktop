import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError } from './version-control-types'

export type UnlinkWorkspaceResult = CommandResult<null, VersionControlCommandError>

export function unlinkWorkspace(rootPath: string): Promise<UnlinkWorkspaceResult> {
  return invokeResult('unlink_workspace', { input: { rootPath } })
}
