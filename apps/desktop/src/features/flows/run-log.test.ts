import { describe, expect, it } from 'vitest'
import { applyEventToLog, entryDurationMs, startLogEntry } from './run-log'
import type { RunLogEntry } from './run-log'

describe('applyEventToLog', () => {
  it('opens an entry when a node starts and closes it when it finishes', () => {
    const started = applyEventToLog([], { type: 'nodeStarted', nodeId: 'req' }, 100)
    expect(started).toEqual([{ nodeId: 'req', startedAtMs: 100, finishedAtMs: null, status: { status: 'running' } }])

    const finished = applyEventToLog(started, { type: 'nodeSucceeded', nodeId: 'req', statusCode: 200, durationMs: 40 }, 150)
    expect(finished).toEqual([
      { nodeId: 'req', startedAtMs: 100, finishedAtMs: 150, status: { status: 'success', statusCode: 200, durationMs: 40 } },
    ])
  })

  it('attaches the called url and its variables to the open entry and keeps them after it finishes', () => {
    const started = applyEventToLog([], { type: 'nodeStarted', nodeId: 'req' }, 100)
    const call = {
      requestUrl: '{{baseUrl}}/users',
      resolvedUrl: 'https://api.example.com/users',
      variables: [{ name: 'baseUrl', value: 'https://api.example.com', sensitive: false }],
    }
    const withCall = applyEventToLog(started, { type: 'nodeCallResolved', nodeId: 'req', ...call }, 101)
    const finished = applyEventToLog(withCall, { type: 'nodeSucceeded', nodeId: 'req', statusCode: 200, durationMs: 5 }, 120)

    expect(finished[0].call).toEqual(call)
  })

  it('creates a closed entry for nodes that never report a start', () => {
    const entries = applyEventToLog([], { type: 'nodeBranched', nodeId: 'if', result: false }, 10)
    expect(entries).toEqual([{ nodeId: 'if', startedAtMs: 10, finishedAtMs: 10, status: { status: 'branched', result: false, message: null } }])
  })

  it('keeps the explanation of a mock block with two outputs', () => {
    const started = applyEventToLog([], { type: 'nodeStarted', nodeId: 'wait' }, 1)
    const finished = applyEventToLog(
      started,
      { type: 'nodeBranched', nodeId: 'wait', result: false, message: 'nenhuma chamada em POST /users em 30000 ms' },
      30,
    )
    expect(finished[0].status).toEqual({ status: 'branched', result: false, message: 'nenhuma chamada em POST /users em 30000 ms' })
  })

  it('keeps traversed generic blocks but drops every node that was not executed', () => {
    const kept = applyEventToLog([], { type: 'nodeSkipped', nodeId: 'blk', reason: 'notRunnable' }, 1)
    expect(kept).toHaveLength(1)
    for (const reason of ['branchNotTaken', 'unreachable', 'cancelled'] as const) {
      expect(applyEventToLog(kept, { type: 'nodeSkipped', nodeId: 'x', reason }, 2)).toBe(kept)
    }
  })

  it('ignores runFinished and does not mutate the previous entries', () => {
    const before: RunLogEntry[] = [startLogEntry('start', 0)]
    expect(applyEventToLog(before, { type: 'runFinished', cancelled: false }, 5)).toBe(before)
    applyEventToLog(before, { type: 'nodeStarted', nodeId: 'x' }, 5)
    expect(before).toHaveLength(1)
  })

  it('closes a sleep entry as completed and logs the message of a log node', () => {
    const started = applyEventToLog([], { type: 'nodeStarted', nodeId: 'sleep' }, 100)
    const slept = applyEventToLog(started, { type: 'nodeCompleted', nodeId: 'sleep', message: null }, 1100)
    expect(slept).toEqual([{ nodeId: 'sleep', startedAtMs: 100, finishedAtMs: 1100, status: { status: 'completed', message: null } }])

    const logged = applyEventToLog(slept, { type: 'nodeCompleted', nodeId: 'log', message: 'status 200' }, 1101)
    expect(logged[1]).toEqual({
      nodeId: 'log',
      startedAtMs: 1101,
      finishedAtMs: 1101,
      status: { status: 'completed', message: 'status 200' },
    })
  })

  it('adds one closed entry per while iteration and reopens body nodes each time', () => {
    let entries: RunLogEntry[] = []
    for (const iteration of [1, 2]) {
      entries = applyEventToLog(entries, { type: 'nodeLoopIteration', nodeId: 'while', iteration }, iteration * 10)
      entries = applyEventToLog(entries, { type: 'nodeStarted', nodeId: 'sleep' }, iteration * 10 + 1)
      entries = applyEventToLog(entries, { type: 'nodeCompleted', nodeId: 'sleep', message: null }, iteration * 10 + 5)
    }
    entries = applyEventToLog(entries, { type: 'nodeLoopFinished', nodeId: 'while', iterations: 2 }, 30)

    expect(entries.map((entry) => [entry.nodeId, entry.status.status])).toEqual([
      ['while', 'looping'],
      ['sleep', 'completed'],
      ['while', 'looping'],
      ['sleep', 'completed'],
      ['while', 'loopFinished'],
    ])
    expect(entries.every((entry) => entry.finishedAtMs !== null)).toBe(true)
  })

  it('records failures with their message', () => {
    const entries = applyEventToLog([], { type: 'nodeFailed', nodeId: 'req', message: 'boom' }, 7)
    expect(entries[0].status).toEqual({ status: 'failed', message: 'boom' })
  })
})

describe('entryDurationMs', () => {
  it('prefers the duration measured by the engine', () => {
    expect(entryDurationMs({ nodeId: 'r', startedAtMs: 0, finishedAtMs: 900, status: { status: 'success', statusCode: 200, durationMs: 40 } })).toBe(40)
  })

  it('falls back to the observed interval and is null while running', () => {
    expect(entryDurationMs({ nodeId: 'r', startedAtMs: 100, finishedAtMs: 130, status: { status: 'failed', message: 'x' } })).toBe(30)
    expect(entryDurationMs({ nodeId: 'r', startedAtMs: 100, finishedAtMs: null, status: { status: 'running' } })).toBeNull()
  })
})
