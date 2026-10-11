import { invokeResult, type CommandResult } from './invoke-result'
import type { FileDiffDto, GitlabCommandError } from './gitlab-types'

export type GetFileDiffResult = CommandResult<FileDiffDto, GitlabCommandError>

/** Diff entre a versão remota (esquerda) e a local (direita); só os trechos alterados cruzam o IPC. */
export function getFileDiff(
  rootPath: string,
  operationId: string,
  fileName: string,
  expectedRemoteRevision?: string | null,
): Promise<GetFileDiffResult> {
  return invokeResult('get_file_diff', { input: { rootPath, operationId, fileName, expectedRemoteRevision } })
}
