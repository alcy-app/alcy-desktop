import type { ExecuteGrpcRequestOutput } from '../../bindings/execute-grpc-request'
import type { HistoryEntryDetailDto } from '../../bindings/get-history-entry'
import type { HistoryEntrySummaryDto } from '../../bindings/list-history'
import { emptyRestBody, restBodyFromDto } from './body-state'
import { emptyGrpcCall, emptyRequestContent, websocketFromDto } from './collection-tree'
import type { ExecuteWebSocketRequestOutput } from '../../bindings/execute-websocket-request'
import type { RequestContent } from './collection-tree'
import { grpcCodeName } from './grpc-status'
import type { ExecutionState } from './request-workbench.types'

export interface HistoryDateGroup {
  dateKey: string
  entries: HistoryEntrySummaryDto[]
}

export type HistoryFilter = 'all' | 'current' | 'collections' | 'flows' | 'runners'

/** Tipo do componente da aba ativa; `null` quando não há aba aberta. */
export type ActiveComponentKind = 'request' | 'flow' | 'runner' | null

/** Filtra por origem. `current` segue o tipo da aba ativa (sem aba ativa, mostra tudo). */
export function filterHistory(
  entries: HistoryEntrySummaryDto[],
  filter: HistoryFilter,
  activeKind: ActiveComponentKind,
): HistoryEntrySummaryDto[] {
  if (filter === 'collections') return entries.filter((entry) => entry.origin === 'collection')
  if (filter === 'flows') return entries.filter((entry) => entry.origin === 'flow' || entry.origin === 'load')
  if (filter === 'runners') return entries.filter((entry) => entry.origin === 'runner')
  if (filter === 'current' && activeKind !== null) {
    const origin = activeKind === 'flow' ? 'flow' : activeKind === 'runner' ? 'runner' : 'collection'
    return entries.filter((entry) => activeKind === 'flow' ? entry.origin === 'flow' || entry.origin === 'load' : entry.origin === origin)
  }
  return entries
}

/** Chave de agrupamento por dia local, ex.: `2026-08-30`. */
function dateKeyFor(executedAtMs: number): string {
  const date = new Date(executedAtMs)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Agrupa entradas por dia local, preservando a ordem mais-recente-primeiro já devolvida pelo backend. */
export function groupHistoryByDate(entries: HistoryEntrySummaryDto[]): HistoryDateGroup[] {
  const groups: HistoryDateGroup[] = []

  for (const entry of entries) {
    const dateKey = dateKeyFor(entry.executedAtMs)
    const current = groups.at(-1)
    if (current && current.dateKey === dateKey) {
      current.entries.push(entry)
    } else {
      groups.push({ dateKey, entries: [entry] })
    }
  }

  return groups
}

export function historyDetailToContent(detail: HistoryEntryDetailDto): RequestContent {
  if (detail.protocol === 'websocket') {
    return {
      ...emptyRequestContent('websocket'),
      endpointUrl: detail.endpoint,
      headers: detail.headers,
      authentication: detail.authentication,
      websocket: websocketFromDto(detail.websocket, detail.body),
    }
  }
  if (detail.protocol === 'grpc') {
    return {
      ...emptyRequestContent('grpc'),
      endpointUrl: detail.endpoint,
      headers: detail.headers,
      authentication: detail.authentication,
      grpc: {
        service: detail.grpc?.service ?? '',
        method: detail.grpc?.method ?? '',
        schemaSource: detail.grpc?.schemaSource ?? { type: 'reflection' },
        deadlineMs: detail.grpc?.deadlineMs ?? null,
        message: detail.body,
      },
    }
  }
  if (detail.protocol === 'rest') {
    return {
      protocol: 'rest',
      endpointUrl: detail.endpoint,
      query: '',
      variables: '',
      method: detail.method,
      body: restBodyFromDto(detail.restBody, detail.body),
      headers: detail.headers,
      authentication: detail.authentication,
      preRequestScript: '',
      postResponseScript: '',
      routeParams: [],
      grpc: emptyGrpcCall,
    }
  }

  return {
    protocol: 'graphql',
    endpointUrl: detail.endpoint,
    query: detail.body,
    variables: detail.variables,
    method: detail.method,
    body: emptyRestBody,
    headers: detail.headers,
    authentication: detail.authentication,
    preRequestScript: '',
    postResponseScript: '',
    routeParams: [],
    grpc: emptyGrpcCall,
  }
}

/** A gRPC send as history keeps it: the status in `grpc-status`/
 * `grpc-message` among the metadata, the received messages as the body. */
function grpcResultFromHistory(
  outcome: Extract<HistoryEntryDetailDto['outcome'], { type: 'success' }>,
): ExecuteGrpcRequestOutput {
  const value = (name: string) => outcome.headers.find((header) => header.name === name)?.value
  const code = Number(value('grpc-status') ?? '2')
  const body = outcome.body
  const messageCount =
    body.kind === 'windowed' ? 0 : body.body.trim() === '' ? 0 : body.body.trimStart().startsWith('[') ? countArray(body.body) : 1
  return {
    status: { code, codeName: grpcCodeName(code), message: value('grpc-message') ?? '' },
    durationMs: outcome.durationMs,
    sizeBytes: outcome.sizeBytes,
    messageCount,
    body,
    headers: outcome.headers.filter((header) => header.name !== 'grpc-status' && header.name !== 'grpc-message'),
    trailers: [],
  }
}

function countArray(json: string): number {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.length : 1
  } catch {
    return 1
  }
}

/** A WebSocket connection as history keeps it: the handshake headers plus
 * the close in `websocket-close-*` pseudo-headers, the received messages as
 * the body. */
function websocketResultFromHistory(
  outcome: Extract<HistoryEntryDetailDto['outcome'], { type: 'success' }>,
): ExecuteWebSocketRequestOutput {
  const value = (name: string) => outcome.headers.find((header) => header.name === name)?.value
  const code = value(WEBSOCKET_CLOSE_CODE_HEADER)
  const closedBy = value(WEBSOCKET_CLOSED_BY_HEADER)
  const body = outcome.body
  const receivedCount =
    body.kind === 'windowed' ? 0 : body.body === '' ? 0 : body.body.startsWith('[\n') ? countArray(body.body) : 1
  return {
    statusCode: outcome.statusCode,
    durationMs: outcome.durationMs,
    sizeBytes: outcome.sizeBytes,
    body,
    headers: outcome.headers.filter((header) => !header.name.startsWith('websocket-close') && header.name !== WEBSOCKET_CLOSED_BY_HEADER),
    requestHeaders: [],
    cookies: [],
    connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
    waitingMs: 0,
    close: {
      code: code === undefined ? null : Number(code),
      reason: value(WEBSOCKET_CLOSE_REASON_HEADER) ?? '',
      closedBy: closedBy === 'client' || closedBy === 'server' || closedBy === 'transport' ? closedBy : outcome.statusCode === 101 ? 'transport' : 'rejected',
    },
    subprotocol: null,
    sentCount: 0,
    receivedCount,
    environmentChanges: [],
    scopedChanges: [],
    scriptLogs: [],
    scriptError: null,
    testResults: [],
  }
}

const WEBSOCKET_CLOSE_CODE_HEADER = 'websocket-close-code'
const WEBSOCKET_CLOSE_REASON_HEADER = 'websocket-close-reason'
const WEBSOCKET_CLOSED_BY_HEADER = 'websocket-closed-by'

export function historyDetailToExecutionState(detail: HistoryEntryDetailDto): ExecutionState {
  if (detail.outcome.type === 'success' && detail.protocol === 'websocket') {
    return {
      status: 'success',
      result: websocketResultFromHistory(detail.outcome),
      ...(detail.outcome.responseStored === false && { responseNotStored: true }),
    }
  }
  if (detail.outcome.type === 'success' && detail.protocol === 'grpc') {
    return {
      status: 'success',
      result: grpcResultFromHistory(detail.outcome),
      ...(detail.outcome.responseStored === false && { responseNotStored: true }),
    }
  }
  if (detail.outcome.type === 'success') {
    const { statusCode, durationMs, sizeBytes, body, bodyEncoding, headers, graphqlErrors, responseStored } = detail.outcome
    // O histórico persistido sempre guarda o corpo inteiro em disco, mas
    // `get_history_entry` aplica o mesmo corte inline/janela que a
    // execução ao vivo antes de atravessar o IPC (ver ADR 0005) — `body`
    // já chega como `ResponseBodyOutput`, sem envelope extra aqui.
    //
    // Headers efetivos de requisição, cookies, timing e conexão não são
    // persistidos (ver ADR 0010) — uma entrada reaberta do histórico
    // sempre volta com esses campos vazios/zerados, diferente de uma
    // execução ao vivo.
    return {
      status: 'success',
      result: {
        statusCode,
        durationMs,
        sizeBytes,
        body,
        bodyEncoding,
        headers,
        graphqlErrors,
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
      ...(responseStored === false && { responseNotStored: true }),
    }
  }

  if (detail.outcome.kind === 'timeout') {
    return { status: 'error', error: { kind: 'timeout' } }
  }

  return { status: 'error', error: { kind: 'network', message: detail.outcome.message } }
}
