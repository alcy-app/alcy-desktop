import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'

export type LogoutGitlabResult = CommandResult<null, GitlabCommandError>

export function logoutGitlab(accountId: string): Promise<LogoutGitlabResult> {
  return invokeResult('logout_gitlab', { input: { accountId } })
}
