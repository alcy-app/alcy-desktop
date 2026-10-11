import { describe, expect, it } from 'vitest'
import type { TimedFlowRunEventDto } from '../../bindings/get-flow-run-history'
import type { FlowEdgeState, FlowNodeState } from './flows.types'
import { nodeStatusFromEvent, replayRun } from './replay-run'

const nodes: FlowNodeState[] = [
  { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
  { id: 'a', kind: 'request', requestId: 'r1', position: { x: 1, y: 0 } },
  { id: 'b', kind: 'request', requestId: 'r2', position: { x: 2, y: 0 } },
]
const edges: FlowEdgeState[] = [
  { id: 'e0', sourceNodeId: 'start', targetNodeId: 'a' },
  { id: 'e1', sourceNodeId: 'a', targetNodeId: 'b', sourceHandle: 'success' },
  { id: 'e2', sourceNodeId: 'a', targetNodeId: 'b', sourceHandle: 'failure' },
]

const events: TimedFlowRunEventDto[] = [
  { atMs: 100, event: { type: 'nodeStarted', nodeId: 'a' } },
  {
    atMs: 110,
    event: { type: 'nodeCallResolved', nodeId: 'a', requestUrl: '{{u}}', resolvedUrl: 'https://x', variables: [] },
  },
  { atMs: 150, event: { type: 'nodeSucceeded', nodeId: 'a', statusCode: 200, durationMs: 40 } },
  { atMs: 151, event: { type: 'nodeSkipped', nodeId: 'b', reason: 'branchNotTaken' } },
]

describe('replayRun', () => {
  const replayed = replayRun(nodes, edges, events, 90)

  it('rebuilds node statuses from the events', () => {
    expect(replayed.statuses.a).toEqual({ status: 'success', statusCode: 200, durationMs: 40 })
    expect(replayed.statuses.b).toEqual({ status: 'skipped', reason: 'branchNotTaken' })
  })

  it('lights the start edges and only the taken output edges', () => {
    expect([...replayed.traversedEdges].sort()).toEqual(['e0', 'e1'])
  })

  it('logs the start node then each reached node with the recorded times', () => {
    expect(replayed.logEntries.map((entry) => entry.nodeId)).toEqual(['start', 'a'])
    const entry = replayed.logEntries[1]
    expect(entry.startedAtMs).toBe(100)
    expect(entry.finishedAtMs).toBe(150)
    expect(entry.call?.resolvedUrl).toBe('https://x')
  })

  it('returns an empty state for a run without events', () => {
    const empty = replayRun(nodes, edges, [], 0)
    expect(empty.logEntries).toEqual([])
    expect(empty.traversedEdges.size).toBe(0)
  })
})

describe('replayRun with a display node', () => {
  it('keeps the displayed value as the node status', () => {
    const replayed = replayRun(
      [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'show', kind: 'display', template: '{{token}}', position: { x: 1, y: 0 } },
      ],
      [{ id: 'e0', sourceNodeId: 'start', targetNodeId: 'show' }],
      [{ atMs: 5, event: { type: 'nodeCompleted', nodeId: 'show', message: '••••••••' } }],
      0,
    )
    expect(replayed.statuses.show).toEqual({ status: 'completed', message: '••••••••' })
  })
})

describe('replayRun with a while node', () => {
  it('keeps the final loop status and lights both outputs that were taken', () => {
    const replayed = replayRun(
      [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'w', kind: 'while', condition: { left: '{{i}}', operator: 'lessThan', right: '2' }, maxIterations: 10, position: { x: 1, y: 0 } },
        { id: 'log', kind: 'log', message: '{{i}}', position: { x: 2, y: 0 } },
        { id: 'end', kind: 'log', message: 'fim', position: { x: 3, y: 0 } },
      ],
      [
        { id: 'e0', sourceNodeId: 'start', targetNodeId: 'w' },
        { id: 'e1', sourceNodeId: 'w', targetNodeId: 'log', sourceHandle: 'loop' },
        { id: 'e2', sourceNodeId: 'w', targetNodeId: 'end', sourceHandle: 'done' },
      ],
      [
        { atMs: 1, event: { type: 'nodeLoopIteration', nodeId: 'w', iteration: 1 } },
        { atMs: 2, event: { type: 'nodeCompleted', nodeId: 'log', message: '1' } },
        { atMs: 3, event: { type: 'nodeLoopFinished', nodeId: 'w', iterations: 1 } },
        { atMs: 4, event: { type: 'nodeCompleted', nodeId: 'end', message: 'fim' } },
      ],
      0,
    )
    expect(replayed.statuses.w).toEqual({ status: 'loopFinished', iterations: 1 })
    expect([...replayed.traversedEdges].sort()).toEqual(['e0', 'e1', 'e2'])
  })
})

describe('nodeStatusFromEvent', () => {
  it('ignores call-resolved events', () => {
    expect(
      nodeStatusFromEvent({ type: 'nodeCallResolved', nodeId: 'a', requestUrl: '', resolvedUrl: '', variables: [] }),
    ).toBeNull()
  })
})
