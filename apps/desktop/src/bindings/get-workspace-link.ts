import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, WorkspaceLinkDto } from './gitlab-types'

export type GetWorkspaceLinkResult = CommandResult<WorkspaceLinkDto | null, GitlabCommandError>

/** Vínculo do workspace com um repositório remoto (`null` se não há). */
export function getWorkspaceLink(rootPath: string): Promise<GetWorkspaceLinkResult> {
  return invokeResult('get_workspace_link', { input: { rootPath } })
}
