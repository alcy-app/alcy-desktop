import type { AgentContextInput } from '../../bindings/agent-turn'
import type { TreeNode } from '../request-workbench/collection-tree'
import type { EditorSelection, EditorSlot } from '../request-workbench/editor-bridge'
import type { AgentHostEnvironment, AgentHostTab, WorkbenchAgentHost } from './agent-host'

export type AgentContextKind = 'tab' | 'request' | 'collection' | 'folder' | 'environment' | 'response' | 'field' | 'selection' | 'flow' | 'monitor' | 'runner' | 'mock' | 'quote' | 'document'

export interface AgentContextOption extends AgentContextInput {
  kind: AgentContextKind
  /** Presentation metadata; quotes keep the existing native contract. */
  quoteKind?: 'message' | 'reply' | 'selection'
  preview?: string
}

const MAX_OPTIONS_PER_KIND = 8

function matches(query: string, ...values: string[]) {
  const needle = query.trim().toLowerCase()
  return needle === '' || values.some((value) => value.toLowerCase().includes(needle))
}

export function savedRequests(nodes: TreeNode[], path: string[] = []): AgentContextOption[] {
  return nodes.flatMap((node) => {
    const nodePath = [...path, node.name]
    const requests = node.requests.map((request): AgentContextOption => {
      const method = request.protocol === 'rest' ? request.content.method.toUpperCase() : request.protocol
      return {
        kind: 'request',
        id: request.id,
        label: request.name,
        summary: `${nodePath.join(' / ')}\n${method} ${request.content.endpointUrl}`.trim(),
      }
    })
    return [...requests, ...savedRequests(node.folders, nodePath)]
  })
}

function tabContext(tab: AgentHostTab): AgentContextOption {
  const method = tab.protocol === 'rest' ? tab.content.method.toUpperCase() : tab.protocol
  return { kind: 'tab', id: tab.id, label: tab.name, summary: `${method} ${tab.content.endpointUrl}${tab.dirty ? ' (unsaved)' : ''}` }
}

function environmentContext(environment: AgentHostEnvironment): AgentContextOption {
  const names = environment.variables.map((variable) => variable.name).slice(0, 40).join(', ')
  return { kind: 'environment', id: environment.id, label: environment.name, summary: `Variables: ${names || 'none'}` }
}

/** Items the `@` menu offers for `query`, grouped by kind in a fixed order. */
export function agentContextOptions(host: WorkbenchAgentHost, query: string): AgentContextOption[] {
  const activeTabId = host.activeTabId()
  const tabs = host.tabs()
  const tabOptions = tabs
    .filter((tab) => matches(query, tab.name, tab.content.endpointUrl))
    .slice(0, MAX_OPTIONS_PER_KIND)
    .map(tabContext)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const responseOptions: AgentContextOption[] =
    activeTab && activeTab.execution.status === 'success' && 'statusCode' in activeTab.execution.result && matches(query, activeTab.name, 'response', 'resposta')
      ? [{ kind: 'response', id: activeTab.id, label: activeTab.name, summary: `Last response: HTTP ${activeTab.execution.result.statusCode}. Read it with get_response.` }]
      : []
  const requestOptions = savedRequests(host.collections())
    .filter((option) => matches(query, option.label, option.summary))
    .slice(0, MAX_OPTIONS_PER_KIND)
  const environmentOptions = host
    .environments()
    .filter((environment) => matches(query, environment.name))
    .slice(0, MAX_OPTIONS_PER_KIND)
    .map(environmentContext)
  const resourceOptions = (host.resources?.context() ?? [])
    .filter((option) => matches(query, option.label, option.summary))
    .filter((option, index, all) => all.slice(0, index).filter((previous) => previous.kind === option.kind).length < MAX_OPTIONS_PER_KIND) as AgentContextOption[]
  const documentOptions = (host.documents?.context() ?? []).filter((option) => matches(query, option.label)).slice(0, MAX_OPTIONS_PER_KIND) as AgentContextOption[]
  return [...responseOptions, ...tabOptions, ...requestOptions, ...environmentOptions, ...resourceOptions, ...documentOptions]
}

/** How the agent reads each kind of item when the workbench has nothing more to say about it. */
const READ_HINTS: Partial<Record<AgentContextKind, string>> = {
  tab: 'Open tab. Read with get_request.',
  request: 'Saved request. Read with get_request.',
  collection: 'Collection. Read with get_collection.',
  folder: 'Collection folder. Read with get_collection.',
  environment: 'Environment. Read with list_environments.',
  flow: 'Flow. Read with get_flow.',
  monitor: 'Value monitor. Read with get_value_monitor.',
  runner: 'Collection runner. Read with get_runner.',
  mock: 'Mock server. Read with get_mock_server.',
}

function findFolder(nodes: TreeNode[], id: string, path: string[] = []): { node: TreeNode; path: string[] } | null {
  for (const node of nodes) {
    if (node.id === id) return { node, path }
    const found = findFolder(node.folders, id, [...path, node.name])
    if (found) return found
  }
  return null
}

function countRequests(node: TreeNode): number {
  return node.requests.length + node.folders.reduce((total, folder) => total + countRequests(folder), 0)
}

/** An item mentioned from outside the chat (an item menu), described the way the `@` menu would. */
export function mentionContext(host: WorkbenchAgentHost, item: { kind: AgentContextKind; id: string; label: string; summary?: string }): AgentContextOption {
  const fallback: AgentContextOption = { kind: item.kind, id: item.id, label: item.label, summary: item.summary ?? READ_HINTS[item.kind] ?? '' }
  switch (item.kind) {
    case 'field': {
      // A value of the response on screen, which is the active tab's.
      const tab = host.tabs().find((candidate) => candidate.id === host.activeTabId())
      const where = tab ? ` in the last response of tab "${tab.name}" (tabId ${tab.id})` : ' in the response'
      return { ...fallback, id: tab ? `${tab.id}:${item.id}` : item.id, summary: `Value at ${item.id}${where}:\n${item.summary ?? ''}` }
    }
    case 'request':
      return savedRequests(host.collections()).find((option) => option.id === item.id) ?? fallback
    case 'collection':
    case 'folder': {
      const found = findFolder(host.collections(), item.id)
      if (!found) return fallback
      const where = found.path.length > 0 ? `In ${found.path.join(' / ')}. ` : ''
      return { ...fallback, label: found.node.name, summary: `${where}${found.node.folders.length} folders, ${countRequests(found.node)} requests. ${fallback.summary}` }
    }
    case 'tab': {
      const tab = host.tabs().find((candidate) => candidate.id === item.id)
      return tab ? tabContext(tab) : fallback
    }
    case 'environment': {
      const environment = host.environments().find((candidate) => candidate.id === item.id)
      return environment ? environmentContext(environment) : fallback
    }
    default: {
      const resource = host.resources?.context().find((option) => option.kind === item.kind && option.id === item.id)
      return resource ? { ...fallback, label: resource.label, summary: resource.summary } : fallback
    }
  }
}

/** A message of the chat, or part of one, attached as context (`quote` kind in the prompt). */
export function quoteContext(text: string, label: string, quoteKind: 'message' | 'reply' | 'selection'): AgentContextOption {
  return { kind: 'quote', id: `quote-${crypto.randomUUID()}`, label, summary: text, quoteKind }
}

/** The `@query` being typed right before the caret, if any. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query) || query.length > 60) return null
  return { start: at, query }
}

const SLOT_DESCRIPTIONS: Record<EditorSlot, string> = {
  body: 'Request body',
  query: 'GraphQL query',
  variables: 'GraphQL variables',
  preRequestScript: 'Pre-request script',
  postResponseScript: 'Post-response script',
  response: 'Response body',
}

/** The editor selection as the first context reference: the subject of the message. */
export function selectionContext(selection: EditorSelection, host: WorkbenchAgentHost, label: string): AgentContextOption {
  const tab = host.tabs().find((candidate) => candidate.id === host.activeTabId())
  const where = tab ? `${SLOT_DESCRIPTIONS[selection.slot]} of tab "${tab.name}" (tabId ${tab.id})` : SLOT_DESCRIPTIONS[selection.slot]
  return { kind: 'selection', id: selection.slot, label, summary: `${where}, selected text:\n${selection.text}`, preview: selection.text }
}
