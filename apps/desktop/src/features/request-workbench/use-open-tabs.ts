import { useCallback, useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import type { FlowRunDetailDto } from '../../bindings/get-flow-run-history'
import type { RunnerTab } from '../collection-runner/CollectionRunner'
import type { DropEdge } from '../../shared/use-pointer-drag'
import type { FlowState } from '../flows/flows.types'
import type { AppNotification } from '../notifications/notifications.types'
import { isTabDirty } from './use-workbench-state'
import type { WorkbenchTab } from './request-workbench.types'

export interface OpenTabDescriptor {
  id: string
  kind: 'request' | 'flow' | 'runLog' | 'runner' | 'notification' | 'mockServer'
  label: string
  dirty: boolean
  preview: boolean
  /** Fixed tabs appear before movable tabs. */
  fixed: boolean
  /** False for tabs that cannot be fixed, such as review or conflict tabs. */
  fixable?: boolean
  /** Protocol or method badge shown before request tab names. */
  request?: Pick<WorkbenchTab, 'protocol' | 'method'>
}

export type ActiveOpenTab =
  | { kind: 'request'; id: string }
  | { kind: 'flow'; id: string }
  | { kind: 'runLog'; id: string }
  | { kind: 'runner'; id: string }
  | { kind: 'notification'; id: string }
  | { kind: 'mockServer'; id: string }
  | null

/** Read-only snapshot of a historical flow run. */
export interface RunLogTab {
  id: string
  label: string
  detail: FlowRunDetailDto
  pinned: boolean
}

/** Read-only notification details rendered as Markdown. */
export interface NotificationTab {
  id: string
  notification: AppNotification
}

export interface MockServerTab {
  id: string
  serverId: string
  label: string
  dirty: boolean
  /** Inline mock owned by a Start mock block; Save writes to its flow (spec 0121). */
  flowNodeRef?: { flowId: string; nodeId: string }
}

interface WorkbenchTabsSlice {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  selectTab: (id: string) => void
  pinTab: (id: string) => void
  closePreviewTab: () => void
  closeTab: (id: string) => void
  closeAllTabs: () => void
  closeOtherTabs: (id: string) => void
  closeTabsWhere: (shouldClose: (tabId: string) => boolean) => void
  toggleFixTab: (id: string) => void
  reorderTabs: (draggedId: string, targetId: string, edge: DropEdge) => void
  reorderTabsGroup: (ids: readonly string[], targetId: string, edge: DropEdge) => void
}

interface FlowsSlice {
  flows: FlowState[]
}

/** Combine workbench request tabs and session-only flow tabs in a single bar.
 * Flow contents are persisted separately by useFlowsState. */
export function useOpenTabs(workbench: WorkbenchTabsSlice, flows: FlowsSlice) {
  const { language, t } = useLanguage()
  const [openFlowIds, setOpenFlowIds] = useState<string[]>([])
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null)
  const [runLogTabs, setRunLogTabs] = useState<RunLogTab[]>([])
  const [activeRunLogId, setActiveRunLogId] = useState<string | null>(null)
  // Collection runner tabs are session-only, like flow tabs (spec 0073).
  const [runnerTabs, setRunnerTabs] = useState<RunnerTab[]>([])
  const [activeRunnerId, setActiveRunnerId] = useState<string | null>(null)
  // Notification details are session-only, like runner tabs.
  const [notificationTabs, setNotificationTabs] = useState<NotificationTab[]>([])
  const [activeNotificationId, setActiveNotificationId] = useState<string | null>(null)
  const [mockServerTabs, setMockServerTabs] = useState<MockServerTab[]>([])
  const [activeMockServerId, setActiveMockServerId] = useState<string | null>(null)
  // Fixed non-request tabs remain session-only; request tabs persist their fixed state in the workbench.
  const [fixedOtherIds, setFixedOtherIds] = useState<string[]>([])
  // Callbacks passed to memoized components use stable methods and read current request tabs through a ref.
  const {
    selectTab,
    pinTab,
    closePreviewTab,
    closeTab,
    closeAllTabs,
    closeOtherTabs,
    closeTabsWhere,
    toggleFixTab,
    reorderTabs,
    reorderTabsGroup,
  } = workbench
  const requestTabsRef = useRef(workbench.tabs)
  useEffect(() => {
    requestTabsRef.current = workbench.tabs
  }, [workbench.tabs])

  const activeOpenTab: ActiveOpenTab =
    activeMockServerId !== null
      ? { kind: 'mockServer', id: activeMockServerId }
      : activeNotificationId !== null
      ? { kind: 'notification', id: activeNotificationId }
      : activeRunnerId !== null
      ? { kind: 'runner', id: activeRunnerId }
      : activeRunLogId !== null
      ? { kind: 'runLog', id: activeRunLogId }
      : activeFlowId !== null
        ? { kind: 'flow', id: activeFlowId }
        : workbench.activeTabId !== null
        ? { kind: 'request', id: workbench.activeTabId }
        : null

  const unsortedDescriptors: OpenTabDescriptor[] = [
    ...workbench.tabs.map((tab) => ({
      id: tab.id,
      kind: 'request' as const,
      label: tab.name || t('workbench.openTabs.untitled'),
      dirty: isTabDirty(tab),
      preview: !tab.pinned,
      fixed: tab.fixed === true,
      request: { protocol: tab.protocol, method: tab.method },
    })),
    ...openFlowIds.map((id) => ({
      id,
      kind: 'flow' as const,
      label: flows.flows.find((flow) => flow.id === id)?.name || t('common.unnamed'),
      dirty: false,
      preview: false,
      fixed: fixedOtherIds.includes(id),
    })),
    ...runLogTabs.map((tab) => ({
      id: tab.id,
      kind: 'runLog' as const,
      label: tab.label,
      dirty: false,
      preview: !tab.pinned,
      fixed: fixedOtherIds.includes(tab.id),
    })),
    ...runnerTabs.map((tab) => ({
      id: tab.id,
      kind: 'runner' as const,
      label: tab.label,
      dirty: false,
      preview: false,
      fixed: fixedOtherIds.includes(tab.id),
    })),
    ...notificationTabs.map((tab) => ({
      id: tab.id,
      kind: 'notification' as const,
      label: tab.notification.title[language],
      dirty: false,
      preview: false,
      fixed: fixedOtherIds.includes(tab.id),
    })),
    ...mockServerTabs.map((tab) => ({
      id: tab.id,
      kind: 'mockServer' as const,
      label: tab.label,
      dirty: tab.dirty,
      preview: false,
      fixed: fixedOtherIds.includes(tab.id),
    })),
  ]
  // Fixed tabs come first; stable sorting preserves opening or drag order within each group.
  const descriptors = [...unsortedDescriptors].sort((a, b) => Number(b.fixed) - Number(a.fixed))
  const activeOpenTabId = activeOpenTab?.id ?? null
  // Closing callbacks read the current order without depending on every request edit.
  const descriptorsRef = useRef(descriptors)
  useEffect(() => {
    descriptorsRef.current = descriptors
  })

  const openFlow = useCallback((id: string) => {
    setOpenFlowIds((current) => (current.includes(id) ? current : [...current, id]))
    setActiveFlowId(id)
    setActiveRunLogId(null)
    setActiveRunnerId(null)
    setActiveNotificationId(null)
    setActiveMockServerId(null)
  }, [])

  const openMockServer = useCallback((serverId: string, label: string) => {
    const id = `mock-server:${serverId}`
    setMockServerTabs((current) =>
      current.some((tab) => tab.id === id) ? current : [...current, { id, serverId, label, dirty: false }],
    )
    setActiveMockServerId(id)
    setActiveFlowId(null)
    setActiveRunLogId(null)
    setActiveRunnerId(null)
    setActiveNotificationId(null)
  }, [])

  /** Open or activate the inline mock tab belonging to a Start mock block. */
  const openInlineMockServer = useCallback((flowId: string, nodeId: string, label: string) => {
    const id = mockServerTabs.find((tab) => tab.flowNodeRef?.flowId === flowId && tab.flowNodeRef.nodeId === nodeId)?.id ?? `mock-server:flow:${flowId}:${nodeId}`
    setMockServerTabs((current) =>
      current.some((tab) => tab.id === id) ? current : [...current, { id, serverId: id, label, dirty: false, flowNodeRef: { flowId, nodeId } }],
    )
    setActiveMockServerId(id)
    setActiveFlowId(null)
    setActiveRunLogId(null)
    setActiveRunnerId(null)
    setActiveNotificationId(null)
  }, [mockServerTabs])

  /** Preserve an inline mock tab and its local edits after its graph node is renamed. */
  const renameFlowNode = useCallback((flowId: string, previous: string, next: string) => {
    setMockServerTabs((current) => current.map((tab) => tab.flowNodeRef?.flowId === flowId && tab.flowNodeRef.nodeId === previous ? { ...tab, flowNodeRef: { flowId, nodeId: next } } : tab))
  }, [])

  const updateMockServerTab = useCallback((serverId: string, patch: Partial<Pick<MockServerTab, 'label' | 'dirty'>>) => {
    setMockServerTabs((current) => current.map((tab) => (tab.serverId === serverId ? { ...tab, ...patch } : tab)))
  }, [])

  /** Open or activate a runner tab. */
  const openRunner = useCallback((tab: RunnerTab) => {
    setRunnerTabs((current) => (current.some((candidate) => candidate.id === tab.id) ? current : [...current, tab]))
    setActiveRunnerId(tab.id)
    setActiveNotificationId(null)
    setActiveMockServerId(null)
  }, [])

  /** Open or activate a notification details tab. */
  const openNotification = useCallback((notification: AppNotification) => {
    const id = `notification:${notification.id}`
    setNotificationTabs((current) =>
      current.some((candidate) => candidate.id === id) ? current : [...current, { id, notification }],
    )
    setActiveNotificationId(id)
    setActiveMockServerId(null)
  }, [])

  const openRunLog = useCallback(
    (tab: Omit<RunLogTab, 'pinned'>) => {
      if (!runLogTabs.some((candidate) => candidate.id === tab.id)) closePreviewTab()
      setRunLogTabs((current) => {
        if (current.some((candidate) => candidate.id === tab.id)) return current
        const nextTab = { ...tab, pinned: false }
        const previewIndex = current.findIndex((candidate) => !candidate.pinned)
        if (previewIndex === -1) return [...current, nextTab]
        const next = [...current]
        next[previewIndex] = nextTab
        return next
      })
      setActiveRunLogId(tab.id)
      setActiveRunnerId(null)
      setActiveNotificationId(null)
      setActiveMockServerId(null)
    },
    [runLogTabs, closePreviewTab],
  )

  const closeRunLogPreview = useCallback(() => {
    setRunLogTabs((current) => current.filter((tab) => tab.pinned))
    setActiveRunLogId(null)
    setActiveFlowId(null)
    setActiveRunnerId(null)
    setActiveNotificationId(null)
  }, [])

  const pinOpenTab = useCallback(
    (id: string) => {
      if (runLogTabs.some((tab) => tab.id === id)) {
        setRunLogTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, pinned: true } : tab)))
        return
      }
      pinTab(id)
    },
    [runLogTabs, pinTab],
  )

  const selectOpenTab = useCallback(
    (id: string) => {
      if (mockServerTabs.some((tab) => tab.id === id)) {
        setActiveMockServerId(id)
        setActiveNotificationId(null)
        setActiveRunnerId(null)
        setActiveRunLogId(null)
        setActiveFlowId(null)
        return
      }
      setActiveMockServerId(null)
      if (notificationTabs.some((tab) => tab.id === id)) {
        setActiveNotificationId(id)
        return
      }
      setActiveNotificationId(null)
      if (runnerTabs.some((tab) => tab.id === id)) {
        setActiveRunnerId(id)
        return
      }
      setActiveRunnerId(null)
      if (runLogTabs.some((tab) => tab.id === id)) {
        setActiveRunLogId(id)
      } else if (openFlowIds.includes(id)) {
        setActiveRunLogId(null)
        setActiveFlowId(id)
      } else {
        setActiveRunLogId(null)
        setActiveFlowId(null)
        selectTab(id)
      }
    },
    [mockServerTabs, notificationTabs, openFlowIds, runLogTabs, runnerTabs, selectTab],
  )

  /** Return inline request tabs to their open flow. When no request tab remains,
   * activate another open view instead of falling back to an empty request editor. */
  const activateAfterClosingRequest = useCallback(
    (id: string) => {
      const originFlowId = requestTabsRef.current.find((tab) => tab.id === id)?.flowNodeRef?.flowId
      if (originFlowId && openFlowIds.includes(originFlowId)) {
        setActiveFlowId(originFlowId)
        return
      }
      if (requestTabsRef.current.some((tab) => tab.id !== id)) return
      const lastFlowId = openFlowIds.at(-1)
      const lastRunLog = runLogTabs.at(-1)
      const lastRunner = runnerTabs.at(-1)
      const lastNotification = notificationTabs.at(-1)
      const lastMockServer = mockServerTabs.at(-1)
      if (lastMockServer) setActiveMockServerId(lastMockServer.id)
      else if (lastFlowId) setActiveFlowId(lastFlowId)
      else if (lastRunLog) setActiveRunLogId(lastRunLog.id)
      else if (lastRunner) setActiveRunnerId(lastRunner.id)
      else if (lastNotification) setActiveNotificationId(lastNotification.id)
    },
    [mockServerTabs, notificationTabs, openFlowIds, runLogTabs, runnerTabs],
  )

  /** Clear a closed tab's active state and activate its right or left neighbor. */
  const releaseClosedTab = useCallback(
    (id: string, clearActive: (update: (currentActive: string | null) => string | null) => void) => {
      clearActive((currentActive) => (currentActive === id ? null : currentActive))
      if (activeOpenTabId !== id) return
      const tabs = descriptorsRef.current
      const index = tabs.findIndex((tab) => tab.id === id)
      const neighbor = tabs[index + 1] ?? tabs[index - 1]
      if (neighbor) selectOpenTab(neighbor.id)
    },
    [activeOpenTabId, selectOpenTab],
  )

  const closeOpenTab = useCallback(
    (id: string) => {
      setFixedOtherIds((current) => (current.includes(id) ? current.filter((fixedId) => fixedId !== id) : current))
      if (mockServerTabs.some((tab) => tab.id === id)) {
        setMockServerTabs((current) => current.filter((tab) => tab.id !== id))
        releaseClosedTab(id, setActiveMockServerId)
      } else if (notificationTabs.some((tab) => tab.id === id)) {
        setNotificationTabs((current) => current.filter((tab) => tab.id !== id))
        releaseClosedTab(id, setActiveNotificationId)
      } else if (runnerTabs.some((tab) => tab.id === id)) {
        setRunnerTabs((current) => current.filter((tab) => tab.id !== id))
        releaseClosedTab(id, setActiveRunnerId)
      } else if (runLogTabs.some((tab) => tab.id === id)) {
        setRunLogTabs((current) => current.filter((tab) => tab.id !== id))
        releaseClosedTab(id, setActiveRunLogId)
      } else if (openFlowIds.includes(id)) {
        setOpenFlowIds((current) => {
          const remaining = current.filter((flowId) => flowId !== id)
          setActiveFlowId((currentActive) =>
            currentActive === id ? (remaining[remaining.length - 1] ?? null) : currentActive,
          )
          return remaining
        })
      } else {
        const requestIsActive =
          activeNotificationId === null &&
          activeMockServerId === null &&
          activeRunnerId === null &&
          activeRunLogId === null &&
          activeFlowId === null &&
          workbench.activeTabId === id
        if (requestIsActive) activateAfterClosingRequest(id)
        closeTab(id)
      }
    },
    [
      activateAfterClosingRequest,
      releaseClosedTab,
      activeFlowId,
      activeMockServerId,
      activeNotificationId,
      activeRunLogId,
      activeRunnerId,
      notificationTabs,
      mockServerTabs,
      openFlowIds,
      runLogTabs,
      runnerTabs,
      workbench.activeTabId,
      closeTab,
    ],
  )

  const toggleFixOpenTab = useCallback(
    (id: string) => {
      const isOther =
        openFlowIds.includes(id) ||
        runLogTabs.some((tab) => tab.id === id) ||
        runnerTabs.some((tab) => tab.id === id) ||
        notificationTabs.some((tab) => tab.id === id)
        || mockServerTabs.some((tab) => tab.id === id)
      if (!isOther) {
        toggleFixTab(id)
        return
      }
      setFixedOtherIds((current) => (current.includes(id) ? current.filter((fixedId) => fixedId !== id) : [...current, id]))
      // Fixing a tab promotes it from preview, like double-clicking.
      setRunLogTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, pinned: true } : tab)))
    },
    [mockServerTabs, notificationTabs, openFlowIds, runLogTabs, runnerTabs, toggleFixTab],
  )

  /** Close matching tabs and activate the first remaining view when needed. */
  const closeOpenTabsWhere = useCallback(
    (shouldClose: (id: string) => boolean) => {
      const keep = (id: string) => !shouldClose(id)
      const flowIds = openFlowIds.filter(keep)
      const runLogs = runLogTabs.filter((tab) => keep(tab.id))
      const runners = runnerTabs.filter((tab) => keep(tab.id))
      const notifications = notificationTabs.filter((tab) => keep(tab.id))
      const mockServers = mockServerTabs.filter((tab) => keep(tab.id))
      setOpenFlowIds(flowIds)
      setRunLogTabs(runLogs)
      setRunnerTabs(runners)
      setNotificationTabs(notifications)
      setMockServerTabs(mockServers)
      setFixedOtherIds((current) => current.filter(keep))
      const stillActive = (activeId: string | null) => (activeId !== null && keep(activeId) ? activeId : null)
      const nextNotification = stillActive(activeNotificationId)
      const nextMockServer = stillActive(activeMockServerId)
      const nextRunner = stillActive(activeRunnerId)
      const nextRunLog = stillActive(activeRunLogId)
      const nextFlow = stillActive(activeFlowId)
      setActiveNotificationId(nextNotification)
      setActiveMockServerId(nextMockServer)
      setActiveRunnerId(nextRunner)
      setActiveRunLogId(nextRunLog)
      setActiveFlowId(nextFlow)
      closeTabsWhere(shouldClose)
      const anyActive = nextMockServer ?? nextNotification ?? nextRunner ?? nextRunLog ?? nextFlow
      if (anyActive === null && !requestTabsRef.current.some((tab) => keep(tab.id))) {
        const lastFlowId = flowIds.at(-1)
        const lastRunLog = runLogs.at(-1)
        const lastRunner = runners.at(-1)
        const lastNotification = notifications.at(-1)
        const lastMockServer = mockServers.at(-1)
        if (lastMockServer) setActiveMockServerId(lastMockServer.id)
        else if (lastFlowId) setActiveFlowId(lastFlowId)
        else if (lastRunLog) setActiveRunLogId(lastRunLog.id)
        else if (lastRunner) setActiveRunnerId(lastRunner.id)
        else if (lastNotification) setActiveNotificationId(lastNotification.id)
      }
    },
    [
      activeFlowId,
      activeMockServerId,
      activeNotificationId,
      activeRunLogId,
      activeRunnerId,
      notificationTabs,
      mockServerTabs,
      openFlowIds,
      runLogTabs,
      runnerTabs,
      closeTabsWhere,
    ],
  )

  const closeUnfixedOpenTabs = useCallback(
    () => closeOpenTabsWhere((id) => !descriptors.some((tab) => tab.id === id && tab.fixed)),
    [closeOpenTabsWhere, descriptors],
  )

  const closeOpenTabs = useCallback(
    (ids: readonly string[]) => closeOpenTabsWhere((id) => ids.includes(id)),
    [closeOpenTabsWhere],
  )

  const closeAllOpenTabs = useCallback(() => {
    setFixedOtherIds([])
    setOpenFlowIds([])
    setActiveFlowId(null)
    setRunLogTabs([])
    setActiveRunLogId(null)
    setRunnerTabs([])
    setActiveRunnerId(null)
    setNotificationTabs([])
    setActiveNotificationId(null)
    setMockServerTabs([])
    setActiveMockServerId(null)
    closeAllTabs()
  }, [closeAllTabs])

  const closeOtherOpenTabs = useCallback(
    (id: string) => {
      const keepsNotification = notificationTabs.find((tab) => tab.id === id)
      setNotificationTabs(keepsNotification ? [keepsNotification] : [])
      setActiveNotificationId(keepsNotification ? id : null)
      const keepsMockServer = mockServerTabs.find((tab) => tab.id === id)
      setMockServerTabs(keepsMockServer ? [keepsMockServer] : [])
      setActiveMockServerId(keepsMockServer ? id : null)
      const keepsRunner = runnerTabs.find((tab) => tab.id === id)
      setRunnerTabs(keepsRunner ? [keepsRunner] : [])
      setActiveRunnerId(keepsRunner ? id : null)
      const keepsRunLog = runLogTabs.find((tab) => tab.id === id)
      setRunLogTabs(keepsRunLog ? [keepsRunLog] : [])
      setActiveRunLogId(keepsRunLog ? id : null)
      setFixedOtherIds((current) => current.filter((fixedId) => fixedId === id))
      if (keepsNotification || keepsMockServer || keepsRunner || keepsRunLog) {
        setOpenFlowIds([])
        setActiveFlowId(null)
        closeAllTabs()
      } else if (openFlowIds.includes(id)) {
        setOpenFlowIds([id])
        setActiveFlowId(id)
        closeAllTabs()
      } else {
        setOpenFlowIds([])
        setActiveFlowId(null)
        closeOtherTabs(id)
      }
    },
    [mockServerTabs, notificationTabs, openFlowIds, runLogTabs, runnerTabs, closeAllTabs, closeOtherTabs],
  )

  /** Reorder within request or flow groups; dragging between groups does nothing (spec 0042). */
  const reorderOpenTabs = useCallback(
    (draggedId: string, targetId: string, edge: DropEdge) => {
      if (runLogTabs.some((tab) => tab.id === draggedId || tab.id === targetId)) return
      if (runnerTabs.some((tab) => tab.id === draggedId || tab.id === targetId)) return
      if (notificationTabs.some((tab) => tab.id === draggedId || tab.id === targetId)) return
      if (mockServerTabs.some((tab) => tab.id === draggedId || tab.id === targetId)) return

      const draggedIsFlow = openFlowIds.includes(draggedId)
      const targetIsFlow = openFlowIds.includes(targetId)
      if (draggedIsFlow !== targetIsFlow) return

      if (draggedIsFlow) {
        setOpenFlowIds((current) => {
          const fromIndex = current.indexOf(draggedId)
          const toIndex = current.indexOf(targetId)
          if (fromIndex === -1 || toIndex === -1) return current
          const next = [...current]
          next.splice(fromIndex, 1)
          const adjustedTargetIndex = next.indexOf(targetId)
          const insertIndex = edge === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex
          next.splice(insertIndex, 0, draggedId)
          return next
        })
        return
      }

      reorderTabs(draggedId, targetId, edge)
    },
    [mockServerTabs, notificationTabs, openFlowIds, runLogTabs, runnerTabs, reorderTabs],
  )

  /** Move multiple tabs within the target's type and fixed or movable group. */
  const reorderOpenTabsGroup = useCallback(
    (ids: readonly string[], targetId: string, edge: DropEdge) => {
      const target = descriptors.find((tab) => tab.id === targetId)
      if (!target || (target.kind !== 'request' && target.kind !== 'flow')) return
      const movable = ids.filter((id) => {
        const tab = descriptors.find((candidate) => candidate.id === id)
        return tab !== undefined && tab.kind === target.kind && tab.fixed === target.fixed
      })
      if (movable.length === 0) return

      if (target.kind === 'request') {
        reorderTabsGroup(movable, targetId, edge)
        return
      }
      setOpenFlowIds((current) => {
        if (movable.includes(targetId)) return current
        const moved = current.filter((id) => movable.includes(id))
        const next = current.filter((id) => !movable.includes(id))
        const targetIndex = next.indexOf(targetId)
        if (targetIndex === -1) return current
        next.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, ...moved)
        return next
      })
    },
    [descriptors, reorderTabsGroup],
  )

  return {
    descriptors,
    activeOpenTab,
    openFlow,
    openRunLog,
    runLogTabs,
    openRunner,
    runnerTabs,
    openNotification,
    notificationTabs,
    openMockServer,
    openInlineMockServer,
    renameFlowNode,
    updateMockServerTab,
    mockServerTabs,
    selectOpenTab,
    pinOpenTab,
    closeRunLogPreview,
    closeOpenTab,
    closeAllOpenTabs,
    closeOtherOpenTabs,
    closeUnfixedOpenTabs,
    closeOpenTabs,
    toggleFixOpenTab,
    reorderOpenTabs,
    reorderOpenTabsGroup,
  }
}
