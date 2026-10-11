import { useCallback, useEffect, useState } from 'react'
import { getCollectionRunHistory } from '../../bindings/get-collection-run-history'
import type { CollectionRunDetailDto } from '../../bindings/get-collection-run-history'
import { getFlowRunHistory } from '../../bindings/get-flow-run-history'
import type { FlowRunDetailDto } from '../../bindings/get-flow-run-history'
import { getHistoryEntry } from '../../bindings/get-history-entry'
import { getLoadRunHistory } from '../../bindings/get-load-run-history'
import type { LoadRunDetailDto } from '../../bindings/get-load-run-history'
import { listHistory } from '../../bindings/list-history'
import type { HistoryEntrySummaryDto } from '../../bindings/list-history'
import { historyDetailToContent, historyDetailToExecutionState } from './history'
import type { RequestContent } from './collection-tree'
import type { ExecutionState } from './request-workbench.types'

export type RestoreHistoryEntryResult =
  | {
      ok: true
      content: RequestContent
      execution: ExecutionState
      /** Tamanho original do corpo quando o histórico guardou só o início dele; `null` quando está inteiro. */
      truncatedBodyTotalBytes: number | null
    }
  | { ok: false }

export function useHistoryState(workspaceRootPath: string) {
  const [entries, setEntries] = useState<HistoryEntrySummaryDto[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const result = await listHistory(workspaceRootPath)
    if (result.ok) setEntries(result.value)
    setLoaded(true)
  }, [workspaceRootPath])

  useEffect(() => {
    let cancelled = false

    void listHistory(workspaceRootPath).then((result) => {
      if (cancelled) return
      if (result.ok) setEntries(result.value)
      setLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [workspaceRootPath])

  const restore = useCallback(
    async (id: string): Promise<RestoreHistoryEntryResult> => {
      const result = await getHistoryEntry(workspaceRootPath, id)
      if (!result.ok) return { ok: false }

      const { outcome } = result.value
      return {
        ok: true,
        content: historyDetailToContent(result.value),
        execution: historyDetailToExecutionState(result.value),
        truncatedBodyTotalBytes: outcome.type === 'success' && outcome.bodyTruncated ? outcome.sizeBytes : null,
      }
    },
    [workspaceRootPath],
  )

  const loadFlowRun = useCallback(
    async (id: string): Promise<FlowRunDetailDto | null> => {
      const result = await getFlowRunHistory(workspaceRootPath, id)
      return result.ok ? result.value : null
    },
    [workspaceRootPath],
  )

  const loadCollectionRun = useCallback(
    async (id: string): Promise<CollectionRunDetailDto | null> => {
      const result = await getCollectionRunHistory(workspaceRootPath, id)
      return result.ok ? result.value : null
    },
    [workspaceRootPath],
  )

  const loadLoadRun = useCallback(
    async (id: string): Promise<LoadRunDetailDto | null> => {
      const result = await getLoadRunHistory(workspaceRootPath, id)
      return result.ok ? result.value : null
    },
    [workspaceRootPath],
  )

  return { entries, loaded, refresh, restore, loadFlowRun, loadCollectionRun, loadLoadRun }
}
