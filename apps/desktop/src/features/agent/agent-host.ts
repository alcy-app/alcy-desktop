import type { RequestContent, TreeNode } from '../request-workbench/collection-tree'
import type { ExecutionState, WorkbenchProtocol } from '../request-workbench/request-workbench.types'

/** A request tab as the agent tools see it. */
export interface AgentHostTab {
  id: string
  name: string
  protocol: WorkbenchProtocol
  requestId: string | null
  dirty: boolean
  /** Inline request of a flow node, saved into the flow rather than a collection. */
  isFlowNode: boolean
  content: RequestContent
  execution: ExecutionState
}

export interface AgentHostEnvironment {
  id: string
  name: string
  variables: { name: string; value: string; sensitive: boolean }[]
}

export type AgentSaveResult = { ok: true; requestId: string; name: string } | { ok: false; reason: 'notFound' | 'flowNode' | 'needsParent' | 'unknownParent' }

/**
 * What the agent can read and do on the workbench (ADR 0064). Built by the
 * workbench from its own state and actions; reads always return the latest
 * state, and actions resolve once the interface reflects them.
 */
export interface WorkbenchAgentHost {
  tabs(): AgentHostTab[]
  activeTabId(): string | null
  collections(): TreeNode[]
  environments(): AgentHostEnvironment[]
  activeEnvironmentId(): string | null
  /** Tab id of the opened request, or `null` when it does not exist. */
  openRequest(requestId: string): Promise<string | null>
  selectTab(tabId: string): Promise<boolean>
  /** Tab id of the new draft. */
  newRequestTab(name: string, content: RequestContent): Promise<string | null>
  replaceContent(tabId: string, content: RequestContent): void
  /** Sends the tab's request and resolves with its execution afterwards. */
  send(tabId: string): Promise<ExecutionState | null>
  saveTab(tabId: string, target: { parentId: string; name: string } | null): Promise<AgentSaveResult>
  createCollection(name: string): string
  createFolder(parentId: string, name: string): string | null
  setVariable(environmentId: string, name: string, value: string, sensitive: boolean | undefined): void
  setActiveEnvironment(environmentId: string | null): void
}
