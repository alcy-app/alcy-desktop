import { useLayoutEffect, useMemo, useRef } from 'react'
import { importCollectionsFromText } from '../../bindings/import-collections-from-text'
import type { AgentHostTab, WorkbenchAgentHost } from '../agent/agent-host'
import type { useEnvironmentsState } from '../environments/use-environments-state'
import { findNode, findRequest, insertFolder, insertRequest, regenerateIds, uniqueChildName, updateRequestContent, type RequestContent, type TreeNode } from './collection-tree'
import { editorHighlighter, revealEditor, type EditorField, type EditorHighlighter, type EditorSlot } from './editor-bridge'
import type { useCollectionsState } from './use-collections-state'
import { requestToDto, treeFromDto } from './use-collections-state'
import type { useFlowsState } from '../flows/use-flows-state'
import type { useOpenTabs } from './use-open-tabs'
import { contentOf, isTabDirty, type useWorkbenchState } from './use-workbench-state'
import type { RequestTabId, WorkbenchTab } from './request-workbench.types'
import type { AgentResourceHost } from '../agent/use-agent-resources'
import type { AgentDocumentHost } from '../documents/document-agent-tools'

interface AgentHostSources {
  documents?: AgentDocumentHost
  workspaceRootPath: string
  resources?: AgentResourceHost
  flows?: ReturnType<typeof useFlowsState>
  workbench: ReturnType<typeof useWorkbenchState>
  openTabs: ReturnType<typeof useOpenTabs>
  collections: ReturnType<typeof useCollectionsState>
  environments: ReturnType<typeof useEnvironmentsState>
  /** Sends the active tab the way the Send button does (scripts, console, history). */
  sendActive: () => Promise<void>
}

/** Longest wait for a render after an action that may not change any state. */
const RENDER_FALLBACK_MS = 200
/** Longest wait for an editor to mount after switching to its section. */
const EDITOR_MOUNT_TIMEOUT_MS = 1000
/** How long send_request waits for a WebSocket connection to open. */
const WEBSOCKET_OPEN_WAIT_MS = 30_000

const FIELD_SECTIONS: Record<EditorField, RequestTabId> = {
  body: 'body',
  query: 'query',
  variables: 'variables',
  preRequestScript: 'scripts',
  postResponseScript: 'scripts',
}

/** Request fields with an editor for the protocol, in the order they are searched. */
function editorFields(content: RequestContent): EditorField[] {
  const scripts: EditorField[] = ['preRequestScript', 'postResponseScript']
  if (content.protocol === 'graphql') return ['query', 'variables', ...scripts]
  if (content.protocol === 'rest') return [...(content.body.type === 'raw' ? ['body' as const] : []), ...scripts]
  return scripts
}

function fieldText(content: RequestContent, field: EditorField): string {
  switch (field) {
    case 'body':
      return content.body.type === 'raw' ? content.body.content : ''
    case 'query':
      return content.query
    case 'variables':
      return content.variables
    case 'preRequestScript':
      return content.preRequestScript
    case 'postResponseScript':
      return content.postResponseScript
  }
}

/** Waits until the slot's editor is mounted, asking its panel to show it. */
async function mountedEditor(slot: EditorSlot): Promise<EditorHighlighter | null> {
  const deadline = Date.now() + EDITOR_MOUNT_TIMEOUT_MS
  for (;;) {
    revealEditor(slot)
    const highlighter = editorHighlighter(slot)
    if (highlighter) return highlighter
    if (Date.now() > deadline) return null
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  }
}

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
    grpcStream: tab.grpcStream,
    websocketStream: tab.websocketStream,
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
      get documents() { return latest.current.documents },
      get resources() { return latest.current.resources },
      tabs: () => latest.current.workbench.tabs.map(toHostTab),
      activeTabId: () => latest.current.openTabs.activeOpenTab?.id ?? latest.current.workbench.activeTabId,
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
        if (!latest.current.openTabs.descriptors.some((tab) => tab.id === tabId)) return false
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
      async closeTab(tabId) {
        if (!latest.current.openTabs.descriptors.some((tab) => tab.id === tabId)) return false
        latest.current.openTabs.closeOpenTab(tabId)
        await afterRender()
        return true
      },
      async highlight(tabId, target, field, text) {
        const tab = findTab(tabId)
        if (!tab) return { ok: false, reason: 'notFound' }
        let slot: EditorSlot = 'response'
        if (target === 'response') {
          if (tab.execution.status !== 'success') return { ok: false, reason: 'noResponse' }
        } else {
          const content = contentOf(tab)
          const needle = text.toLowerCase()
          const candidates = field ? [field] : editorFields(content)
          const chosen = candidates.find((candidate) => fieldText(content, candidate).toLowerCase().includes(needle)) ?? (field ?? null)
          if (!chosen) return { ok: false, reason: 'noMatch' }
          slot = chosen
        }
        await show(tabId)
        if (slot !== 'response') {
          latest.current.workbench.setActiveSection(FIELD_SECTIONS[slot])
          await afterRender()
        }
        const highlighter = await mountedEditor(slot)
        if (!highlighter) return { ok: false, reason: 'noEditor' }
        const matches = highlighter.highlight(text)
        return matches > 0 ? { ok: true, slot, matches } : { ok: false, reason: 'noMatch' }
      },
      replaceContent(tabId, content) {
        latest.current.workbench.replaceTabContent(tabId, content)
      },
      async send(tabId) {
        if (!findTab(tabId)) return null
        await show(tabId)
        const completion = latest.current.sendActive()
        const protocol = findTab(tabId)?.protocol
        if (protocol === 'grpc') void completion.catch(() => undefined)
        else if (protocol === 'websocket') {
          // A connection only resolves when it closes: answer once it opened or failed.
          void completion.catch(() => undefined)
          const deadline = Date.now() + WEBSOCKET_OPEN_WAIT_MS
          while (Date.now() < deadline) {
            const tab = findTab(tabId)
            if (!tab || tab.execution.status !== 'loading' || tab.websocketStream?.status === 'open') break
            await afterRender()
          }
        } else await completion
        await afterRender()
        return findTab(tabId)?.execution ?? null
      },
      async cancelRequest(tabId) {
        if (findTab(tabId)?.execution.status !== 'loading') return false
        await show(tabId)
        latest.current.workbench.cancel()
        await afterRender()
        return true
      },
      async controlWebSocket(tabId, close) {
        if (findTab(tabId)?.websocketStream?.status !== 'open') return false
        await show(tabId)
        if (close) await latest.current.workbench.disconnectWebSocket()
        else await latest.current.workbench.sendWebSocketComposerMessage()
        await afterRender()
        return !findTab(tabId)?.websocketStream?.error
      },
      async controlGrpcStream(tabId, close) {
        if (!findTab(tabId)?.grpcStream?.accepting) return false
        await show(tabId)
        await latest.current.workbench.controlGrpcStream(close)
        await afterRender()
        return !findTab(tabId)?.grpcStream?.error
      },
      async saveTab(tabId, target) {
        const { workbench, collections } = latest.current
        const tab = findTab(tabId)
        if (!tab) return { ok: false, reason: 'notFound' }
        if (tab.flowNodeRef) {
          const ref = tab.flowNodeRef
          const node = latest.current.flows?.flows.find((flow) => flow.id === ref.flowId)?.nodes.find((node) => node.id === ref.nodeId)
          if (node?.kind !== 'inlineRequest' || !latest.current.resources) return { ok: false, reason: 'flowNode' }
          const content = workbench.contentOfTab(tabId)
          const result = await latest.current.resources.call('update_flow', { flowId: ref.flowId, upsertNodes: [{ id: ref.nodeId, request: requestToDto({ ...node.request, content }) }] })
          if (result.isError) throw new Error(result.content)
          latest.current.workbench.markContentSaved(tabId, content)
          await afterRender()
          return { ok: true, requestId: node.request.id, name: node.request.name }
        }
        if (tab.requestId) {
          if (isTabDirty(tab)) {
            const id = tab.requestId
            const content = workbench.contentOfTab(tabId)
            await collections.commitCollections((current) => updateRequestContent(current, id, content))
            workbench.markContentSaved(tabId)
            await afterRender()
          }
          return { ok: true, requestId: tab.requestId, name: tab.name }
        }
        if (!target) return { ok: false, reason: 'needsParent' }
        if (!findNode(collections.collections, target.parentId)) return { ok: false, reason: 'unknownParent' }
        const saved = { id: crypto.randomUUID(), name: target.name, protocol: tab.protocol, content: workbench.contentOfTab(tabId) }
        await collections.commitCollections((current) => insertRequest(current, target.parentId, saved))
        workbench.markSaved(tabId, saved.id, saved.name)
        await afterRender()
        return { ok: true, requestId: saved.id, name: saved.name }
      },
      async createCollection(name) {
        const id = crypto.randomUUID()
        await latest.current.collections.commitCollections((current) => insertFolder(current, null, { id, name, folders: [], requests: [], authentication: { type: 'none' }, variables: [] }))
        await afterRender()
        return id
      },
      async importFromText(content) {
        const { workspaceRootPath, collections, environments } = latest.current
        if (!collections.loaded || collections.loadError) throw new Error(collections.loadError ?? 'Collections are not loaded.')
        if (!environments.loaded || environments.loadError) throw new Error(environments.loadError ?? 'Environments are not loaded.')
        const result = await importCollectionsFromText(content, workspaceRootPath)
        if (!result.ok) throw new Error(result.error.message)
        if (latest.current.workspaceRootPath !== workspaceRootPath) throw new Error('The workspace is no longer available.')
        const data = result.value
        const imported = treeFromDto(data.collections).map((node) => regenerateIds(node))
        const importedEnvironments = data.environments.map((environment) => ({
          ...environment, id: crypto.randomUUID(),
          variables: environment.variables.map((variable) => ({ ...variable, id: crypto.randomUUID() })),
        }))
        if (imported.length > 0) {
          await collections.commitCollections((current) => {
            let next = current
            for (const node of imported) {
              node.name = uniqueChildName(next, null, 'folder', node.name)
              next = insertFolder(next, null, node)
            }
            return next
          })
          await afterRender()
        }
        if (importedEnvironments.length > 0) {
          try {
            if (latest.current.workspaceRootPath !== workspaceRootPath) throw new Error('The workspace is no longer available.')
            await environments.commitEnvironments((current) => ({ ...current, environments: [...current.environments, ...importedEnvironments] }))
            await afterRender()
          } catch (error) {
            if (imported.length > 0) throw new Error(`Collections were imported, but environments could not be saved: ${error instanceof Error ? error.message : String(error)}. Do not repeat the whole import; it would duplicate collections.`, { cause: error })
            throw error
          }
        }
        let folderCount = 0
        let requestCount = 0
        let firstRequestId: string | null = null
        const count = (node: TreeNode) => {
          firstRequestId ??= node.requests[0]?.id ?? null
          requestCount += node.requests.length
          folderCount += node.folders.length
          node.folders.forEach(count)
        }
        imported.forEach(count)
        return {
          collectionCount: imported.length, folderCount, requestCount, environmentCount: importedEnvironments.length,
          collections: imported.slice(0, 50).map(({ id, name }) => ({ id, name })),
          environments: importedEnvironments.slice(0, 50).map(({ id, name }) => ({ id, name })),
          firstRequestId, scriptCount: data.scriptCount, warningCount: data.warnings.length, warnings: data.warnings.slice(0, 20),
        }
      },
      async createFolder(parentId, name) {
        if (!findNode(latest.current.collections.collections, parentId)) return null
        const id = crypto.randomUUID()
        await latest.current.collections.commitCollections((current) => insertFolder(current, parentId, { id, name, folders: [], requests: [], authentication: { type: 'inherit' }, variables: [] }))
        await afterRender()
        return id
      },
      async setVariable(environmentId, name, value, sensitive) {
        await latest.current.environments.commitEnvironments((current) => ({ ...current, environments: current.environments.map((environment) => {
          if (environment.id !== environmentId) return environment
          const existing = environment.variables.find((variable) => variable.name === name)
          const variable = { id: existing?.id ?? crypto.randomUUID(), name, value, sensitive: sensitive ?? existing?.sensitive ?? false }
          return { ...environment, variables: existing ? environment.variables.map((row) => row.name === name ? variable : row) : [...environment.variables, variable] }
        }) }))
        await afterRender()
      },
      async setActiveEnvironment(activeEnvironmentId) {
        await latest.current.environments.commitEnvironments((current) => ({ ...current, activeEnvironmentId }))
        await afterRender()
      },
    }
    return host
  }, [])
}
