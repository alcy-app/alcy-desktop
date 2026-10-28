import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { DriveFolderDto } from './onedrive-types'

export type GetOnedriveRootResult = CommandResult<DriveFolderDto, GitlabCommandError>

/** Raiz do OneDrive da própria conta, onde a navegação de pastas começa. */
export function getOnedriveRoot(operationId: string, accountId: string): Promise<GetOnedriveRootResult> {
  return invokeResult('get_onedrive_root', { input: { operationId, accountId } })
}
