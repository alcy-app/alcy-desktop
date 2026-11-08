import { invokeResult } from './invoke-result'
import type { VersionControlCommandError, ItemResolutionDto, ResolutionPreviewDto } from './version-control-types'

export function previewConflictResolution(
  rootPath: string,
  operationId: string,
  fileName: string,
  items: ItemResolutionDto[],
  expectedLocalRevision: string | null,
  expectedRemoteRevision: string | null,
  itemId: string,
): Promise<{ ok: true; value: ResolutionPreviewDto } | { ok: false; error: VersionControlCommandError }> {
  return invokeResult('preview_conflict_resolution', {
    input: {
      rootPath,
      operationId,
      fileName,
      items,
      expectedLocalRevision,
      expectedRemoteRevision,
      itemId,
    },
  })
}
