import { invokeResult, type CommandResult } from './invoke-result'
import type { ChangeSelectionDto, GitlabCommandError } from './gitlab-types'

export interface PushResultDto {
  commitId: string
  pushed: string[]
}

export type CommitAndPushResult = CommandResult<PushResultDto, GitlabCommandError>

export function commitAndPush(
  rootPath: string,
  operationId: string,
  message: string,
  selections: ChangeSelectionDto[],
): Promise<CommitAndPushResult> {
  return invokeResult('commit_and_push', { input: { rootPath, operationId, message, selections } })
}
