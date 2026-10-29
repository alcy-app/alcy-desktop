import type { AgentContextInput } from '../../bindings/agent-turn'
import type { TreeNode } from '../request-workbench/collection-tree'
import type { EditorSelection, EditorSlot } from '../request-workbench/editor-bridge'
import type { WorkbenchAgentHost } from './agent-host'

export type AgentContextKind = 'tab' | 'request' | 'environment' | 'response' | 'selection' | 'flow' | 'monitor' | 'runner' | 'mock'

export interface AgentContextOption extends AgentContextInput {
  kind: AgentContextKind
}

const MAX_OPTIONS_PER_KIND = 8

function matches(query: string, ...values: string[]) {
  const needle = query.trim().toLowerCase()
  return needle === '' || values.some((value) => value.toLowerCase().includes(needle))
}

function savedRequests(nodes: TreeNode[], path: string[] = []): AgentContextOption[] {
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

/** Items the `@` menu offers for `query`, grouped by kind in a fixed order. */
export function agentContextOptions(host: WorkbenchAgentHost, query: string): AgentContextOption[] {
  const activeTabId = host.activeTabId()
  const tabs = host.tabs()
  const tabOptions = tabs
    .filter((tab) => matches(query, tab.name, tab.content.endpointUrl))
    .slice(0, MAX_OPTIONS_PER_KIND)
    .map((tab): AgentContextOption => ({
      kind: 'tab',
      id: tab.id,
      label: tab.name,
      summary: `${tab.protocol === 'rest' ? tab.content.method.toUpperCase() : tab.protocol} ${tab.content.endpointUrl}${tab.dirty ? ' (unsaved)' : ''}`,
    }))
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
    .map((environment): AgentContextOption => ({
      kind: 'environment',
      id: environment.id,
      label: environment.name,
      summary: `Variables: ${environment.variables.map((variable) => variable.name).slice(0, 40).join(', ') || 'none'}`,
    }))
  const resourceOptions = (host.resources?.context() ?? [])
    .filter((option) => matches(query, option.label, option.summary))
    .filter((option, index, all) => all.slice(0, index).filter((previous) => previous.kind === option.kind).length < MAX_OPTIONS_PER_KIND) as AgentContextOption[]
  return [...responseOptions, ...tabOptions, ...requestOptions, ...environmentOptions, ...resourceOptions]
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
  return { kind: 'selection', id: selection.slot, label, summary: `${where}, selected text:\n${selection.text}` }
}
