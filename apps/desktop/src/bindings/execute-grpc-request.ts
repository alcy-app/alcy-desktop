import type { VariableScopeInput } from './execute-graphql-request'
import type { EnvironmentVariableDto } from './list-environments'
import { Channel } from '@tauri-apps/api/core'
import type { ResponseBodyOutput } from './execute-graphql-request'
import { invokeResult, type CommandResult } from './invoke-result'
import type { GrpcCommandError, GrpcConnectionInput, GrpcMethodKind } from './load-grpc-schema'

export interface GrpcStatusOutput {
  code: number
  /** Canonical name (`OK`, `NOT_FOUND`, …). */
  codeName: string
  message: string
}

export interface GrpcMetadataEntry {
  name: string
  value: string
}

export interface ExecuteGrpcRequestInput extends GrpcConnectionInput {
  executionId: string
  service: string
  method: string
  deadlineMs: number | null
  /** The request message, as JSON. */
  message: string
  tabId: string | null
}

export interface ExecuteGrpcRequestOutput {
  /** Tells a gRPC result apart from the HTTP ones in a union. */
  status: GrpcStatusOutput
  durationMs: number
  sizeBytes: number
  messageCount: number
  /** The received message as JSON; a JSON array when there are several. */
  body: ResponseBodyOutput
  headers: GrpcMetadataEntry[]
  trailers: GrpcMetadataEntry[]
}

/** A call's progress, as it happens. Message JSON longer than 256 KiB
 * arrives cut (`truncated`); the final output keeps the whole body. */
export type GrpcCallEventDto =
  | { type: 'started'; kind: GrpcMethodKind }
  | { type: 'sent'; index: number; json: string; truncated: boolean; sizeBytes: number; elapsedMs: number }
  | { type: 'headers'; metadata: GrpcMetadataEntry[]; elapsedMs: number }
  | { type: 'received'; index: number; json: string; truncated: boolean; sizeBytes: number; elapsedMs: number }
  | { type: 'finished'; status: GrpcStatusOutput; trailers: GrpcMetadataEntry[]; elapsedMs: number }

/** Calls a gRPC method, reporting each event to `onEvent` as it happens; the
 * promise resolves when the call ends. Cancellable with
 * `cancel_graphql_request` and the same `executionId`. */
export function executeGrpcRequest(
  input: ExecuteGrpcRequestInput,
  onEvent: (event: GrpcCallEventDto) => void = () => {},
): Promise<CommandResult<ExecuteGrpcRequestOutput, GrpcCommandError>> {
  const channel = new Channel<GrpcCallEventDto>()
  channel.onmessage = onEvent
  return invokeResult('execute_grpc_request', { input, onEvent: channel })
}

/** Sends one more message on a client-streaming call in progress. */
export function sendGrpcMessage(executionId: string, message: string, environmentVariables: EnvironmentVariableDto[], variableScopes: VariableScopeInput[]): Promise<CommandResult<null, GrpcCommandError>> {
  return invokeResult('send_grpc_message', { input: { executionId, message, environmentVariables, variableScopes } })
}

/** Ends the request stream of a call in progress. */
export function closeGrpcSend(executionId: string): Promise<CommandResult<null, GrpcCommandError>> {
  return invokeResult('close_grpc_send', { executionId })
}
