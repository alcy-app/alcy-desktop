import { useCallback, useRef, useState } from 'react'
import type { ScopedVariableChange } from '../../bindings/execute-graphql-request'
import { cancelFlow } from '../../bindings/cancel-flow'
import { executeFlow } from '../../bindings/execute-flow'
import type { ExecuteFlowError, FlowNodeSkipReasonDto, FlowRunEventDto } from '../../bindings/execute-flow'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { useLanguage } from '../../shared/i18n/use-language'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { useToast } from '../../shared/ui/use-toast'
import type { FlowEdgeState, FlowNodeState } from './flows.types'
import { traversedEdgeIds } from './flow-run-trail'
import { nodeStatusFromEvent } from './replay-run'
import { applyEventToLog, startLogEntry } from './run-log'
import type { RunLogEntry } from './run-log'
import { dtoFromFlowNode } from './use-flows-state'

export type NodeRunStatus =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'success'; statusCode: number; durationMs: number }
  /** `message`: explicação dos blocos de mock com duas saídas (spec 0121). */
  | { status: 'branched'; result: boolean; message?: string | null }
  | { status: 'failed'; message: string }
  /** `log`/`display`/`setVariables`/`sleep` concluído; `message` já mascarado. */
  | { status: 'completed'; message: string | null }
  /** `while` rodando a iteração `iteration`. */
  | { status: 'looping'; iteration: number }
  | { status: 'loopFinished'; iterations: number }
  | { status: 'cancelled' }
  | { status: 'skipped'; reason: FlowNodeSkipReasonDto }

interface UseFlowRunParams {
  rootPath: string
  flowName: string
  /** Chamado quando o run termina (o backend já gravou o histórico). */
  onRunFinished?: () => void
  /** Variáveis de ambiente gravadas pelos scripts durante o run. */
  onEnvironmentChanges?: (changes: { name: string; value: string | null }[]) => void
  /** Variáveis de coleção/pasta gravadas pelos scripts durante o run (ADR 0031). */
  onScopedChanges?: (changes: ScopedVariableChange[]) => void
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

/** Motor de execução (spec 0043) só é acionado por aqui — nenhum status
 * entra em `FlowNodeState`/`onChange`, então um run nunca é persistido em
 * `alcy-flows.json` (decisão de escopo da spec seguinte). */
export function useFlowRun({
  rootPath,
  flowName,
  onRunFinished,
  onEnvironmentChanges,
  onScopedChanges,
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
    // Snapshot do grafo enviado ao backend: o rastro é do que está rodando,
    // não de edições feitas no canvas durante o run. Como `statuses`, é
    // limpo só ao iniciar um novo run, e nunca persistido.
    const runEdges = edges
    // O motor não emite evento para o Start (só para o que ele alcança), então
    // as edges que saem dele são percorridas por definição — marcadas quando
    // o primeiro evento chega, para não acender nada se o run falhar antes de
    // começar (grafo inválido).
    const startIds = new Set(nodes.filter((node) => node.kind === 'start').map((node) => node.id))
    const startEdgeIds = runEdges.filter((edge) => startIds.has(edge.sourceNodeId)).map((edge) => edge.id)
    let receivedFirstEvent = false

    void executeFlow(
      {
        flowExecutionId,
        rootPath,
        flowName,
        nodes: nodes.map(dtoFromFlowNode),
        edges,
        environmentVariables,
      },
      (event: FlowRunEventDto) => {
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
          // O Start não é reportado pelo motor; entra no log junto do primeiro evento.
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
      // erro de pré-execução: zero eventos foram emitidos, `runFinished` nunca chega
      setIsRunning(false)
      showToast(t('flows.canvas.runErrorToast', { message: errorMessage(result.error, t) }), 'error')
    })
  }, [nodes, edges, environmentVariables, rootPath, flowName, onRunFinished, onEnvironmentChanges, onScopedChanges, showToast, t])

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
  // Rejeição não tem a forma de `ExecuteFlowError` (ex.: erro de
  // desserialização do próprio Tauri, ou algo lançado antes do command
  // devolver um `Result`) — mostra o valor bruto em vez de "undefined".
  return typeof error === 'string' ? error : JSON.stringify(error)
}
