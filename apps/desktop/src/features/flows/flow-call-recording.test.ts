import { describe, expect, it } from 'vitest'
import type { FlowExchangeDto, FlowRunEventDto } from '../../bindings/execute-flow'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { RequestSummary } from '../request-workbench/collection-tree'
import { consoleEntryFromFlowCall, recordedCallFromEvent } from './flow-call-recording'

function exchange(overrides: Partial<FlowExchangeDto> = {}): FlowExchangeDto {
  return {
    url: 'https://api.example.com/users?key=secret',
    statusCode: 201,
    durationMs: 30,
    sizeBytes: 11,
    body: '{"ok":true}',
    bodyEncoding: 'text',
    truncated: false,
    headers: [{ name: 'content-type', value: 'application/json' }],
    requestHeaders: [{ name: 'authorization', value: 'Bearer secret' }],
    cookies: [],
    connection: { remoteAddress: '127.0.0.1:443', httpVersion: 'HTTP/1.1', tlsCertificatePresent: true, certificateVerificationDisabled: false },
    finalUrl: null,
    waitingMs: 10,
    ...overrides,
  }
}

const callResolved: FlowRunEventDto = {
  type: 'nodeCallResolved',
  nodeId: 'req',
  requestUrl: '{{baseUrl}}/users?key={{key}}',
  resolvedUrl: 'https://api.example.com/users?key=••••••••',
  variables: [],
}

function restRequest(): RequestSummary {
  return {
    id: 'saved',
    name: 'Create user',
    protocol: 'rest',
    content: {
      ...emptyRequestContent('rest'),
      endpointUrl: '{{baseUrl}}/users',
      method: 'post',
      body: { type: 'raw', content: '{"name":"{{name}}"}', rawLanguage: 'json' },
    },
  }
}

describe('recordedCallFromEvent', () => {
  it('records a call when its exchange arrives, with the URL actually sent', () => {
    const pending = new Map<string, string>()
    expect(recordedCallFromEvent(pending, callResolved, 1)).toBeNull()

    const call = recordedCallFromEvent(pending, { type: 'nodeExchange', nodeId: 'req', exchange: exchange() }, 50)

    expect(call).toEqual({ nodeId: 'req', executedAtMs: 50, url: 'https://api.example.com/users?key=secret', exchange: exchange() })
    // The node's later outcome does not record it again.
    expect(recordedCallFromEvent(pending, { type: 'nodeFailed', nodeId: 'req', message: 'gRPC INTERNAL' }, 51)).toBeNull()
  })

  it('records a call that failed without a response, with the URL shown in the run log', () => {
    const pending = new Map<string, string>()
    recordedCallFromEvent(pending, callResolved, 1)

    const call = recordedCallFromEvent(pending, { type: 'nodeFailed', nodeId: 'req', message: 'connection refused' }, 20)

    expect(call).toEqual({ nodeId: 'req', executedAtMs: 20, url: 'https://api.example.com/users?key=••••••••', exchange: null })
  })

  it('ignores failures of nodes that sent nothing, and cancelled calls', () => {
    const pending = new Map<string, string>()
    expect(recordedCallFromEvent(pending, { type: 'nodeFailed', nodeId: 'if', message: 'missing variable' }, 1)).toBeNull()

    recordedCallFromEvent(pending, callResolved, 2)
    expect(recordedCallFromEvent(pending, { type: 'nodeCancelled', nodeId: 'req' }, 3)).toBeNull()
    expect(recordedCallFromEvent(pending, { type: 'nodeFailed', nodeId: 'req', message: 'late' }, 4)).toBeNull()
  })
})

describe('consoleEntryFromFlowCall', () => {
  it('builds a recorder entry with the node request method and body template', () => {
    const entry = consoleEntryFromFlowCall(
      { nodeId: 'req', executedAtMs: 50, url: 'https://api.example.com/users', exchange: exchange({ truncated: true }) },
      restRequest(),
    )

    expect(entry).toMatchObject({
      kind: 'request',
      endpointUrl: 'https://api.example.com/users',
      executedAtMs: 50,
      durationMs: 30,
      outcome: 'success',
      statusCode: 201,
      detail: {
        method: 'post',
        requestBody: '{"name":"{{name}}"}',
        requestHeaders: [{ name: 'authorization', value: 'Bearer secret' }],
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: { kind: 'inline', body: '{"ok":true}' },
        waitingMs: 10,
        truncated: true,
      },
    })
  })

  it('records a failed call as an error without detail, falling back to the template URL', () => {
    const entry = consoleEntryFromFlowCall({ nodeId: 'req', executedAtMs: 5, url: null, exchange: null }, restRequest())

    expect(entry).toMatchObject({ endpointUrl: '{{baseUrl}}/users', outcome: 'error', statusCode: null, durationMs: null, detail: null })
  })

  it('sends GraphQL requests as POST with the query as body', () => {
    const request: RequestSummary = {
      id: 'gql',
      name: 'Ping',
      protocol: 'graphql',
      content: { ...emptyRequestContent('graphql'), query: 'query { ping }' },
    }

    const entry = consoleEntryFromFlowCall({ nodeId: 'gql', executedAtMs: 1, url: 'https://api.example.com/graphql', exchange: exchange() }, request)

    expect(entry.detail).toMatchObject({ method: 'post', requestBody: 'query { ping }' })
  })
})
