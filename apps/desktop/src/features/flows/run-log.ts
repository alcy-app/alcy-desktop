import type { CallVariableDto, FlowRunEventDto } from '../../bindings/execute-flow'
import type { NodeRunStatus } from './use-flow-run'

/** Request call details: saved URL template, resolved URL and variable values at dispatch. */
export interface RunLogCall {
  requestUrl: string
  resolvedUrl: string
  variables: CallVariableDto[]
}

/** One entry per reached node, in execution order. finishedAtMs stays null while the node is active. */
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
      // Only reached nodes enter the log; untaken, unreachable and cancelled-before-start nodes did not run.
      return event.reason === 'notRunnable' ? { status: 'skipped', reason: 'notRunnable' } : null
    default:
      return null
  }
}

/** Initial entry for Start, which the engine does not report. */
export function startLogEntry(nodeId: string, nowMs: number): RunLogEntry {
  return { nodeId, startedAtMs: nowMs, finishedAtMs: nowMs, status: { status: 'skipped', reason: 'notRunnable' } }
}

/** Apply a run event without mutating the input array. */
export function applyEventToLog(entries: RunLogEntry[], event: FlowRunEventDto, nowMs: number): RunLogEntry[] {
  if (event.type === 'nodeWaitingForHuman' || event.type === 'nodeFormSubmitted') {
    return entries.map((entry) => entry.nodeId === event.nodeId && entry.finishedAtMs === null ? { ...entry, status: event.type === 'nodeWaitingForHuman' ? { status: 'waitingForHuman', waitId: event.waitId } : { status: 'running' } } : entry)
  }
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

/** Engine duration when available, otherwise the observed frontend interval; null while active. */
export function entryDurationMs(entry: RunLogEntry): number | null {
  if (entry.status.status === 'success') return entry.status.durationMs
  if (entry.finishedAtMs === null) return null
  return Math.max(0, entry.finishedAtMs - entry.startedAtMs)
}
