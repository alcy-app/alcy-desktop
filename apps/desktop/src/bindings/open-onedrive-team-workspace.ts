import type { WorkspaceDto } from './create-workspace'
import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'

export interface OpenOnedriveTeamWorkspaceInput {
  operationId: string
  accountId: string
  driveId: string
  folderId: string
  /** Id do manifesto criado quando a pasta do time ainda não tem um. */
  id: string
}

export type OpenOnedriveTeamWorkspaceResult = CommandResult<WorkspaceDto, GitlabCommandError>

/** Abre um workspace do time: reaproveita a cópia local vinculada ou cria uma nova já sincronizada. */
export function openOnedriveTeamWorkspace(input: OpenOnedriveTeamWorkspaceInput): Promise<OpenOnedriveTeamWorkspaceResult> {
  return invokeResult('open_onedrive_team_workspace', { input })
}
