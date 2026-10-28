import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { FolderPageDto } from './onedrive-types'

export interface ListOnedriveFoldersInput {
  operationId: string
  accountId: string
  driveId: string
  folderId: string
  nextLink?: string | null
}

export type ListOnedriveFoldersResult = CommandResult<FolderPageDto, GitlabCommandError>

export function listOnedriveFolders(input: ListOnedriveFoldersInput): Promise<ListOnedriveFoldersResult> {
  return invokeResult('list_onedrive_folders', { input })
}
