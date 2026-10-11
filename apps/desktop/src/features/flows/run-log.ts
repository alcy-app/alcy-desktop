import type { CallVariableDto, FlowRunEventDto } from '../../bindings/execute-flow'
import type { NodeRunStatus } from './use-flow-run'

/** URL chamada por um node de requisição naquele run: a template como estava
 * salva, a enviada e o valor de cada variável no momento da chamada. */
export interface RunLogCall {
  requestUrl: string
  resolvedUrl: string
  variables: CallVariableDto[]
}

/** Uma linha do log de um Run: um node por entrada, na ordem em que o run o
 * alcançou. `finishedAtMs` é `null` enquanto o node ainda executa. */
export interface RunLogEntry {
  nodeId: string
  startedAtMs: number
  finishedAtMs: number | null
  status: NodeRunStatus
  call?: RunLogCall
}

function finishedStatus(event: FlowRunEventDto): NodeRunStatus | null {
  switch (event.type) {
    case 'nodeSucceeded':
      return { status: 'success', statusCode: event.statusCode, durationMs: event.durationMs }
    case 'nodeBranched':
      return { status: 'branched', result: event.result, message: event.message ?? null }
    case 'nodeFailed':
      return { status: 'failed', message: event.message }
    case 'nodeCompleted':
      return { status: 'completed', message: event.message }
    case 'nodeLoopIteration':
      return { status: 'looping', iteration: event.iteration }
    case 'nodeLoopFinished':
      return { status: 'loopFinished', iterations: event.iterations }
    case 'nodeCancelled':
      return { status: 'cancelled' }
    case 'nodeSkipped':
      // Só entra no log o que o run de fato atravessou: nodes pulados (ramo não
      // tomado, inalcançável, run cancelado antes de começar) não foram executados.
      return event.reason === 'notRunnable' ? { status: 'skipped', reason: 'notRunnable' } : null
    default:
      return null
  }
}

/** Entrada inicial do log para um node que o motor não reporta (o Start). */
export function startLogEntry(nodeId: string, nowMs: number): RunLogEntry {
  return { nodeId, startedAtMs: nowMs, finishedAtMs: nowMs, status: { status: 'skipped', reason: 'notRunnable' } }
}

/** Aplica um evento do run ao log, sem mutar o array recebido. */
export function applyEventToLog(entries: RunLogEntry[], event: FlowRunEventDto, nowMs: number): RunLogEntry[] {
  if (event.type === 'runFinished' || event.type === 'scriptsFinished') return entries

  if (event.type === 'nodeStarted') {
    return [...entries, { nodeId: event.nodeId, startedAtMs: nowMs, finishedAtMs: null, status: { status: 'running' } }]
  }

  if (event.type === 'nodeCallResolved') {
    const call = { requestUrl: event.requestUrl, resolvedUrl: event.resolvedUrl, variables: event.variables }
    return entries.map((entry) => (entry.nodeId === event.nodeId && entry.finishedAtMs === null ? { ...entry, call } : entry))
  }

  const status = finishedStatus(event)
  if (!status) return entries

  const openIndex = entries.findIndex((entry) => entry.nodeId === event.nodeId && entry.finishedAtMs === null)
  if (openIndex === -1) {
    return [...entries, { nodeId: event.nodeId, startedAtMs: nowMs, finishedAtMs: nowMs, status }]
  }
  return entries.map((entry, index) => (index === openIndex ? { ...entry, finishedAtMs: nowMs, status } : entry))
}

/** Duração exibida: a medida pelo motor quando há (resposta recebida), senão o
 * intervalo observado no frontend; `null` enquanto o node ainda executa. */
export function entryDurationMs(entry: RunLogEntry): number | null {
  if (entry.status.status === 'success') return entry.status.durationMs
  if (entry.finishedAtMs === null) return null
  return Math.max(0, entry.finishedAtMs - entry.startedAtMs)
}
