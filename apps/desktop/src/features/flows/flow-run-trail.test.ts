import { describe, expect, it } from 'vitest'
import type { FlowRunEventDto } from '../../bindings/execute-flow'
import { isVisitedStatus, takenHandleForEvent, traversedEdgeIds } from './flow-run-trail'
import type { FlowEdgeState } from './flows.types'

const edges: FlowEdgeState[] = [
  { id: 'e-ok', sourceNodeId: 'req', targetNodeId: 'a', sourceHandle: 'success' },
  { id: 'e-ko', sourceNodeId: 'req', targetNodeId: 'b', sourceHandle: 'failure' },
  { id: 'e-join', sourceNodeId: 'req', targetNodeId: 'c', sourceHandle: 'success' },
  { id: 'e-start', sourceNodeId: 'start', targetNodeId: 'req' },
  { id: 'e-true', sourceNodeId: 'if', targetNodeId: 'a', sourceHandle: 'true' },
  { id: 'e-false', sourceNodeId: 'if', targetNodeId: 'b', sourceHandle: 'false' },
  { id: 'e-log', sourceNodeId: 'log', targetNodeId: 'a' },
  { id: 'e-loop', sourceNodeId: 'while', targetNodeId: 'a', sourceHandle: 'loop' },
  { id: 'e-done', sourceNodeId: 'while', targetNodeId: 'b', sourceHandle: 'done' },
]

describe('takenHandleForEvent', () => {
  it('maps a response below 400 to success and 400+ to failure', () => {
    expect(takenHandleForEvent({ type: 'nodeSucceeded', nodeId: 'req', statusCode: 204, durationMs: 1 })).toBe('success')
    expect(takenHandleForEvent({ type: 'nodeSucceeded', nodeId: 'req', statusCode: 404, durationMs: 1 })).toBe('failure')
  })

  it('maps failures to failure but a cancellation traverses nothing', () => {
    expect(takenHandleForEvent({ type: 'nodeFailed', nodeId: 'req', message: 'x' })).toBe('failure')
    expect(takenHandleForEvent({ type: 'nodeCancelled', nodeId: 'req' })).toBeNull()
  })

  it('maps a branch result to its handle', () => {
    expect(takenHandleForEvent({ type: 'nodeBranched', nodeId: 'if', result: true })).toBe('true')
    expect(takenHandleForEvent({ type: 'nodeBranched', nodeId: 'if', result: false })).toBe('false')
  })

  it('treats a traversed generic block as a single-output node and ignores other skips', () => {
    expect(takenHandleForEvent({ type: 'nodeSkipped', nodeId: 'blk', reason: 'notRunnable' })).toBeUndefined()
    expect(takenHandleForEvent({ type: 'nodeSkipped', nodeId: 'blk', reason: 'branchNotTaken' })).toBeNull()
    expect(takenHandleForEvent({ type: 'nodeStarted', nodeId: 'req' })).toBeNull()
  })
})

describe('traversedEdgeIds', () => {
  it('returns every edge leaving the node through the taken handle', () => {
    const event: FlowRunEventDto = { type: 'nodeSucceeded', nodeId: 'req', statusCode: 200, durationMs: 1 }
    expect(traversedEdgeIds(event, edges)).toEqual(['e-ok', 'e-join'])
  })

  it('never includes the edge of the branch not taken', () => {
    expect(traversedEdgeIds({ type: 'nodeBranched', nodeId: 'if', result: true }, edges)).toEqual(['e-true'])
  })

  it('follows unlabeled edges for single-output nodes', () => {
    expect(traversedEdgeIds({ type: 'nodeSkipped', nodeId: 'start', reason: 'notRunnable' }, edges)).toEqual(['e-start'])
  })

  it('follows the single output of a completed or failed log node', () => {
    expect(traversedEdgeIds({ type: 'nodeCompleted', nodeId: 'log', message: 'ok' }, edges)).toEqual(['e-log'])
    expect(traversedEdgeIds({ type: 'nodeFailed', nodeId: 'log', message: 'x' }, edges)).toEqual(['e-log'])
  })

  it('lights the loop output on each iteration and the done output when the loop ends', () => {
    expect(traversedEdgeIds({ type: 'nodeLoopIteration', nodeId: 'while', iteration: 2 }, edges)).toEqual(['e-loop'])
    expect(traversedEdgeIds({ type: 'nodeLoopFinished', nodeId: 'while', iterations: 2 }, edges)).toEqual(['e-done'])
  })

  it('returns nothing for events that traverse nothing', () => {
    expect(traversedEdgeIds({ type: 'nodeStarted', nodeId: 'req' }, edges)).toEqual([])
    expect(traversedEdgeIds({ type: 'runFinished', cancelled: false }, edges)).toEqual([])
  })
})

describe('isVisitedStatus', () => {
  it('counts nodes the run went through', () => {
    expect(isVisitedStatus({ status: 'success', statusCode: 200, durationMs: 1 })).toBe(true)
    expect(isVisitedStatus({ status: 'failed', message: 'x' })).toBe(true)
    expect(isVisitedStatus({ status: 'branched', result: true })).toBe(true)
    expect(isVisitedStatus({ status: 'skipped', reason: 'notRunnable' })).toBe(true)
    expect(isVisitedStatus({ status: 'completed', message: null })).toBe(true)
  })

  it('does not count idle, running, cancelled or not-taken nodes', () => {
    expect(isVisitedStatus(undefined)).toBe(false)
    expect(isVisitedStatus({ status: 'idle' })).toBe(false)
    expect(isVisitedStatus({ status: 'running' })).toBe(false)
    expect(isVisitedStatus({ status: 'cancelled' })).toBe(false)
    expect(isVisitedStatus({ status: 'skipped', reason: 'branchNotTaken' })).toBe(false)
  })
})
