import { useCallback, useEffect, useState } from 'react'
import { createWorkspace } from '../../bindings/create-workspace'
import type { WorkspaceCommandError, WorkspaceDto } from '../../bindings/create-workspace'
import { listRecentWorkspaces } from '../../bindings/list-recent-workspaces'
import type { RecentWorkspaceDto } from '../../bindings/list-recent-workspaces'
import { openWorkspace } from '../../bindings/open-workspace'
import { pickWorkspaceFolder } from '../../bindings/pick-workspace-folder'

export type StartScreenBusyState = 'idle' | 'creating' | 'opening'

export function useStartScreenState(onWorkspaceReady: (workspace: WorkspaceDto) => void) {
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceDto[]>([])
  const [busy, setBusy] = useState<StartScreenBusyState>('idle')
  const [error, setError] = useState<WorkspaceCommandError | null>(null)

  useEffect(() => {
    let cancelled = false

    void listRecentWorkspaces().then((result) => {
      if (cancelled) return
      if (result.ok) setRecentWorkspaces(result.value)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const openByPath = useCallback(
    async (rootPath: string) => {
      setBusy('opening')
      setError(null)
      const result = await openWorkspace({ rootPath })
      setBusy('idle')

      if (result.ok) {
        onWorkspaceReady(result.value)
      } else {
        setError(result.error)
      }
    },
    [onWorkspaceReady],
  )

  const create = useCallback(async () => {
    setBusy('creating')
    setError(null)
    const result = await createWorkspace({ id: crypto.randomUUID() })
    setBusy('idle')

    if (result.ok) {
      onWorkspaceReady(result.value)
    } else {
      setError(result.error)
    }
  }, [onWorkspaceReady])

  const openPicked = useCallback(async () => {
    const rootPath = await pickWorkspaceFolder()
    if (rootPath === null) return
    await openByPath(rootPath)
  }, [openByPath])

  return {
    recentWorkspaces,
    busy,
    error,
    create,
    openPicked,
    openRecent: openByPath,
  }
}
