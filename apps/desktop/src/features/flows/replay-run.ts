import type { FlowRunEventDto } from '../../bindings/execute-flow'
import type { TimedFlowRunEventDto } from '../../bindings/get-flow-run-history'
import type { FlowEdgeState, FlowNodeState } from './flows.types'
import { traversedEdgeIds } from './flow-run-trail'
import { applyEventToLog, startLogEntry } from './run-log'
import type { RunLogEntry } from './run-log'
import type { NodeRunStatus } from './use-flow-run'

/** Status update defined by an event, or null for log-only events. Shared by live execution and history replay. */
export function nodeStatusFromEvent(event: FlowRunEventDto): { nodeId: string; status: NodeRunStatus } | null {
  switch (event.type) {
    case 'nodeWaitingForHuman':
      return { nodeId: event.nodeId, status: { status: 'waitingForHuman', waitId: event.waitId } }
    case 'nodeFormSubmitted':
      return { nodeId: event.nodeId, status: { status: 'running' } }
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

/** Reconstruct recorded status, traversed edges and log entries using timestamped events and the live reducers. */
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
      // The engine omits Start; its log entry and outgoing trail appear with the first event.
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
