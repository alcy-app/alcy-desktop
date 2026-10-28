import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { TeamCatalogDto } from './onedrive-types'

export type GetOnedriveTeamCatalogResult = CommandResult<TeamCatalogDto, GitlabCommandError>

/** Pasta `Alcy/` do time; os workspaces são as subpastas, lidas com `listOnedriveFolders`. */
export function getOnedriveTeamCatalog(operationId: string, accountId: string, teamId: string): Promise<GetOnedriveTeamCatalogResult> {
  return invokeResult('get_onedrive_team_catalog', { input: { operationId, accountId, teamId } })
}
