import { useCallback, useEffect, useRef, useState } from 'react'
import { loadTabSession } from '../../bindings/load-tab-session'
import { saveTabSession } from '../../bindings/save-tab-session'
import { registerBeforeExit } from '../../shared/app-lifecycle/before-exit'
import type { RequestContent, TreeNode } from './collection-tree'
import type { WorkbenchTab } from './request-workbench.types'
import { parseTabSession, resolveTabSession, sessionFromLegacy, snapshotTabSession } from './tab-session'
import type { RestoredTab, TabSession } from './tab-session'
import { clearLegacyTabs, loadLegacyTabs } from './workbench-tabs-storage'
import { parseTabGroups } from './tab-groups'
import type { TabGroup } from './tab-groups'

const EMPTY_GROUPS: TabGroup[] = []
const SAVE_DEBOUNCE_MS = 800

interface UseTabSessionOptions {
  rootPath: string
  groups?: TabGroup[]
  restoreGroups?: (groups: TabGroup[]) => void
  tabs: WorkbenchTab[]
  activeTabId: string | null
  collections: TreeNode[]
  collectionsLoaded: boolean
  contentOf: (tab: WorkbenchTab) => RequestContent
  restoreTabs: (tabs: RestoredTab[], activeTabId: string | null) => void
}

/** Restore after collections load, then debounce snapshots and flush before exit or unmount.
 * No snapshot is saved until restoration finishes, preserving existing drafts on startup. */
export function useTabSession({
  rootPath,
  groups = EMPTY_GROUPS,
  restoreGroups,
  tabs,
  activeTabId,
  collections,
  collectionsLoaded,
  contentOf,
  restoreTabs,
}: UseTabSessionOptions) {
  // Undefined while loading; null when no current or legacy session exists.
  const [session, setSession] = useState<TabSession | null | undefined>(undefined)
  const [restored, setRestored] = useState(false)
  const restoredRef = useRef(false)
  const legacyPendingRef = useRef(false)
  const lastSavedRef = useRef<string | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const latestRef = useRef({ tabs, activeTabId, contentOf, groups })

  useEffect(() => {
    latestRef.current = { tabs, activeTabId, contentOf, groups }
  }, [tabs, activeTabId, contentOf, groups])

  useEffect(() => {
    let cancelled = false
    void loadTabSession(rootPath).then((result) => {
      if (cancelled) return
      if (result.ok && result.value !== null) {
        const parsed = parseTabSession(result.value)
        if (parsed !== null) {
          // Compare against the loaded snapshot to avoid rewriting an unchanged session.
          lastSavedRef.current = JSON.stringify({ version: 1, ...parsed })
        }
        setSession(parsed)
        return
      }
      // Migrate legacy storage when no file exists; unreadable sessions do not block startup.
      const legacy = result.ok ? loadLegacyTabs(rootPath) : null
      legacyPendingRef.current = legacy !== null
      setSession(legacy === null ? null : sessionFromLegacy(legacy))
    })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  useEffect(() => {
    if (restoredRef.current || session === undefined || !collectionsLoaded) return
    restoredRef.current = true
    if (session !== null) {
      const resolved = resolveTabSession(session, collections)
      restoreTabs(resolved, session.activeTabId)
      restoreGroups?.(parseTabGroups(session.groups, new Set(resolved.filter((tab) => !tab.fixed).map((tab) => tab.id))))
    }
    setRestored(true)
  }, [session, collectionsLoaded, collections, restoreTabs, restoreGroups])

  /** Flush only when the current snapshot differs from the last successful save. */
  const flush = useCallback(async () => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    if (!restoredRef.current) return

    const { tabs: currentTabs, activeTabId: currentActiveTabId, contentOf: currentContentOf, groups: currentGroups } = latestRef.current
    const snapshot = snapshotTabSession(currentTabs, currentActiveTabId, currentContentOf, currentGroups)
    const serialized = JSON.stringify(snapshot)
    if (serialized === lastSavedRef.current) return

    lastSavedRef.current = serialized
    const result = await saveTabSession(rootPath, snapshot)
    if (!result.ok) {
      // Retry on the next change or exit flush.
      lastSavedRef.current = null
      return
    }
    if (legacyPendingRef.current) {
      legacyPendingRef.current = false
      clearLegacyTabs(rootPath)
    }
  }, [rootPath])

  useEffect(() => {
    if (!restored) return
    if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = null
      void flush()
    }, SAVE_DEBOUNCE_MS)
  }, [tabs, activeTabId, groups, restored, flush])

  useEffect(() => {
    const unregister = registerBeforeExit(flush)
    return () => {
      unregister()
      void flush()
    }
  }, [flush])

  return { restored }
}
