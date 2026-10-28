import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { DriveFolderDto } from './onedrive-types'

export type ResolveOnedriveShareLinkResult = CommandResult<DriveFolderDto, GitlabCommandError>

/** Pasta por trás de um link de compartilhamento (pastas de outras pessoas, SharePoint e Teams). */
export function resolveOnedriveShareLink(operationId: string, accountId: string, link: string): Promise<ResolveOnedriveShareLinkResult> {
  return invokeResult('resolve_onedrive_share_link', { input: { operationId, accountId, link } })
}
