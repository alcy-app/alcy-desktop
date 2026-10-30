import { describe, expect, it } from 'vitest'
import type { HistoryEntryDetailDto } from '../../bindings/get-history-entry'
import type { HistoryEntrySummaryDto } from '../../bindings/list-history'
import { emptyGrpcCall } from './collection-tree'
import { filterHistory, groupHistoryByDate, historyDetailToContent, historyDetailToExecutionState } from './history'

function summary(id: string, executedAtMs: number): HistoryEntrySummaryDto {
  return {
    origin: 'collection',
    id,
    protocol: 'graphql',
    endpoint: 'https://api.example.com/graphql',
    executedAtMs,
    outcome: { type: 'success', statusCode: 200, durationMs: 12, sizeBytes: 2, responseStored: true },
  }
}

function detail(outcome: HistoryEntryDetailDto['outcome']): HistoryEntryDetailDto {
  return {
    id: 'entry-1',
    protocol: 'graphql',
    endpoint: 'https://api.example.com/graphql',
    method: 'post',
    body: 'query { ping }',
    restBody: null,
    variables: '{}',
    headers: [{ name: 'Accept', value: 'application/json', enabled: true }],
    authentication: { type: 'bearer', token: 'secret' },
    executedAtMs: 1_700_000_000_000,
    outcome,
  }
}

describe('groupHistoryByDate', () => {
  it('groups entries executed on the same local day together', () => {
    const morning = new Date(2026, 7, 30, 9, 0, 0).getTime()
    const evening = new Date(2026, 7, 30, 21, 0, 0).getTime()
    const entries = [summary('entry-2', evening), summary('entry-1', morning)]

    const groups = groupHistoryByDate(entries)

    expect(groups).toHaveLength(1)
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['entry-2', 'entry-1'])
  })

  it('starts a new group for a different local day, preserving input order', () => {
    const day1 = new Date(2026, 7, 29, 12, 0, 0).getTime()
    const day2 = new Date(2026, 7, 30, 12, 0, 0).getTime()
    const entries = [summary('entry-newer', day2), summary('entry-older', day1)]

    const groups = groupHistoryByDate(entries)

    expect(groups).toHaveLength(2)
    expect(groups[0].entries[0].id).toBe('entry-newer')
    expect(groups[1].entries[0].id).toBe('entry-older')
  })

  it('returns no groups for an empty list', () => {
    expect(groupHistoryByDate([])).toEqual([])
  })
})

describe('historyDetailToContent', () => {
  it('maps a history entry detail to restorable request content', () => {
    const content = historyDetailToContent(
      detail({
        type: 'success',
        statusCode: 200,
        durationMs: 1,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        headers: [],
        graphqlErrors: [],
        bodyTruncated: false,
        responseStored: true,
      }),
    )

    expect(content).toEqual({
      protocol: 'graphql',
      endpointUrl: 'https://api.example.com/graphql',
      query: 'query { ping }',
      variables: '{}',
      method: 'post',
      body: { type: 'raw', content: '', rawLanguage: 'json' },
      headers: [{ name: 'Accept', value: 'application/json', enabled: true }],
      authentication: { type: 'bearer', token: 'secret' },
      preRequestScript: '',
      postResponseScript: '',
      routeParams: [],
      grpc: emptyGrpcCall,
    })
  })

  it('maps a REST history entry detail to restorable request content, preserving method and body', () => {
    const content = historyDetailToContent({
      ...detail({
        type: 'success',
        statusCode: 201,
        durationMs: 1,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        headers: [],
        graphqlErrors: [],
        bodyTruncated: false,
        responseStored: true,
      }),
      protocol: 'rest',
      endpoint: 'https://api.example.com/users',
      method: 'put',
      body: '{"name":"acme"}',
      variables: '',
    })

    expect(content).toEqual({
      protocol: 'rest',
      endpointUrl: 'https://api.example.com/users',
      query: '',
      variables: '',
      method: 'put',
      body: { type: 'raw', content: '{"name":"acme"}', rawLanguage: 'json' },
      headers: [{ name: 'Accept', value: 'application/json', enabled: true }],
      authentication: { type: 'bearer', token: 'secret' },
      preRequestScript: '',
      postResponseScript: '',
      routeParams: [],
      grpc: emptyGrpcCall,
    })
  })
})

describe('historyDetailToExecutionState', () => {
  it('maps a successful outcome to a success execution state', () => {
    const state = historyDetailToExecutionState(
      detail({
        type: 'success',
        statusCode: 200,
        durationMs: 12,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        graphqlErrors: [],
        bodyTruncated: false,
        responseStored: true,
      }),
    )

    expect(state).toEqual({
      status: 'success',
      result: {
        statusCode: 200,
        durationMs: 12,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        graphqlErrors: [],
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scopedChanges: [],
        scriptLogs: [],
        scriptError: null,
        testResults: [],
      },
    })
  })

  it('marks a success whose response was not stored', () => {
    const state = historyDetailToExecutionState(
      detail({
        type: 'success',
        statusCode: 200,
        durationMs: 12,
        sizeBytes: 2,
        body: { kind: 'inline', body: '' },
        bodyEncoding: 'text',
        headers: [],
        graphqlErrors: [],
        bodyTruncated: false,
        responseStored: false,
      }),
    )

    expect(state).toMatchObject({ status: 'success', responseNotStored: true, result: { statusCode: 200, sizeBytes: 2 } })
  })

  it('passes a windowed body through unchanged, without wrapping it again', () => {
    const windowedBody = { kind: 'windowed' as const, handle: 'history:entry-1', totalBytes: 6_000_000, preview: '{"a"', previewNextOffset: 4 }
    const state = historyDetailToExecutionState(
      detail({
        type: 'success',
        statusCode: 200,
        durationMs: 12,
        sizeBytes: 6_000_000,
        body: windowedBody,
        bodyEncoding: 'text',
        headers: [],
        graphqlErrors: [],
        bodyTruncated: false,
        responseStored: true,
      }),
    )

    expect(state).toEqual({
      status: 'success',
      result: {
        statusCode: 200,
        durationMs: 12,
        sizeBytes: 6_000_000,
        body: windowedBody,
        bodyEncoding: 'text',
        headers: [],
        graphqlErrors: [],
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scopedChanges: [],
        scriptLogs: [],
        scriptError: null,
        testResults: [],
      },
    })
  })

  it('maps a network failure to an error execution state with its message', () => {
    const state = historyDetailToExecutionState(detail({ type: 'failed', kind: 'network', message: 'connection refused' }))

    expect(state).toEqual({ status: 'error', error: { kind: 'network', message: 'connection refused' } })
  })

  it('maps a timeout failure to an error execution state without a message', () => {
    const state = historyDetailToExecutionState(detail({ type: 'failed', kind: 'timeout', message: 'tempo de execução esgotado' }))

    expect(state).toEqual({ status: 'error', error: { kind: 'timeout' } })
  })
})

describe('filterHistory', () => {
  const collectionEntry = summary('c', 1)
  const flowEntry: HistoryEntrySummaryDto = {
    origin: 'flow',
    id: 'f',
    flowName: 'Meu flow',
    executedAtMs: 2,
    durationMs: 10,
    status: 'completed',
  }
  const entries = [flowEntry, collectionEntry]

  it('returns everything for "all"', () => {
    expect(filterHistory(entries, 'all', 'flow')).toEqual(entries)
  })

  it('filters by collections or flows', () => {
    expect(filterHistory(entries, 'collections', null)).toEqual([collectionEntry])
    expect(filterHistory(entries, 'flows', null)).toEqual([flowEntry])
  })

  it('follows the active component kind for "current"', () => {
    expect(filterHistory(entries, 'current', 'flow')).toEqual([flowEntry])
    expect(filterHistory(entries, 'current', 'request')).toEqual([collectionEntry])
  })

  it('filters collection runner runs', () => {
    const runnerEntry: HistoryEntrySummaryDto = {
      origin: 'runner',
      id: 'r',
      scopeName: 'Loja',
      executedAtMs: 3,
      durationMs: 10,
      status: 'failed',
      passed: 1,
      total: 2,
    }
    const all = [runnerEntry, ...entries]

    expect(filterHistory(all, 'runners', null)).toEqual([runnerEntry])
    expect(filterHistory(all, 'current', 'runner')).toEqual([runnerEntry])
    expect(filterHistory(all, 'flows', null)).toEqual([flowEntry])
  })

  it('includes load runs in the flow history and current-flow filters', () => {
    const loadEntry: HistoryEntrySummaryDto = {
      origin: 'load',
      id: 'load-1',
      flowId: 'flow-1',
      flowName: 'Carga de login',
      executedAtMs: 4,
      durationMs: 100,
      status: 'completed',
      passed: true,
      requests: 20,
      failedRequests: 0,
    }
    const all = [loadEntry, ...entries]

    expect(filterHistory(all, 'flows', null)).toEqual([loadEntry, flowEntry])
    expect(filterHistory(all, 'current', 'flow')).toEqual([loadEntry, flowEntry])
  })

  it('shows everything for "current" without an active component', () => {
    expect(filterHistory(entries, 'current', null)).toEqual(entries)
  })
})
