import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError, WorkspaceLinkDto } from './version-control-types'

export type GetWorkspaceLinkResult = CommandResult<WorkspaceLinkDto | null, VersionControlCommandError>

/** Vínculo do workspace com um repositório remoto (`null` se não há). */
export function getWorkspaceLink(rootPath: string): Promise<GetWorkspaceLinkResult> {
  return invokeResult('get_workspace_link', { input: { rootPath } })
}
