import { useCallback, useState } from 'react'
import { createWorkspace } from '../../bindings/create-workspace'
import type { WorkspaceCommandError, WorkspaceDto } from '../../bindings/create-workspace'
import { listRecentWorkspaces } from '../../bindings/list-recent-workspaces'
import type { RecentWorkspaceDto } from '../../bindings/list-recent-workspaces'
import { openWorkspace } from '../../bindings/open-workspace'
import { pickWorkspaceFolder } from '../../bindings/pick-workspace-folder'
import { removeWorkspace } from '../../bindings/remove-workspace'
import { renameWorkspace } from '../../bindings/rename-workspace'
import { FEATURE_FLAGS } from '../../shared/feature-flags'

export type WorkspaceMenuBusyState = 'idle' | 'creating' | 'switching' | 'importing' | 'removing' | 'renaming'

interface UseWorkspaceMenuStateArgs {
  currentWorkspace: WorkspaceDto
  onWorkspaceChange: (workspace: WorkspaceDto) => void
  onExitToStartScreen: () => void
  /** Avisa que um arquivo do workspace atual mudou em disco (o manifesto é versionado). */
  onLocalChange?: () => void
}

export function useWorkspaceMenuState({
  currentWorkspace,
  onWorkspaceChange,
  onExitToStartScreen,
  onLocalChange,
}: UseWorkspaceMenuStateArgs) {
  const [isOpen, setIsOpen] = useState(false)
  const [recents, setRecents] = useState<RecentWorkspaceDto[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<WorkspaceMenuBusyState>('idle')
  const [error, setError] = useState<WorkspaceCommandError | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<RecentWorkspaceDto | null>(null)
  const [renamingRootPath, setRenamingRootPath] = useState<string | null>(null)
  const [importDialogOpen, setImportDialogOpen] = useState(false)

  const refresh = useCallback(async () => {
    const result = await listRecentWorkspaces()
    if (result.ok) setRecents(result.value)
    setLoaded(true)
  }, [])

  const open = useCallback(() => {
    setIsOpen(true)
    setError(null)
    setPendingRemoval(null)
    setRenamingRootPath(null)
    void refresh()
  }, [refresh])

  const close = useCallback(() => {
    setIsOpen(false)
    setPendingRemoval(null)
    setRenamingRootPath(null)
  }, [])

  const switchTo = useCallback(
    async (rootPath: string, busyState: WorkspaceMenuBusyState) => {
      if (rootPath === currentWorkspace.rootPath) {
        close()
        return
      }

      setBusy(busyState)
      setError(null)
      const result = await openWorkspace({ rootPath })
      setBusy('idle')

      if (result.ok) {
        onWorkspaceChange(result.value)
        close()
        return
      }

      if (result.error.kind === 'notAWorkspace') {
        await removeWorkspace({ rootPath, deleteFiles: false })
        void refresh()
      }
      setError(result.error)
    },
    [close, currentWorkspace.rootPath, onWorkspaceChange, refresh],
  )

  const switchToRecent = useCallback((rootPath: string) => switchTo(rootPath, 'switching'), [switchTo])

  const create = useCallback(async () => {
    setBusy('creating')
    setError(null)
    const result = await createWorkspace({ id: crypto.randomUUID() })
    setBusy('idle')

    if (result.ok) {
      onWorkspaceChange(result.value)
      close()
    } else {
      setError(result.error)
    }
  }, [close, onWorkspaceChange])

  const importExisting = useCallback(async () => {
    if (FEATURE_FLAGS.localGit) {
      close()
      setImportDialogOpen(true)
      return
    }
    const rootPath = await pickWorkspaceFolder()
    if (rootPath === null) return
    await switchTo(rootPath, 'importing')
  }, [close, switchTo])

  const closeImportDialog = useCallback(() => setImportDialogOpen(false), [])

  const finishImport = useCallback(
    (workspace: WorkspaceDto) => {
      setImportDialogOpen(false)
      if (workspace.rootPath !== currentWorkspace.rootPath) onWorkspaceChange(workspace)
    },
    [currentWorkspace.rootPath, onWorkspaceChange],
  )

  const startRename = useCallback((rootPath: string) => {
    setError(null)
    setRenamingRootPath(rootPath)
  }, [])

  const cancelRename = useCallback(() => {
    setRenamingRootPath(null)
  }, [])

  /** Nome vazio ou igual ao atual só encerra a edição, sem gravar nada. */
  const commitRename = useCallback(
    async (entry: RecentWorkspaceDto, draft: string) => {
      setRenamingRootPath(null)
      const name = draft.trim()
      if (name === '' || name === entry.name) return

      setBusy('renaming')
      setError(null)
      const result = await renameWorkspace({ rootPath: entry.rootPath, name })
      setBusy('idle')

      if (!result.ok) {
        setError(result.error)
        return
      }

      const renamed = result.value
      setRecents((current) =>
        current.map((recent) => (recent.rootPath === renamed.rootPath ? { ...recent, name: renamed.name } : recent)),
      )

      if (renamed.rootPath === currentWorkspace.rootPath) {
        onWorkspaceChange(renamed)
        onLocalChange?.()
      }
    },
    [currentWorkspace.rootPath, onLocalChange, onWorkspaceChange],
  )

  const requestRemoval = useCallback((entry: RecentWorkspaceDto) => {
    setError(null)
    setPendingRemoval(entry)
  }, [])

  const cancelRemoval = useCallback(() => {
    setPendingRemoval(null)
  }, [])

  const confirmRemoval = useCallback(
    async (deleteFiles: boolean) => {
      if (!pendingRemoval) return

      const removedRootPath = pendingRemoval.rootPath
      const wasCurrent = removedRootPath === currentWorkspace.rootPath

      setBusy('removing')
      setError(null)
      const result = await removeWorkspace({ rootPath: removedRootPath, deleteFiles })
      setBusy('idle')
      setPendingRemoval(null)

      if (!result.ok) {
        setError(result.error)
        return
      }

      setRecents(result.value)

      if (!wasCurrent) return

      const next = result.value[0]
      if (!next) {
        onExitToStartScreen()
        return
      }

      const opened = await openWorkspace({ rootPath: next.rootPath })
      if (opened.ok) {
        onWorkspaceChange(opened.value)
        close()
      } else {
        onExitToStartScreen()
      }
    },
    [close, currentWorkspace.rootPath, onExitToStartScreen, onWorkspaceChange, pendingRemoval],
  )

  return {
    isOpen,
    open,
    close,
    recents,
    loaded,
    busy,
    error,
    pendingRemoval,
    switchToRecent,
    create,
    importExisting,
    importDialogOpen,
    closeImportDialog,
    finishImport,
    renamingRootPath,
    startRename,
    cancelRename,
    commitRename,
    requestRemoval,
    cancelRemoval,
    confirmRemoval,
  }
}
