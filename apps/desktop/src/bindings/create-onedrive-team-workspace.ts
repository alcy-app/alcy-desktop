import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { DriveFolderDto } from './onedrive-types'

export interface CreateOnedriveTeamWorkspaceInput {
  operationId: string
  accountId: string
  teamId: string
  name: string
}

export type CreateOnedriveTeamWorkspaceResult = CommandResult<DriveFolderDto, GitlabCommandError>

/** Cria a pasta de um novo workspace no catálogo do time (nome repetido é conflito). */
export function createOnedriveTeamWorkspace(input: CreateOnedriveTeamWorkspaceInput): Promise<CreateOnedriveTeamWorkspaceResult> {
  return invokeResult('create_onedrive_team_workspace', { input })
}
