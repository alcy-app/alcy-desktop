import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, VersionStatusDto } from './gitlab-types'

export interface LinkWorkspaceInput {
  rootPath: string
  operationId: string
  accountId: string
  projectId: number
  projectPath: string
  branch: string
  directory: string
  includeEnvironments: boolean
}

export type LinkWorkspaceResult = CommandResult<VersionStatusDto, GitlabCommandError>

export function linkWorkspace(input: LinkWorkspaceInput): Promise<LinkWorkspaceResult> {
  return invokeResult('link_workspace', { input })
}
