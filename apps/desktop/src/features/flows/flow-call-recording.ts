import type { FlowExchangeDto, FlowRunEventDto } from '../../bindings/execute-flow'
import { bodyPreviewText, toBodyState } from '../request-workbench/body-state'
import type { RequestSummary } from '../request-workbench/collection-tree'
import type { ConsoleEntryInput } from '../request-workbench/use-console-state'

/** One request node execution of a live run, for the HAR recorder. */
export interface FlowRecordedCall {
  nodeId: string
  executedAtMs: number
  /** URL actually sent, or the masked one shown in the run log when the call failed without a response. */
  url: string | null
  /** `null` when the call failed before any response arrived. */
  exchange: FlowExchangeDto | null
}

/** Turn run events into recorded calls. `pending` holds each node's displayed URL
 * between `nodeCallResolved` and its outcome, so a network failure is still
 * recorded; a node in a `while` reuses its slot on every iteration. */
export function recordedCallFromEvent(
  pending: Map<string, string>,
  event: FlowRunEventDto,
  nowMs: number,
): FlowRecordedCall | null {
  switch (event.type) {
    case 'nodeCallResolved':
      pending.set(event.nodeId, event.resolvedUrl)
      return null
    case 'nodeExchange':
      pending.delete(event.nodeId)
      return { nodeId: event.nodeId, executedAtMs: nowMs, url: event.exchange.url, exchange: event.exchange }
    case 'nodeFailed': {
      // Only calls that were sent: resolution failures never reach `nodeCallResolved`.
      const url = pending.get(event.nodeId)
      if (url === undefined) return null
      pending.delete(event.nodeId)
      return { nodeId: event.nodeId, executedAtMs: nowMs, url, exchange: null }
    }
    case 'nodeCancelled':
      pending.delete(event.nodeId)
      return null
    default:
      return null
  }
}

/** Recorder entry of a flow call, shaped like a manual send: method and body
 * come from the node's request (the body as its template, like the workbench). */
export function consoleEntryFromFlowCall(call: FlowRecordedCall, request: RequestSummary | null): ConsoleEntryInput {
  const content = request?.content
  const method = content?.protocol === 'rest' ? content.method : 'post'
  const requestBody = !content ? '' : content.protocol === 'rest' ? bodyPreviewText(toBodyState(content.body)) : content.query
  const { exchange } = call
  return {
    kind: 'request',
    endpointUrl: call.url ?? content?.endpointUrl ?? '',
    executedAtMs: call.executedAtMs,
    durationMs: exchange?.durationMs ?? null,
    outcome: exchange ? 'success' : 'error',
    statusCode: exchange?.statusCode ?? null,
    hasGraphqlErrors: false,
    errorKind: null,
    scriptMessage: null,
    detail: exchange && {
      method,
      requestBody,
      durationMs: exchange.durationMs,
      requestHeaders: exchange.requestHeaders,
      cookies: exchange.cookies,
      connection: exchange.connection,
      finalUrl: exchange.finalUrl,
      waitingMs: exchange.waitingMs,
      responseHeaders: exchange.headers,
      body: { kind: 'inline', body: exchange.body },
      bodyEncoding: exchange.bodyEncoding,
      truncated: exchange.truncated,
    },
  }
}
