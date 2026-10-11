import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabAccountDto, GitlabCommandError } from './gitlab-types'

export type ListGitlabAccountsResult = CommandResult<GitlabAccountDto[], GitlabCommandError>

export function listGitlabAccounts(): Promise<ListGitlabAccountsResult> {
  return invokeResult('list_gitlab_accounts')
}
