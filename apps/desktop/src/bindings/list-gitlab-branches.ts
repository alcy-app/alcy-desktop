import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabBranchDto, GitlabCommandError, PageDto } from './gitlab-types'

export interface ListGitlabBranchesInput {
  accountId: string
  projectId: number
  search?: string
  page?: number
}

export type ListGitlabBranchesResult = CommandResult<PageDto<GitlabBranchDto>, GitlabCommandError>

export function listGitlabBranches(input: ListGitlabBranchesInput): Promise<ListGitlabBranchesResult> {
  return invokeResult('list_gitlab_branches', { input })
}
