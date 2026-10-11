import type { FlowRunEventDto } from '../../bindings/execute-flow'
import type { TimedFlowRunEventDto } from '../../bindings/get-flow-run-history'
import type { FlowEdgeState, FlowNodeState } from './flows.types'
import { traversedEdgeIds } from './flow-run-trail'
import { applyEventToLog, startLogEntry } from './run-log'
import type { RunLogEntry } from './run-log'
import type { NodeRunStatus } from './use-flow-run'

/** Status que um evento define para o node, ou `null` quando ele não muda o
 * status (`nodeCallResolved` só alimenta o log). Compartilhado pelo run ao
 * vivo e pela reexecução de um run do histórico. */
export function nodeStatusFromEvent(event: FlowRunEventDto): { nodeId: string; status: NodeRunStatus } | null {
  switch (event.type) {
    case 'nodeStarted':
      return { nodeId: event.nodeId, status: { status: 'running' } }
    case 'nodeSucceeded':
      return { nodeId: event.nodeId, status: { status: 'success', statusCode: event.statusCode, durationMs: event.durationMs } }
    case 'nodeBranched':
      return { nodeId: event.nodeId, status: { status: 'branched', result: event.result, message: event.message ?? null } }
    case 'nodeFailed':
      return { nodeId: event.nodeId, status: { status: 'failed', message: event.message } }
    case 'nodeCompleted':
      return { nodeId: event.nodeId, status: { status: 'completed', message: event.message } }
    case 'nodeLoopIteration':
      return { nodeId: event.nodeId, status: { status: 'looping', iteration: event.iteration } }
    case 'nodeLoopFinished':
      return { nodeId: event.nodeId, status: { status: 'loopFinished', iterations: event.iterations } }
    case 'nodeCancelled':
      return { nodeId: event.nodeId, status: { status: 'cancelled' } }
    case 'nodeSkipped':
      return { nodeId: event.nodeId, status: { status: 'skipped', reason: event.reason } }
    default:
      return null
  }
}

export interface ReplayedRun {
  statuses: Record<string, NodeRunStatus>
  traversedEdges: ReadonlySet<string>
  logEntries: RunLogEntry[]
}

/** Reconstrói o estado final de um run gravado reaplicando seus eventos, na
 * ordem e com a hora em que chegaram, pelos mesmos passos do run ao vivo
 * (`useFlowRun`): status por node, edges percorridas e log. */
export function replayRun(
  nodes: FlowNodeState[],
  edges: FlowEdgeState[],
  events: TimedFlowRunEventDto[],
  runStartedAtMs: number,
): ReplayedRun {
  const startIds = nodes.filter((node) => node.kind === 'start').map((node) => node.id)
  const startEdgeIds = edges.filter((edge) => startIds.includes(edge.sourceNodeId)).map((edge) => edge.id)

  const statuses: Record<string, NodeRunStatus> = {}
  const traversed = new Set<string>()
  let logEntries: RunLogEntry[] = []
  let receivedFirstEvent = false

  for (const { atMs, event } of events) {
    if (!receivedFirstEvent) {
      receivedFirstEvent = true
      // O motor não reporta o Start: entra no log e acende suas edges junto do primeiro evento.
      startEdgeIds.forEach((id) => traversed.add(id))
      logEntries = startIds.reduce((entries, id) => [...entries, startLogEntry(id, runStartedAtMs)], logEntries)
    }
    logEntries = applyEventToLog(logEntries, event, atMs)
    traversedEdgeIds(event, edges).forEach((id) => traversed.add(id))
    const update = nodeStatusFromEvent(event)
    if (update) statuses[update.nodeId] = update.status
  }

  return { statuses, traversedEdges: traversed, logEntries }
}
