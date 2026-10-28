import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { OnedriveAccountDto } from './onedrive-types'

export type ListOnedriveAccountsResult = CommandResult<OnedriveAccountDto[], GitlabCommandError>

export function listOnedriveAccounts(): Promise<ListOnedriveAccountsResult> {
  return invokeResult('list_onedrive_accounts')
}
