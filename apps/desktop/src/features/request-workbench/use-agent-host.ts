import { useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentHostTab, WorkbenchAgentHost } from '../agent/agent-host'
import type { useEnvironmentsState } from '../environments/use-environments-state'
import { findNode, findRequest } from './collection-tree'
import type { useCollectionsState } from './use-collections-state'
import type { useOpenTabs } from './use-open-tabs'
import { contentOf, isTabDirty, type useWorkbenchState } from './use-workbench-state'
import type { WorkbenchTab } from './request-workbench.types'

interface AgentHostSources {
  workbench: ReturnType<typeof useWorkbenchState>
  openTabs: ReturnType<typeof useOpenTabs>
  collections: ReturnType<typeof useCollectionsState>
  environments: ReturnType<typeof useEnvironmentsState>
  /** Sends the active tab the way the Send button does (scripts, console, history). */
  sendActive: () => Promise<void>
}

/** Longest wait for a render after an action that may not change any state. */
const RENDER_FALLBACK_MS = 200

function toHostTab(tab: WorkbenchTab): AgentHostTab {
  return {
    id: tab.id,
    name: tab.name,
    protocol: tab.protocol,
    requestId: tab.requestId,
    dirty: isTabDirty(tab),
    isFlowNode: tab.flowNodeRef !== undefined,
    content: contentOf(tab),
    execution: tab.execution,
  }
}

/**
 * The workbench as the agent sees it (ADR 0064). Reads go to the latest
 * render; actions resolve after the render that applies them, so the next
 * tool call already sees their effect.
 */
export function useAgentHost(sources: AgentHostSources): WorkbenchAgentHost {
  const latest = useRef(sources)
  const waiters = useRef<(() => void)[]>([])

  useLayoutEffect(() => {
    latest.current = sources
    const pending = waiters.current
    waiters.current = []
    for (const resolve of pending) resolve()
  })

  return useMemo(() => {
    const afterRender = () =>
      new Promise<void>((resolve) => {
        waiters.current.push(resolve)
        window.setTimeout(resolve, RENDER_FALLBACK_MS)
      })
    const findTab = (tabId: string) => latest.current.workbench.tabs.find((tab) => tab.id === tabId)
    const show = async (tabId: string) => {
      latest.current.openTabs.selectOpenTab(tabId)
      await afterRender()
    }

    const host: WorkbenchAgentHost = {
      tabs: () => latest.current.workbench.tabs.map(toHostTab),
      activeTabId: () => latest.current.workbench.activeTabId,
      collections: () => latest.current.collections.collections,
      environments: () =>
        latest.current.environments.environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          variables: environment.variables.map(({ name, value, sensitive }) => ({ name, value, sensitive })),
        })),
      activeEnvironmentId: () => latest.current.environments.activeEnvironmentId,
      async openRequest(requestId) {
        const request = findRequest(latest.current.collections.collections, requestId)
        if (!request) return null
        // Pinned, so the next preview does not replace the tab the agent works on.
        latest.current.workbench.openRequest(request.id, request.content, request.name, true, false)
        await afterRender()
        const tab = latest.current.workbench.tabs.find((candidate) => candidate.requestId === requestId)
        if (!tab) return null
        await show(tab.id)
        return tab.id
      },
      async selectTab(tabId) {
        if (!findTab(tabId)) return false
        await show(tabId)
        return true
      },
      async newRequestTab(name, content) {
        const before = new Set(latest.current.workbench.tabs.map((tab) => tab.id))
        latest.current.workbench.openDraft(name, content)
        await afterRender()
        const tab = latest.current.workbench.tabs.find((candidate) => !before.has(candidate.id))
        if (!tab) return null
        await show(tab.id)
        return tab.id
      },
      replaceContent(tabId, content) {
        latest.current.workbench.replaceTabContent(tabId, content)
      },
      async send(tabId) {
        if (!findTab(tabId)) return null
        await show(tabId)
        await latest.current.sendActive()
        await afterRender()
        return findTab(tabId)?.execution ?? null
      },
      async saveTab(tabId, target) {
        const { workbench, collections } = latest.current
        const tab = findTab(tabId)
        if (!tab) return { ok: false, reason: 'notFound' }
        if (tab.flowNodeRef) return { ok: false, reason: 'flowNode' }
        if (tab.requestId) {
          if (isTabDirty(tab)) {
            collections.updateRequestContent(tab.requestId, workbench.contentOfTab(tabId))
            workbench.markContentSaved(tabId)
            await afterRender()
          }
          return { ok: true, requestId: tab.requestId, name: tab.name }
        }
        if (!target) return { ok: false, reason: 'needsParent' }
        if (!findNode(collections.collections, target.parentId)) return { ok: false, reason: 'unknownParent' }
        const saved = collections.addRequest(target.parentId, target.name, tab.protocol, workbench.contentOfTab(tabId))
        workbench.markSaved(tabId, saved.id, saved.name)
        await afterRender()
        return { ok: true, requestId: saved.id, name: saved.name }
      },
      createCollection: (name) => latest.current.collections.addCollection(name),
      createFolder(parentId, name) {
        if (!findNode(latest.current.collections.collections, parentId)) return null
        return latest.current.collections.addFolder(parentId, name)
      },
      setVariable: (environmentId, name, value, sensitive) => latest.current.environments.upsertVariable(environmentId, name, value, sensitive),
      setActiveEnvironment: (environmentId) => latest.current.environments.setActiveEnvironmentId(environmentId),
    }
    return host
  }, [])
}
