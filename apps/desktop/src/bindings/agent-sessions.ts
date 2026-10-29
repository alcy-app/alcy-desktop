import type { AgentCommandError } from './agent-settings'
import { invokeResult } from './invoke-result'

export interface AgentSessionSummaryDto {
  id: string
  title: string
  updatedAtMs: number
}

export type AgentViewItemDto =
  /** `atMs` is absent in chats saved before message times existed. */
  | { kind: 'user'; text: string; atMs?: number }
  | { kind: 'assistant'; text: string; atMs?: number }
  | { kind: 'tool'; callId: string; name: string; input: Record<string, unknown>; isError: boolean }

export interface AgentSessionViewDto {
  id: string
  title: string
  providerId: string
  model: string
  items: AgentViewItemDto[]
  /** Older items left out of `items`. */
  omittedItems: number
}

export function listAgentSessions(rootPath: string) {
  return invokeResult<AgentSessionSummaryDto[], AgentCommandError>('list_agent_sessions', { input: { rootPath } })
}

export function loadAgentSession(rootPath: string, sessionId: string) {
  return invokeResult<AgentSessionViewDto, AgentCommandError>('load_agent_session', { input: { rootPath, sessionId } })
}

export function deleteAgentSession(rootPath: string, sessionId: string) {
  return invokeResult<void, AgentCommandError>('delete_agent_session', { input: { rootPath, sessionId } })
}
