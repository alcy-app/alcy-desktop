import { invokeResult, type CommandResult } from './invoke-result'
import type { VersionControlCommandError, PullPreviewDto } from './version-control-types'

export type PreviewPullChangesResult = CommandResult<PullPreviewDto, VersionControlCommandError>

/** O que uma atualização traria do remoto, sem escrever nada em disco — usado para revisar antes de aplicar (`pullChanges`). */
export function previewPullChanges(rootPath: string, operationId: string): Promise<PreviewPullChangesResult> {
  return invokeResult('preview_pull_changes', { input: { rootPath, operationId } })
}
