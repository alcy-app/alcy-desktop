import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError, VersionStatusDto } from './version-control-types'

/** Creates (or adopts) the git repository in the workspace folder, on `main`. */
export interface LinkWorkspaceInput {
  rootPath: string
  operationId: string
  includeEnvironments: boolean
}

export type LinkWorkspaceResult = CommandResult<VersionStatusDto, VersionControlCommandError>

export function linkWorkspace(input: LinkWorkspaceInput): Promise<LinkWorkspaceResult> {
  return invokeResult('link_workspace', { input })
}
