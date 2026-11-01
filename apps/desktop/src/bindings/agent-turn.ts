import { Channel, invoke } from '@tauri-apps/api/core'
import type { AgentCommandError } from './agent-settings'
import { invokeResult } from './invoke-result'

export type AgentToolClass = 'read' | 'edit' | 'sideEffect'

export type AgentTurnStop = 'endTurn' | 'maxTokens' | 'roundLimit' | 'cancelled' | 'other'

export type AgentEventDto =
  | { type: 'sessionStarted'; sessionId: string; title: string }
  | { type: 'textDelta'; text: string }
  | { type: 'toolCallRequested'; waitId: string; callId: string; name: string; input: Record<string, unknown>; class: AgentToolClass }
  | { type: 'toolCallFinished'; callId: string; isError: boolean }
  /** The oldest part of the chat was summarized to fit the model's context. */
  | { type: 'contextCompacted' }
  /** The model named a new chat from its first message. */
  | { type: 'titleChanged'; title: string }

export interface AgentContextInput {
  kind: string
  id: string
  label: string
  summary: string
}

export interface StartAgentTurnInput {
  runId: string
  rootPath: string
  sessionId: string | null
  providerId: string
  /** Empty uses the provider's default model. */
  model: string
  text: string
  context: AgentContextInput[]
  /** Interface language, the default answer language. */
  language: 'pt-BR' | 'en'
  /** The text replaces the user's last message and what came after it (retry or edit). */
  replaceLastTurn?: boolean
}

export interface AgentTurnResultDto {
  sessionId: string
  stopReason: AgentTurnStop
  inputTokens: number
  outputTokens: number
}

/** Runs one turn; events stream until the promise settles. */
export async function startAgentTurn(input: StartAgentTurnInput, onEvent: (event: AgentEventDto) => void) {
  const channel = new Channel<AgentEventDto>()
  channel.onmessage = onEvent
  try {
    const value = await invoke<AgentTurnResultDto>('start_agent_turn', { input, onEvent: channel })
    return { ok: true as const, value }
  } catch (error) {
    return { ok: false as const, error: error as AgentCommandError }
  }
}

export function cancelAgentTurn(runId: string) {
  return invokeResult<void, never>('cancel_agent_turn', { input: { runId } })
}

export interface AgentCompactionResultDto {
  compacted: boolean
  cancelled: boolean
  inputTokens: number
  outputTokens: number
}

/** Summarizes the saved native transcript without creating a user message or running tools. */
export function compactAgentSession(input: { runId: string; rootPath: string; sessionId: string; providerId: string; model: string }) {
  return invokeResult<AgentCompactionResultDto, AgentCommandError>('compact_agent_session', { input })
}

export function submitAgentToolResult(waitId: string, content: string, isError: boolean) {
  return invokeResult<void, AgentCommandError>('submit_agent_tool_result', { input: { waitId, content, isError } })
}
