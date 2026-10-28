import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, VersionStatusDto } from './gitlab-types'

/** Onde vincular o workspace, por provider. */
export type LinkTarget =
  | { provider: 'gitlab'; accountId: string; projectId: number; projectPath: string; branch: string; directory: string }
  | { provider: 'onedrive'; accountId: string; driveId: string; folderId: string }

export type LinkWorkspaceInput = LinkTarget & {
  rootPath: string
  operationId: string
  includeEnvironments: boolean
}

export type LinkWorkspaceResult = CommandResult<VersionStatusDto, GitlabCommandError>

export function linkWorkspace(input: LinkWorkspaceInput): Promise<LinkWorkspaceResult> {
  return invokeResult('link_workspace', { input })
}
