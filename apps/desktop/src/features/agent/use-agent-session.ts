import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCommandError } from '../../bindings/agent-settings'
import { loadAgentSession, type AgentSessionViewDto } from '../../bindings/agent-sessions'
import {
  cancelAgentTurn,
  startAgentTurn,
  submitAgentToolResult,
  type AgentContextInput,
  type AgentEventDto,
  type AgentToolClass,
} from '../../bindings/agent-turn'
import type { TranslationKey } from '../../shared/i18n/translations'
import { useLanguage } from '../../shared/i18n/use-language'
import type { WorkbenchAgentHost } from './agent-host'
import { rememberSession, rememberedSession } from './agent-session-memory'
import { runAgentTool, summarizeToolCall, toolNeedsApproval } from './agent-tools'

export type AgentToolState = 'running' | 'awaitingApproval' | 'done' | 'failed' | 'declined' | 'reverted'

export type AgentChatItem =
  /** `atMs`: when the message was sent or started arriving; unknown in older chats. */
  | { kind: 'user'; id: string; text: string; context: AgentContextInput[]; atMs?: number }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; atMs?: number }
  | { kind: 'tool'; id: string; name: string; toolClass: AgentToolClass; summary: string; state: AgentToolState; canRevert: boolean; autoApproved: boolean }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string }

interface UseAgentSessionOptions {
  rootPath: string
  host: WorkbenchAgentHost
  providerId: string | null
  model: string
  defaultRequestName: string
  /** Run every action without asking, side effects included. */
  autoApprove: boolean
}

export function agentErrorMessage(error: AgentCommandError, t: (key: TranslationKey, values?: Record<string, string | number>) => string): string {
  switch (error.kind) {
    case 'unauthorized':
      return t('agent.error.unauthorized')
    case 'rateLimited':
      return t('agent.error.rateLimited')
    case 'missingApiKey':
      return t('agent.error.missingApiKey')
    case 'missingModel':
      return t('agent.error.missingModel')
    case 'unknownProvider':
      return t('agent.error.unknownProvider')
    case 'busy':
      return t('agent.error.busy')
    case 'notFound':
      return t('agent.error.notFound')
    case 'provider':
      return t('agent.error.provider', { status: error.status, message: error.message })
    case 'network':
    case 'invalid':
    case 'storage':
    case 'credentials':
      return t('agent.error.credentials', { message: error.message })
    case 'invalidResponse':
      return t('agent.error.generic', { message: error.message })
  }
}

let itemSequence = 0
function nextItemId(prefix: string) {
  itemSequence += 1
  return `${prefix}-${itemSequence}`
}

/** One chat with the agent: streaming, tool calls on the workbench, approvals and history. */
export function useAgentSession({ rootPath, host, providerId, model, defaultRequestName, autoApprove }: UseAgentSessionOptions) {
  const { t, language } = useLanguage()
  const [items, setItems] = useState<AgentChatItem[]>([])
  const [running, setRunning] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  const approvalsRef = useRef(new Map<string, (approved: boolean) => void>())
  const revertsRef = useRef(new Map<string, () => void>())
  // Tools read the latest host and default name, not those of the render that started the turn.
  const hostRef = useRef(host)
  const defaultNameRef = useRef(defaultRequestName)
  const autoApproveRef = useRef(autoApprove)
  useEffect(() => {
    hostRef.current = host
    defaultNameRef.current = defaultRequestName
    autoApproveRef.current = autoApprove
  })

  const updateTool = useCallback((id: string, patch: Partial<Extract<AgentChatItem, { kind: 'tool' }>>) => {
    setItems((current) => current.map((item) => (item.kind === 'tool' && item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const declinePendingApprovals = useCallback(() => {
    for (const resolve of approvalsRef.current.values()) resolve(false)
    approvalsRef.current.clear()
  }, [])

  const handleToolCall = useCallback(
    async (event: Extract<AgentEventDto, { type: 'toolCallRequested' }>) => {
      const gated = event.class === 'sideEffect' || toolNeedsApproval(event.name, event.input, hostRef.current)
      const needsApproval = gated && !autoApproveRef.current
      setItems((current) => [
        ...current.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item)),
        {
          kind: 'tool',
          id: event.callId,
          name: event.name,
          toolClass: event.class,
          summary: summarizeToolCall(event.name, event.input, hostRef.current),
          state: needsApproval ? 'awaitingApproval' : 'running',
          canRevert: false,
          autoApproved: gated && !needsApproval,
        },
      ])
      if (needsApproval) {
        const approved = await new Promise<boolean>((resolve) => approvalsRef.current.set(event.callId, resolve))
        approvalsRef.current.delete(event.callId)
        if (!approved) {
          updateTool(event.callId, { state: 'declined' })
          await submitAgentToolResult(event.waitId, 'The user declined this action. Ask what they want instead of retrying it.', true)
          return
        }
        updateTool(event.callId, { state: 'running' })
      }
      const outcome = await runAgentTool(event.name, event.input, hostRef.current, defaultNameRef.current)
      if (outcome.revert) revertsRef.current.set(event.callId, outcome.revert)
      updateTool(event.callId, { state: outcome.isError ? 'failed' : 'done', canRevert: outcome.revert !== undefined })
      await submitAgentToolResult(event.waitId, outcome.content, outcome.isError)
    },
    [updateTool],
  )

  const handleEvent = useCallback(
    (event: AgentEventDto) => {
      switch (event.type) {
        case 'sessionStarted':
          rememberSession(rootPath, event.sessionId)
          setSessionId(event.sessionId)
          setTitle(event.title)
          return
        case 'textDelta':
          setItems((current) => {
            const last = current[current.length - 1]
            if (last?.kind === 'assistant' && last.streaming) {
              return [...current.slice(0, -1), { ...last, text: last.text + event.text }]
            }
            return [...current, { kind: 'assistant', id: nextItemId('assistant'), text: event.text, streaming: true, atMs: Date.now() }]
          })
          return
        case 'toolCallRequested':
          void handleToolCall(event)
          return
        case 'toolCallFinished':
          return
        case 'contextCompacted':
          setItems((current) => [
            ...current.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item)),
            { kind: 'notice', id: nextItemId('notice'), tone: 'info', text: t('agent.notice.compacted') },
          ])
          return
      }
    },
    [handleToolCall, rootPath, t],
  )

  const send = useCallback(
    async (text: string, context: AgentContextInput[]) => {
      const trimmed = text.trim()
      if (trimmed === '' || runIdRef.current !== null || providerId === null) return
      const runId = crypto.randomUUID()
      runIdRef.current = runId
      setRunning(true)
      setItems((current) => [...current, { kind: 'user', id: nextItemId('user'), text: trimmed, context, atMs: Date.now() }])
      const result = await startAgentTurn(
        { runId, rootPath, sessionId, providerId, model, text: trimmed, context, language },
        handleEvent,
      )
      runIdRef.current = null
      declinePendingApprovals()
      setRunning(false)
      setItems((current) => {
        const settled = current.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item))
        if (!result.ok) return [...settled, { kind: 'notice', id: nextItemId('notice'), tone: 'error', text: agentErrorMessage(result.error, t) }]
        const stop = result.value.stopReason
        if (stop === 'endTurn') return settled
        return [...settled, { kind: 'notice', id: nextItemId('notice'), tone: 'info', text: t(`agent.stop.${stop}`) }]
      })
      if (result.ok) setSessionId(result.value.sessionId)
    },
    [declinePendingApprovals, handleEvent, language, model, providerId, rootPath, sessionId, t],
  )

  const stop = useCallback(() => {
    const runId = runIdRef.current
    if (runId === null) return
    declinePendingApprovals()
    void cancelAgentTurn(runId)
  }, [declinePendingApprovals])

  const resolveApproval = useCallback((callId: string, approved: boolean) => {
    approvalsRef.current.get(callId)?.(approved)
  }, [])

  // Switching to auto-approval also approves what is already waiting.
  useEffect(() => {
    if (!autoApprove) return
    for (const [callId, resolve] of approvalsRef.current) {
      updateTool(callId, { autoApproved: true })
      resolve(true)
    }
  }, [autoApprove, updateTool])

  const revert = useCallback(
    (callId: string) => {
      const undo = revertsRef.current.get(callId)
      if (!undo) return
      undo()
      revertsRef.current.delete(callId)
      updateTool(callId, { state: 'reverted', canRevert: false })
    },
    [updateTool],
  )

  const newChat = useCallback(() => {
    if (runIdRef.current !== null) return
    setItems([])
    setSessionId(null)
    setTitle(null)
    revertsRef.current.clear()
    rememberSession(rootPath, null)
  }, [rootPath])

  /** Shows a saved chat and remembers it as the workspace's open chat. */
  const applyView = useCallback(
    (view: AgentSessionViewDto) => {
      rememberSession(rootPath, view.id)
      revertsRef.current.clear()
      setSessionId(view.id)
      setTitle(view.title)
      setItems([
        ...(view.omittedItems > 0 ? [{ kind: 'notice' as const, id: nextItemId('notice'), tone: 'info' as const, text: t('agent.history.omitted', { count: view.omittedItems }) }] : []),
        ...view.items.map((item): AgentChatItem => {
          switch (item.kind) {
            case 'user':
              return { kind: 'user', id: nextItemId('user'), text: item.text, context: [], atMs: item.atMs }
            case 'assistant':
              return { kind: 'assistant', id: nextItemId('assistant'), text: item.text, streaming: false, atMs: item.atMs }
            case 'tool':
              return {
                kind: 'tool',
                id: item.callId,
                name: item.name,
                toolClass: 'read',
                summary: summarizeToolCall(item.name, item.input, null),
                state: item.isError ? 'failed' : 'done',
                canRevert: false,
                autoApproved: false,
              }
          }
        }),
      ])
    },
    [rootPath, t],
  )

  const openSession = useCallback(
    async (id: string) => {
      if (runIdRef.current !== null) return
      const result = await loadAgentSession(rootPath, id)
      if (result.ok) applyView(result.value)
      else setItems((current) => [...current, { kind: 'notice', id: nextItemId('notice'), tone: 'error', text: agentErrorMessage(result.error, t) }])
    },
    [applyView, rootPath, t],
  )

  // Bring back the chat last open in this workspace when the panel mounts.
  // A remembered chat that no longer exists is forgotten quietly.
  useEffect(() => {
    const id = rememberedSession(rootPath)
    if (id === null) return
    let cancelled = false
    void loadAgentSession(rootPath, id).then((result) => {
      if (cancelled || runIdRef.current !== null) return
      if (result.ok) applyView(result.value)
      else rememberSession(rootPath, null)
    })
    return () => {
      cancelled = true
    }
    // Only once per workspace: later changes come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  // A turn left running when the panel goes away (or the workspace changes) is cancelled.
  useEffect(
    () => () => {
      const runId = runIdRef.current
      for (const resolve of approvalsRef.current.values()) resolve(false)
      if (runId !== null) void cancelAgentTurn(runId)
    },
    [rootPath],
  )

  return { items, running, sessionId, title, send, stop, approve: (callId: string) => resolveApproval(callId, true), decline: (callId: string) => resolveApproval(callId, false), revert, newChat, openSession }
}
