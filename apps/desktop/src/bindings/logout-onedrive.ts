import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'

export type LogoutOnedriveResult = CommandResult<null, GitlabCommandError>

export function logoutOnedrive(accountId: string): Promise<LogoutOnedriveResult> {
  return invokeResult('logout_onedrive', { input: { accountId } })
}
