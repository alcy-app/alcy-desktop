import { useCallback, useRef, useState } from 'react'
import { createWorkspace } from '../../bindings/create-workspace'
import type { WorkspaceCommandError, WorkspaceDto } from '../../bindings/create-workspace'
import { getWorkspaceRemovalOptions } from '../../bindings/get-workspace-removal-options'
import type { WorkspaceRemovalOptionsDto } from '../../bindings/get-workspace-removal-options'
import { listRecentWorkspaces } from '../../bindings/list-recent-workspaces'
import type { RecentWorkspaceDto } from '../../bindings/list-recent-workspaces'
import { openWorkspace } from '../../bindings/open-workspace'
import { pickWorkspaceFolder } from '../../bindings/pick-workspace-folder'
import { removeWorkspace } from '../../bindings/remove-workspace'
import { openWorkspaceFolder } from '../../bindings/open-workspace-folder'
import { renameWorkspace } from '../../bindings/rename-workspace'
import { renameWorkspaceFolder } from '../../bindings/rename-workspace-folder'
import { runBeforeExit } from '../../shared/app-lifecycle/before-exit'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { moveCollectionFavorites } from '../request-workbench/use-collection-favorites'
import { folderNameOf } from './workspace-folder'

export type WorkspaceMenuBusyState = 'idle' | 'creating' | 'switching' | 'importing' | 'removing' | 'renaming'

export type WorkspaceRenameTarget = 'alias' | 'folder'

interface PendingRename {
  entry: RecentWorkspaceDto
  /** `null` while still asking what to rename. */
  target: WorkspaceRenameTarget | null
}

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
  /** `null` while still checking who may delete the files. */
  const [removalOptions, setRemovalOptions] = useState<WorkspaceRemovalOptionsDto | null>(null)
  const removalRequestRef = useRef(0)
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null)
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
    setPendingRename(null)
    void refresh()
  }, [refresh])

  const close = useCallback(() => {
    setIsOpen(false)
    setPendingRemoval(null)
    setPendingRename(null)
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

  const openFolder = useCallback(
    async (rootPath: string) => {
      setError(null)
      const result = await openWorkspaceFolder({ rootPath })
      if (result.ok) close()
      else setError(result.error)
    },
    [close],
  )

  const startRename = useCallback((entry: RecentWorkspaceDto) => {
    setError(null)
    setPendingRename({ entry, target: null })
  }, [])

  const chooseRenameTarget = useCallback((target: WorkspaceRenameTarget) => {
    setError(null)
    setPendingRename((current) => (current ? { ...current, target } : current))
  }, [])

  const backToRenameChoice = useCallback(() => {
    setError(null)
    setPendingRename((current) => (current ? { ...current, target: null } : current))
  }, [])

  const cancelRename = useCallback(() => {
    setError(null)
    setPendingRename(null)
  }, [])

  const commitAliasRename = useCallback(
    async (entry: RecentWorkspaceDto, name: string) => {
      const result = await renameWorkspace({ rootPath: entry.rootPath, name })
      if (!result.ok) return result.error

      const renamed = result.value
      setRecents((current) =>
        current.map((recent) => (recent.rootPath === renamed.rootPath ? { ...recent, name: renamed.name } : recent)),
      )
      if (renamed.rootPath === currentWorkspace.rootPath) {
        onWorkspaceChange(renamed)
        onLocalChange?.()
      }
      return null
    },
    [currentWorkspace.rootPath, onLocalChange, onWorkspaceChange],
  )

  const commitFolderRename = useCallback(
    async (entry: RecentWorkspaceDto, folderName: string) => {
      const isCurrent = entry.rootPath === currentWorkspace.rootPath
      // Edits waiting to be saved would otherwise land on the old path.
      if (isCurrent) await runBeforeExit()

      const result = await renameWorkspaceFolder({ rootPath: entry.rootPath, folderName })
      if (!result.ok) return result.error

      const renamed = result.value
      moveCollectionFavorites(entry.rootPath, renamed.rootPath)
      setRecents((current) =>
        current.map((recent) => (recent.rootPath === entry.rootPath ? { ...recent, rootPath: renamed.rootPath } : recent)),
      )
      if (isCurrent) onWorkspaceChange(renamed)
      return null
    },
    [currentWorkspace.rootPath, onWorkspaceChange],
  )

  /** A blank or unchanged name just leaves the panel; a failure keeps it open with the draft. */
  const commitRename = useCallback(
    async (draft: string) => {
      if (!pendingRename?.target) return
      const { entry, target } = pendingRename
      const name = draft.trim()
      if (name === '' || name === (target === 'alias' ? entry.name : folderNameOf(entry.rootPath))) {
        setPendingRename(null)
        return
      }

      setBusy('renaming')
      setError(null)
      const failure = await (target === 'alias' ? commitAliasRename(entry, name) : commitFolderRename(entry, name))
      setBusy('idle')

      if (failure) setError(failure)
      else setPendingRename(null)
    },
    [commitAliasRename, commitFolderRename, pendingRename],
  )

  const requestRemoval = useCallback(async (entry: RecentWorkspaceDto) => {
    const request = ++removalRequestRef.current
    setError(null)
    setPendingRemoval(entry)
    setRemovalOptions(null)
    const result = await getWorkspaceRemovalOptions({ rootPath: entry.rootPath })
    if (request !== removalRequestRef.current) return
    // A repository that cannot be read (mid-sync, say) keeps its files.
    setRemovalOptions(result.ok ? result.value : { canDeleteFiles: false, ownerName: null })
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
    removalOptions,
    switchToRecent,
    create,
    importExisting,
    importDialogOpen,
    closeImportDialog,
    finishImport,
    openFolder,
    pendingRename,
    startRename,
    chooseRenameTarget,
    backToRenameChoice,
    cancelRename,
    commitRename,
    requestRemoval,
    cancelRemoval,
    confirmRemoval,
  }
}
