import { notifyWhenUnfocused } from '../../bindings/system-notification'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCommandError } from '../../bindings/agent-settings'
import { loadAgentSession, type AgentSessionViewDto } from '../../bindings/agent-sessions'
import {
  cancelAgentTurn,
  compactAgentSession,
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
import { toolLabel } from './agent-tool-labels'

export type AgentToolState = 'running' | 'awaitingApproval' | 'done' | 'failed' | 'declined' | 'reverted'

export type AgentChatItem =
  /** `atMs`: when the message was sent or started arriving; unknown in older chats. */
  /** `sent`: the message reached the saved transcript (false until its turn starts). */
  | { kind: 'user'; id: string; text: string; context: AgentContextInput[]; atMs?: number; sent?: boolean }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; atMs?: number }
  | { kind: 'tool'; id: string; name: string; toolClass: AgentToolClass; summary: string; state: AgentToolState; canRevert: boolean; autoApproved: boolean }
  /** `retry`: the turn failed and its message can be sent again. */
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string; retry?: boolean }
  /** Tokens one turn used, shown after its reply. */
  | { kind: 'usage'; id: string; input: number; output: number }

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
const NO_TOKENS = { input: 0, output: 0 }

function lastUserIndex(items: AgentChatItem[]): number {
  return items.findLastIndex((item) => item.kind === 'user')
}

export function useAgentSession({ rootPath, host, providerId, model, defaultRequestName, autoApprove }: UseAgentSessionOptions) {
  const { t, language } = useLanguage()
  const [items, setItems] = useState<AgentChatItem[]>([])
  const [running, setRunning] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  /** Every token the chat used, also of turns replaced by a retry or an edit. */
  const [tokens, setTokens] = useState(NO_TOKENS)
  const runIdRef = useRef<string | null>(null)
  const viewRevisionRef = useRef(0)
  const approvalsRef = useRef(new Map<string, (approved: boolean) => void>())
  const revertsRef = useRef(new Map<string, () => void | boolean>())
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
      let fingerprint: string | undefined
      try { if (needsApproval) fingerprint = hostRef.current.resources?.fingerprint(event.name, event.input) } catch { /* Invalid targets are reported by the executor. */ }
      const summary = summarizeToolCall(event.name, event.input, hostRef.current)
      setItems((current) => [
        ...current.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item)),
        {
          kind: 'tool',
          id: event.callId,
          name: event.name,
          toolClass: event.class,
          summary,
          state: needsApproval ? 'awaitingApproval' : 'running',
          canRevert: false,
          autoApproved: gated && !needsApproval,
        },
      ])
      if (needsApproval) {
        // Someone working in another window learns that the chat is waiting for them.
        void notifyWhenUnfocused(t('agent.notify.approvalTitle'), [toolLabel(event.name, t), summary].filter(Boolean).join(' · '))
        const approved = await new Promise<boolean>((resolve) => approvalsRef.current.set(event.callId, resolve))
        approvalsRef.current.delete(event.callId)
        if (!approved) {
          updateTool(event.callId, { state: 'declined' })
          await submitAgentToolResult(event.waitId, 'The user declined this action. Ask what they want instead of retrying it.', true)
          return
        }
        updateTool(event.callId, { state: 'running' })
      }
      if (fingerprint !== undefined) {
        let current: string | undefined
        try { current = hostRef.current.resources?.fingerprint(event.name, event.input) } catch { current = undefined }
        if (current !== fingerprint) {
          updateTool(event.callId, { state: 'failed' })
          await submitAgentToolResult(event.waitId, 'The resource changed while awaiting approval. Read it again and propose an updated action.', true)
          return
        }
      }
      const outcome = await runAgentTool(event.name, event.input, hostRef.current, defaultNameRef.current)
      if (outcome.revert) revertsRef.current.set(event.callId, outcome.revert)
      updateTool(event.callId, { state: outcome.isError ? 'failed' : 'done', canRevert: outcome.revert !== undefined })
      await submitAgentToolResult(event.waitId, outcome.content, outcome.isError)
    },
    [t, updateTool],
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
        case 'titleChanged':
          setTitle(event.title)
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

  /**
   * `replaceLast` sends the text in place of the user's last message and what
   * followed it; the saved transcript changes only when that message reached it.
   */
  const startTurn = useCallback(
    async (text: string, context: AgentContextInput[], replaceLast: boolean) => {
      const trimmed = text.trim()
      if (trimmed === '' || runIdRef.current !== null || providerId === null) return
      const runId = crypto.randomUUID()
      runIdRef.current = runId
      setRunning(true)
      const userId = nextItemId('user')
      const replaced = replaceLast ? items[lastUserIndex(items)] : undefined
      const replaceLastTurn = replaced?.kind === 'user' && replaced.sent !== false
      setItems((current) => {
        const last = replaceLast ? lastUserIndex(current) : -1
        return [...(last >= 0 ? current.slice(0, last) : current), { kind: 'user', id: userId, text: trimmed, context, atMs: Date.now(), sent: false }]
      })
      const result = await startAgentTurn(
        { runId, rootPath, sessionId, providerId, model, text: trimmed, context, language, replaceLastTurn, documentsEnabled: FEATURE_FLAGS.documents },
        (event) => {
          // The message is in the transcript once its turn starts.
          if (event.type === 'sessionStarted') setItems((current) => current.map((item) => (item.id === userId && item.kind === 'user' ? { ...item, sent: true } : item)))
          handleEvent(event)
        },
      )
      runIdRef.current = null
      declinePendingApprovals()
      setRunning(false)
      setItems((current) => {
        const settled = current.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item))
        if (!result.ok) return [...settled, { kind: 'notice', id: nextItemId('notice'), tone: 'error', text: agentErrorMessage(result.error, t), retry: true }]
        const { stopReason: stop, inputTokens, outputTokens } = result.value
        const withUsage: AgentChatItem[] = inputTokens + outputTokens > 0
          ? [...settled, { kind: 'usage', id: nextItemId('usage'), input: inputTokens, output: outputTokens }]
          : settled
        if (stop === 'endTurn') return withUsage
        return [...withUsage, { kind: 'notice', id: nextItemId('notice'), tone: 'info', text: t(`agent.stop.${stop}`) }]
      })
      if (result.ok) setTokens((current) => ({ input: current.input + result.value.inputTokens, output: current.output + result.value.outputTokens }))
      if (result.ok) setSessionId(result.value.sessionId)
    },
    [declinePendingApprovals, handleEvent, items, language, model, providerId, rootPath, sessionId, t],
  )

  const send = useCallback((text: string, context: AgentContextInput[]) => startTurn(text, context, false), [startTurn])

  const compact = useCallback(async () => {
    if (runIdRef.current !== null || providerId === null || sessionId === null) return
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setRunning(true)
    setCompacting(true)
    const result = await compactAgentSession({ runId, rootPath, sessionId, providerId, model })
    runIdRef.current = null
    setRunning(false)
    setCompacting(false)
    setItems((current) => {
      if (!result.ok) return [...current, { kind: 'notice', id: nextItemId('notice'), tone: 'error', text: agentErrorMessage(result.error, t) }]
      const { compacted, cancelled, inputTokens, outputTokens } = result.value
      const text = cancelled ? t('agent.stop.cancelled') : t(compacted ? 'agent.command.compacted' : 'agent.command.unchanged')
      return [
        ...current,
        { kind: 'notice', id: nextItemId('notice'), tone: 'info', text },
        ...(inputTokens + outputTokens > 0 ? [{ kind: 'usage' as const, id: nextItemId('usage'), input: inputTokens, output: outputTokens }] : []),
      ]
    })
    if (result.ok) setTokens((current) => ({ input: current.input + result.value.inputTokens, output: current.output + result.value.outputTokens }))
  }, [model, providerId, rootPath, sessionId, t])

  /** Sends the last message again after its turn failed. */
  const retry = useCallback(() => {
    const last = items[lastUserIndex(items)]
    if (last?.kind === 'user') void startTurn(last.text, last.context, true)
  }, [items, startTurn])

  /** Sends an edited version of the last message in its place. */
  const editLast = useCallback(
    (text: string) => {
      const last = items[lastUserIndex(items)]
      if (last?.kind === 'user') void startTurn(text, last.context, true)
    },
    [items, startTurn],
  )

  const stop = useCallback(() => {
    const runId = runIdRef.current
    if (runId === null) return
    declinePendingApprovals()
    hostRef.current.resources?.cancelReads?.()
    hostRef.current.documents?.cancel()
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
      if (undo() === false) {
        updateTool(callId, { canRevert: false })
        revertsRef.current.delete(callId)
        return
      }
      revertsRef.current.delete(callId)
      updateTool(callId, { state: 'reverted', canRevert: false })
    },
    [updateTool],
  )

  const newChat = useCallback(() => {
    if (runIdRef.current !== null) return
    viewRevisionRef.current += 1
    setItems([])
    setTokens(NO_TOKENS)
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
      setTokens(view.totalTokens ?? NO_TOKENS)
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
            case 'usage':
              return { kind: 'usage', id: nextItemId('usage'), input: item.inputTokens, output: item.outputTokens }
          }
        }),
      ])
    },
    [rootPath, t],
  )

  const openSession = useCallback(
    async (id: string) => {
      if (runIdRef.current !== null) return
      const revision = ++viewRevisionRef.current
      const result = await loadAgentSession(rootPath, id)
      if (revision !== viewRevisionRef.current || runIdRef.current !== null) return
      if (result.ok) applyView(result.value)
      else setItems((current) => [...current, { kind: 'notice', id: nextItemId('notice'), tone: 'error', text: agentErrorMessage(result.error, t) }])
    },
    [applyView, rootPath, t],
  )

  // Bring back the chat last open in this workspace when the panel mounts
  // during the same app run. A remembered chat that no longer exists is
  // forgotten quietly.
  useEffect(() => {
    const id = rememberedSession(rootPath)
    if (id === null) return
    const revision = viewRevisionRef.current
    let cancelled = false
    void loadAgentSession(rootPath, id).then((result) => {
      if (cancelled || revision !== viewRevisionRef.current || runIdRef.current !== null) return
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
      hostRef.current.resources?.cancelReads?.()
      hostRef.current.documents?.cancel()
      if (runId !== null) void cancelAgentTurn(runId)
    },
    [rootPath],
  )

  return { items, running, compacting, sessionId, title, tokens, send, compact, retry, editLast, stop, approve: (callId: string) => resolveApproval(callId, true), decline: (callId: string) => resolveApproval(callId, false), revert, newChat, openSession }
}
