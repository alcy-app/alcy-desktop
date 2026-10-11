import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, GitlabProjectDto, PageDto } from './gitlab-types'

export interface ListGitlabProjectsInput {
  accountId: string
  search?: string
  page?: number
}

export type ListGitlabProjectsResult = CommandResult<PageDto<GitlabProjectDto>, GitlabCommandError>

export function listGitlabProjects(input: ListGitlabProjectsInput): Promise<ListGitlabProjectsResult> {
  return invokeResult('list_gitlab_projects', { input })
}
