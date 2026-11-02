import { Channel } from '@tauri-apps/api/core'
import {
  splitExecutionFailure,
  type ConnectionInfo,
  type Cookie,
  type EnvironmentChange,
  type HeaderInput,
  type AuthenticationInput,
  type ResponseBodyOutput,
  type ResponseHeader,
  type ScopedVariableChange,
  type ScriptEffectsOnFailure,
  type ScriptErrorOutput,
  type ScriptTestResult,
  type VariableScopeInput,
} from './execute-graphql-request'
import type { ExecuteRestRequestError, RouteParameterInput } from './execute-rest-request'
import { invokeResult, type CommandResult } from './invoke-result'
import type { EnvironmentVariableDto } from './list-environments'
import type { WebSocketCallDto, WebSocketMessageFormat } from './websocket-call'

export interface ExecuteWebSocketRequestInput {
  executionId: string
  rootPath: string
  endpointUrl: string
  routeParams: RouteParameterInput[]
  headers: HeaderInput[]
  authentication: AuthenticationInput
  requestId: string | null
  tabId: string | null
  environmentVariables: EnvironmentVariableDto[]
  variableScopes: VariableScopeInput[]
  preRequestScript: string
  postResponseScript: string
  /** The composer message; connecting does not send it. */
  message: string
  websocket: WebSocketCallDto
}

/** Who ended a connection; `rejected` means the server refused the upgrade. */
export type WebSocketClosedBy = 'client' | 'server' | 'transport' | 'rejected'

export interface WebSocketCloseOutput {
  code: number | null
  reason: string
  closedBy: WebSocketClosedBy
}

export interface ExecuteWebSocketRequestOutput {
  /** 101, or the status the server refused the upgrade with. */
  statusCode: number
  durationMs: number
  sizeBytes: number
  /** The received messages: the message itself when there is one, a JSON
   * array when there are several; the refusal body when rejected. */
  body: ResponseBodyOutput
  headers: ResponseHeader[]
  requestHeaders: ResponseHeader[]
  cookies: Cookie[]
  connection: ConnectionInfo
  waitingMs: number
  /** Tells a WebSocket result apart from the other protocols in a union. */
  close: WebSocketCloseOutput
  subprotocol: string | null
  sentCount: number
  receivedCount: number
  environmentChanges: EnvironmentChange[]
  scopedChanges: ScopedVariableChange[]
  scriptLogs: string[]
  scriptError: ScriptErrorOutput | null
  testResults: ScriptTestResult[]
}

/** A connection's progress, as it happens. Data longer than 256 KiB arrives
 * cut (`truncated`); the final output keeps the received messages whole. */
export type WebSocketEventDto =
  | { type: 'opened'; status: number; headers: ResponseHeader[]; subprotocol: string | null; elapsedMs: number }
  | {
      type: 'message'
      direction: 'sent' | 'received'
      index: number
      /** `binary` data is base64. */
      format: 'text' | 'binary'
      data: string
      truncated: boolean
      sizeBytes: number
      elapsedMs: number
    }
  | { type: 'closed'; code: number | null; reason: string; closedBy: WebSocketClosedBy; elapsedMs: number }

export type ExecuteWebSocketRequestResult =
  | { ok: true; value: ExecuteWebSocketRequestOutput }
  | ({ ok: false; error: ExecuteRestRequestError } & ScriptEffectsOnFailure)

/** Opens a connection, reporting each event to `onEvent`; the promise
 * resolves when the connection ends. Cancellable (abrupt close) with
 * `cancel_graphql_request` and the same `executionId`. */
export async function executeWebSocketRequest(
  input: ExecuteWebSocketRequestInput,
  onEvent: (event: WebSocketEventDto) => void = () => {},
): Promise<ExecuteWebSocketRequestResult> {
  const channel = new Channel<WebSocketEventDto>()
  channel.onmessage = onEvent
  const result = await invokeResult<ExecuteWebSocketRequestOutput, unknown>('execute_websocket_request', {
    input,
    onEvent: channel,
  })
  return result.ok ? result : { ok: false, ...splitExecutionFailure<ExecuteRestRequestError>(result.error) }
}

/** Sends one message on an open connection; `{{variables}}` resolve with the
 * values captured when connecting. */
export function sendWebSocketMessage(
  executionId: string,
  message: string,
  format: WebSocketMessageFormat,
): Promise<CommandResult<null, ExecuteRestRequestError>> {
  return invokeResult('send_websocket_message', { input: { executionId, message, format } })
}

/** Closes an open connection normally; the execution then resolves. */
export function closeWebSocket(executionId: string): Promise<CommandResult<null, ExecuteRestRequestError>> {
  return invokeResult('close_websocket', { executionId, code: null, reason: null })
}
