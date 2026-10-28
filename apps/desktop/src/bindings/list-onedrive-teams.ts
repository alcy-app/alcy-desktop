import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { TeamDto } from './onedrive-types'

export type ListOnedriveTeamsResult = CommandResult<TeamDto[], GitlabCommandError>

/** Times do Teams de que a conta participa. */
export function listOnedriveTeams(operationId: string, accountId: string): Promise<ListOnedriveTeamsResult> {
  return invokeResult('list_onedrive_teams', { input: { operationId, accountId } })
}
