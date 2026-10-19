import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScopedVariableChange } from '../../bindings/execute-graphql-request'
import { cancelFlow } from '../../bindings/cancel-flow'
import { executeFlow } from '../../bindings/execute-flow'
import type { ExecuteFlowError, FlowNodeSkipReasonDto, FlowRunEventDto } from '../../bindings/execute-flow'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { useLanguage } from '../../shared/i18n/use-language'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { useToast } from '../../shared/ui/use-toast'
import type { FlowEdgeState, FlowNodeState } from './flows.types'
import { recordedCallFromEvent } from './flow-call-recording'
import type { FlowRecordedCall } from './flow-call-recording'
import { traversedEdgeIds } from './flow-run-trail'
import { nodeStatusFromEvent } from './replay-run'
import { applyEventToLog, startLogEntry } from './run-log'
import type { RunLogEntry } from './run-log'
import { dtoFromFlowNode } from './use-flows-state'

export type NodeRunStatus =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'success'; statusCode: number; durationMs: number }
  /** `message`: explanation of two-output mock blocks (spec 0121). */
  | { status: 'branched'; result: boolean; message?: string | null }
  | { status: 'failed'; message: string }
  /** `log`/`display`/`setVariables`/`sleep` finished; `message` already masked. */
  | { status: 'completed'; message: string | null }
  /** `while` running iteration `iteration`. */
  | { status: 'looping'; iteration: number }
  | { status: 'loopFinished'; iterations: number }
  | { status: 'cancelled' }
  | { status: 'skipped'; reason: FlowNodeSkipReasonDto }

interface UseFlowRunParams {
  rootPath: string
  flowName: string
  /** Called when the run ends (the backend has already recorded history). */
  onRunFinished?: () => void
  /** Environment variables written by scripts during the run. */
  onEnvironmentChanges?: (changes: { name: string; value: string | null }[]) => void
  /** Collection/folder variables written by scripts during the run (ADR 0031). */
  onScopedChanges?: (changes: ScopedVariableChange[]) => void
  /** Ask for each request node's full exchange; read when a run starts. */
  recordExchanges?: boolean
  /** Each request node call of a run started with `recordExchanges`. */
  onCall?: (call: FlowRecordedCall) => void
  nodes: FlowNodeState[]
  edges: FlowEdgeState[]
  environmentVariables: EnvironmentVariableDto[]
}

type KeyedErrorKind = 'cyclicGraph' | 'missingStartNode' | 'invalidLoopBody'

const ERROR_MESSAGE_KEY: Record<KeyedErrorKind, TranslationKey> = {
  cyclicGraph: 'flows.canvas.runErrorCyclicGraph',
  missingStartNode: 'flows.canvas.runErrorMissingStartNode',
  invalidLoopBody: 'flows.canvas.runErrorInvalidLoopBody',
}

/** The only entry point to the execution engine (spec 0043): no status goes into
 * `FlowNodeState`/`onChange`, so a run is never persisted in `alcy-flows.json`. */
export function useFlowRun({
  rootPath,
  flowName,
  onRunFinished,
  onEnvironmentChanges,
  onScopedChanges,
  recordExchanges = false,
  onCall,
  nodes,
  edges,
  environmentVariables,
}: UseFlowRunParams) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [statuses, setStatuses] = useState<Record<string, NodeRunStatus>>({})
  const [traversedEdges, setTraversedEdges] = useState<ReadonlySet<string>>(() => new Set())
  const [logEntries, setLogEntries] = useState<RunLogEntry[]>([])
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null)
  const [flowExecutionId, setFlowExecutionId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const executionIdRef = useRef<string | null>(null)
  // Latest callback, so a call is reported to the recorder as it is now, not as it was at run start.
  const onCallRef = useRef(onCall)
  useEffect(() => {
    onCallRef.current = onCall
  })

  const run = useCallback(() => {
    const flowExecutionId = crypto.randomUUID()
    executionIdRef.current = flowExecutionId
    setFlowExecutionId(flowExecutionId)
    setStatuses({})
    setTraversedEdges(new Set())
    const runStartedAt = Date.now()
    setRunStartedAtMs(runStartedAt)
    setLogEntries([])
    setIsRunning(true)
    // Snapshot of the graph sent to the backend: the trail is of what is running,
    // not of canvas edits made during the run. Like `statuses`, it is only
    // cleared when a new run starts, and never persisted.
    const runEdges = edges
    // The engine emits no event for Start (only for what it reaches), so its
    // outgoing edges are traversed by definition — marked when the first event
    // arrives, so nothing lights up if the run fails before starting (invalid graph).
    const startIds = new Set(nodes.filter((node) => node.kind === 'start').map((node) => node.id))
    const startEdgeIds = runEdges.filter((edge) => startIds.has(edge.sourceNodeId)).map((edge) => edge.id)
    let receivedFirstEvent = false
    const pendingCalls = recordExchanges ? new Map<string, string>() : null

    void executeFlow(
      {
        flowExecutionId,
        rootPath,
        flowName,
        nodes: nodes.map(dtoFromFlowNode),
        edges,
        environmentVariables,
        recordExchanges,
      },
      (event: FlowRunEventDto) => {
        if (pendingCalls) {
          const call = recordedCallFromEvent(pendingCalls, event, Date.now())
          if (call) onCallRef.current?.(call)
        }
        if (event.type === 'nodeExchange') return
        if (event.type === 'runFinished') {
          setIsRunning(false)
          onRunFinished?.()
          return
        }
        if (event.type === 'scriptsFinished') {
          onEnvironmentChanges?.(event.environmentChanges)
          onScopedChanges?.(event.scopedChanges)
          return
        }
        const traversed = traversedEdgeIds(event, runEdges)
        if (!receivedFirstEvent) {
          receivedFirstEvent = true
          traversed.push(...startEdgeIds)
          // The engine does not report Start; it enters the log with the first event.
          setLogEntries((current) => [...startIds].reduce((entries, id) => [...entries, startLogEntry(id, runStartedAt)], current))
        }
        setLogEntries((current) => applyEventToLog(current, event, Date.now()))
        if (traversed.length > 0) {
          setTraversedEdges((current) => new Set([...current, ...traversed]))
        }
        const update = nodeStatusFromEvent(event)
        if (update) setStatuses((current) => ({ ...current, [update.nodeId]: update.status }))
      },
    ).then((result) => {
      if (result.ok) return
      // Pre-run error: no event was emitted, `runFinished` never arrives.
      setIsRunning(false)
      showToast(t('flows.canvas.runErrorToast', { message: errorMessage(result.error, t) }), 'error')
    })
  }, [nodes, edges, environmentVariables, rootPath, flowName, recordExchanges, onRunFinished, onEnvironmentChanges, onScopedChanges, showToast, t])

  const cancel = useCallback(() => {
    if (!executionIdRef.current) return
    void cancelFlow(executionIdRef.current)
  }, [])

  return { statuses, traversedEdges, logEntries, runStartedAtMs, flowExecutionId, isRunning, run, cancel }
}

function errorMessage(error: ExecuteFlowError, t: (key: TranslationKey, params?: TranslationParams) => string): string {
  if (error && (error.kind === 'invalidGraph' || error.kind === 'storage')) return error.message
  if (error && error.kind in ERROR_MESSAGE_KEY) {
    return t(ERROR_MESSAGE_KEY[error.kind as KeyedErrorKind])
  }
  // A rejection without the `ExecuteFlowError` shape (e.g. a Tauri
  // deserialization error, or something thrown before the command returns a
  // `Result`) shows the raw value instead of "undefined".
  return typeof error === 'string' ? error : JSON.stringify(error)
}
