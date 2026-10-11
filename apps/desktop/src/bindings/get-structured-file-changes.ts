import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, StructuredFileChangesDto } from './gitlab-types'

const PAGE_SIZE = 200

export async function getStructuredFileChanges(
  rootPath: string,
  operationId: string,
  fileName: string,
  expectedRemoteRevision?: string | null,
  expectedLocalRevision?: string | null,
): Promise<CommandResult<StructuredFileChangesDto, GitlabCommandError>> {
  const items: StructuredFileChangesDto['items'] = []
  let offset = 0
  let localRevision = expectedLocalRevision
  let remoteRevision = expectedRemoteRevision

  while (true) {
    const result = await invokeResult<StructuredFileChangesDto, GitlabCommandError>(
      'get_structured_file_changes',
      {
        input: {
          rootPath,
          operationId,
          fileName,
          expectedLocalRevision: localRevision,
          expectedRemoteRevision: remoteRevision,
          offset,
          limit: PAGE_SIZE,
        },
      },
    )
    if (!result.ok) return result
    items.push(...result.value.items)
    localRevision = result.value.localRevision
    remoteRevision = result.value.remoteRevision
    if (result.value.nextOffset == null) {
      return {
        ok: true,
        value: {
          ...result.value,
          totalItems: result.value.totalItems ?? items.length,
          nextOffset: null,
          items,
        },
      }
    }
    offset = result.value.nextOffset
  }
}
